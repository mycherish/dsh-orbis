/**
 * The always-on HUD's data layer: snapshot in, Chinese copy / colour tone /
 * progress weight out.
 *
 * Deliberately pure — no React, no DOM, no timers, no `Date.now()` — so the
 * whole rule set (eleven states, silence wording, progress weights, the
 * auto-expand policy) is unit-testable without jsdom.
 *
 * Invariants the component relies on:
 *  - the second line never contains a raw tool argument, command or path; it is
 *    built only from `label`, `safeTarget`, `activeTools`, `silenceMs` and the
 *    aggregate metrics;
 *  - progress never grows with elapsed time: silence cannot look like work.
 */
import type { OrbitConnection, OrbitDisplayMode } from '../contracts';
import type { OrbitActivity, OrbitAgentState, OrbitSnapshot } from '../../shared/protocol';

/** Colour mood of a state; the card maps it to an accent and to motion. */
export type HudTone = 'calm' | 'busy' | 'alert' | 'done';

/** How the card should present itself right now. */
export type HudCardMode = 'hidden' | 'expanded' | 'compact';

/** The one-line subject of each of the eleven states. */
export const HUD_STATE_TITLE: Record<OrbitAgentState, string> = {
  idle: '空闲',
  starting: '开始处理',
  thinking: '思考中',
  preparing: '准备调用工具',
  executing: '执行中',
  responding: '回复中',
  waiting: '等待你确认',
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

/** `completed` / `interrupted` / `error` are the settled states. */
const TERMINAL_STATES: ReadonlySet<OrbitAgentState> = new Set<OrbitAgentState>([
  'completed',
  'interrupted',
  'error',
]);

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** True while the Agent is doing something worth unfolding a card for. */
export function isActiveState(state: OrbitAgentState): boolean {
  return state !== 'idle' && state !== 'quiet';
}

/** True for the three settled states that end a turn. */
export function isSettledState(state: OrbitAgentState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Line one: what the Agent is doing, plus a truthful connection caveat. */
export function hudTitle(snapshot: OrbitSnapshot, connection: OrbitConnection): string {
  const base = HUD_STATE_TITLE[snapshot.agentState];
  if (connection === 'closed') return `已离线 · ${base}`;
  if (connection === 'reconnecting') return `重连中 · ${base}`;
  return base;
}

/** `23000` → 「已静默 23 秒」; over a minute it switches to minutes. */
export function formatSilence(silenceMs: number): string {
  const seconds = Math.max(0, Math.round((Number.isFinite(silenceMs) ? silenceMs : 0) / 1000));
  if (seconds < 60) return `已静默 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `已静默 ${minutes} 分` : `已静默 ${minutes} 分 ${rest} 秒`;
}

/** `label` plus the whitelisted target; never any raw argument. */
function activityText(event: OrbitActivity | undefined, fallback: string): string {
  if (event === undefined) return fallback;
  const label = typeof event.label === 'string' && event.label !== '' ? event.label : fallback;
  const target = event.safeTarget;
  if (typeof target !== 'string' || target === '') return label;
  return `${label} · ${target}`;
}

/** `第 2 轮 · 第 5 步`, degrading gracefully when a counter is missing. */
function stepText(snapshot: OrbitSnapshot): string {
  const parts: string[] = [];
  if (typeof snapshot.turn === 'number' && snapshot.turn > 0) parts.push(`第 ${snapshot.turn} 轮`);
  if (typeof snapshot.step === 'number' && snapshot.step > 0) parts.push(`第 ${snapshot.step} 步`);
  return parts.join(' · ');
}

/** The newest row with a given status, used for the `error` line. */
function newestWithStatus(snapshot: OrbitSnapshot, status: OrbitActivity['status']): OrbitActivity | undefined {
  return snapshot.events.find((event) => event.status === status);
}

/**
 * Line two: the concrete object or count behind the state. Built only from safe
 * fields, so nothing here can echo a tool argument, command or file content.
 */
export function hudDetail(snapshot: OrbitSnapshot): string {
  const latest = snapshot.events[0];
  const tools = Math.max(0, snapshot.activeTools);
  const metrics = snapshot.metrics ?? { turns: 0, steps: 0, tools: 0, files: 0, approvals: 0, retries: 0, startedAt: 0 };

  switch (snapshot.agentState) {
    case 'idle':
      return '暂无进行中的任务';
    case 'starting': {
      const steps = stepText(snapshot);
      return steps === '' ? '正在接收任务' : `${steps} · 正在接收任务`;
    }
    case 'thinking': {
      const steps = stepText(snapshot);
      return steps === '' ? '正在推理下一步' : `${steps} · 推理中`;
    }
    case 'preparing':
      return activityText(latest, '正在选择要用的工具');
    case 'executing':
      // The newest activity row is the truth here; counts only as a fallback.
      return tools === 0
        ? activityText(latest, '正在执行工具')
        : activityText(latest, `共 ${tools} 个工具正在执行`);
    case 'responding': {
      const steps = stepText(snapshot);
      return steps === '' ? '正在生成回复' : `${steps} · 生成回复`;
    }
    case 'waiting':
      return activityText(latest, '需要你的确认才能继续');
    case 'quiet':
      return formatSilence(snapshot.silenceMs);
    case 'completed':
      return `共 ${metrics.steps} 步 · ${metrics.tools} 次工具`;
    case 'interrupted':
      return '本轮已中断，可在 Workspace 查看';
    case 'error':
      return activityText(newestWithStatus(snapshot, 'error'), '出错了，可在 Workspace 查看');
    default:
      return '';
  }
}

/**
 * 0..1 bar weight, derived from real signals only:
 * `activeTools` (how much is in flight) — never from `silenceMs` or any clock.
 * `quiet` therefore stays low and flat: silence is not progress.
 */
export function hudProgress(snapshot: OrbitSnapshot): number {
  const tools = Math.max(0, snapshot.activeTools);
  switch (snapshot.agentState) {
    case 'idle':
      return 0;
    case 'starting':
      return 0.08;
    case 'thinking':
      return 0.18;
    case 'preparing':
      return 0.26;
    case 'executing':
      return clamp01(Math.min(0.85, 0.45 + tools * 0.05));
    case 'responding':
      return 0.7;
    case 'waiting':
      return 0.78;
    case 'quiet':
      // A running tool is still real work; silence alone never advances the bar.
      return tools === 0 ? 0.2 : clamp01(Math.min(0.5, 0.3 + tools * 0.05));
    case 'completed':
    case 'interrupted':
    case 'error':
      return 1;
    default:
      return 0;
  }
}

/** Colour mood; the card turns this into accent + motion. */
export function hudTone(state: OrbitAgentState): HudTone {
  return STATE_TONE[state];
}

/**
 * The auto-expand policy, in one pure function:
 *  - `orb` mode draws no card at all;
 *  - `compact` mode is always the single line;
 *  - `auto` unfolds while the Agent is active, folds down to the single line
 *    when it is not — but a card the user folded by hand never unfolds itself
 *    again, no matter which event arrives next.
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

/* ------------------------------------------------------------------ *
 * Corner reservation
 * ------------------------------------------------------------------ */

/** Default card anchor measured from the viewport bottom. */
const HUD_BASE_BOTTOM = 104;
/** Gap kept between the orb and the card when the card steps aside. */
const HUD_ORB_GAP = 12;
/** Square edge of the draggable orb. */
const ORB_SIZE = 76;
/** Card footprint from the right edge, at its widest. */
const HUD_SPAN_RIGHT = 24 + 300;
/** Expanded card height cap and the collapsed chip height. */
const HUD_HEIGHT = 160;
const HUD_CHIP_HEIGHT = 32;

/**
 * Where the card should sit so it never covers the orb.
 *
 * The card lives in the lower-right corner and the orb is draggable, so the
 * shell asks this function before every render: when the two footprints would
 * intersect, the card rises to sit just above the orb instead of drawing over
 * it. Pure arithmetic — no DOM, no layout read — so it is unit-testable.
 */
export function hudDodgeOffset(position: { right: number; bottom: number }, collapsed: boolean): number {
  const height = collapsed ? HUD_CHIP_HEIGHT : HUD_HEIGHT;
  const overlapsHorizontally = position.right < HUD_SPAN_RIGHT;
  const cardTop = HUD_BASE_BOTTOM + height;
  const orbTop = position.bottom + ORB_SIZE;
  const overlapsVertically = orbTop > HUD_BASE_BOTTOM && position.bottom < cardTop;
  if (!overlapsHorizontally || !overlapsVertically) return HUD_BASE_BOTTOM;
  return Math.round(position.bottom + ORB_SIZE + HUD_ORB_GAP);
}
