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
import { MAX_TITLE, redactInlinePaths } from '../activity/redactor';
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
  /** Blocked on the human? */
  waitingApproval: boolean;
  /** The block is a question rather than an approval. */
  waitingQuestion?: boolean;
  /** The silence observation (already bucketed). */
  silence: OrbitSilence;
}

/**
 * Normalize one line of free Agent- or user-authored text for the browser.
 *
 * Both `nextStep` (a `todo/write` line) and `taskTitle` (a Session title, which
 * a `first-prompt` provider derives from the human's own words) are prose, not
 * structured targets, so they used to reach the Client untouched. They now take
 * the same route every other field takes: absolute paths collapse to their
 * basename, control characters are dropped, and the result is bounded.
 */
function safeLine(text: unknown, max: number): string | undefined {
  if (typeof text !== 'string') return undefined;
  const cleaned = redactInlinePaths(text.replace(/[\u0000-\u001f\u007f]/g, ' ')).trim();
  if (cleaned === '') return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Clip a plan line to something a 470px card can show without wrapping. */
function clipPlan(text: string): string | undefined {
  return safeLine(text, MAX_NEXT_STEP);
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
    waitingQuestion: input.waitingQuestion === true,
  });

  // A title is prose the human may have written; it is bounded and path-redacted
  // like any other forwarded string, and an empty remainder falls back honestly.
  const title = safeLine(input.sessionTitle, MAX_TITLE) ?? '';
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

  if (input.waitingApproval) {
    context.waitingReason = input.waitingQuestion === true ? 'question' : 'approval';
  }

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
