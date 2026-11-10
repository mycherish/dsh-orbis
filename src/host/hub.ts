/**
 * Per-Session orbit state: the fold from DSH events to `OrbitSnapshot`.
 *
 * One `OrbitHub` lives for the lifetime of the plugin. Pipeline (spec §3):
 *
 *   DSH events → normalizer → correlation → state machine
 *              → aggregator → phase inference → silence → Task Context
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
import type { OrbitTaskContext } from '../shared/task-context-types';
import { CallRegistry, type SettledStatus } from './correlation';
import {
  applyEvent,
  computeState,
  createMachine,
  quietLevelFor,
  silenceOf,
  type MachineState,
  type StreamPhase,
  type TurnEndKind,
} from './state-machine';
import {
  abandonActivity,
  approvalActivity,
  errorActivity,
  questionActivity,
  retryActivity,
  settledActivity,
  toolActivity,
} from './activity/normalizer';
import {
  detectSilence,
  monotonicNow,
  type SilenceInput,
} from './context/silence-detector';
import { buildTaskContext, emptyTaskContext } from './context/task-context-engine';
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
  /** An open call older than this is settled as unknown. */
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
  quietLevel: 0 | 1 | 2 | 3;
  /** From `session/title`; undefined until the Host has seen one. */
  title?: string;
  /** Unfinished items from the newest `todo/write`, in the Agent's order. */
  plan: string[];
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
  if (reason === 'error' || reason === 'blocked') return 'failed';
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
    /*
     * Production default is the process-relative clock. Every duration the state
     * machine reasons about — silence buckets, hold expiry, the 10-minute orphan
     * call timeout — is a delta, and a wall clock can jump: an NTP correction or a
     * sleep/wake forward would fabricate an hour of silence and cancel running
     * tools, while a jump backwards would postpone every timeout. `monotonicNow()`
     * was written for exactly this and then never wired up, so the two clocks were
     * the same function.
     *
     * A caller that injects `now` is driving a fake timeline from a test and wants
     * one clock, not two; only the default pair splits (`mono` for durations, wall
     * for the human-facing `updatedAt`).
     */
    this.mono = options.mono ?? options.now ?? monotonicNow;
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
      plan: [],
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
   * times per second and each one still advances the version, but subscribers
   * are only told at most once per window.
   */
  private touch(record: SessionRecord, at: number, channel: 'event' | 'stream' = 'event'): void {
    record.machine.agentState = computeState(record.machine, at);
    record.quietLevel = quietLevelFor(record.machine, at);
    record.machine.updatedAt = at;
    record.updatedAt = this.clock();
    this.lastTouched = record.sessionId;
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
    if (current.status !== 'running' && current.status !== 'unknown') return undefined;
    const settled = settledActivity(current, status, at);
    record.activities[index] = settled;
    return settled;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}:${this.sequence}`;
  }

  /** Drop columns of a stale response row once the model moves on. */
  private closeStreamRows(record: SessionRecord, at: number): void {
    for (let index = 0; index < record.activities.length; index += 1) {
      const row = record.activities[index];
      if (row === undefined) continue;
      if (row.source !== 'stream' || row.status !== 'running') continue;
      record.activities[index] = settledActivity(row, 'success', at);
    }
  }

  // ------------------------------------------------------------------ folds

  /**
   * Seed the Session title from a source other than the `session/title` event.
   *
   * The event only fires once per title change, so a Host that reloads after it
   * already happened would otherwise show the fallback title for the rest of the
   * Session. The caller reads the title from the Harness' own fold and passes the
   * already-derived string in: nothing here is inferred.
   */
  seedTitle(sessionId: string, title: string): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const trimmed = title.trim();
    if (trimmed === '') return;
    const record = this.ensure(sessionId);
    // A live `session/title` event is the newer truth; never overwrite it.
    if (record.title !== undefined) return;
    record.title = trimmed;
    this.touch(record, this.mono());
  }

  /** Fold one durable DSH Session event. Unknown event types are ignored. */
  handleSessionEvent(sessionId: string, event: SessionEventLike): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    if (typeof event !== 'object' || event === null) return;
    const epoch = asNumber(event.time) ?? this.clock();
    const at = this.mono();
    const data = event.data;

    switch (event.type) {
      case 'session/title': {
        const record = this.ensure(sessionId);
        const title = asString(recordOf(data, 'title'));
        if (title === undefined) return;
        record.title = title;
        this.touch(record, at);
        return;
      }

      case 'todo/write': {
        const record = this.ensure(sessionId);
        const todos = recordOf(data, 'todos');
        if (!Array.isArray(todos)) return;
        // Only unfinished items, in the Agent's own order; the first one is the
        // "next step". Nothing is derived, nothing is written by us.
        record.plan = todos
          .map((todo) => {
            const content = asString(recordOf(todo, 'content'));
            const status = asString(recordOf(todo, 'status'));
            return status === 'completed' || content === undefined ? undefined : content;
          })
          .filter((item): item is string => item !== undefined);
        this.touch(record, at);
        return;
      }

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
        this.closeStreamRows(record, epoch);
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
        if (row.fileKind !== undefined) record.metrics.files += 1;
        if (turn !== undefined) record.machine.turn = turn;
        if (step !== undefined) record.machine.step = step;

        if (outcome.kind === 'pre-settled') {
          this.pushActivity(record, settledActivity(row, outcome.status, epoch));
          this.touch(record, at);
          return;
        }

        this.closeStreamRows(record, epoch);
        this.pushActivity(record, row);
        // An approval waiting on *this* call resolves the moment that tool runs.
        // Correlating by callId matters: with two asks outstanding, settling every
        // running approval row faked an "allowed" verdict for one nobody approved.
        // A row without a callId cannot be attributed to this call, so it is left
        // for `approval/decided` (or `turn/end`) to settle.
        for (const activity of record.activities) {
          if (
            activity.category === 'approval'
            && activity.status === 'running'
            && activity.callId === callId
          ) {
            this.settleRow(record, activity.id, 'success', epoch);
            /*
             * Tell the state machine *which* ask this call releases. The machine
             * used to clear both ask sets whenever any tool started, which meant a
             * second outstanding approval (or question) stopped being reported as
             * blocking the moment the first one ran, even though nobody had
             * answered it. The id attribution belongs here because this is the only
             * place that knows the call-to-ask correlation.
             */
            applyEvent(record.machine, { kind: 'approval-decided', id: activity.id, at });
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
            : 'failed'
          : 'success';
        const call = record.calls.settle(callId, status);
        if (call === undefined) return;
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
        const callId = asString(recordOf(data, 'callId'));
        const turn = asNumber(recordOf(data, 'turn'));
        const step = asNumber(recordOf(data, 'step'));
        record.metrics.approvals += 1;
        /*
         * The waterfall side already saw this ask and left a placeholder row keyed
         * by callId; this durable event names the real id. Adopting "the first
         * running bridge row" renamed the wrong row whenever two asks were in
         * flight, so the match is on callId now. When the event carries no callId
         * there is nothing to attribute and the old first-match fallback stays.
         */
        const bridgeIndex = record.activities.findIndex((row) => {
          if (row.category !== 'approval' || row.status !== 'running') return false;
          if (!row.id.startsWith('bridge:')) return false;
          return callId === undefined ? true : row.callId === callId;
        });
        const adopted = bridgeIndex >= 0 ? record.activities[bridgeIndex] : undefined;
        if (adopted !== undefined) {
          record.activities[bridgeIndex] = {
            ...adopted,
            id: approvalId,
            ...(callId === undefined ? {} : { callId }),
            ...(turn === undefined ? {} : { turn }),
            ...(step === undefined ? {} : { step }),
          };
        } else {
          this.pushActivity(record, approvalActivity(epoch, approvalId, sessionId, toolName, { turn, step, callId }));
        }
        // The placeholder's id leaves the blocking set as the real one enters it,
        // so the count of outstanding asks stays honest.
        if (adopted !== undefined) {
          applyEvent(record.machine, { kind: 'approval-decided', id: adopted.id, at });
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
        applyEvent(record.machine, { kind: 'approval-decided', ...(approvalId === undefined ? {} : { id: approvalId }), at });
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
        this.closeStreamRows(record, epoch);
        if (recordOf(data, 'interrupted') !== true) {
          this.touch(record, at);
          return;
        }
        applyEvent(record.machine, { kind: 'interrupted', at });
        this.touch(record, at);
        return;
      }

      case 'turn/end': {
        const record = this.ensure(sessionId);
        const reason = turnEndKindOf(asString(recordOf(recordOf(data, 'reason'), 'kind')));
        const drained = drainStatusOf(reason);
        for (const call of record.calls.drain(drained)) {
          this.settleRow(record, call.callId, drained, epoch);
        }
        this.closeStreamRows(record, epoch);
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
      default:
        return 'failed';
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
    /*
     * A frame must prove it belongs to the live Turn. DSH's delta variants carry
     * no Turn at all, so the only usable evidence is that the machine still has a
     * Turn open — otherwise a frame still in flight when the Turn ended would
     * push `completed` / `interrupted` / `error` back to `responding`.
     */
    if (signal.turn === undefined) {
      if (!record.machine.running) return;
    } else if (record.machine.lastClosedTurn !== undefined && signal.turn <= record.machine.lastClosedTurn) {
      return;
    } else if (record.machine.turn !== undefined && signal.turn < record.machine.turn) {
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
    if (!record.activities.some((row) => row.id === id)) {
      this.pushActivity(record, approvalActivity(epoch, id, sessionId, toolName, { callId }));
    }
    applyEvent(record.machine, { kind: 'approval-asked', id, at });
    this.touch(record, at);
  }

  /**
   * Observe a `user-questions/request`.
   *
   * The Agent is blocked on the human, exactly like an approval, so the published
   * state is the same `waiting` — but the HUD must not tell the user to approve
   * something that is really a question. Only the Agent and the call id are read;
   * the questions themselves are user-facing content and never reach the DTO.
   *
   * `settled` runs when the waterfall resolves or rejects. It looks the record up
   * instead of creating one, so an answer arriving after the Session was evicted
   * cannot resurrect it.
   */
  handleQuestion(sessionId: string, toolName?: string, callId?: string): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const record = this.ensure(sessionId);
    const epoch = this.clock();
    const at = this.mono();
    const id = callId === undefined ? this.nextId('question') : `question:${callId}`;
    if (!record.activities.some((row) => row.id === id)) {
      this.pushActivity(record, questionActivity(epoch, id, sessionId, toolName, {
        callId,
        ...(record.machine.turn === undefined ? {} : { turn: record.machine.turn }),
        ...(record.machine.step === undefined ? {} : { step: record.machine.step }),
      }));
    }
    applyEvent(record.machine, { kind: 'question-asked', id, at });
    this.touch(record, at);
  }

  /**
   * The question was answered, declined or cancelled: drop that one block.
   *
   * `callId` names which ask settled. Without it the newest open ask is settled,
   * which is the best a caller that only saw "something finished" can do.
   */
  handleQuestionSettled(sessionId: string, callId?: string): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const record = this.records.get(sessionId);
    if (record === undefined) return;
    const at = this.mono();
    const id = callId === undefined
      ? record.machine.questionIds[record.machine.questionIds.length - 1]
      : `question:${callId}`;
    if (id !== undefined) this.settleRow(record, id, 'success', this.clock());
    applyEvent(record.machine, { kind: 'question-settled', ...(id === undefined ? {} : { id }), at });
    this.touch(record, at);
  }

  handleError(sessionId: string, code?: string): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const record = this.ensure(sessionId);
    const epoch = this.clock();
    const at = this.mono();
    /*
     * Every in-flight tool is dead, and the state machine has to be told.
     * Draining the registry alone left `machine.openTools` still holding those
     * ids, so the moment the error hold expired `computeState` fell through to
     * `openTools.length > 0` and the panel went back to `executing` with a
     * non-zero `activeTools` — for a turn that had already failed. The expiry
     * path in `tick()` has always emitted one `tool-end` per drained call; this
     * is the same bookkeeping, for the same reason.
     */
    for (const call of record.calls.drain('failed')) {
      this.settleRow(record, call.callId, 'failed', epoch);
      applyEvent(record.machine, { kind: 'tool-end', id: call.callId, at });
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
    this.records.delete(sessionId);
    if (this.lastTouched === sessionId) this.lastTouched = undefined;
    this.queueNotify();
  }

  /** Expire held states, silence buckets and stale calls. */
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
      /*
       * Deliberately no `hasPendingHold` fast path here.
       *
       * That predicate answers "could a tick still change something", and it
       * returns `false` in exactly the tick where a hold expires — which is the
       * one tick where the stored `completed` / `error` / `interrupted` label
       * has to fall back to `idle`. Skipping it there left the record parked on
       * the held label with no version bump and no notification, while
       * `snapshot()` recomputed `idle` on read: the server reported idle and
       * every SSE client stayed on 「已完成」 until some unrelated event happened.
       * Recomputation is a handful of comparisons, so the fast path bought
       * nothing but that blind spot.
       */
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

  /**
   * Build the Task Context for one record.
   *
   * Exposed separately so a Client can be served a context without a full
   * snapshot (diagnostics), and so tests can assert on it directly.
   */
  taskContext(sessionId?: string | null): OrbitTaskContext {
    const resolved = this.resolveSession(sessionId);
    const record = resolved === undefined ? undefined : this.records.get(resolved);
    if (record === undefined) return emptyTaskContext(this.clock());

    const at = this.mono();
    /* The Agent is blocked on the human when either ask is outstanding; which one
     * it is changes the wording, never the state. */
    const waiting = record.machine.approvalIds.length > 0
      ? 'approval'
      : record.machine.questionIds.length > 0
        ? 'question'
        : undefined;
    const silenceInput: SilenceInput = {
      ms: silenceOf(record.machine, at),
      activeTools: record.machine.openTools.length,
      waitingApproval: waiting !== undefined,
      waitingQuestion: waiting === 'question',
      responding: record.machine.phase === 'responding',
      turnOpen: record.machine.running,
    };
    return buildTaskContext({
      rows: record.activities,
      startedAt: record.metrics.startedAt,
      ...(record.title === undefined ? {} : { sessionTitle: record.title }),
      plan: record.plan,
      turnOpen: record.machine.running,
      responding: record.machine.phase === 'responding',
      waitingApproval: waiting !== undefined,
      waitingQuestion: waiting === 'question',
      silence: detectSilence(silenceInput),
    });
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
        task: emptyTaskContext(now),
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
      task: this.taskContext(record.sessionId),
      updatedAt: record.updatedAt,
      metrics: {
        ...record.metrics,
        // A Host reload loses the `turn/start` events that came before it, but the
        // machine still learns the real turn (and step) number from the events it
        // does see. Report the higher value so the counter can never claim fewer
        // turns than the Session is actually on — no number is invented, `turns`
        // is exact because DSH numbers turns sequentially from 1.
        turns: Math.max(record.metrics.turns, machine.turn ?? 0),
        steps: Math.max(record.metrics.steps, machine.step ?? 0),
      },
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
