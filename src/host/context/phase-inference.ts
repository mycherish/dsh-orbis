/**
 * Phase inference (spec §3.4).
 *
 * The phase is read off the *real* activities, never predicted from a tool
 * name alone and never invented when the evidence is thin. Each rule is a
 * one-line reason, and the function returns the reason so the UI can explain
 * itself if it ever needs to.
 */
import {
  PHASE_LABEL,
  type OrbitActivity,
  type OrbitConfidence,
  type OrbitTaskPhase,
  type OrbitToolCategory,
} from '../../shared/task-context-types';

/** Category → the phase that category implies, while that work is current. */
const CATEGORY_PHASE: Record<OrbitToolCategory, OrbitTaskPhase> = {
  reasoning: 'analyzing',
  file_read: 'reading',
  file_write: 'editing',
  command: 'analyzing',
  search: 'analyzing',
  build: 'building',
  test: 'testing',
  api: 'querying',
  database: 'querying',
  inspection: 'verifying',
  approval: 'waiting',
  response: 'answering',
  unknown: 'analyzing',
};

export interface PhaseInput {
  /** Newest-first activity rows. */
  rows: readonly OrbitActivity[];
  /** Is the Turn still open? */
  turnOpen: boolean;
  /** Has the model produced any text in this step? */
  responding: boolean;
  /** Is an approval outstanding? */
  waitingApproval: boolean;
}

export interface PhaseResult {
  phase: OrbitTaskPhase;
  phaseLabel: string;
  confidence: OrbitConfidence;
  /** Short, human-readable justification (`最近 3 项活动都是读取`). */
  reason: string;
}

/** How many recent rows the inference window looks at. */
const WINDOW = 3;

function phaseOfCategory(category: OrbitToolCategory): OrbitTaskPhase {
  return CATEGORY_PHASE[category];
}

/** Does this row still describe current work? */
function isLive(row: OrbitActivity): boolean {
  return row.status === 'running';
}

/**
 * Infer the current phase.
 *
 * Priority:
 *  1. a pending approval is `waiting` — nothing else can be true while blocked;
 *  2. the newest *running* row decides (high confidence);
 *  3. otherwise a majority of the last three rows decides (medium);
 *  4. a responding model with no tool evidence is `answering` (medium);
 *  5. an open Turn with nothing observed is `understanding` (low);
 *  6. nothing at all is `idle` (low).
 */
export function inferPhase(input: PhaseInput): PhaseResult {
  const { rows } = input;

  if (input.waitingApproval) {
    return { phase: 'waiting', phaseLabel: PHASE_LABEL.waiting, confidence: 'high', reason: '有未决的审批请求' };
  }

  const live = rows.find(isLive);
  if (live !== undefined) {
    return {
      phase: phaseOfCategory(live.category),
      phaseLabel: PHASE_LABEL[phaseOfCategory(live.category)],
      confidence: live.confidence,
      reason: `当前活动：${live.label}`,
    };
  }

  const window = rows.slice(0, WINDOW);
  if (window.length > 0) {
    const counts = new Map<OrbitTaskPhase, number>();
    for (const row of window) {
      const phase = phaseOfCategory(row.category);
      counts.set(phase, (counts.get(phase) ?? 0) + 1);
    }
    let best: OrbitTaskPhase = 'analyzing';
    let bestCount = 0;
    for (const [phase, count] of counts) {
      if (count > bestCount) {
        best = phase;
        bestCount = count;
      }
    }
    return {
      phase: best,
      phaseLabel: PHASE_LABEL[best],
      confidence: window.length >= 2 ? 'medium' : 'low',
      reason: `最近 ${window.length} 项活动倾向「${PHASE_LABEL[best]}」`,
    };
  }

  if (input.responding) {
    return { phase: 'answering', phaseLabel: PHASE_LABEL.answering, confidence: 'medium', reason: '模型正在输出文本' };
  }

  if (input.turnOpen) {
    return {
      phase: 'understanding',
      phaseLabel: PHASE_LABEL.understanding,
      confidence: 'low',
      reason: 'Turn 已开始，尚无工具活动',
    };
  }

  return { phase: 'idle', phaseLabel: PHASE_LABEL.idle, confidence: 'low', reason: '没有可观察的活动' };
}
