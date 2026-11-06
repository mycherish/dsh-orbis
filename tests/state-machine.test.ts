import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  computeState,
  createMachine,
  hasPendingHold,
  type OrbitMachineEvent,
} from '../src/host/state-machine';
import { COMPLETED_HOLD_MS, ERROR_HOLD_MS } from '../src/shared/protocol';

const T0 = 1_700_000_000_000;

function run(events: OrbitMachineEvent[]) {
  const machine = createMachine(T0);
  for (const event of events) applyEvent(machine, event);
  return machine;
}

describe('state machine: documented transitions (spec §2.3)', () => {
  it('starts idle', () => {
    expect(createMachine(T0).agentState).toBe('idle');
  });

  it('running → thinking', () => {
    const machine = run([{ kind: 'status', status: 'running', at: T0 + 10 }]);
    expect(computeState(machine, T0 + 10)).toBe('thinking');
  });

  it('tool start → executing, all tools done while running → thinking', () => {
    const machine = run([
      { kind: 'status', status: 'running', at: T0 },
      { kind: 'tool-start', id: 'a', at: T0 + 1 },
    ]);
    expect(machine.agentState).toBe('executing');

    applyEvent(machine, { kind: 'tool-end', id: 'a', at: T0 + 2 });
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
    expect(machine.agentState).toBe('thinking');
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
      { kind: 'approval', at: T0 + 1 },
    ]);
    expect(machine.agentState).toBe('waiting');
    applyEvent(machine, { kind: 'tool-start', id: 'a', at: T0 + 2 });
    expect(machine.agentState).toBe('executing');
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
      { kind: 'approval', at: T0 + 1 },
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
    expect(machine.agentState).toBe('thinking');
  });

  it('turn end clears open tools so a later turn starts clean', () => {
    const machine = run([
      { kind: 'tool-start', id: 'a', at: T0 + 1 },
      { kind: 'turn-end', reason: 'aborted', at: T0 + 2 },
    ]);
    expect(machine.openTools).toEqual([]);
    expect(machine.agentState).toBe('completed');
  });
});
