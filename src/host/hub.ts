/**
 * Per-Session orbit state: the fold from DSH events to `OrbitSnapshot`.
 *
 * One `OrbitHub` lives for the lifetime of the plugin. It keeps a small LRU of
 * Session records (a Session's state never mixes with another's), normalizes
 * each DSH event through `normalize.ts`, correlates tool calls by `callId`,
 * drives the eleven-state machine, and notifies subscribers so the SSE route
 * can push a fresh snapshot.
 *
 * Two clocks, on purpose:
 *  - `now()` is the wall clock; it stamps activity rows for humans.
 *  - `mono()` is monotonic; it answers "how long has this been silent", which a
 *    system time jump must never distort.
 *
 * Nothing here is persisted: a Host restart starts from zero.
 */
import {
  CALL_TIMEOUT_MS,
  MAX_ACTIVITY_ROWS,
  type OrbitActivity,
  type OrbitActivityStatus,
  type OrbitAgentState,
  type OrbitMetrics,
  type OrbitSnapshot,
} from '../shared/protocol';
import { CallRegistry, type SettledStatus } from './correlation';
import {
  applyEvent,
  computeState,
  createMachine,
  hasPendingHold,
  quietLevelFor,
  silenceOf,
  type MachineState,
  type StreamPhase,
  type TurnEndKind,
} from './state-machine';
import {
  approvalActivity,
  errorActivity,
  retryActivity,
  settledActivity,
  toolActivity,
} from './normalize';
import { monotonicNow, type QuietLevel } from './quiet';
import { phaseOfSignal, streamSignalOf } from './stream';

/** Structural view of a DSH `SessionEvent`; only the fields we read. */
export interface SessionEventLike {
  readonly type: string;
  readonly time?: number;
  readonly data?: unknown;
}

/** Structural view of the DSH `Session`; only the identity is used. */
export interface SessionLike {
  readonly id: unknown;
}

export interface HubOptions {
  /** Sessions kept in memory; the least recently updated is evicted. */
  maxSessions?: number;
  maxActivities?: number;
  /** Wall clock for activity timestamps. */
  now?: () => number;
  /** Monotonic clock for silence detection; defaults to `now`. */
  mono?: () => number;
  /** An open call older than this is settled as cancelled. */
  callTimeoutMs?: number;
  /** Coalescing window for transient stream notifications. */
  streamNotifyMs?: number;
}

interface SessionRecord {
  sessionId: string;
  machine: MachineState;
  /** Newest first. */
  activities: OrbitActivity[];
  calls: CallRegistry;
  metrics: OrbitMetrics;
  version: number;
  quietLevel: QuietLevel;
  /** Wall-clock instant of the last change, used for LRU order. */
  updatedAt: number;
}

function recordOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Map a `turn/end.reason.kind` onto the machine vocabulary. */
function turnEndKindOf(reason: string | undefined): TurnEndKind {
  switch (reason) {
    case 'completed':
    case 'interrupted':
    case 'aborted':
    case 'blocked':
    case 'error':
    case 'max-tokens':
    case 'forked':
      return reason;
    default:
      return 'other';
  }
}

/** How open calls of a turn that ended this way should be settled. */
function drainStatusOf(reason: TurnEndKind): SettledStatus {
  if (reason === 'error' || reason === 'blocked') return 'error';
  if (reason === 'interrupted' || reason === 'aborted') return 'cancelled';
  return 'success';
}

export class OrbitHub {
  private readonly records = new Map<string, SessionRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly maxSessions: number;
  private readonly maxActivities: number;
  private readonly clock: () => number;
  private readonly mono: () => number;
  private readonly callTimeoutMs: number;
  private readonly streamNotifyMs: number;
  private notifyQueued = false;
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private lastTouched: string | undefined;

  constructor(options: HubOptions = {}) {
    this.maxSessions = options.maxSessions ?? 8;
    this.maxActivities = options.maxActivities ?? MAX_ACTIVITY_ROWS;
    this.clock = options.now ?? (() => Date.now());
    this.mono = options.mono ?? this.clock;
    this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.streamNotifyMs = Math.max(0, options.streamNotifyMs ?? 120);
  }

  // ---------------------------------------------------------------- records

  private ensure(sessionId: string): SessionRecord {
    const existing = this.records.get(sessionId);
    if (existing !== undefined) return existing;
    const now = this.clock();
    const record: SessionRecord = {
      sessionId,
      machine: createMachine(this.mono()),
      activities: [],
      calls: new CallRegistry(),
      metrics: { turns: 0, steps: 0, tools: 0, files: 0, approvals: 0, retries: 0, startedAt: now },
      version: 1,
      quietLevel: 0,
      updatedAt: now,
    };
    this.records.set(sessionId, record);
    this.evictIfNeeded(sessionId);
    return record;
  }

  private evictIfNeeded(keep: string): void {
    while (this.records.size > this.maxSessions) {
      let oldestId: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, record] of this.records) {
        if (id === keep) continue;
        if (record.updatedAt < oldestAt) {
          oldestAt = record.updatedAt;
          oldestId = id;
        }
      }
      if (oldestId === undefined) return;
      this.records.get(oldestId)?.calls.clear();
      this.records.delete(oldestId);
      if (this.lastTouched === oldestId) this.lastTouched = keep;
    }
  }

  /**
   * Recompute the published state after a mutation and queue a notification.
   *
   * `stream` uses the throttled channel: transient frames arrive dozens of
   * times per second and each one still advances the version (so a Client that
   * polls `/state` sees the truth), but subscribers are only told at most once
   * per window.
   */
  private touch(record: SessionRecord, at: number, channel: 'event' | 'stream' = 'event'): void {
    record.machine.agentState = computeState(record.machine, at);
    record.quietLevel = quietLevelFor(record.machine, at);
    record.machine.updatedAt = at;
    record.updatedAt = this.clock();
    this.lastTouched = record.sessionId;
    // Every observed event can change a row, a counter or a timestamp even when
    // the headline state stays the same, so the version always advances.
    record.version += 1;
    if (channel === 'stream') this.queueStreamNotify();
    else this.queueNotify();
  }

  private queueNotify(): void {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      this.emit();
    });
  }

  /**
   * Transient frames can arrive dozens of times per second; the state machine
   * applies every one of them, but subscribers are told at most once per
   * window, which keeps the SSE stream and the Client cheap during streaming.
   */
  private queueStreamNotify(): void {
    if (this.streamTimer !== null) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      if (this.listeners.size === 0) return;
      this.emit();
    }, this.streamNotifyMs);
    (this.streamTimer as unknown as { unref?: () => void }).unref?.();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A broken subscriber must never break event ingestion.
      }
    }
  }

  private pushActivity(record: SessionRecord, activity: OrbitActivity): void {
    record.activities.unshift(activity);
    if (record.activities.length > this.maxActivities) {
      record.activities.length = this.maxActivities;
    }
  }

  /** Settle one row by id. Returns the settled row, or `undefined` when absent. */
  private settleRow(
    record: SessionRecord,
    id: string,
    status: OrbitActivityStatus,
    at: number,
  ): OrbitActivity | undefined {
    const index = record.activities.findIndex((row) => row.id === id);
    if (index < 0) return undefined;
    const current = record.activities[index];
    if (current === undefined) return undefined;
    if (current.status !== 'running' && current.status !== 'waiting') return undefined;
    const settled = settledActivity(current, status, at);
    record.activities[index] = settled;
    return settled;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}:${this.sequence}`;
  }

  // ------------------------------------------------------------------ folds

  /** Fold one durable DSH Session event. Unknown event types are ignored. */
  handleSessionEvent(sessionId: string, event: SessionEventLike): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    if (typeof event !== 'object' || event === null) return;
    const epoch = asNumber(event.time) ?? this.clock();
    const at = this.mono();
    const data = event.data;

    switch (event.type) {
      case 'turn/start': {
        const record = this.ensure(sessionId);
        record.metrics.turns += 1;
        applyEvent(record.machine, { kind: 'turn-start', turn: asNumber(recordOf(data, 'turn')), at });
        this.touch(record, at);
        return;
      }

      case 'step/start': {
        const record = this.ensure(sessionId);
        record.metrics.steps += 1;
        applyEvent(record.machine, {
          kind: 'step-start',
          turn: asNumber(recordOf(data, 'turn')),
          step: asNumber(recordOf(data, 'step')),
          at,
        });
        this.touch(record, at);
        return;
      }

      case 'tool/call': {
        const record = this.ensure(sessionId);
        const callId = asString(recordOf(data, 'callId'));
        const name = asString(recordOf(data, 'name'));
        if (callId === undefined || name === undefined) return;
        const argumentsJson = typeof recordOf(data, 'arguments') === 'string'
          ? (recordOf(data, 'arguments') as string)
          : '';
        const turn = asNumber(recordOf(data, 'turn'));
        const step = asNumber(recordOf(data, 'step'));
        const outcome = record.calls.start({ callId, name, turn, step, at: epoch }, at);

        if (outcome.kind === 'duplicate' || outcome.kind === 'already-settled') return;

        const row = toolActivity({ id: callId, sessionId, rawName: name, argumentsJson, at: epoch, turn, step });
        record.metrics.tools += 1;
        if (row.type === 'file') record.metrics.files += 1;
        // The call knows its Turn/Step even when no `step/start` was observed.
        if (turn !== undefined) record.machine.turn = turn;
        if (step !== undefined) record.machine.step = step;

        if (outcome.kind === 'pre-settled') {
          // The result was already observed; the row opens settled and never
          // counts as an active tool.
          this.pushActivity(record, settledActivity(row, outcome.status, epoch));
          this.touch(record, at);
          return;
        }

        this.pushActivity(record, row);
        // An approval waiting on this call resolves the moment the tool runs.
        for (const activity of record.activities) {
          if (activity.type === 'approval' && activity.status === 'waiting') {
            this.settleRow(record, activity.id, 'success', epoch);
          }
        }
        applyEvent(record.machine, { kind: 'tool-start', id: callId, at });
        this.touch(record, at);
        return;
      }

      case 'tool/result': {
        const record = this.ensure(sessionId);
        const message = recordOf(data, 'message');
        const callId = asString(recordOf(message, 'toolCallId'));
        if (callId === undefined) return;
        const error = recordOf(data, 'error');
        const errorCode = asString(recordOf(error, 'code'));
        const failed = recordOf(message, 'isError') === true || error !== undefined;
        const status: SettledStatus = failed
          ? errorCode === 'ABORTED' || errorCode === 'CANCELLED'
            ? 'cancelled'
            : 'error'
          : 'success';
        const call = record.calls.settle(callId, status);
        if (call === undefined) {
          // Unknown or duplicate: remembered by the registry for a late call.
          return;
        }
        const resultTurn = asNumber(recordOf(data, 'turn'));
        const resultStep = asNumber(recordOf(data, 'step'));
        if (resultTurn !== undefined) record.machine.turn = resultTurn;
        if (resultStep !== undefined) record.machine.step = resultStep;
        this.settleRow(record, callId, status, epoch);
        applyEvent(record.machine, { kind: 'tool-end', id: callId, at });
        this.touch(record, at);
        return;
      }

      case 'approval/asked': {
        const record = this.ensure(sessionId);
        const approvalId = asString(recordOf(data, 'id'));
        if (approvalId === undefined) return;
        const toolName = asString(recordOf(data, 'toolName'));
        const turn = asNumber(recordOf(data, 'turn'));
        const step = asNumber(recordOf(data, 'step'));
        record.metrics.approvals += 1;
        // A waterfall bridge row exists for this ask: adopt it instead of
        // showing the same decision twice.
        const bridgeIndex = record.activities.findIndex(
          (row) => row.type === 'approval' && row.status === 'waiting' && row.id.startsWith('bridge:'),
        );
        if (bridgeIndex >= 0) {
          const bridge = record.activities[bridgeIndex];
          if (bridge !== undefined) {
            record.activities[bridgeIndex] = {
              ...bridge,
              id: approvalId,
              label: 'approval',
              ...(turn === undefined ? {} : { turn }),
              ...(step === undefined ? {} : { step }),
              ...(bridge.safeTarget === undefined && toolName !== undefined
                ? { safeTarget: toolName.slice(0, 40) }
                : {}),
            };
          }
        } else {
          this.pushActivity(record, approvalActivity(epoch, approvalId, sessionId, toolName, { turn, step }));
        }
        applyEvent(record.machine, { kind: 'approval-asked', id: approvalId, at });
        this.touch(record, at);
        return;
      }

      case 'approval/decided': {
        const record = this.ensure(sessionId);
        const approvalId = asString(recordOf(data, 'id'));
        const outcome = asString(recordOf(data, 'outcome'));
        this.settleRow(record, approvalId ?? '', this.approvalStatus(outcome), epoch);
        applyEvent(record.machine, { kind: 'approval-decided', at });
        this.touch(record, at);
        return;
      }

      case 'llm/retry': {
        const record = this.ensure(sessionId);
        const attempt = asNumber(recordOf(data, 'retry')) ?? 0;
        record.metrics.retries += 1;
        const turn = asNumber(recordOf(data, 'turn'));
        const step = asNumber(recordOf(data, 'step'));
        const id = `retry:${turn ?? 0}:${step ?? 0}:${attempt}`;
        if (!record.activities.some((row) => row.id === id)) {
          this.pushActivity(record, retryActivity(epoch, id, sessionId, attempt));
        }
        applyEvent(record.machine, { kind: 'stream', phase: 'thinking', at });
        this.touch(record, at);
        return;
      }

      case 'assistant/message': {
        const record = this.ensure(sessionId);
        if (recordOf(data, 'interrupted') !== true) return;
        applyEvent(record.machine, { kind: 'interrupted', at });
        this.touch(record, at);
        return;
      }

      case 'turn/end': {
        const record = this.ensure(sessionId);
        const reason = turnEndKindOf(asString(recordOf(recordOf(data, 'reason'), 'kind')));
        for (const call of record.calls.drain(drainStatusOf(reason))) {
          this.settleRow(record, call.callId, drainStatusOf(reason), epoch);
        }
        applyEvent(record.machine, { kind: 'turn-end', reason, at });
        this.touch(record, at);
        return;
      }

      default:
        return;
    }
  }

  private approvalStatus(outcome: string | undefined): OrbitActivityStatus {
    switch (outcome) {
      case 'allowed-once':
        return 'success';
      case 'cancelled':
        return 'cancelled';
      case 'rejected':
      case 'unavailable':
        return 'error';
      default:
        return 'error';
    }
  }

  /**
   * Fold one transient `agent/assistant-stream` frame.
   *
   * Only the frame's type tags are inspected; the deltas themselves are never
   * read, so no reasoning or answer text can reach the Client through this path.
   */
  handleStream(sessionId: string, frame: unknown): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const signal = streamSignalOf(frame);
    if (signal === undefined) return;
    const record = this.ensure(sessionId);
    // A frame from an already-finished turn must not resurrect `running`.
    if (signal.turn !== undefined && record.machine.turn !== undefined && signal.turn < record.machine.turn) {
      return;
    }
    const at = this.mono();
    const phase: StreamPhase = phaseOfSignal(signal) ?? 'none';
    applyEvent(record.machine, { kind: 'stream', phase, at });
    if (signal.turn !== undefined) record.machine.turn = signal.turn;
    if (signal.step !== undefined) record.machine.step = signal.step;
    this.touch(record, at, 'stream');
  }

  handleStatus(sessionId: string, status: 'idle' | 'running'): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const record = this.ensure(sessionId);
    const at = this.mono();
    applyEvent(record.machine, { kind: 'status', status, at });
    this.touch(record, at);
  }

  handleTurnStopping(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const record = this.ensure(sessionId);
    const at = this.mono();
    applyEvent(record.machine, { kind: 'turn-stopping', at });
    this.touch(record, at);
  }

  /**
   * Optimistic bridge for the `approval/request` waterfall, which fires before
   * the durable `approval/asked`. The row is tagged so the durable event can
   * adopt it rather than showing the same decision twice.
   */
  handleApproval(sessionId: string, toolName?: string, callId?: string): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const record = this.ensure(sessionId);
    const epoch = this.clock();
    const at = this.mono();
    const id = callId === undefined ? this.nextId('bridge') : `bridge:${callId}`;
    const existing = record.activities.find((row) => row.id === id);
    if (existing === undefined) {
      this.pushActivity(record, approvalActivity(epoch, id, sessionId, toolName));
    }
    applyEvent(record.machine, { kind: 'approval-asked', id, at });
    this.touch(record, at);
  }

  handleError(sessionId: string, code?: string): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const record = this.ensure(sessionId);
    const epoch = this.clock();
    const at = this.mono();
    for (const call of record.calls.drain('error')) {
      this.settleRow(record, call.callId, 'error', epoch);
    }
    this.pushActivity(record, errorActivity(epoch, this.nextId('error'), sessionId, code));
    applyEvent(record.machine, { kind: 'error', at });
    this.touch(record, at);
  }

  /** Drop a Session completely: its Agent will never report again. */
  handleDisposed(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const record = this.records.get(sessionId);
    if (record === undefined) return;
    record.calls.clear();
    record.calls = new CallRegistry();
    this.records.delete(sessionId);
    if (this.lastTouched === sessionId) this.lastTouched = undefined;
    this.queueNotify();
  }

  /** Expire held states and stale calls. Cheap when nothing is pending. */
  tick(): void {
    const at = this.mono();
    const epoch = this.clock();
    for (const record of this.records.values()) {
      const expired = record.calls.expire(at, this.callTimeoutMs, 'cancelled');
      if (expired.length > 0) {
        for (const call of expired) {
          this.settleRow(record, call.callId, 'cancelled', epoch);
          applyEvent(record.machine, { kind: 'tool-end', id: call.callId, at });
        }
        record.version += 1;
        record.updatedAt = epoch;
        this.queueNotify();
        continue;
      }
      if (!hasPendingHold(record.machine, at)) continue;
      const next = computeState(record.machine, at);
      const level = quietLevelFor(record.machine, at);
      if (next === record.machine.agentState && level === record.quietLevel) continue;
      record.machine.agentState = next;
      record.quietLevel = level;
      record.machine.updatedAt = at;
      record.updatedAt = epoch;
      record.version += 1;
      this.queueNotify();
    }
  }

  // ---------------------------------------------------------------- reading

  /** Session ids, most recently updated first. */
  sessionIds(): string[] {
    return [...this.records.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((record) => record.sessionId);
  }

  /** Resolve which Session a snapshot request means. */
  resolveSession(requested?: string | null): string | undefined {
    if (typeof requested === 'string' && requested !== '') return requested;
    if (this.lastTouched !== undefined && this.records.has(this.lastTouched)) return this.lastTouched;
    return this.sessionIds()[0];
  }

  snapshot(requested?: string | null): OrbitSnapshot {
    const sessionId = this.resolveSession(requested);
    const record = sessionId === undefined ? undefined : this.records.get(sessionId);
    const now = this.clock();
    if (record === undefined) {
      return {
        version: 0,
        agentState: 'idle',
        activeTools: 0,
        silenceMs: 0,
        quietLevel: 0,
        events: [],
        updatedAt: now,
        metrics: { turns: 0, steps: 0, tools: 0, files: 0, approvals: 0, retries: 0, startedAt: now },
      };
    }
    const at = this.mono();
    const machine = record.machine;
    const agentState: OrbitAgentState = computeState(machine, at);
    return {
      version: record.version,
      sessionId: record.sessionId,
      agentState,
      activeTools: machine.openTools.length,
      ...(machine.turn === undefined ? {} : { turn: machine.turn }),
      ...(machine.step === undefined ? {} : { step: machine.step }),
      silenceMs: Math.round(silenceOf(machine, at)),
      quietLevel: quietLevelFor(machine, at),
      events: record.activities.slice(0, this.maxActivities),
      updatedAt: record.updatedAt,
      metrics: { ...record.metrics },
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.streamTimer !== null) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    this.listeners.clear();
    for (const record of this.records.values()) record.calls.clear();
    this.records.clear();
    this.lastTouched = undefined;
  }
}

/** Kept for tests and diagnostics: the monotonic clock the hub uses by default. */
export { monotonicNow };
