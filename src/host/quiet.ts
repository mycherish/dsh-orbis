/**
 * Quiet detection on a monotonic clock.
 *
 * Wall-clock time can jump (NTP correction, sleep/wake, manual change), so the
 * "how long has the Agent been silent" question is answered from
 * `performance.now()`-style monotonic milliseconds. `Date.now()` is used only
 * for the human-facing timestamps carried by activity rows.
 */
import {
  QUIET_AFTER_MS,
  QUIET_LEVEL2_MS,
  QUIET_LEVEL3_MS,
} from '../shared/protocol';

export type QuietLevel = 0 | 1 | 2 | 3;

/** Monotonic milliseconds; falls back to `Date.now()` where the API is absent. */
export function monotonicNow(): number {
  try {
    const perf = globalThis.performance;
    if (perf !== undefined && typeof perf.now === 'function') return perf.now();
  } catch {
    // Fall through to the wall clock.
  }
  return Date.now();
}

/**
 * Bucket one silence duration.
 *
 * 0 → under 10s (normal), 1 → 10–30s, 2 → 30–60s, 3 → over 60s. Negative or
 * non-finite input means "no silence": the Agent just produced an event.
 */
export function quietLevelOf(silenceMs: number): QuietLevel {
  if (typeof silenceMs !== 'number' || !Number.isFinite(silenceMs) || silenceMs < QUIET_AFTER_MS) return 0;
  if (silenceMs < QUIET_LEVEL2_MS) return 1;
  if (silenceMs < QUIET_LEVEL3_MS) return 2;
  return 3;
}

/** True once silence should be surfaced as the `quiet` state. */
export function isQuiet(silenceMs: number): boolean {
  return quietLevelOf(silenceMs) > 0;
}

/**
 * Milliseconds until the next silence boundary, or `undefined` when no further
 * boundary can change anything (level 3 is terminal). A scheduler can use this
 * to arm exactly one timer instead of polling.
 */
export function msUntilNextQuietBoundary(silenceMs: number): number | undefined {
  const level = quietLevelOf(silenceMs);
  if (level === 3) return undefined;
  const next = level === 0 ? QUIET_AFTER_MS : level === 1 ? QUIET_LEVEL2_MS : QUIET_LEVEL3_MS;
  return Math.max(0, next - silenceMs);
}
