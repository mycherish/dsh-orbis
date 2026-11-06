import { describe, expect, it } from 'vitest';
import { OrbitHub, type SessionEventLike } from '../src/host/hub';
import { MAX_ACTIVITY_ROWS } from '../src/shared/protocol';

const T0 = 1_700_000_000_000;

function toolCall(seq: number, callId: string, name: string, args: string, time: number): SessionEventLike {
  return { type: 'tool/call', time, data: { turn: 1, step: 1, callId, name, arguments: args } };
}

function toolResult(callId: string, time: number, isError = false): SessionEventLike {
  return {
    type: 'tool/result',
    time,
    data: { turn: 1, step: 1, message: { toolCallId: callId, isError }, ...(isError ? { error: { name: 'E', code: 'E_BROKEN' } } : {}) },
  };
}

describe('hub fold', () => {
  it('creates a row on tool/call and settles it with a duration', () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleSessionEvent('s1', toolCall(1, 'c1', 'read', '{"file_path":"/tmp/a.md"}', T0 + 100));
    let snapshot = hub.snapshot('s1');
    expect(snapshot.sessionId).toBe('s1');
    expect(snapshot.agentState).toBe('executing');
    expect(snapshot.activeTools).toBe(1);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]?.status).toBe('running');
    expect(snapshot.events[0]?.target).toBe('a.md');

    hub.handleSessionEvent('s1', toolResult('c1', T0 + 600));
    snapshot = hub.snapshot('s1');
    expect(snapshot.activeTools).toBe(0);
    expect(snapshot.events[0]?.status).toBe('success');
    expect(snapshot.events[0]?.duration).toBe(500);
    expect(snapshot.metrics.tools).toBe(1);
    expect(snapshot.metrics.files).toBe(1);
  });

  it('marks a failed tool as error and keeps the state machine honest', () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleStatus('s1', 'running');
    hub.handleSessionEvent('s1', toolCall(1, 'c1', 'bash', '{"command":"false"}', T0 + 10));
    hub.handleSessionEvent('s1', toolResult('c1', T0 + 20, true));
    const snapshot = hub.snapshot('s1');
    expect(snapshot.events[0]?.status).toBe('error');
    expect(snapshot.agentState).toBe('thinking');
  });

  it('never mixes two Sessions', () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleSessionEvent('alpha', toolCall(1, 'a1', 'read', '{"file_path":"/x/one.md"}', T0 + 1));
    hub.handleSessionEvent('beta', toolCall(1, 'b1', 'write', '{"file_path":"/x/two.md"}', T0 + 2));

    const alpha = hub.snapshot('alpha');
    const beta = hub.snapshot('beta');
    expect(alpha.events.map((row) => row.id)).toEqual(['a1']);
    expect(beta.events.map((row) => row.id)).toEqual(['b1']);
    expect(alpha.events[0]?.target).toBe('one.md');
    expect(beta.events[0]?.target).toBe('two.md');
    expect(alpha.sessionId).toBe('alpha');
    expect(beta.sessionId).toBe('beta');
  });

  it('caps the activity list and keeps the newest row first', () => {
    const hub = new OrbitHub({ now: () => T0 });
    for (let index = 0; index < MAX_ACTIVITY_ROWS + 12; index += 1) {
      hub.handleSessionEvent('s1', toolCall(index, `c${index}`, 'grep', '{"pattern":"x"}', T0 + index));
    }
    const snapshot = hub.snapshot('s1');
    expect(snapshot.events).toHaveLength(MAX_ACTIVITY_ROWS);
    expect(snapshot.events[0]?.id).toBe(`c${MAX_ACTIVITY_ROWS + 11}`);
  });

  it('evicts the least recently updated Session beyond maxSessions', () => {
    const hub = new OrbitHub({ maxSessions: 2, now: () => T0 });
    hub.handleSessionEvent('old', toolCall(1, 'c1', 'read', '{}', T0));
    hub.handleSessionEvent('mid', toolCall(1, 'c2', 'read', '{}', T0 + 10));
    hub.handleSessionEvent('new', toolCall(1, 'c3', 'read', '{}', T0 + 20));

    expect(hub.sessionIds()).toContain('new');
    expect(hub.sessionIds()).not.toContain('old');
    expect(hub.sessionIds()).toHaveLength(2);
  });

  it('exposes completed and error holds, then expires them on tick', () => {
    let now = T0;
    const hub = new OrbitHub({ now: () => now });
    hub.handleStatus('s1', 'running');
    hub.handleTurnStopping('s1');
    expect(hub.snapshot('s1').agentState).toBe('completed');
    hub.handleStatus('s1', 'idle');

    now = T0 + 3000;
    hub.tick();
    expect(hub.snapshot('s1').agentState).toBe('idle');

    hub.handleError('s1', 'QUOTA');
    expect(hub.snapshot('s1').agentState).toBe('error');
    expect(hub.snapshot('s1').events[0]?.name).toBe('QUOTA');
    now = T0 + 9000;
    hub.tick();
    expect(hub.snapshot('s1').agentState).toBe('idle');
  });

  it('records approvals and resolves them when the gated tool starts', () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleStatus('s1', 'running');
    hub.handleApproval('s1', 'bash');
    let snapshot = hub.snapshot('s1');
    expect(snapshot.agentState).toBe('waiting');
    expect(snapshot.events[0]?.type).toBe('approval');

    hub.handleSessionEvent('s1', toolCall(1, 'c1', 'bash', '{"command":"ls"}', T0 + 5));
    snapshot = hub.snapshot('s1');
    expect(snapshot.agentState).toBe('executing');
    expect(snapshot.events.find((row) => row.type === 'approval')?.status).toBe('success');
  });

  it('bumps version on change and notifies subscribers', async () => {
    const hub = new OrbitHub({ now: () => T0 });
    let calls = 0;
    const off = hub.subscribe(() => {
      calls += 1;
    });
    hub.handleStatus('s1', 'running');
    await Promise.resolve();
    expect(calls).toBeGreaterThan(0);

    const first = hub.snapshot('s1').version;
    hub.handleStatus('s1', 'idle');
    await Promise.resolve();
    expect(hub.snapshot('s1').version).toBeGreaterThan(first);
    off();
  });

  it('answers an unknown Session with an idle envelope instead of throwing', () => {
    const hub = new OrbitHub({ now: () => T0 });
    const snapshot = hub.snapshot('never-seen');
    expect(snapshot.sessionId).toBeUndefined();
    expect(snapshot.agentState).toBe('idle');
    expect(snapshot.events).toEqual([]);
    expect(snapshot.version).toBe(0);
  });

  it('ignores malformed events without breaking later ones', () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleSessionEvent('s1', { type: 'tool/call', time: T0, data: null });
    hub.handleSessionEvent('s1', { type: 'turn/start', time: T0 + 1, data: { turn: 1 } });
    hub.handleSessionEvent('s1', { type: 'mystery/event', time: T0 + 2, data: {} });
    const snapshot = hub.snapshot('s1');
    expect(snapshot.metrics.turns).toBe(1);
    expect(snapshot.events).toEqual([]);
  });
});
