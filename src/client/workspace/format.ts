/**
 * Pure, framework-free helpers for the Workspace panel: relative time,
 * duration / span formatting, activity classification and the timeline model.
 *
 * Everything here is a deterministic function of its arguments (plus a `now`
 * that the caller ticks) so the panel can be reasoned about — and tested —
 * without React or a DOM.
 */
import type {
  OrbitActivity,
  OrbitActivityStatus,
  OrbitAgentState,
  OrbitToolCategory,
} from '../../shared/protocol';
import type { OrbitConnection } from '../contracts';
import { ORBIT_PALETTE, STATE_COLOR } from '../contracts';
import { CATEGORY_LABEL, SENSITIVE_TARGET_LABEL } from '../../shared/task-context-types';
import { LABELS } from './labels';

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** `刚刚 / 12s / 3m / 2h / 5d` — coarse, calm, never negative. */
export function relativeTime(from: number, now: number): string {
  const diff = now - from;
  if (!Number.isFinite(diff) || diff < 5000) return LABELS.units.justNow;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}${LABELS.units.second}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${LABELS.units.minute}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${LABELS.units.hour}`;
  return `${Math.floor(hours / 24)}${LABELS.units.day}`;
}

/** `840ms / 1.2s / 1m 04s` — one decimal below a minute, clock-like above. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return LABELS.units.empty;
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}${LABELS.units.milli}`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}${LABELS.units.second}`;
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) {
    return `${minutes}${LABELS.units.minute} ${String(rest).padStart(2, '0')}${LABELS.units.second}`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}${LABELS.units.hour} ${String(minutes % 60).padStart(2, '0')}${LABELS.units.minute}`;
}

/** `3` / `1.2k` — keeps the stat strip from growing unbounded. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return LABELS.units.empty;
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatFps(fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) return LABELS.units.empty;
  return String(Math.round(fps));
}

/* ------------------------------------------------------------------ *
 * Visual vocabulary
 * ------------------------------------------------------------------ */

/** The five node families of the legend. */
export type CategoryKey = 'read' | 'write' | 'edit' | 'error' | 'tool';

export interface CategoryStyle {
  key: CategoryKey;
  label: string;
  color: string;
}

export const CATEGORIES: readonly CategoryStyle[] = [
  { key: 'read', label: LABELS.category.read, color: ORBIT_PALETTE.blue },
  { key: 'write', label: LABELS.category.write, color: ORBIT_PALETTE.purple },
  { key: 'edit', label: LABELS.category.edit, color: ORBIT_PALETTE.cyan },
  { key: 'error', label: LABELS.category.error, color: ORBIT_PALETTE.error },
  { key: 'tool', label: LABELS.category.tool, color: ORBIT_PALETTE.success },
];

const CATEGORY_COLOR: Record<CategoryKey, string> = {
  read: ORBIT_PALETTE.blue,
  write: ORBIT_PALETTE.purple,
  edit: ORBIT_PALETTE.cyan,
  error: ORBIT_PALETTE.error,
  tool: ORBIT_PALETTE.success,
};

/*
 * Thirteen v2.0 tool categories, five legend colours: each category borrows the
 * family whose semantics it shares most, and gets its own one-character glyph so
 * the badge still tells rows apart inside one colour.
 */
const TOOL_VISUAL: Record<OrbitToolCategory, { key: CategoryKey; glyph: string }> = {
  /* 读取族：都是在「看」，不改变任何东西。 */
  file_read: { key: 'read', glyph: 'R' },
  search: { key: 'read', glyph: 'S' },
  // 整理思路是「内部读取」，用 read 族但换字形。
  reasoning: { key: 'read', glyph: '~' },
  // 组织答复是输出，但输出的是文字结论而非文件，仍归 read 族。
  response: { key: 'read', glyph: 'A' },
  /* 写入族：会落地产出。 */
  file_write: { key: 'write', glyph: 'W' },
  build: { key: 'write', glyph: 'B' },
  // 跑测试是「一件有结果的事」，和构建同族。
  test: { key: 'write', glyph: 'T' },
  /* 编辑族：驱动外部动作 / 等待外部确认。 */
  command: { key: 'edit', glyph: '>' },
  api: { key: 'edit', glyph: '@' },
  database: { key: 'edit', glyph: 'D' },
  inspection: { key: 'edit', glyph: '?' },
  // 等审批是一次待办的动作确认。
  approval: { key: 'edit', glyph: '!' },
  /* 兜底：Host 只说「有其他动作在发生」。 */
  unknown: { key: 'tool', glyph: '·' },
};

export interface ActivityVisual {
  /** Legend family the badge borrows its colour from. */
  key: CategoryKey;
  /** One-character badge glyph. */
  glyph: string;
  color: string;
  /** Short kind word for the row's second line. */
  kind: string;
  /**
   * Second-line target text. Always empty for a redacted row: the masked file
   * has no name to show, so the sentence lives in `kind` instead.
   */
  target?: string;
}

/** Chinese category word, straight from the shared contract table. */
export function categoryVisualLabel(category: OrbitToolCategory): string {
  return CATEGORY_LABEL[category] ?? CATEGORY_LABEL.unknown;
}

/* A failed row keeps its family word but takes the error colour and spike. */
const FAILED_VISUAL: { key: CategoryKey; glyph: string } = { key: 'error', glyph: '!' };

/** Classify one activity row into badge glyph, colour, kind word and target. */
export function activityVisual(activity: OrbitActivity): ActivityVisual {
  /* Redaction is a text rule, failure a colour rule — they never fight. */
  const redacted = activity.redacted === true;
  const base =
    activity.status === 'failed'
      ? FAILED_VISUAL
      : TOOL_VISUAL[activity.category] ?? TOOL_VISUAL.unknown;
  return {
    key: base.key,
    glyph: base.glyph,
    color: CATEGORY_COLOR[base.key],
    kind: redacted ? SENSITIVE_TARGET_LABEL : categoryVisualLabel(activity.category),
    target: redacted ? undefined : activity.safeTarget,
  };
}

const STATUS_COLOR: Record<OrbitActivityStatus, string> = {
  running: ORBIT_PALETTE.cyan,
  success: ORBIT_PALETTE.success,
  failed: ORBIT_PALETTE.error,
  // 取消不是失败：用次要文字色，让「异常」的红只留给真正的失败。
  cancelled: ORBIT_PALETTE.labelDim,
  // 只知道「开始过」的行同样退到次要色，不做任何猜测。
  unknown: ORBIT_PALETTE.labelDim,
};

export function statusColor(status: OrbitActivityStatus): string {
  return STATUS_COLOR[status];
}

export function stateColor(state: OrbitAgentState): string {
  return STATE_COLOR[state];
}

const CONNECTION_COLOR: Record<OrbitConnection, string> = {
  connecting: ORBIT_PALETTE.blue,
  open: ORBIT_PALETTE.success,
  reconnecting: ORBIT_PALETTE.warning,
  closed: ORBIT_PALETTE.error,
};

export function connectionColor(connection: OrbitConnection): string {
  return CONNECTION_COLOR[connection];
}

/** True for the transports that deserve a header banner. */
export function isDegraded(connection: OrbitConnection): boolean {
  return connection === 'reconnecting' || connection === 'closed';
}

/* ------------------------------------------------------------------ *
 * List + timeline models
 * ------------------------------------------------------------------ */

/**
 * Trim the newest-first rows the Host sent to the number the panel displays.
 * The Host already sorts newest-first (spec §2.2), so this never reorders —
 * it only caps the list and is a no-op for short sessions.
 */
export function visibleRows(events: readonly OrbitActivity[], max: number): OrbitActivity[] {
  if (max <= 0) return [];
  return events.length > max ? events.slice(0, max) : events.slice();
}

export interface TimelineMark {
  id: string;
  /** 0..100 horizontal position inside the rail. */
  leftPct: number;
  color: string;
  /** Tick height as a percentage of the rail height. */
  heightPct: number;
  side: 'up' | 'down';
  active: boolean;
  label: string;
}

export interface TimelineModel {
  marks: TimelineMark[];
  /** Where the newest event sits (0..100); also the fill width. */
  headPct: number;
  /** Total wall-clock span covered by the rail, already formatted. */
  span: string;
  empty: boolean;
}

export const EMPTY_TIMELINE: TimelineModel = {
  marks: [],
  headPct: 0,
  span: LABELS.units.empty,
  empty: true,
};

const MARK_HEIGHT: Record<OrbitActivityStatus, number> = {
  running: 52,
  success: 28,
  // 被取消的节点留个矮记号：在场，但不抢戏。
  cancelled: 20,
  // 只知道「开始过」的行比取消还要矮一点：连结局都不确定。
  unknown: 18,
  failed: 76,
};

/** The row's own safe name, or the category word when the Host sent none. */
export function rowLabel(activity: OrbitActivity): string {
  const label = typeof activity.label === 'string' ? activity.label.trim() : '';
  return label === '' ? categoryVisualLabel(activity.category) : label;
}

/**
 * Normalise every event start time into a 0..100 position on one rail.
 *
 * The domain is anchored on `metrics.startedAt` when the Host provided it and
 * extended to `updatedAt`, so a quiet tail after the last event stays visible
 * as unfilled rail instead of stretching the ticks.
 *
 * v2 rows carry `startedAt` (epoch ms); a run's earlier start is preferred over
 * its settlement so an erroring slow call still sits where it began.
 */
export function buildTimeline(
  events: readonly OrbitActivity[],
  startedAt: number | undefined,
  updatedAt: number | undefined,
): TimelineModel {
  if (events.length === 0) return EMPTY_TIMELINE;

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (!Number.isFinite(event.startedAt)) continue;
    if (event.startedAt < minTs) minTs = event.startedAt;
    if (event.startedAt > maxTs) maxTs = event.startedAt;
  }
  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return EMPTY_TIMELINE;

  const anchor =
    typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt <= minTs
      ? startedAt
      : minTs;
  const tail = typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > maxTs
    ? updatedAt
    : maxTs;
  const total = tail - anchor;
  /* Keep ticks off the rounded rail ends: map 0..1 into 1.6%..98.4%. */
  const INSET = 1.6;
  const positionOf = (timestamp: number): number => {
    if (total <= 0) return 50;
    return INSET + clamp01((timestamp - anchor) / total) * (100 - INSET * 2);
  };

  const marks: TimelineMark[] = events.map((event, index) => ({
    id: event.id,
    leftPct: positionOf(event.startedAt),
    color: statusColor(event.status),
    heightPct: MARK_HEIGHT[event.status],
    side: index % 2 === 0 ? 'up' : 'down',
    active: event.status === 'running',
    label: `${rowLabel(event)} · ${LABELS.statusZh[event.status]}`,
  }));

  return {
    marks,
    headPct: positionOf(maxTs),
    span: formatDuration(total),
    empty: false,
  };
}
