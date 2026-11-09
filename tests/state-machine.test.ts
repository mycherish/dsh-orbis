import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  computeState,
  createMachine,
  hasPendingHold,
  quietLevelFor,
  type OrbitMachineEvent,
} from '../src/host/state-machine';
import {
  COMPLETED_HOLD_MS,
  ERROR_HOLD_MS,
  INTERRUPTED_HOLD_MS,
  SILENCE_LEVEL1_MS,
} from '../src/shared/protocol';

const T0 = 1_700_000_000_000;

function run(events: OrbitMachineEvent[]) {
  const machine = createMachine(T0);
  for (const event of events) applyEvent(machine, event);
  return machine;
}

describe('state machine: documented transitions', () => {
  it('starts idle', () => {
    expect(createMachine(T0).agentState).toBe('idle');
  });

  it('running without a step reads starting, never thinking', () => {
    // DSH reports the loop as running before the first step and during
    // wake-ups, so `running` alone must not claim a Turn is thinking.
    const machine = run([{ kind: 'status', status: 'running', at: T0 + 10 }]);
    expect(computeState(machine, T0 + 10)).toBe('starting');
  });

  it('running with an open step reads thinking', () => {
    const machine = run([
      { kind: 'status', status: 'running', at: T0 },
      { kind: 'step-start', turn: 1, step: 1, at: T0 + 1 },
    ]);
    expect(machine.agentState).toBe('thinking');
  });

  it('tool start → executing, all tools done while running → thinking', () => {
    const machine = run([
      { kind: 'status', status: 'running', at: T0 },
      { kind: 'step-start', turn: 1, step: 1, at: T0 + 1 },
      { kind: 'tool-start', id: 'a', at: T0 + 2 },
    ]);
    expect(machine.agentState).toBe('executing');

    applyEvent(machine, { kind: 'tool-end', id: 'a', at: T0 + 3 });
    expect(machine.agentState).toBe('thinking');
  });

  it('keeps executing while parallel tools remain open', () => {
    const machine = run([
      { kind: 'status', status: 'running', at: T0 },
      { kind: 'tool-start', id: 'a', at: T0 + 1 },
      { kind: 'tool-start', id: 'b', at: T0 + 2 },
    ]);
    expect(machine.agentState).toBe('executing');
    applyEvent(machine, { kind: 'tool-end', id: 'a', at: T0 + 3 });
    expect(machine.agentState).toBe('executing');
    expect(machine.openTools).toEqual(['b']);
    applyEvent(machine, { kind: 'tool-end', id: 'b', at: T0 + 4 });
    expect(machine.agentState).toBe('starting');
  });

  it('idle status after a turn falls back to idle', () => {
    const machine = run([
      { kind: 'status', status: 'running', at: T0 },
      { kind: 'status', status: 'idle', at: T0 + 100 },
    ]);
    expect(machine.agentState).toBe('idle');
  });

  it('approval request → waiting, and the next tool start releases it', () => {
    const machine = run([
      { kind: 'status', status: 'running', at: T0 },
      { kind: 'approval-asked', id: 'ap1', at: T0 + 1 },
    ]);
    expect(machine.agentState).toBe('waiting');
    applyEvent(machine, { kind: 'tool-start', id: 'a', at: T0 + 2 });
    expect(machine.agentState).toBe('executing');
  });

  it('an answered approval stops waiting without starting a tool', () => {
    const machine = run([
      { kind: 'status', status: 'running', at: T0 },
      { kind: 'step-start', turn: 1, step: 1, at: T0 + 1 },
      { kind: 'approval-asked', id: 'ap1', at: T0 + 2 },
    ]);
    expect(machine.agentState).toBe('waiting');
    applyEvent(machine, { kind: 'approval-decided', at: T0 + 3 });
    expect(machine.agentState).toBe('thinking');
  });

  it('turn-stopping → completed, then idle after the hold', () => {
    const machine = run([
      { kind: 'status', status: 'running', at: T0 },
      { kind: 'turn-stopping', at: T0 + 10 },
    ]);
    expect(machine.agentState).toBe('completed');
    // While the hold runs the agent still reports running, so `thinking` would
    // win anyway; the visible state must stay `completed` until it expires.
    expect(computeState(machine, T0 + 10 + COMPLETED_HOLD_MS - 1)).toBe('completed');
    // The turn closes: the Agent reports idle, then the hold expires.
    applyEvent(machine, { kind: 'status', status: 'idle', at: T0 + 20 });
    expect(computeState(machine, T0 + 10 + COMPLETED_HOLD_MS + 1)).toBe('idle');
    expect(hasPendingHold(machine, T0 + 10)).toBe(true);
  });

  it('turn end with an error reason → error for ERROR_HOLD_MS', () => {
    const machine = run([
      { kind: 'status', status: 'running', at: T0 },
      { kind: 'turn-end', reason: 'error', at: T0 + 5 },
    ]);
    expect(machine.agentState).toBe('error');
    expect(computeState(machine, T0 + 5 + ERROR_HOLD_MS + 1)).toBe('idle');
  });

  it('agent error → error even while tools are open', () => {
    const machine = run([
      { kind: 'status', status: 'running', at: T0 },
      { kind: 'tool-start', id: 'a', at: T0 + 1 },
      { kind: 'error', at: T0 + 2 },
    ]);
    expect(machine.agentState).toBe('error');
  });

  it('honours the documented priority: waiting outranks error', () => {
    const machine = run([
      { kind: 'error', at: T0 },
      { kind: 'approval-asked', id: 'ap1', at: T0 + 1 },
    ]);
    expect(machine.agentState).toBe('waiting');
    // After the ask, `error` still outranks `completed` for its hold window.
    applyEvent(machine, { kind: 'turn-end', reason: 'completed', at: T0 + 2 });
    expect(machine.agentState).toBe('error');
    expect(computeState(machine, T0 + 2 + ERROR_HOLD_MS + 1)).toBe('idle');
  });

  it('a new running clears the completed hold', () => {
    const machine = run([
      { kind: 'turn-stopping', at: T0 },
      { kind: 'status', status: 'running', at: T0 + 10 },
    ]);
    expect(machine.agentState).toBe('starting');
  });

  it('turn end clears open tools so a later turn starts clean', () => {
    const machine = run([
      { kind: 'tool-start', id: 'a', at: T0 + 1 },
      { kind: 'turn-end', reason: 'aborted', at: T0 + 2 },
    ]);
    expect(machine.openTools).toEqual([]);
    expect(machine.agentState).toBe('interrupted');
  });
});

describe('state machine v2: the five new states', () => {
  it('turn/start alone reads starting', () => {
    const machine = run([{ kind: 'turn-start', turn: 3, at: T0 }]);
    expect(machine.agentState).toBe('starting');
    expect(machine.turn).toBe(3);
  });

  it('step/start reads thinking', () => {
    const machine = run([{ kind: 'step-start', turn: 1, step: 2, at: T0 }]);
    expect(machine.agentState).toBe('thinking');
    expect(machine.step).toBe(2);
  });

  it('a reasoning delta keeps thinking, a text delta switches to responding', () => {
    const machine = run([
      { kind: 'step-start', turn: 1, step: 1, at: T0 },
      { kind: 'stream', phase: 'thinking', at: T0 + 1 },
    ]);
    expect(machine.agentState).toBe('thinking');

    applyEvent(machine, { kind: 'stream', phase: 'responding', at: T0 + 2 });
    expect(machine.agentState).toBe('responding');
  });

  it('a tool-call delta reads preparing until the call actually starts', () => {
    const machine = run([
      { kind: 'step-start', turn: 1, step: 1, at: T0 },
      { kind: 'stream', phase: 'preparing', at: T0 + 1 },
    ]);
    expect(machine.agentState).toBe('preparing');

    applyEvent(machine, { kind: 'tool-start', id: 'a', at: T0 + 2 });
    expect(machine.agentState).toBe('executing');
  });

  it('silence past thirty seconds reads quiet and buckets by level', () => {
    const machine = run([{ kind: 'step-start', turn: 1, step: 1, at: T0 }]);
    expect(computeState(machine, T0 + SILENCE_LEVEL1_MS - 1)).toBe('thinking');
    expect(quietLevelFor(machine, T0 + SILENCE_LEVEL1_MS - 1)).toBe(0);

    expect(computeState(machine, T0 + SILENCE_LEVEL1_MS)).toBe('quiet');
    expect(quietLevelFor(machine, T0 + SILENCE_LEVEL1_MS)).toBe(1);
    expect(quietLevelFor(machine, T0 + 60_000)).toBe(2);
    expect(quietLevelFor(machine, T0 + 180_000)).toBe(3);
  });

  it('an executing tool keeps executing even when it is silent for minutes', () => {
    const machine = run([
      { kind: 'step-start', turn: 1, step: 1, at: T0 },
      { kind: 'tool-start', id: 'a', at: T0 + 1 },
    ]);
    expect(computeState(machine, T0 + 200_000)).toBe('executing');
    // The silence is still reported, just not as the headline state.
    expect(quietLevelFor(machine, T0 + 200_000)).toBe(3);
  });

  it('any new signal resets the silence window', () => {
    const machine = run([
      { kind: 'step-start', turn: 1, step: 1, at: T0 },
      { kind: 'stream', phase: 'responding', at: T0 + 20_000 },
    ]);
    expect(computeState(machine, T0 + 20_000)).toBe('responding');
    expect(quietLevelFor(machine, T0 + 20_000)).toBe(0);
  });

  it('an interrupted turn end holds the interrupted state, then idles', () => {
    const machine = run([
      { kind: 'step-start', turn: 1, step: 1, at: T0 },
      { kind: 'turn-end', reason: 'interrupted', at: T0 + 5 },
    ]);
    expect(machine.agentState).toBe('interrupted');
    expect(computeState(machine, T0 + 5 + INTERRUPTED_HOLD_MS - 1)).toBe('interrupted');
    expect(computeState(machine, T0 + 5 + INTERRUPTED_HOLD_MS + 1)).toBe('idle');
  });

  it('an interrupted assistant message surfaces interrupted without ending the turn', () => {
    const machine = run([
      { kind: 'step-start', turn: 1, step: 1, at: T0 },
      { kind: 'interrupted', at: T0 + 5 },
    ]);
    expect(machine.agentState).toBe('interrupted');
    expect(machine.running).toBe(true);
  });

  it('max-tokens still reads completed, blocked reads error', () => {
    expect(run([{ kind: 'turn-end', reason: 'max-tokens', at: T0 }]).agentState).toBe('completed');
    expect(run([{ kind: 'turn-end', reason: 'blocked', at: T0 }]).agentState).toBe('error');
  });

  it('reports a pending hold while an approval is outstanding', () => {
    const machine = run([{ kind: 'approval-asked', id: 'ap1', at: T0 }]);
    expect(hasPendingHold(machine, T0)).toBe(true);
  });
});

describe('questions and closed turns', () => {
  it('treats a question as a block, independently of an approval', () => {
    const state = createMachine(0);
    applyEvent(state, { kind: 'status', status: 'running', at: 1 });
    applyEvent(state, { kind: 'approval-asked', id: 'ap', at: 2 });
    applyEvent(state, { kind: 'question-asked', id: 'q', at: 3 });
    expect(state.agentState).toBe('waiting');

    // Deciding the approval must not claim the question was answered.
    applyEvent(state, { kind: 'approval-decided', id: 'ap', at: 4 });
    expect(state.agentState).toBe('waiting');
    expect(state.questionIds).toEqual(['q']);

    applyEvent(state, { kind: 'question-settled', id: 'q', at: 5 });
    expect(state.agentState).not.toBe('waiting');
    expect(state.questionIds).toEqual([]);
  });

  /*
   * Two asks can be outstanding at once — parallel tools, or a subagent asking for
   * its own permission. A single slot let the second overwrite the first, so
   * deciding the first cleared a block that was still there.
   */
  it('holds every outstanding approval, not just the newest one', () => {
    const state = createMachine(0);
    applyEvent(state, { kind: 'status', status: 'running', at: 1 });
    applyEvent(state, { kind: 'approval-asked', id: 'ap-1', at: 2 });
    applyEvent(state, { kind: 'approval-asked', id: 'ap-2', at: 3 });
    expect(state.approvalIds).toEqual(['ap-1', 'ap-2']);

    // Deciding the NEWEST one must leave the older one blocking.
    applyEvent(state, { kind: 'approval-decided', id: 'ap-2', at: 4 });
    expect(state.agentState).toBe('waiting');
    expect(state.approvalIds).toEqual(['ap-1']);

    applyEvent(state, { kind: 'approval-decided', id: 'ap-1', at: 5 });
    expect(state.agentState).not.toBe('waiting');
  });

  it('does not double-count the same ask arriving twice', () => {
    const state = createMachine(0);
    applyEvent(state, { kind: 'status', status: 'running', at: 1 });
    applyEvent(state, { kind: 'approval-asked', id: 'ap-1', at: 2 });
    applyEvent(state, { kind: 'approval-asked', id: 'ap-1', at: 3 });
    expect(state.approvalIds).toEqual(['ap-1']);
    applyEvent(state, { kind: 'approval-decided', id: 'ap-1', at: 4 });
    expect(state.agentState).not.toBe('waiting');
  });

  it('remembers the last closed Turn so stale frames can be dropped', () => {
    const state = createMachine(0);
    applyEvent(state, { kind: 'turn-start', turn: 7, at: 1 });
    expect(state.lastClosedTurn).toBeUndefined();
    applyEvent(state, { kind: 'turn-end', reason: 'completed', at: 2 });
    expect(state.lastClosedTurn).toBe(7);
  });
});
