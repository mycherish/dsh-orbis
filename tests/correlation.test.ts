import { describe, expect, it } from 'vitest';
import { CallRegistry } from '../src/host/correlation';

function meta(callId: string, at = 0) {
  return { callId, name: 'read', turn: 1, step: 1, at };
}

describe('call correlation', () => {
  it('opens a call once and ignores a duplicate start', () => {
    const calls = new CallRegistry();
    const first = calls.start(meta('c1'), 10);
    expect(first.kind).toBe('new');
    expect(calls.size).toBe(1);

    const second = calls.start(meta('c1'), 20);
    expect(second.kind).toBe('duplicate');
    expect(calls.size).toBe(1);
    expect(calls.running()[0]?.startedAt).toBe(10);
  });

  it('settles in arrival order independent of start order', () => {
    const calls = new CallRegistry();
    calls.start(meta('a'), 1);
    calls.start(meta('b'), 2);

    // `b` finishes first: correlation is by id, not by FIFO.
    expect(calls.settle('b', 'success')?.callId).toBe('b');
    expect(calls.running().map((call) => call.callId)).toEqual(['a']);
    expect(calls.settle('a', 'failed')?.callId).toBe('a');
    expect(calls.size).toBe(0);
  });

  it('remembers a result that arrives before its call', () => {
    const calls = new CallRegistry();
    expect(calls.settle('c9', 'failed')).toBeUndefined();

    const outcome = calls.start(meta('c9'), 5);
    expect(outcome).toEqual({ kind: 'pre-settled', status: 'failed' });
    expect(calls.size).toBe(0);
  });

  it('swallows a duplicate result and a late duplicate call', () => {
    const calls = new CallRegistry();
    calls.start(meta('c1'), 0);
    expect(calls.settle('c1', 'success')).toBeDefined();
    expect(calls.settle('c1', 'success')).toBeUndefined();
    expect(calls.start(meta('c1'), 10)).toEqual({ kind: 'already-settled', status: 'success' });
  });

  it('bounds the remembered early results', () => {
    const calls = new CallRegistry({ maxEarly: 2 });
    for (let index = 0; index < 10; index += 1) calls.settle(`early-${index}`, 'success');
    // The two newest survive; the oldest was evicted and starts fresh.
    expect(calls.start(meta('early-9'), 0).kind).toBe('pre-settled');
    expect(calls.start(meta('early-0'), 0).kind).toBe('new');
  });

  it('drains every open call when a turn ends', () => {
    const calls = new CallRegistry();
    calls.start(meta('a'), 1);
    calls.start(meta('b'), 2);
    const drained = calls.drain('cancelled');
    expect(drained.map((call) => call.callId).sort()).toEqual(['a', 'b']);
    expect(calls.size).toBe(0);
    // Drained ids are remembered, so a late result cannot resurrect them.
    expect(calls.settle('a', 'success')).toBeUndefined();
  });

  it('expires only calls past the timeout', () => {
    const calls = new CallRegistry();
    calls.start(meta('old'), 0);
    calls.start(meta('fresh'), 950);

    const expired = calls.expire(1000, 100);
    expect(expired.map((call) => call.callId)).toEqual(['old']);
    expect(calls.running().map((call) => call.callId)).toEqual(['fresh']);
  });

  it('treats a non-positive timeout as "never expire"', () => {
    const calls = new CallRegistry();
    calls.start(meta('a'), 0);
    expect(calls.expire(1_000_000, 0)).toEqual([]);
    expect(calls.size).toBe(1);
  });

  it('rejects an empty id instead of bookkeeping it', () => {
    const calls = new CallRegistry();
    expect(calls.start(meta(''), 0).kind).toBe('duplicate');
    expect(calls.settle('', 'success')).toBeUndefined();
    expect(calls.size).toBe(0);
  });

  it('clear forgets everything', () => {
    const calls = new CallRegistry();
    calls.start(meta('a'), 0);
    calls.settle('b', 'success');
    calls.clear();
    expect(calls.size).toBe(0);
    expect(calls.start(meta('a'), 0).kind).toBe('new');
    expect(calls.start(meta('b'), 0).kind).toBe('new');
  });
});
