/**
 * The Activity Aggregator (spec §3.1).
 *
 * Turns the retained activity rows into the four things the HUD actually shows:
 * the newest few, the still-running ones, honest counters, and one sentence
 * about the newest action.
 *
 * Pure: no clock is read here — the caller passes `nowEpoch` when needed.
 */
import type { OrbitActivity } from '../../shared/task-context-types';

export interface AggregateInput {
  /** Newest-first rows. */
  rows: readonly OrbitActivity[];
  /** How many rows `recentActivities` should carry. */
  recentLimit: number;
}

export interface Aggregated {
  recentActivities: OrbitActivity[];
  activeActivities: OrbitActivity[];
  completedCount: number;
  failedCount: number;
  observedActivityCount: number;
  toolCallCount: number;
  /** Epoch milliseconds of the newest activity, or 0 when there is none. */
  lastActivityAt: number;
}

/** Compose the aggregate view of the retained rows. */
export function aggregateActivities(input: AggregateInput): Aggregated {
  const rows = input.rows;
  const recent = rows.slice(0, Math.max(0, input.recentLimit));
  const active: OrbitActivity[] = [];
  let completed = 0;
  let failed = 0;
  let tools = 0;
  let lastActivityAt = 0;

  for (const row of rows) {
    if (row.status === 'running') active.push(row);
    else if (row.status === 'success') completed += 1;
    else if (row.status === 'failed') failed += 1;
    if (row.source === 'tool' || row.source === 'approval') tools += 1;
    const moment = row.finishedAt ?? row.startedAt;
    if (moment > lastActivityAt) lastActivityAt = moment;
  }

  return {
    recentActivities: recent,
    activeActivities: active,
    completedCount: completed,
    failedCount: failed,
    observedActivityCount: rows.length,
    toolCallCount: tools,
    lastActivityAt,
  };
}

/**
 * One sentence about the newest real action, e.g. `修改文件 · report.md`.
 *
 * Only `label` and the already-redacted `safeTarget` are used, so this can
 * never echo a raw argument or a path.
 */
export function currentActionOf(rows: readonly OrbitActivity[]): string | undefined {
  const newest = rows[0];
  if (newest === undefined) return undefined;
  const label = typeof newest.label === 'string' && newest.label !== '' ? newest.label : undefined;
  if (label === undefined) return undefined;
  const target = newest.safeTarget;
  return typeof target === 'string' && target !== '' ? `${label} · ${target}` : label;
}
