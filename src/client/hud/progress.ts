/**
 * The always-on HUD's rule set: one snapshot in, Chinese copy / colour tokens /
 * clock text out.
 *
 * Deliberately pure — no React, no DOM, no timers, no `Date.now()` — so every
 * decision the panel makes (the eleven status words, the activity icon and
 * colour vocabulary, the two runtime pills, the expand policy, the silence
 * gate, the footer arithmetic) is unit-testable without jsdom.
 *
 * Invariants the components rely on:
 *  - nothing here reads a clock: `formatClock` / `formatElapsed` /
 *    `runtimePills` take the instant as an argument, so a test can pin it;
 *  - the activity text is built only from `label` / `safeTarget` / `redacted`,
 *    so no tool argument, command, path or file body can reach the panel;
 *  - `runtimePills().mode` is the constant 「纯事件模式 · 0 额外 Token」: this
 *    plugin never calls a model, and the copy must not drift from that fact.
 */
import { ORBIT_PALETTE, type OrbitConnection, type OrbitDisplayMode } from '../contracts';
import type {
  OrbitActivity,
  OrbitAgentState,
  OrbitActivityStatus,
  OrbitTaskContext,
  OrbitToolCategory,
} from '../../shared/protocol';
import {
  CATEGORY_LABEL,
  PHASE_LABEL,
  SENSITIVE_TARGET_LABEL,
  TASK_TITLE_FALLBACK,
} from '../../shared/task-context-types';
import { HUD_RECENT_ROWS } from '../../shared/protocol';

/** Colour mood of a state; the panel maps it to motion, not to hue. */
export type HudTone = 'calm' | 'busy' | 'alert' | 'done';

/** How the panel presents itself right now. */
export type HudCardMode = 'hidden' | 'expanded' | 'compact';

const P = ORBIT_PALETTE;

/* ------------------------------------------------------------------ *
 * State → word / tone
 * ------------------------------------------------------------------ */

/** The one status word each of the eleven states shows in the header pill. */
export const HUD_STATUS_CHIP: Record<OrbitAgentState, string> = {
  idle: '待机',
  starting: '启动中',
  thinking: '思考中',
  preparing: '准备工具',
  executing: '执行中',
  responding: '回复中',
  waiting: '等待审批',
  quiet: '静默中',
  completed: '已完成',
  interrupted: '已中断',
  error: '出错了',
};

const STATE_TONE: Record<OrbitAgentState, HudTone> = {
  idle: 'calm',
  starting: 'busy',
  thinking: 'busy',
  preparing: 'busy',
  executing: 'busy',
  responding: 'busy',
  waiting: 'alert',
  quiet: 'calm',
  completed: 'done',
  interrupted: 'alert',
  error: 'alert',
};

/** Chinese status word for the header pill. Never empty, all eleven distinct. */
export function hudStatusChip(state: OrbitAgentState): string {
  return HUD_STATUS_CHIP[state] ?? HUD_STATUS_CHIP.idle;
}

/** Colour mood; the panel turns this into pulse / glow, never into a hue swap. */
export function hudTone(state: OrbitAgentState): HudTone {
  return STATE_TONE[state];
}

/** True while the Agent is doing something worth unfolding the panel for. */
export function isActiveState(state: OrbitAgentState): boolean {
  return state !== 'idle' && state !== 'quiet';
}

/** True for the three settled states that end a turn. */
export function isSettledState(state: OrbitAgentState): boolean {
  return state === 'completed' || state === 'interrupted' || state === 'error';
}

/**
 * Header pill text: the state word, plus an honest caveat when the stream is
 * not live. The caveat never replaces the state — the panel still says what
 * the Agent was last doing.
 */
export function hudChipText(state: OrbitAgentState, connection: OrbitConnection): string {
  const base = hudStatusChip(state);
  if (connection === 'closed') return `${base} · 已离线`;
  if (connection === 'reconnecting') return `${base} · 重连中`;
  return base;
}

/* ------------------------------------------------------------------ *
 * Activity vocabulary
 * ------------------------------------------------------------------ */

/** One glyph per activity outcome (spec §5.1: ✓ ◉ ✕ …). */
export const ACTIVITY_ICON: Record<OrbitActivityStatus, string> = {
  running: '◉',
  success: '✓',
  failed: '✕',
  cancelled: '…',
  unknown: '·',
};

/** The word shown in the row's right-hand column. */
export const ACTIVITY_STATUS_LABEL: Record<OrbitActivityStatus, string> = {
  running: '进行中',
  success: '完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '已记录',
};

export function activityIcon(status: OrbitActivityStatus): string {
  return ACTIVITY_ICON[status] ?? ACTIVITY_ICON.unknown;
}

export function activityStatusLabel(status: OrbitActivityStatus): string {
  return ACTIVITY_STATUS_LABEL[status] ?? ACTIVITY_STATUS_LABEL.unknown;
}

/**
 * Row colour, from the shared palette only.
 *
 * Precedence is deliberate: an outcome (失败 / 已取消) always wins over a
 * category, because the outcome is what the eye must find first; then the two
 * "model is thinking" families, then the success/running split, and only then
 * the neutral dim.
 */
export function activityColor(category: OrbitToolCategory, status: OrbitActivityStatus): string {
  if (status === 'failed') return P.error;
  if (status === 'cancelled') return P.labelDim;
  if (category === 'approval') return P.warning;
  if (category === 'reasoning' || category === 'response') return P.purple;
  if (status === 'success') return P.success;
  if (status === 'running') return P.blue;
  return P.labelDim;
}

/**
 * Row text: the safe label plus the whitelisted target. A row the Host had to
 * mask never shows its (partial) target at all — it collapses to one fixed
 * sentence, so a masked name cannot be guessed from its neighbours either.
 */
export function activityText(activity: OrbitActivity): string {
  if (activity.redacted === true) return SENSITIVE_TARGET_LABEL;
  const raw = typeof activity.label === 'string' ? activity.label.trim() : '';
  const label = raw === '' ? (CATEGORY_LABEL[activity.category] ?? CATEGORY_LABEL.unknown) : raw;
  const target = typeof activity.safeTarget === 'string' ? activity.safeTarget.trim() : '';
  return target === '' ? label : `${label} · ${target}`;
}

/** Newest-first rows, capped to what the panel draws. The Host already sorts. */
export function hudActivityRows(task: OrbitTaskContext, max: number = HUD_RECENT_ROWS): OrbitActivity[] {
  if (!Array.isArray(task.recentActivities) || max <= 0) return [];
  return task.recentActivities.slice(0, max);
}

/* ------------------------------------------------------------------ *
 * Clocks — pure: every instant is an argument
 * ------------------------------------------------------------------ */

/** `14:02` in the viewer's local time. A bad instant degrades to `--:--`. */
export function formatClock(epochMs: number): string {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '--:--';
  const date = new Date(epochMs);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return '--:--';
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * `15 分 42 秒` / `1 小时 03 分` / `42 秒`.
 *
 * Seconds are dropped once an hour is involved (a HUD does not need them at
 * that scale) but kept zero-padded, so the pill never jitters in width.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours} 小时 ${String(minutes).padStart(2, '0')} 分`;
  if (total >= 60) {
    return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
  }
  return `${total} 秒`;
}

/** The constant half of the second pill — this plugin never calls a model. */
export const RUNTIME_MODE_LABEL = '纯事件模式 · 0 额外 Token';

/** Milliseconds from the first observed event to `now`, clamped at zero. */
export function taskElapsedMs(task: OrbitTaskContext, now: number): number {
  const end = Number.isFinite(now) ? now : task.lastActivityAt;
  const start = Number.isFinite(task.startedAt) ? task.startedAt : end;
  return Math.max(0, end - start);
}

/**
 * The two info pills under the title.
 *
 * `now` is a parameter (never `Date.now()`), so the shell can hand in its
 * ticking clock and a test can pin one instant. While the stream is down the
 * countdown stops at the last event we actually saw: we do not claim the Agent
 * kept running through a window we could not observe.
 */
export function runtimePills(
  task: OrbitTaskContext,
  connection: OrbitConnection = 'open',
  now: number = task.lastActivityAt,
): { elapsed: string; mode: string } {
  const instant = connection === 'closed' ? Math.min(now, task.lastActivityAt) : now;
  return {
    elapsed: formatElapsed(taskElapsedMs(task, instant)),
    mode: RUNTIME_MODE_LABEL,
  };
}

/* ------------------------------------------------------------------ *
 * Copy
 * ------------------------------------------------------------------ */

/** Fixed sentence per state, used when there is no better real signal. */
export const STATUS_SENTENCE: Record<OrbitAgentState, string> = {
  idle: '当前没有新活动。',
  starting: '正在接收任务。',
  thinking: '正在分析，当前没有新的工具调用。',
  preparing: '正在选择要使用的工具。',
  executing: '正在执行工具调用。',
  responding: '正在组织答复。',
  waiting: '正在等待用户审批。',
  quiet: '暂时没有新活动，会话仍在进行。',
  completed: '本轮任务已完成。',
  interrupted: '本轮已中断，可在工作区查看细节。',
  error: '最近一次操作没有成功，可在工作区查看细节。',
};

/**
 * The fixed sentence for a state.
 *
 * `waiting` covers two different requests, so the reason decides the wording —
 * telling someone to approve an approval that is really a question is exactly
 * the kind of confident-but-wrong line this HUD must never print.
 */
export function statusSentence(state: OrbitAgentState, waitingReason?: 'approval' | 'question'): string {
  if (state === 'waiting' && waitingReason === 'question') return '正在等待你回答问题。';
  return STATUS_SENTENCE[state] ?? STATUS_SENTENCE.idle;
}

/** The task title, with an honest mark when it is the generic fallback. */
export function taskTitleOf(task: OrbitTaskContext | null): { text: string; fallback: boolean } {
  if (task === null) return { text: TASK_TITLE_FALLBACK, fallback: true };
  const raw = typeof task.taskTitle === 'string' ? task.taskTitle.trim() : '';
  if (raw === '' || task.titleSource === 'fallback') return { text: TASK_TITLE_FALLBACK, fallback: true };
  return { text: raw, fallback: false };
}

/** The phase line under the title; never empty. */
export function phaseTextOf(task: OrbitTaskContext | null, state: OrbitAgentState): string {
  if (task === null) return isActiveState(state) ? '正在接收任务' : '等待任务';
  const raw = typeof task.phaseLabel === 'string' ? task.phaseLabel.trim() : '';
  return raw === '' ? (PHASE_LABEL[task.phase] ?? PHASE_LABEL.idle) : raw;
}

/** True when the Host actually published a plan step (never predicted). */
export function nextStepLabel(task: OrbitTaskContext | null): string | undefined {
  if (task === null) return undefined;
  const raw = typeof task.nextStep === 'string' ? task.nextStep.trim() : '';
  return raw === '' ? undefined : raw;
}

/** Silence is only surfaced when it is real *and* the user kept the switch on. */
export function shouldShowSilence(task: OrbitTaskContext | null, showSilenceAlert: boolean = true): boolean {
  if (task === null || showSilenceAlert !== true) return false;
  const level = task.silence?.level;
  return typeof level === 'number' && level >= 1;
}

/**
 * The one sentence in 「当前状态」.
 *
 * Order of truth: the Host's silence sentence (it already knows the duration),
 * then the newest real action, then a fixed sentence for the state. Nothing
 * here may say the Agent is stuck or unresponsive — silence is not failure.
 */
export function currentStatusText(
  task: OrbitTaskContext | null,
  state: OrbitAgentState,
  showSilenceAlert: boolean = true,
): string {
  if (task === null) {
    return state === 'idle' ? '等待第一条任务事件…' : statusSentence(state);
  }
  if (shouldShowSilence(task, showSilenceAlert)) {
    const label = typeof task.silence.label === 'string' ? task.silence.label.trim() : '';
    if (label !== '') return label;
  }
  const action = typeof task.currentAction === 'string' ? task.currentAction.trim() : '';
  if (action !== '') return action;
  return statusSentence(state, task.waitingReason);
}

/**
 * The footer line. Only real counters are printed: a zero tool count is
 * omitted instead of being drawn as 「工具 0 次」.
 */
export function footerStats(task: OrbitTaskContext | null, elapsed: string): string {
  if (task === null) return '尚未收到任务事件';
  const observed = Math.max(0, Math.round(task.observedActivityCount));
  const parts: string[] = [observed === 0 ? '尚未观察到活动' : `已观察到 ${observed} 项活动`];
  const tools = Math.max(0, Math.round(task.toolCallCount));
  if (tools > 0) parts.push(`工具 ${tools} 次`);
  parts.push(`运行 ${elapsed}`);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ *
 * Panel policy
 * ------------------------------------------------------------------ */

/**
 * The expand policy, in one pure function:
 *  - `orb` draws no panel at all;
 *  - `compact` is always the one-line chip;
 *  - `auto` unfolds while the Agent is active and folds when it is not — but a
 *    panel the user folded by hand never unfolds itself again, whatever event
 *    arrives next.
 */
export function hudCardMode(
  displayMode: OrbitDisplayMode,
  state: OrbitAgentState,
  collapsed: boolean,
): HudCardMode {
  if (displayMode === 'orb') return 'hidden';
  if (displayMode === 'compact') return 'compact';
  if (collapsed) return 'compact';
  return isActiveState(state) ? 'expanded' : 'compact';
}
