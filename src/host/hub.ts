/**
 * Per-Session orbit state: the fold from DSH events to `OrbitSnapshot`.
 *
 * One `OrbitHub` lives for the lifetime of the plugin. It keeps a small LRU of
 * Session records (a Session's state never mixes with another's), normalizes
 * each DSH event through `normalize.ts`, drives the state machine, and notifies
 * subscribers so the SSE route can push a fresh snapshot.
 *
 * Nothing here is persisted: a Host restart starts from zero (spec §2.7).
 */
import {
  MAX_ACTIVITY_ROWS,
  type OrbitActivity,
  type OrbitMetrics,
  type OrbitSnapshot,
} from '../shared/protocol';
import {
  applyEvent,
  computeState,
  createMachine,
  hasPendingHold,
  type MachineState,
} from './state-machine';
import {
  approvalActivity,
  errorActivity,
  toolActivity,
  type ToolCallInput,
} from './normalize';

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
  now?: () => number;
}

interface OpenCall {
  id: string;
  startedAt: number;
}

interface SessionRecord {
  sessionId: string;
  machine: MachineState;
  /** Newest first. */
  activities: OrbitActivity[];
  open: Map<string, OpenCall>;
  metrics: OrbitMetrics;
  version: number;
  updatedAt: number;
}

function recordOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class OrbitHub {
  private readonly records = new Map<string, SessionRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly maxSessions: number;
  private readonly maxActivities: number;
  private readonly clock: () => number;
  private notifyQueued = false;
  private sequence = 0;
  private lastTouched: string | undefined;

  constructor(options: HubOptions = {}) {
    this.maxSessions = options.maxSessions ?? 8;
    this.maxActivities = options.maxActivities ?? MAX_ACTIVITY_ROWS;
    this.clock = options.now ?? (() => Date.now());
  }

  // ---------------------------------------------------------------- records

  private ensure(sessionId: string): SessionRecord {
    const existing = this.records.get(sessionId);
    if (existing !== undefined) return existing;
    const now = this.clock();
    const record: SessionRecord = {
      sessionId,
      machine: createMachine(now),
      activities: [],
      open: new Map(),
      metrics: { turns: 0, tools: 0, files: 0, startedAt: now },
      version: 1,
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
      this.records.delete(oldestId);
      if (this.lastTouched === oldestId) this.lastTouched = keep;
    }
  }

  /** Recompute the published state after a mutation and queue one notification. */
  private touch(record: SessionRecord, at: number): void {
    const next = computeState(record.machine, at);
    const changed = next !== record.machine.agentState;
    record.machine.agentState = next;
    record.machine.updatedAt = at;
    record.updatedAt = at;
    this.lastTouched = record.sessionId;
    if (!changed && record.version === 0) return;
    record.version += 1;
    this.queueNotify();
  }

  private queueNotify(): void {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          // A broken subscriber must never break event ingestion.
        }
      }
    });
  }

  private pushActivity(record: SessionRecord, activity: OrbitActivity): void {
    record.activities.unshift(activity);
    if (record.activities.length > this.maxActivities) {
      record.activities.length = this.maxActivities;
    }
  }

  private settleActivity(
    record: SessionRecord,
    callId: string,
    status: 'success' | 'error',
    at: number,
  ): OrbitActivity | undefined {
    const index = record.activities.findIndex((row) => row.id === callId && row.status === 'running');
    if (index < 0) return undefined;
    const current = record.activities[index];
    if (current === undefined) return undefined;
    const call = record.open.get(callId);
    const duration = Math.max(0, at - (call === undefined ? current.timestamp : call.startedAt));
    const settled: OrbitActivity = { ...current, status, duration };
    record.activities[index] = settled;
    record.open.delete(callId);
    return settled;
  }

  // ------------------------------------------------------------------ folds

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}:${this.sequence}`;
  }

  /** Fold one durable DSH Session event. Unknown event types are ignored. */
  handleSessionEvent(sessionId: string, event: SessionEventLike): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    if (typeof event !== 'object' || event === null) return;
    const at = asNumber(event.time) ?? this.clock();
    const data = event.data;

    switch (event.type) {
      case 'turn/start': {
        const record = this.ensure(sessionId);
        record.metrics.turns += 1;
        applyEvent(record.machine, { kind: 'turn-start', at });
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
        if (record.open.has(callId)) return;
        const input: ToolCallInput = { id: callId, rawName: name, argumentsJson, at };
        const activity = toolActivity(input);
        record.open.set(callId, { id: callId, startedAt: at });
        record.metrics.tools += 1;
        if (activity.type === 'file') record.metrics.files += 1;
        this.pushActivity(record, activity);
        // Any approval waiting on this call just resolved.
        for (const row of record.activities) {
          if (row.type === 'approval' && row.status === 'waiting') row.status = 'success';
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
        const isError = recordOf(message, 'isError') === true || recordOf(data, 'error') !== undefined;
        this.settleActivity(record, callId, isError ? 'error' : 'success', at);
        applyEvent(record.machine, { kind: 'tool-end', id: callId, at });
        this.touch(record, at);
        return;
      }

      case 'turn/end': {
        const record = this.ensure(sessionId);
        const reasonKind = asString(recordOf(recordOf(data, 'reason'), 'kind')) ?? 'other';
        const reason =
          reasonKind === 'completed'
            ? 'completed'
            : reasonKind === 'error'
              ? 'error'
              : reasonKind === 'aborted'
                ? 'aborted'
                : 'other';
        for (const call of record.open.values()) {
          this.settleActivity(record, call.id, reason === 'error' ? 'error' : 'success', at);
        }
        record.open.clear();
        applyEvent(record.machine, { kind: 'turn-end', reason, at });
        this.touch(record, at);
        return;
      }

      default:
        return;
    }
  }

  handleStatus(sessionId: string, status: 'idle' | 'running'): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const record = this.ensure(sessionId);
    const at = this.clock();
    applyEvent(record.machine, { kind: 'status', status, at });
    this.touch(record, at);
  }

  handleTurnStopping(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const record = this.ensure(sessionId);
    const at = this.clock();
    applyEvent(record.machine, { kind: 'turn-stopping', at });
    this.touch(record, at);
  }

  handleApproval(sessionId: string, toolName?: string): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const record = this.ensure(sessionId);
    const at = this.clock();
    this.pushActivity(record, approvalActivity(at, toolName, this.nextId('approval')));
    applyEvent(record.machine, { kind: 'approval', at });
    this.touch(record, at);
  }

  handleError(sessionId: string, code?: string): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const record = this.ensure(sessionId);
    const at = this.clock();
    this.pushActivity(record, errorActivity(at, code, this.nextId('error')));
    applyEvent(record.machine, { kind: 'error', at });
    this.touch(record, at);
  }

  /** Expire time-boxed states (`completed`, `error`). Cheap when nothing holds. */
  tick(): void {
    const at = this.clock();
    for (const record of this.records.values()) {
      if (!hasPendingHold(record.machine, at)) continue;
      const next = computeState(record.machine, at);
      if (next === record.machine.agentState) continue;
      record.machine.agentState = next;
      record.machine.waiting = record.machine.waiting && next === 'waiting';
      record.version += 1;
      record.updatedAt = at;
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
    if (typeof requested === 'string' && requested !== '') {
      return this.records.has(requested) ? requested : requested;
    }
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
        events: [],
        updatedAt: now,
        metrics: { turns: 0, tools: 0, files: 0, startedAt: now },
      };
    }
    const agentState = computeState(record.machine, now);
    return {
      version: record.version,
      sessionId: record.sessionId,
      agentState,
      activeTools: record.machine.openTools.length,
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
    this.listeners.clear();
    this.records.clear();
    this.lastTouched = undefined;
  }
}
