import { describe, expect, it } from 'vitest';
import { phaseOfSignal, streamSignalOf } from '../src/host/stream';

describe('assistant-stream folding', () => {
  it('reads the opening and closing frames', () => {
    expect(streamSignalOf({ type: 'start', attemptId: 'a', revision: 1, turn: 2, step: 3 }))
      .toEqual({ kind: 'attempt-start', turn: 2, step: 3 });
    expect(streamSignalOf({ type: 'end', attemptId: 'a', revision: 9, outcome: { kind: 'abandoned' } }))
      .toEqual({ kind: 'attempt-end', turn: undefined, step: undefined });
  });

  it('maps chunk types to phases without touching their content', () => {
    const reasoning = streamSignalOf({
      type: 'chunk',
      chunk: { type: 'reasoning-delta', index: 0, text: 'SECRET-CHAIN-OF-THOUGHT' },
    });
    expect(reasoning?.kind).toBe('reasoning');
    expect(JSON.stringify(reasoning)).not.toContain('SECRET');

    expect(streamSignalOf({ type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'hello' } })?.kind)
      .toBe('text');
    expect(streamSignalOf({
      type: 'chunk',
      chunk: { type: 'tool-call-delta', index: 0, id: 'c1', name: 'bash', argumentsDelta: '{"command":"rm -rf /"}' },
    })?.kind).toBe('tool-call');
    expect(streamSignalOf({ type: 'chunk', chunk: { type: 'finish', reason: 'stop' } })?.kind).toBe('finish');
  });

  it('ignores frames that say nothing about progress', () => {
    expect(streamSignalOf({ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1 } } })).toBeUndefined();
    expect(streamSignalOf({ type: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text' } } }))
      .toBeUndefined();
    expect(streamSignalOf({ type: 'mystery' })).toBeUndefined();
    expect(streamSignalOf(null)).toBeUndefined();
    expect(streamSignalOf('nope')).toBeUndefined();
    expect(streamSignalOf({ type: 'chunk' })).toBeUndefined();
  });

  it('never lets a delta body reach the signal object', () => {
    const signal = streamSignalOf({
      type: 'chunk',
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'user secret' },
    });
    expect(signal).toEqual({ kind: 'text', turn: 1, step: 1 });
    expect(Object.keys(signal ?? {})).toEqual(['kind', 'turn', 'step']);
  });

  it('maps signals to machine phases', () => {
    expect(phaseOfSignal({ kind: 'attempt-start' })).toBe('thinking');
    expect(phaseOfSignal({ kind: 'reasoning' })).toBe('thinking');
    expect(phaseOfSignal({ kind: 'tool-call' })).toBe('preparing');
    expect(phaseOfSignal({ kind: 'text' })).toBe('responding');
    expect(phaseOfSignal({ kind: 'finish' })).toBeUndefined();
    expect(phaseOfSignal({ kind: 'attempt-end' })).toBeUndefined();
  });
});
