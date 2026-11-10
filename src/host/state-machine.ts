/**
 * The eleven-state Agent state machine (v2).
 *
 * Pure and dependency-free: the hub feeds it normalized intents and asks it for
 * the current state. Four rules keep it honest —
 *
 *  1. `waiting` / `error` / `interrupted` / `completed` are *held* states with
 *     their own lifetime, so a blind priority overwrite cannot hide them.
 *  2. Tool bookkeeping is counted, not overwritten: `executing` lasts exactly
 *     as long as at least one call is open, which keeps parallel tools sane.
 *  3. `running` alone never means "a Turn is executing": DSH reports the loop
 *     as running before the first step and during wake-ups, so a running Agent
 *     with no step yet is `starting`, and a running Agent with no visible
 *     progress for thirty seconds (`SILENCE_LEVEL1_MS`) is `quiet`.
 *  4. Every clock value here is monotonic (`at`), never wall-clock, so a system
 *     time jump cannot fabricate or erase silence.
 */
import {
  COMPLETED_HOLD_MS,
  ERROR_HOLD_MS,
  INTERRUPTED_HOLD_MS,
  SILENCE_LEVEL1_MS,
  type OrbitAgentState,
} from '../shared/protocol';
import { silenceLevelOf } from './context/silence-detector';
import type { OrbitSilenceLevel } from '../shared/task-context-types';

/** How a Turn ended, as reported by `turn/end.reason.kind`. */
export type TurnEndKind =
  | 'completed'
  | 'interrupted'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'max-tokens'
  | 'forked'
  | 'other';

/** The transient stream phase inside the current step. */
export type StreamPhase = 'none' | 'thinking' | 'preparing' | 'responding';

export type OrbitMachineEvent =
  | { kind: 'status'; status: 'idle' | 'running'; at: number }
  | { kind: 'turn-start'; turn?: number; at: number }
  | { kind: 'step-start'; turn?: number; step?: number; at: number }
  | { kind: 'stream'; phase: StreamPhase; at: number }
  | { kind: 'tool-start'; id: string; at: number }
  | { kind: 'tool-end'; id: string; at: number }
  | { kind: 'approval-asked'; id: string; at: number }
  | { kind: 'approval-decided'; id?: string; at: number }
  /** A `user-questions/request`: also blocked on the human, but a question. */
  | { kind: 'question-asked'; id: string; at: number }
  | { kind: 'question-settled'; id?: string; at: number }
  | { kind: 'turn-end'; reason: TurnEndKind; at: number }
  | { kind: 'turn-stopping'; at: number }
  /** A step was interrupted but its Turn may still continue (`assistant/message.interrupted`). */
  | { kind: 'interrupted'; at: number }
  | { kind: 'error'; at: number }
  | { kind: 'tick'; at: number };

export interface MachineState {
  running: boolean;
  /** Durable Turn in flight. */
  turn?: number;
  /** Durable Step in flight. */
  step?: number;
  /** Transient stream phase inside the current step. */
  phase: StreamPhase;
  /** Tool call ids that started and have not settled. */
  openTools: string[];
  /**
   * Approval asks currently blocking progress, in arrival order.
   *
   * A list, not a slot. Two approvals are genuinely outstanding at once (parallel
   * tools, or a subagent asking for its own permission), and a single slot let the
   * second overwrite the first — so deciding the first one cleared a block that
   * was still there. Kept separate from `questionIds` for the same reason: the two
   * are different requests and settling one must not speak for the other.
   */
  approvalIds: string[];
  /** Question asks currently blocking progress, in arrival order. */
  questionIds: string[];
  /**
   * Highest Turn already closed by `turn/end`.
   *
   * Transient stream frames from DSH's delta variants carry no Turn at all, so
   * this is the only way to tell "a frame belonging to the live Turn" from "a
   * frame that was still in flight when the Turn ended".
   */
  lastClosedTurn?: number;
  /** `error` stays visible until this instant (monotonic). */
  errorUntil: number;
  /** `interrupted` stays visible until this instant (monotonic). */
  interruptedUntil: number;
  /** `completed` stays visible until this instant (monotonic). */
  completedUntil: number;
  /** Monotonic instant of the last observable activity. */
  lastActivityAt: number;
  agentState: OrbitAgentState;
  /** Monotonic instant of the last transition. */
  updatedAt: number;
}

export interface MachineResult {
  state: MachineState;
  changed: boolean;
}

export function createMachine(now: number): MachineState {
  return {
    running: false,
    phase: 'none',
    openTools: [],
    approvalIds: [],
    questionIds: [],
    errorUntil: 0,
    interruptedUntil: 0,
    completedUntil: 0,
    lastActivityAt: now,
    agentState: 'idle',
    updatedAt: now,
  };
}

/** How long the Agent has been silent at instant `at` (never negative). */
export function silenceOf(state: MachineState, at: number): number {
  const silence = at - state.lastActivityAt;
  return Number.isFinite(silence) && silence > 0 ? silence : 0;
}

export function quietLevelFor(state: MachineState, at: number): OrbitSilenceLevel {
  return silenceLevelOf(silenceOf(state, at));
}

/**
 * The published state for the current flags.
 *
 * Priority: approval (someone is blocked on the user) outranks failure, which
 * outranks an interrupted run, which outranks a finished one. Live work comes
 * next: an open tool always reads `executing`, otherwise silence past ten
 * seconds reads `quiet`, and the stream phase picks between
 * `responding` / `preparing` / `thinking` / `starting`.
 */
export function computeState(state: MachineState, at: number): OrbitAgentState {
  if (state.approvalIds.length > 0 || state.questionIds.length > 0) return 'waiting';
  if (state.errorUntil > at) return 'error';
  if (state.interruptedUntil > at) return 'interrupted';
  if (state.completedUntil > at) return 'completed';
  if (state.openTools.length > 0) return 'executing';
  if (!state.running) return 'idle';
  if (silenceOf(state, at) >= SILENCE_LEVEL1_MS) return 'quiet';
  if (state.phase === 'responding') return 'responding';
  if (state.phase === 'preparing') return 'preparing';
  if (state.phase === 'thinking') return 'thinking';
  // An open Step with no stream phase yet is still reasoning about its result.
  if (state.step !== undefined) return 'thinking';
  return 'starting';
}

function settle(state: MachineState, at: number): MachineState {
  state.updatedAt = at;
  state.agentState = computeState(state, at);
  return state;
}

/** Add an ask id without duplicating it (the same ask can arrive twice). */
function addAsk(list: string[], id: string): string[] {
  return list.includes(id) ? list : [...list, id];
}

/** Remove one ask id, or every one of them when the caller cannot name it. */
function dropAsk(list: string[], id: string | undefined): string[] {
  return id === undefined ? [] : list.filter((entry) => entry !== id);
}

/** Clear the time-boxed holds: new work supersedes a finished run. */
function clearHolds(state: MachineState): void {
  state.completedUntil = 0;
  state.errorUntil = 0;
  state.interruptedUntil = 0;
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
        // A running loop starts a fresh window; it is NOT a step by itself.
        state.lastActivityAt = event.at;
        state.phase = state.phase === 'none' ? 'none' : state.phase;
        clearHolds(state);
        state.approvalIds = [];
        state.questionIds = [];
      } else {
        state.phase = 'none';
      }
      break;

    case 'turn-start':
      state.running = true;
      state.turn = event.turn;
      state.step = undefined;
      state.phase = 'none';
      state.approvalIds = [];
      state.questionIds = [];
      state.lastActivityAt = event.at;
      clearHolds(state);
      break;

    case 'step-start':
      state.running = true;
      state.turn = event.turn ?? state.turn;
      state.step = event.step;
      state.phase = 'none';
      state.lastActivityAt = event.at;
      clearHolds(state);
      break;

    case 'stream':
      // A live frame is proof of work even when the durable event lags behind.
      state.running = true;
      if (event.phase !== 'none') state.phase = event.phase;
      state.lastActivityAt = event.at;
      clearHolds(state);
      break;

    case 'tool-start':
      state.running = true;
      state.phase = 'none';
      /*
       * This used to clear both ask sets outright, on the theory that "a tool
       * started, so whatever was blocking is over". That is only true for the ask
       * this turn actually unblocked: with approvals A and B outstanding, starting
       * A wiped B as well and the panel stopped reporting `waiting` while B was
       * still unanswered. Each ask now leaves the set through its own
       * `approval-decided` / `question-settled` event, which the Hub sends with the
       * exact id (`bridge:<callId>` for the adopted placeholder, the durable id
       * otherwise). Nothing here needs a blanket clear.
       */
      if (!state.openTools.includes(event.id)) state.openTools = [...state.openTools, event.id];
      state.lastActivityAt = event.at;
      clearHolds(state);
      break;

    case 'tool-end':
      state.openTools = state.openTools.filter((id) => id !== event.id);
      state.lastActivityAt = event.at;
      break;

    case 'approval-asked':
      state.approvalIds = addAsk(state.approvalIds, event.id);
      state.lastActivityAt = event.at;
      break;

    case 'approval-decided':
      state.approvalIds = dropAsk(state.approvalIds, event.id);
      state.lastActivityAt = event.at;
      break;

    case 'question-asked':
      state.questionIds = addAsk(state.questionIds, event.id);
      state.lastActivityAt = event.at;
      break;

    case 'question-settled':
      state.questionIds = dropAsk(state.questionIds, event.id);
      state.lastActivityAt = event.at;
      break;

    case 'turn-end':
      state.running = false;
      state.openTools = [];
      state.phase = 'none';
      state.approvalIds = [];
      state.questionIds = [];
      state.step = undefined;
      if (state.turn !== undefined) state.lastClosedTurn = state.turn;
      switch (event.reason) {
        case 'completed':
        case 'max-tokens':
          state.completedUntil = event.at + COMPLETED_HOLD_MS;
          break;
        case 'interrupted':
        case 'aborted':
          state.interruptedUntil = event.at + INTERRUPTED_HOLD_MS;
          break;
        case 'error':
        case 'blocked':
          state.errorUntil = event.at + ERROR_HOLD_MS;
          break;
        default:
          break;
      }
      break;

    case 'turn-stopping':
      // The turn is about to close: start the completion animation a beat early.
      state.completedUntil = event.at + COMPLETED_HOLD_MS;
      state.lastActivityAt = event.at;
      break;

    case 'interrupted':
      state.phase = 'none';
      state.interruptedUntil = event.at + INTERRUPTED_HOLD_MS;
      state.lastActivityAt = event.at;
      break;

    case 'error':
      state.approvalIds = [];
      state.questionIds = [];
      state.phase = 'none';
      state.errorUntil = event.at + ERROR_HOLD_MS;
      state.lastActivityAt = event.at;
      break;

    case 'tick':
      // Expiry is handled by computeState; nothing to mutate.
      break;
  }

  settle(state, event.at);
  return { state, changed: state.agentState !== before };
}

/**
 * True when a tick could still change the published state: a hold is running
 * out, or the Agent is running and must cross a silence boundary.
 *
 * Diagnostics and tests only. `OrbitHub.tick()` must not use this as a skip
 * guard: the tick where a hold *expires* is exactly the one it answers `false`
 * to, and that is the tick that has to publish the fallback to the next state.
 */
export function hasPendingHold(state: MachineState, at: number): boolean {
  if (state.errorUntil > at || state.completedUntil > at || state.interruptedUntil > at) return true;
  if (state.approvalIds.length > 0 || state.questionIds.length > 0) return true;
  if (!state.running) return false;
  // `quiet` starts at thirty seconds; after that only the bucket index changes,
  // and both are part of what a tick has to publish.
  return state.agentState !== 'quiet' || silenceLevelOf(silenceOf(state, at)) < 3;
}
