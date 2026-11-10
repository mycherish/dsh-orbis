/**
 * The Silence Detector (spec §7).
 *
 * Silence is *not* a failure signal: a model may be reasoning, a tool may be
 * running, an approval may be pending, or a Turn may have ended without a new
 * event. The detector therefore reports a level plus a sentence that names the
 * actual situation, and never says the Agent is stuck.
 *
 * All arithmetic is on monotonic milliseconds; `ms` carries the wall-clock
 * distance only for display.
 */
import {
  SILENCE_LEVEL1_MS,
  SILENCE_LEVEL2_MS,
  SILENCE_LEVEL3_MS,
} from '../../shared/protocol';
import type { OrbitSilence, OrbitSilenceLevel } from '../../shared/task-context-types';

/** Bucket a silence duration (0–30s / 30–60s / 60–180s / >180s). */
export function silenceLevelOf(ms: number): OrbitSilenceLevel {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < SILENCE_LEVEL1_MS) return 0;
  if (ms < SILENCE_LEVEL2_MS) return 1;
  if (ms < SILENCE_LEVEL3_MS) return 2;
  return 3;
}

/** Milliseconds until the next bucket, or `undefined` at the last one. */
export function msUntilNextSilence(ms: number): number | undefined {
  const level = silenceLevelOf(ms);
  if (level === 3) return undefined;
  const next = level === 0 ? SILENCE_LEVEL1_MS : level === 1 ? SILENCE_LEVEL2_MS : SILENCE_LEVEL3_MS;
  return Math.max(0, next - ms);
}

export interface SilenceInput {
  /** Milliseconds since the last observable activity. */
  ms: number;
  /** A tool call is still open. */
  activeTools: number;
  /** The Agent is blocked on the human (an approval or a question). */
  waitingApproval: boolean;
  /** The block is a question rather than an approval; only the wording differs. */
  waitingQuestion?: boolean;
  /** The model is still streaming text (it is producing, not silent). */
  responding: boolean;
  /** The Turn is still open. */
  turnOpen: boolean;
}

/** Human duration: `45 秒` / `2 分 05 秒`. */
function humanDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`;
}

/**
 * One sentence describing why nothing is happening. Six situations are
 * distinguished, in this order: waiting for a decision, a long-running tool,
 * the model still streaming, a Turn still open, a Turn that ended, and a
 * genuinely idle Agent.
 */
export function silenceLabel(input: SilenceInput): string {
  const level = silenceLevelOf(input.ms);
  const blockNoun = input.waitingQuestion === true ? '你回答' : '你的审批';
  if (level === 0) {
    if (input.waitingApproval) return `正在等待${blockNoun}。`;
    if (input.activeTools > 0) return '工具正在执行，等待输出。';
    if (input.responding) return '模型正在组织答复。';
    return input.turnOpen ? '模型正在处理请求。' : '当前没有新的活动。';
  }

  const elapsed = humanDuration(input.ms);
  if (input.waitingApproval) return `已等待${blockNoun} ${elapsed}，任务暂停在此处。`;
  if (input.activeTools > 0) {
    return level >= 2
      ? `工具仍在执行，已 ${elapsed}没有新的输出。`
      : `工具执行中，已 ${elapsed}没有新的输出。`;
  }
  if (input.responding) return `模型仍在输出，已 ${elapsed}没有新的活动事件。`;
  if (level >= 3) return `已超过 ${elapsed}没有收到任何活动，建议检查任务状态。`;
  if (level === 2) return `已 ${elapsed}没有新的活动更新。`;
  return `已连续 ${elapsed}没有收到新的活动事件。`;
}

/** Build the wire object for one observation. */
export function detectSilence(input: SilenceInput): OrbitSilence {
  const ms = Number.isFinite(input.ms) && input.ms > 0 ? Math.round(input.ms) : 0;
  return { ms, level: silenceLevelOf(ms), label: silenceLabel({ ...input, ms }) };
}

/**
 * Monotonic milliseconds.
 *
 * Wall-clock time can jump (NTP correction, sleep/wake, manual change), so the
 * "how long has this been silent" question is answered from a monotonic source.
 * `Date.now()` is used only for the human-facing activity timestamps.
 */
export function monotonicNow(): number {
  try {
    const perf = globalThis.performance;
    if (perf !== undefined && typeof perf.now === 'function') return perf.now();
  } catch {
    // Fall through to the wall clock.
  }
  return Date.now();
}
