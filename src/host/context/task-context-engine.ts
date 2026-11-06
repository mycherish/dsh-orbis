/**
 * The Task Context Engine (spec §3).
 *
 * Composes the four lower-level pieces into the single object the HUD renders:
 *
 *   activities → aggregate → phase inference → silence → task context
 *
 * It owns two things nobody else may do:
 *  - deciding what the task *title* is (a real Session title, else an honest
 *    fallback — never a guess);
 *  - deciding whether a "next step" exists at all (only from a plan the Agent
 *    actually published).
 */
import {
  PHASE_LABEL,
  TASK_TITLE_FALLBACK,
  type OrbitActivity,
  type OrbitSilence,
  type OrbitTaskContext,
} from '../../shared/task-context-types';
import { HUD_RECENT_ROWS } from '../../shared/protocol';
import { aggregateActivities, currentActionOf } from './activity-aggregator';
import { inferPhase } from './phase-inference';

/** Longest plan line we forward. */
const MAX_NEXT_STEP = 80;

export interface TaskContextInput {
  /** Newest-first activity rows (the Host's ring buffer). */
  rows: readonly OrbitActivity[];
  /** Epoch milliseconds of the Session's first observed event. */
  startedAt: number;
  /** Session title from `session/title`, when the Host has seen one. */
  sessionTitle?: string;
  /** Unfinished plan items from `todo/write`, in the Agent's own order. */
  plan?: readonly string[];
  /** Turn still open? */
  turnOpen: boolean;
  /** Model produced text in this step? */
  responding: boolean;
  /** Approval outstanding? */
  waitingApproval: boolean;
  /** The silence observation (already bucketed). */
  silence: OrbitSilence;
}

/** Clip a plan line to something a 470px card can show without wrapping. */
function clipPlan(text: string): string | undefined {
  const value = typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  if (value === '') return undefined;
  return value.length > MAX_NEXT_STEP ? `${value.slice(0, MAX_NEXT_STEP - 1)}…` : value;
}

/**
 * Build the Task Context.
 *
 * `nextStep` is `undefined` unless the Agent published a plan — this is the one
 * place where "看起来很合理" must never be invented (spec §3.5).
 */
export function buildTaskContext(input: TaskContextInput): OrbitTaskContext {
  const aggregate = aggregateActivities({ rows: input.rows, recentLimit: HUD_RECENT_ROWS });
  const phase = inferPhase({
    rows: input.rows,
    turnOpen: input.turnOpen,
    responding: input.responding,
    waitingApproval: input.waitingApproval,
  });

  const title = typeof input.sessionTitle === 'string' ? input.sessionTitle.trim() : '';
  const planItem = (input.plan ?? []).map(clipPlan).find((item) => item !== undefined);

  const context: OrbitTaskContext = {
    taskTitle: title === '' ? TASK_TITLE_FALLBACK : title,
    titleSource: title === '' ? 'fallback' : 'session',
    phase: phase.phase,
    phaseLabel: phase.phaseLabel === '' ? PHASE_LABEL[phase.phase] : phase.phaseLabel,
    recentActivities: aggregate.recentActivities,
    activeActivities: aggregate.activeActivities,
    completedCount: aggregate.completedCount,
    failedCount: aggregate.failedCount,
    observedActivityCount: aggregate.observedActivityCount,
    toolCallCount: aggregate.toolCallCount,
    startedAt: input.startedAt,
    lastActivityAt: aggregate.lastActivityAt > 0 ? aggregate.lastActivityAt : input.startedAt,
    silence: input.silence,
    confidence: phase.confidence,
    extraTokens: 0,
    mode: 'event-only',
  };

  const action = currentActionOf(input.rows);
  if (action !== undefined) context.currentAction = action;
  if (planItem !== undefined) context.nextStep = planItem;
  return context;
}

/** The idle context, used before a Session has any activity at all. */
export function emptyTaskContext(now: number): OrbitTaskContext {
  return {
    taskTitle: TASK_TITLE_FALLBACK,
    titleSource: 'fallback',
    phase: 'idle',
    phaseLabel: PHASE_LABEL.idle,
    recentActivities: [],
    activeActivities: [],
    completedCount: 0,
    failedCount: 0,
    observedActivityCount: 0,
    toolCallCount: 0,
    startedAt: now,
    lastActivityAt: now,
    silence: { ms: 0, level: 0, label: '当前没有新的活动。' },
    confidence: 'low',
    extraTokens: 0,
    mode: 'event-only',
  };
}
