import { describe, expect, it } from 'vitest';
import { OrbitHub, type SessionEventLike } from '../src/host/hub';
import { MAX_ACTIVITY_ROWS } from '../src/shared/protocol';
import { TASK_TITLE_FALLBACK } from '../src/shared/task-context-types';

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
    expect(snapshot.events[0]?.safeTarget).toBe('a.md');

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
    expect(snapshot.events[0]?.status).toBe('failed');
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
    expect(alpha.events[0]?.safeTarget).toBe('one.md');
    expect(beta.events[0]?.safeTarget).toBe('two.md');
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
    expect(hub.snapshot('s1').events[0]?.label).toBe('QUOTA');
    now = T0 + 9000;
    hub.tick();
    expect(hub.snapshot('s1').agentState).toBe('idle');
  });

  it('records approvals and resolves them when the gated tool starts', () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleStatus('s1', 'running');
    hub.handleApproval('s1', 'bash', 'c1');
    let snapshot = hub.snapshot('s1');
    expect(snapshot.agentState).toBe('waiting');
    expect(snapshot.events[0]?.category).toBe('approval');

    hub.handleSessionEvent('s1', toolCall(1, 'c1', 'bash', '{"command":"ls"}', T0 + 5));
    snapshot = hub.snapshot('s1');
    expect(snapshot.agentState).toBe('executing');
    expect(snapshot.events.find((row) => row.category === 'approval')?.status).toBe('success');
  });

  /*
   * Two asks can be outstanding at once. Settling every running approval row when
   * *any* tool starts reported one of them as "allowed" although nobody approved it.
   */
  it('settles only the approval that belongs to the tool that started', () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleStatus('s1', 'running');
    hub.handleApproval('s1', 'bash', 'c1');
    hub.handleApproval('s1', 'write', 'c2');

    hub.handleSessionEvent('s1', toolCall(1, 'c1', 'bash', '{"command":"ls"}', T0 + 5));

    const approvals = hub.snapshot('s1').events.filter((row) => row.category === 'approval');
    const statusOf = new Map(approvals.map((row) => [row.callId, row.status]));
    expect(statusOf.get('c1')).toBe('success');
    expect(statusOf.get('c2')).toBe('running');
  });

  /*
   * DSH's delta frames carry no Turn, so "is this frame current?" can only be
   * answered by the machine. Without this guard a frame still in flight when the
   * Turn ended pushed `completed` back to `responding` one frame later.
   */
  it('does not let an in-flight stream frame revive a closed Turn', () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleStatus('s1', 'running');
    hub.handleSessionEvent('s1', { type: 'turn/start', time: T0, data: { turn: 3 } });
    hub.handleSessionEvent('s1', {
      type: 'turn/end',
      time: T0 + 10,
      data: { turn: 3, reason: { kind: 'completed' } },
    });
    expect(hub.snapshot('s1').agentState).toBe('completed');

    // A delta frame with no Turn at all.
    hub.handleStream('s1', { type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: T0 + 11, chunk: { type: 'text-delta' } });
    expect(hub.snapshot('s1').agentState).toBe('completed');

    // A frame still tagged with the Turn that already closed.
    hub.handleStream('s1', { type: 'start', turn: 3, step: 1 });
    expect(hub.snapshot('s1').agentState).toBe('completed');

    // An `end` frame from the same attempt.
    hub.handleStream('s1', { type: 'end', attemptId: 'a' });
    expect(hub.snapshot('s1').agentState).toBe('completed');
  });

  /*
   * A question is the Agent blocked on the human, exactly like an approval — but
   * the plugin used to not listen for it at all, so the HUD kept saying the Agent
   * was executing while it was really waiting for an answer.
   */
  it('reports a question as waiting for an answer, not for an approval', () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleStatus('s1', 'running');
    hub.handleQuestion('s1', 'ask_user_question', 'c9');

    let snapshot = hub.snapshot('s1');
    expect(snapshot.agentState).toBe('waiting');
    expect(snapshot.task.waitingReason).toBe('question');
    expect(snapshot.task.phaseLabel).toBe('等待回答');
    expect(snapshot.events[0]?.label).toBe('等待你回答');
    expect(snapshot.events[0]?.category).toBe('approval');

    hub.handleQuestionSettled('s1');
    snapshot = hub.snapshot('s1');
    expect(snapshot.agentState).not.toBe('waiting');
    expect(snapshot.task.waitingReason).toBeUndefined();
  });

  it('keeps waiting while either an approval or a question is still open', () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleStatus('s1', 'running');
    hub.handleApproval('s1', 'bash', 'c1');
    hub.handleQuestion('s1', 'ask_user_question', 'c9');
    expect(hub.snapshot('s1').agentState).toBe('waiting');
    expect(hub.snapshot('s1').task.waitingReason).toBe('approval');

    // Answering the question must not clear the approval that is still pending.
    hub.handleQuestionSettled('s1');
    expect(hub.snapshot('s1').agentState).toBe('waiting');
    expect(hub.snapshot('s1').task.waitingReason).toBe('approval');
  });

  it('never carries the question text into the snapshot', () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleStatus('s1', 'running');
    hub.handleQuestion('s1', 'ask_user_question', 'c9');
    // Even the tool name is clipped, and nothing else is ever passed in.
    expect(JSON.stringify(hub.snapshot('s1'))).not.toContain('SECRET');
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

describe('hub v2: correlation, streams, approvals, quiet', () => {
  /** A hub whose two clocks are the same injectable value, like production. */
  function makeHub(start = T0) {
    let mono = start;
    let epoch = start;
    const hub = new OrbitHub({ now: () => epoch, mono: () => mono });
    return {
      hub,
      advance(ms: number) {
        mono += ms;
        epoch += ms;
      },
      at: () => mono,
    };
  }

  it('settles a result that arrives before its call, without an active tool', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', toolResult('c1', T0 + 10));
    hub.handleSessionEvent('s1', toolCall(1, 'c1', 'read', '{"file_path":"/x/a.md"}', T0));
    const snapshot = hub.snapshot('s1');
    expect(snapshot.activeTools).toBe(0);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]?.status).toBe('success');
  });

  it('ignores a duplicated tool/call and a duplicated tool/result', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', toolCall(1, 'c1', 'read', '{}', T0));
    hub.handleSessionEvent('s1', toolCall(1, 'c1', 'read', '{}', T0 + 1));
    hub.handleSessionEvent('s1', toolResult('c1', T0 + 2));
    hub.handleSessionEvent('s1', toolResult('c1', T0 + 3));
    const snapshot = hub.snapshot('s1');
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.metrics.tools).toBe(1);
    expect(snapshot.activeTools).toBe(0);
  });

  it('settles calls out of order by id', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', toolCall(1, 'slow', 'bash', '{}', T0));
    hub.handleSessionEvent('s1', toolCall(2, 'fast', 'read', '{}', T0 + 1));
    hub.handleSessionEvent('s1', toolResult('fast', T0 + 2));
    let snapshot = hub.snapshot('s1');
    expect(snapshot.activeTools).toBe(1);
    expect(snapshot.events.find((row) => row.id === 'fast')?.status).toBe('success');
    expect(snapshot.events.find((row) => row.id === 'slow')?.status).toBe('running');

    hub.handleSessionEvent('s1', toolResult('slow', T0 + 3, true));
    snapshot = hub.snapshot('s1');
    expect(snapshot.activeTools).toBe(0);
    expect(snapshot.events.find((row) => row.id === 'slow')?.status).toBe('failed');
  });

  it('expires an orphaned call instead of pinning the Agent to executing', () => {
    const clock = makeHub();
    clock.hub.handleSessionEvent('s1', toolCall(1, 'lost', 'bash', '{}', T0));
    expect(clock.hub.snapshot('s1').agentState).toBe('executing');

    clock.advance(5_000);
    clock.hub.tick();
    expect(clock.hub.snapshot('s1').agentState).toBe('executing');

    clock.advance(10 * 60_000);
    const expired = new OrbitHub({ now: () => T0, mono: () => T0 + 11 * 60_000 });
    expect(expired).toBeDefined();
    clock.hub.tick();
    const snapshot = clock.hub.snapshot('s1');
    expect(snapshot.activeTools).toBe(0);
    expect(snapshot.events[0]?.status).toBe('cancelled');
  });

  it('adopts the waterfall bridge row when approval/asked arrives', () => {
    const { hub } = makeHub();
    hub.handleStatus('s1', 'running');
    hub.handleApproval('s1', 'bash', 'call-9');
    hub.handleSessionEvent('s1', {
      type: 'approval/asked',
      time: T0 + 5,
      data: { id: 'ap-1', toolName: 'bash', callId: 'call-9' },
    });
    let snapshot = hub.snapshot('s1');
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]?.id).toBe('ap-1');
    expect(snapshot.agentState).toBe('waiting');
    expect(snapshot.metrics.approvals).toBe(1);

    hub.handleSessionEvent('s1', {
      type: 'approval/decided',
      time: T0 + 9,
      data: { id: 'ap-1', outcome: 'rejected' },
    });
    snapshot = hub.snapshot('s1');
    expect(snapshot.events[0]?.status).toBe('failed');
    expect(snapshot.agentState).not.toBe('waiting');
  });

  it('records an unattached approval as its own row', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', {
      type: 'approval/asked',
      time: T0,
      data: { id: 'ap-2', toolName: 'write' },
    });
    expect(hub.snapshot('s1').events).toHaveLength(1);
    expect(hub.snapshot('s1').agentState).toBe('waiting');
  });

  it('maps approval outcomes to row statuses', () => {
    const { hub } = makeHub();
    const cases: Array<[string, string]> = [
      ['allowed-once', 'success'],
      ['rejected', 'failed'],
      ['cancelled', 'cancelled'],
      ['unavailable', 'failed'],
    ];
    for (const [outcome, expected] of cases) {
      const id = `ap-${outcome}`;
      hub.handleSessionEvent('s1', { type: 'approval/asked', time: T0, data: { id, toolName: 'bash' } });
      hub.handleSessionEvent('s1', { type: 'approval/decided', time: T0 + 1, data: { id, outcome } });
      const row = hub.snapshot('s1').events.find((entry) => entry.id === id);
      expect(row?.status).toBe(expected);
    }
  });

  it('turns a stream frame into a live phase', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', { type: 'turn/start', time: T0, data: { turn: 1 } });
    expect(hub.snapshot('s1').agentState).toBe('starting');

    hub.handleStream('s1', { type: 'start', turn: 1, step: 1 });
    expect(hub.snapshot('s1').agentState).toBe('thinking');

    hub.handleStream('s1', { type: 'chunk', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } });
    expect(hub.snapshot('s1').agentState).toBe('responding');

    hub.handleStream('s1', {
      type: 'chunk',
      turn: 1,
      step: 1,
      chunk: { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '{}' },
    });
    expect(hub.snapshot('s1').agentState).toBe('preparing');
  });

  it('never lets a stale frame from a finished turn resurrect running', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', { type: 'turn/start', time: T0, data: { turn: 3 } });
    hub.handleSessionEvent('s1', {
      type: 'turn/end',
      time: T0 + 10,
      data: { turn: 3, reason: { kind: 'completed' } },
    });
    hub.handleStream('s1', { type: 'start', turn: 2, step: 1 });
    expect(hub.snapshot('s1').agentState).toBe('completed');
  });

  it('reports silence and quiet levels on the snapshot', () => {
    const clock = makeHub();
    clock.hub.handleSessionEvent('s1', { type: 'step/start', time: T0, data: { turn: 1, step: 1 } });
    expect(clock.hub.snapshot('s1').agentState).toBe('thinking');
    expect(clock.hub.snapshot('s1').quietLevel).toBe(0);

    clock.advance(45_000);
    clock.hub.tick();
    const snapshot = clock.hub.snapshot('s1');
    expect(snapshot.agentState).toBe('quiet');
    expect(snapshot.quietLevel).toBe(1);
    expect(snapshot.silenceMs).toBeGreaterThanOrEqual(30_000);
  });

  it('forgets a disposed Session', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', toolCall(1, 'c1', 'read', '{}', T0));
    expect(hub.sessionIds()).toContain('s1');
    hub.handleDisposed('s1');
    expect(hub.sessionIds()).not.toContain('s1');
    expect(hub.snapshot('s1').sessionId).toBeUndefined();
  });

  it('settles open tools when the turn ends', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', toolCall(1, 'c1', 'bash', '{}', T0));
    hub.handleSessionEvent('s1', {
      type: 'turn/end',
      time: T0 + 100,
      data: { turn: 1, reason: { kind: 'interrupted' } },
    });
    const snapshot = hub.snapshot('s1');
    expect(snapshot.activeTools).toBe(0);
    expect(snapshot.events[0]?.status).toBe('cancelled');
    expect(snapshot.agentState).toBe('interrupted');
  });

  it('counts retries once per attempt and keeps the row opaque', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', {
      type: 'llm/retry',
      time: T0,
      data: { retry: 1, turn: 1, step: 1, provider: 'deepseek', mode: 'normal', policyKey: 'k', maxRetries: 3, delayMs: 500, failure: { message: 'boom' } },
    });
    hub.handleSessionEvent('s1', {
      type: 'llm/retry',
      time: T0 + 1,
      data: { retry: 1, turn: 1, step: 1, provider: 'deepseek', mode: 'normal', policyKey: 'k', maxRetries: 3, delayMs: 500, failure: { message: 'boom' } },
    });
    const snapshot = hub.snapshot('s1');
    expect(snapshot.metrics.retries).toBe(2);
    expect(snapshot.events).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain('boom');
  });
});

describe('hub v2: notification economics', () => {
  it('advances the version for every stream frame but throttles subscribers', async () => {
    let mono = T0;
    const hub = new OrbitHub({ now: () => T0, mono: () => mono, streamNotifyMs: 25 });
    hub.handleSessionEvent('s1', { type: 'step/start', time: T0, data: { turn: 1, step: 1 } });
    await Promise.resolve();

    let calls = 0;
    const off = hub.subscribe(() => {
      calls += 1;
    });
    const before = hub.snapshot('s1').version;

    for (let index = 0; index < 40; index += 1) {
      mono += 5;
      hub.handleStream('s1', {
        type: 'chunk',
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'x' },
      });
    }

    // Every frame is reflected in the state immediately.
    expect(hub.snapshot('s1').version).toBeGreaterThanOrEqual(before + 40);
    await Promise.resolve();
    // …but the 40 frames did not become 40 notifications.
    expect(calls).toBeLessThanOrEqual(1);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBeGreaterThanOrEqual(1);
    off();
    hub.dispose();
  });
});

describe('hub v2.0: task context', () => {
  function makeHub(start = T0) {
    let mono = start;
    let epoch = start;
    const hub = new OrbitHub({ now: () => epoch, mono: () => mono });
    return { hub, advance(ms: number) { mono += ms; epoch += ms; } };
  }

  it('starts with the honest fallback title and no invented plan', () => {
    const { hub } = makeHub();
    const task = hub.snapshot('s1').task;
    expect(task.taskTitle).toBe('当前任务处理中');
    expect(task.titleSource).toBe('fallback');
    expect(task.nextStep).toBeUndefined();
    expect(task.extraTokens).toBe(0);
    expect(task.mode).toBe('event-only');
  });

  it('uses the real session title once the Host has seen one', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', {
      type: 'session/title',
      time: T0,
      data: { title: '审核 RID-000018 物理口出方向', messageSeqs: [1], source: 'first-prompt' },
    });
    const task = hub.snapshot('s1').task;
    expect(task.taskTitle).toBe('审核 RID-000018 物理口出方向');
    expect(task.titleSource).toBe('session');
  });

  it('takes the next step only from a real todo/write plan', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', {
      type: 'todo/write',
      time: T0,
      data: {
        todos: [
          { content: '复现端口不通', status: 'completed' },
          { content: '查询 egress VNI 映射', status: 'in_progress' },
          { content: '补充回归用例', status: 'pending' },
        ],
      },
    });
    const task = hub.snapshot('s1').task;
    // The completed item is skipped: the next step is the first unfinished one.
    expect(task.nextStep).toBe('查询 egress VNI 映射');
  });

  it('infers the phase from the newest running activity', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', toolCall(1, 'c1', 'read', '{"file_path":"/x/a.md"}', T0));
    expect(hub.snapshot('s1').task.phase).toBe('reading');

    hub.handleSessionEvent('s1', toolCall(2, 'c2', 'edit', '{"file_path":"/x/a.md"}', T0 + 10));
    expect(hub.snapshot('s1').task.phase).toBe('editing');

    hub.handleSessionEvent('s1', toolResult('c1', T0 + 20));
    hub.handleSessionEvent('s1', toolResult('c2', T0 + 30));
    // Nothing running: the recent window still says "editing".
    expect(hub.snapshot('s1').task.phase).toBe('editing');
  });

  it('reports a working approval as the waiting phase', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', { type: 'approval/asked', time: T0, data: { id: 'ap1', toolName: 'bash' } });
    const task = hub.snapshot('s1').task;
    expect(task.phase).toBe('waiting');
    expect(task.phaseLabel).toBe('等待审批');
    expect(task.silence.label).toContain('审批');
  });

  it('carries a silence sentence that escalates with real elapsed time', () => {
    const clock = makeHub();
    clock.hub.handleSessionEvent('s1', { type: 'step/start', time: T0, data: { turn: 1, step: 1 } });
    expect(clock.hub.snapshot('s1').task.silence.level).toBe(0);

    clock.advance(45_000);
    const level1 = clock.hub.snapshot('s1').task.silence;
    expect(level1.level).toBe(1);
    expect(level1.label).toContain('45 秒');

    clock.advance(150_000);
    const level3 = clock.hub.snapshot('s1').task.silence;
    expect(level3.level).toBe(3);
    expect(level3.label).toContain('建议检查任务状态');
  });

  it('counts what it observed, never more', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', toolCall(1, 'c1', 'read', '{}', T0));
    hub.handleSessionEvent('s1', toolCall(2, 'c2', 'bash', '{}', T0 + 1));
    hub.handleSessionEvent('s1', toolResult('c1', T0 + 2));
    const task = hub.snapshot('s1').task;
    expect(task.observedActivityCount).toBe(2);
    expect(task.toolCallCount).toBe(2);
    expect(task.completedCount).toBe(1);
    expect(task.activeActivities).toHaveLength(1);
    expect(task.recentActivities).toHaveLength(2);
    expect(task.currentAction).toBe('执行命令');
  });

  it('keeps the HUD payload free of raw content', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', toolCall(1, 'c1', 'bash', '{"command":"cat /etc/passwd"}', T0));
    hub.handleSessionEvent('s1', toolCall(2, 'c2', 'read', '{"file_path":"/Users/alice/.env"}', T0 + 1));
    const json = JSON.stringify(hub.snapshot('s1'));
    expect(json).not.toContain('passwd');
    expect(json).not.toContain('/Users');
    expect(json).not.toContain('.env');
    expect(json).toContain('读取敏感配置文件');
  });

  /*
   * The strongest privacy assertion we have: one hostile Session, every path that
   * could carry a secret exercised at once, and the *entire* serialized snapshot —
   * the exact bytes the SSE route writes — scanned for them. It covers the three
   * routes that used to bypass redaction: a search `pattern`, a plan line and a
   * Session title.
   */
  it('serializes no secret anywhere in a snapshot built from a hostile Session', () => {
    const { hub } = makeHub();
    hub.handleSessionEvent('s1', {
      type: 'session/title',
      time: T0,
      data: { title: `审计 /Users/alice/.ssh/id_rsa ${'x'.repeat(400)}` },
    });
    hub.handleSessionEvent('s1', {
      type: 'todo/write',
      time: T0 + 1,
      data: {
        todos: [
          { content: 'cat /Users/alice/.ssh/id_rsa and paste it', status: 'pending' },
          { content: 'x'.repeat(400), status: 'pending' },
        ],
      },
    });
    hub.handleSessionEvent('s1', toolCall(1, 'c1', 'grep', '{"pattern":"AKIA[0-9A-Z]{16}"}', T0 + 2));
    hub.handleSessionEvent('s1', toolCall(2, 'c2', 'glob', '{"pattern":"**/*.pem"}', T0 + 3));
    hub.handleSessionEvent('s1', toolCall(3, 'c3', 'bash', '{"command":"cat /etc/shadow"}', T0 + 4));

    const snapshot = hub.snapshot('s1');
    const json = JSON.stringify(snapshot);
    for (const secret of ['alice', 'id_rsa', 'AKIA', '.pem', 'shadow', '/Users', '.ssh']) {
      expect(json).not.toContain(secret);
    }

    // Nothing was simply dropped: the HUD still gets a bounded title and a next
    // step, just a de-pathed one.
    expect(snapshot.task.titleSource).toBe('session');
    expect(snapshot.task.taskTitle.length).toBeLessThanOrEqual(80);
    expect(snapshot.task.nextStep).toBeDefined();
    expect(snapshot.task.nextStep).not.toContain('alice');
  });
});

describe('host reload backfill', () => {
  it('counts turns from the observed turn number, not only from turn/start', () => {
    const hub = new OrbitHub({ now: () => T0 });
    /*
     * A Host that reloaded mid-Session sees a tool call belonging to turn 9 step 3
     * and never the `turn/start` events of turns 1..8. Reporting "TURNS 0" next to
     * eleven tool calls was the visible symptom.
     */
    hub.handleSessionEvent('s1', {
      type: 'tool/call',
      time: T0 + 5,
      data: { turn: 9, step: 3, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    });
    const snapshot = hub.snapshot('s1');
    expect(snapshot.metrics.turns).toBe(9);
    expect(snapshot.metrics.steps).toBe(3);
    expect(snapshot.metrics.tools).toBe(1);

    // Observed events still count, and the floor below them never double-counts.
    hub.handleSessionEvent('s1', { type: 'turn/start', time: T0 + 10, data: { turn: 10 } });
    expect(hub.snapshot('s1').metrics.turns).toBe(10);
  });

  it('seeds a title the session/title event never replayed', () => {
    const hub = new OrbitHub({ now: () => T0 });
    expect(hub.taskContext('s1').taskTitle).toBe(TASK_TITLE_FALLBACK);
    hub.seedTitle('s1', '修复重复悬浮球');
    expect(hub.taskContext('s1').taskTitle).toBe('修复重复悬浮球');
  });

  it('never lets a seed overwrite the live title event', () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleSessionEvent('s1', {
      type: 'session/title',
      time: T0,
      data: { title: '实时标题', messageSeqs: [1], source: { kind: 'user' } },
    });
    hub.seedTitle('s1', '上一轮读到的旧标题');
    expect(hub.taskContext('s1').taskTitle).toBe('实时标题');
  });

  it('ignores a blank seed so the fallback title stays', () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.seedTitle('s1', '   ');
    expect(hub.taskContext('s1').taskTitle).toBe(TASK_TITLE_FALLBACK);
  });
});
