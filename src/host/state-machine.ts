/**
 * The six-state Agent state machine (spec §2.3).
 *
 * Pure and dependency-free: the hub feeds it normalized intents and asks it for
 * the current state. Two rules matter for correctness —
 *
 *  1. `waiting` / `error` / `completed` are *held* states with their own
 *     lifetime, so a blind priority overwrite cannot hide them.
 *  2. Tool bookkeeping is counted, not overwritten: `executing` lasts exactly
 *     as long as at least one call is open, which keeps parallel tools sane.
 */
import {
  COMPLETED_HOLD_MS,
  ERROR_HOLD_MS,
  type OrbitAgentState,
} from '../shared/protocol';

export type OrbitMachineEvent =
  | { kind: 'status'; status: 'idle' | 'running'; at: number }
  | { kind: 'tool-start'; id: string; at: number }
  | { kind: 'tool-end'; id: string; at: number }
  | { kind: 'turn-start'; at: number }
  | { kind: 'turn-end'; reason: 'completed' | 'error' | 'aborted' | 'other'; at: number }
  | { kind: 'turn-stopping'; at: number }
  | { kind: 'approval'; at: number }
  | { kind: 'error'; at: number }
  | { kind: 'tick'; at: number };

export interface MachineState {
  running: boolean;
  /** Tool call ids that started and have not settled. */
  openTools: string[];
  /** An approval ask is outstanding; cleared by the next tool or turn signal. */
  waiting: boolean;
  /** `error` stays visible until this instant. */
  errorUntil: number;
  /** `completed` stays visible until this instant. */
  completedUntil: number;
  agentState: OrbitAgentState;
  updatedAt: number;
}

export interface MachineResult {
  state: MachineState;
  changed: boolean;
}

export function createMachine(now: number): MachineState {
  return {
    running: false,
    openTools: [],
    waiting: false,
    errorUntil: 0,
    completedUntil: 0,
    agentState: 'idle',
    updatedAt: now,
  };
}

/**
 * The published state for the current flags. `waiting` outranks `error` per the
 * spec's priority table, while both outrank the derived activity states.
 */
export function computeState(state: MachineState, at: number): OrbitAgentState {
  if (state.waiting) return 'waiting';
  if (state.errorUntil > at) return 'error';
  if (state.completedUntil > at) return 'completed';
  if (state.openTools.length > 0) return 'executing';
  if (state.running) return 'thinking';
  return 'idle';
}

function settle(state: MachineState, at: number): MachineState {
  state.updatedAt = at;
  state.agentState = computeState(state, at);
  return state;
}

/**
 * Fold one intent. The input state is mutated and returned; callers that need
 * history keep their own copy, which keeps the hot path allocation-free.
 */
export function applyEvent(input: MachineState, event: OrbitMachineEvent): MachineResult {
  const state = input;
  const before = state.agentState;

  switch (event.kind) {
    case 'status':
      state.running = event.status === 'running';
      if (state.running) {
        // New work after a completed hold returns to `thinking` immediately.
        state.completedUntil = 0;
        state.waiting = false;
      }
      break;

    case 'tool-start':
      state.running = true;
      state.waiting = false;
      state.completedUntil = 0;
      state.errorUntil = 0;
      if (!state.openTools.includes(event.id)) state.openTools = [...state.openTools, event.id];
      break;

    case 'tool-end':
      state.openTools = state.openTools.filter((id) => id !== event.id);
      // A settled call ends any approval that was gating it.
      state.waiting = false;
      break;

    case 'turn-start':
      state.running = true;
      state.waiting = false;
      state.completedUntil = 0;
      state.errorUntil = 0;
      break;

    case 'turn-end':
      state.running = false;
      state.waiting = false;
      state.openTools = [];
      if (event.reason === 'error') {
        state.errorUntil = event.at + ERROR_HOLD_MS;
      } else {
        state.completedUntil = event.at + COMPLETED_HOLD_MS;
      }
      break;

    case 'turn-stopping':
      // The turn is about to close: start the completion animation a beat early.
      state.completedUntil = event.at + COMPLETED_HOLD_MS;
      break;

    case 'approval':
      state.waiting = true;
      break;

    case 'error':
      state.waiting = false;
      state.errorUntil = event.at + ERROR_HOLD_MS;
      break;

    case 'tick':
      // Expiry is handled by computeState; nothing to mutate.
      break;
  }

  settle(state, event.at);
  return { state, changed: state.agentState !== before };
}

/** True when a held state will change on its own and a timer is worth running. */
export function hasPendingHold(state: MachineState, at: number): boolean {
  return state.errorUntil > at || state.completedUntil > at || state.waiting;
}
