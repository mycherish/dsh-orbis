/**
 * Call correlation.
 *
 * DSH identifies a tool call by `callId`; the Client must never match calls by
 * arrival order (FIFO), because:
 *  - two parallel calls may settle in the reverse order they started;
 *  - a `tool/result` can be observed before its `tool/call` when a recovery
 *    path replays results;
 *  - a duplicate append can deliver the same id twice;
 *  - a call can be orphaned forever when its turn is aborted or the Agent is
 *    disposed.
 *
 * This registry is the single owner of that bookkeeping. It stores only ids,
 * timings and the already-normalized label — never arguments or output.
 */

export interface CallMeta {
  /** DSH `tool/call.callId`. */
  callId: string;
  /** Raw tool name; used by the caller for classification, kept here for labels. */
  name: string;
  turn?: number;
  step?: number;
  /** Echoed through so the caller can build the activity row. */
  at: number;
}

export interface RunningCall extends CallMeta {
  /** Monotonic start instant. */
  startedAt: number;
}

export type SettledStatus = 'success' | 'error' | 'cancelled';

export type StartOutcome =
  /** A genuinely new call: create the running row. */
  | { kind: 'new'; call: RunningCall }
  /** The same `callId` was already open: ignore the duplicate. */
  | { kind: 'duplicate' }
  /** The result arrived first; the caller must create a row already settled. */
  | { kind: 'pre-settled'; status: SettledStatus }
  /** The call was already opened and settled: ignore the late repeat. */
  | { kind: 'already-settled'; status: SettledStatus };

export interface CallRegistryOptions {
  /** Max remembered early results (results whose call has not been seen yet). */
  maxEarly?: number;
  /** How many settled ids are remembered to swallow duplicates. */
  maxSettled?: number;
}

const DEFAULT_MAX_EARLY = 32;
const DEFAULT_MAX_SETTLED = 128;

export class CallRegistry {
  private readonly open = new Map<string, RunningCall>();
  private readonly early = new Map<string, SettledStatus>();
  private readonly settled = new Map<string, SettledStatus>();
  private readonly maxEarly: number;
  private readonly maxSettled: number;

  constructor(options: CallRegistryOptions = {}) {
    this.maxEarly = Math.max(1, options.maxEarly ?? DEFAULT_MAX_EARLY);
    this.maxSettled = Math.max(1, options.maxSettled ?? DEFAULT_MAX_SETTLED);
  }

  /** Remember a bounded map with first-in/first-out eviction. */
  private static remember<T>(map: Map<string, T>, key: string, value: T, cap: number): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > cap) {
      const oldest = map.keys().next();
      if (oldest.done === true) return;
      map.delete(oldest.value);
    }
  }

  /** Register a started call. Idempotent per `callId`. */
  start(meta: CallMeta, startedAt: number = meta.at): StartOutcome {
    const { callId } = meta;
    if (callId === '') return { kind: 'duplicate' };
    const already = this.settled.get(callId);
    if (already !== undefined) return { kind: 'already-settled', status: already };
    if (this.open.has(callId)) return { kind: 'duplicate' };
    const early = this.early.get(callId);
    if (early !== undefined) {
      this.early.delete(callId);
      CallRegistry.remember(this.settled, callId, early, this.maxSettled);
      return { kind: 'pre-settled', status: early };
    }
    const call: RunningCall = { ...meta, startedAt };
    this.open.set(callId, call);
    return { kind: 'new', call };
  }

  /**
   * Settle a call. Returns the running record when one was open, or `undefined`
   * when the call is unknown (the result is then remembered for a late call) or
   * already settled (duplicate result).
   */
  settle(callId: string, status: SettledStatus): RunningCall | undefined {
    if (callId === '') return undefined;
    const call = this.open.get(callId);
    if (call !== undefined) {
      this.open.delete(callId);
      CallRegistry.remember(this.settled, callId, status, this.maxSettled);
      return call;
    }
    if (this.settled.has(callId)) return undefined;
    CallRegistry.remember(this.early, callId, status, this.maxEarly);
    return undefined;
  }

  /** Every call still open, in start order. */
  running(): RunningCall[] {
    return [...this.open.values()];
  }

  /** True when at least one call is open. */
  get size(): number {
    return this.open.size;
  }

  /**
   * Settle calls that outlived `timeoutMs`. Returns what was closed so the
   * caller can settle their rows; an orphaned call must not stay `running`
   * forever, which would pin the Agent to `executing`.
   */
  expire(now: number, timeoutMs: number, status: SettledStatus = 'cancelled'): RunningCall[] {
    const expired: RunningCall[] = [];
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return expired;
    for (const [callId, call] of this.open) {
      if (now - call.startedAt < timeoutMs) continue;
      this.open.delete(callId);
      CallRegistry.remember(this.settled, callId, status, this.maxSettled);
      expired.push(call);
    }
    return expired;
  }

  /**
   * Close every open call — used when a Turn ends, an Agent errors, or a
   * Session is disposed. Returns the closed records so rows can be settled.
   */
  drain(status: SettledStatus): RunningCall[] {
    const closed = [...this.open.values()];
    for (const call of closed) {
      CallRegistry.remember(this.settled, call.callId, status, this.maxSettled);
    }
    this.open.clear();
    return closed;
  }

  clear(): void {
    this.open.clear();
    this.early.clear();
    this.settled.clear();
  }
}
