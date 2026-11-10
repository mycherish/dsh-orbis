/**
 * The production clock pair.
 *
 * The Hub takes two clocks and they are not interchangeable: durations (silence
 * buckets, hold expiry, the orphan-call timeout) must come from a monotonic
 * source, while the timestamps a human reads are wall-clock. For a long time both
 * were `Date.now()`, because `monotonicNow()` was written for the job and then
 * never wired in — a change nobody can see from the outside, which is why this
 * file exists as its own module: it has to replace the helper to observe it.
 *
 * Kept separate from `hub.test.ts` on purpose. The `vi.mock` below is file-wide,
 * and the rest of the suite drives the Hub with an injected fake timeline (`now`
 * and `mono` both set), which never reaches the default path this file is about.
 */
import { describe, expect, it, vi } from 'vitest';

const clock = vi.hoisted(() => ({ mono: 1_000 }));

vi.mock('../src/host/context/silence-detector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/context/silence-detector')>();
  return { ...actual, monotonicNow: () => clock.mono };
});

const { OrbitHub } = await import('../src/host/hub');

describe('production clocks', () => {
  it('reads durations from the monotonic helper when nothing is injected', () => {
    // Exactly how `src/host/index.ts` builds it: no options at all.
    const hub = new OrbitHub();
    hub.handleStatus('s1', 'running');

    clock.mono = 31_000; // thirty seconds on the process clock
    expect(hub.snapshot('s1').silenceMs).toBe(30_000);
    expect(hub.snapshot('s1').agentState).toBe('quiet');

    hub.dispose();
  });

  it('keeps the human-facing timestamp on the wall clock', () => {
    const hub = new OrbitHub();
    hub.handleStatus('s1', 'running');
    const snapshot = hub.snapshot('s1');

    // The monotonic clock is 1_000 here; `updatedAt` has to look like an instant
    // a person could read, not like "a second after boot".
    expect(snapshot.updatedAt).toBeGreaterThan(1_000_000_000_000);
    expect(snapshot.silenceMs).toBe(0);

    hub.dispose();
  });
});
