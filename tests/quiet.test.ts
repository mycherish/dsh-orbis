import { describe, expect, it } from 'vitest';
import { isQuiet, msUntilNextQuietBoundary, monotonicNow, quietLevelOf } from '../src/host/quiet';

describe('quiet levels', () => {
  it('buckets silence into the four documented windows', () => {
    expect(quietLevelOf(0)).toBe(0);
    expect(quietLevelOf(9_999)).toBe(0);
    expect(quietLevelOf(10_000)).toBe(1);
    expect(quietLevelOf(29_999)).toBe(1);
    expect(quietLevelOf(30_000)).toBe(2);
    expect(quietLevelOf(59_999)).toBe(2);
    expect(quietLevelOf(60_000)).toBe(3);
    expect(quietLevelOf(600_000)).toBe(3);
  });

  it('treats junk as "no silence" instead of crashing', () => {
    expect(quietLevelOf(Number.NaN)).toBe(0);
    expect(quietLevelOf(Number.POSITIVE_INFINITY)).toBe(0);
    expect(quietLevelOf(-5)).toBe(0);
  });

  it('is quiet only from ten seconds on', () => {
    expect(isQuiet(9_999)).toBe(false);
    expect(isQuiet(10_000)).toBe(true);
  });

  it('arms the next boundary', () => {
    expect(msUntilNextQuietBoundary(0)).toBe(10_000);
    expect(msUntilNextQuietBoundary(12_000)).toBe(18_000);
    expect(msUntilNextQuietBoundary(45_000)).toBe(15_000);
    expect(msUntilNextQuietBoundary(90_000)).toBeUndefined();
  });

  it('exposes a monotonic clock that only moves forward', async () => {
    const first = monotonicNow();
    await Promise.resolve();
    const second = monotonicNow();
    expect(typeof first).toBe('number');
    expect(Number.isFinite(first)).toBe(true);
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
