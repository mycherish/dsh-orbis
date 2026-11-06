/**
 * The right-hand activity stream: newest-first rows, an empty state for a live
 * but silent session, and a skeleton for the moments before the first snapshot.
 */
import * as React from 'react';
import type { OrbitActivity } from '../../shared/protocol';
import { activityVisual, formatDuration, kindAddsInfo, relativeTime, statusColor } from './format';
import { cssVars } from './styles';
import { LABELS } from './labels';

export interface ActivityListProps {
  /** Already capped and already newest-first (the Host sorts, we never reverse). */
  rows: readonly OrbitActivity[];
  /** Ticking clock, so every row's "12s" stays honest. */
  now: number;
  /** True before the first snapshot arrives. */
  loading: boolean;
}

const SKELETON_WIDTHS = ['68%', '52%', '78%', '44%', '60%'];
const SKELETON_ROWS = 5;

export function ActivityList(props: ActivityListProps): React.ReactElement {
  if (props.loading) {
    return (
      <div className="no-skeleton" aria-hidden="true">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <div className="no-skel-row" key={index}>
            <span className="no-skel-badge no-shimmer" />
            <span className="no-skel-lines">
              <span
                className="no-skel-l1 no-shimmer"
                style={cssVars({ '--no-w': SKELETON_WIDTHS[index] ?? '56%' })}
              />
              <span className="no-skel-l2 no-shimmer" />
            </span>
            <span className="no-skel-time no-shimmer" />
          </div>
        ))}
        <div className="no-skel-foot">
          <p className="no-skel-foot-title">{LABELS.empty.loadingTitle}</p>
          <p className="no-skel-foot-hint">{LABELS.empty.loadingHint}</p>
        </div>
      </div>
    );
  }

  if (props.rows.length === 0) {
    return (
      <div className="no-empty">
        <span className="no-empty-orb no-breathe" aria-hidden="true" />
        <p className="no-empty-title">{LABELS.empty.idleTitle}</p>
        <p className="no-empty-sub">{LABELS.empty.idleHint}</p>
      </div>
    );
  }

  return (
    <ol className="no-list">
      {props.rows.map((row) => (
        <ActivityRow key={row.id} row={row} now={props.now} />
      ))}
    </ol>
  );
}

interface ActivityRowProps {
  row: OrbitActivity;
  now: number;
}

function ActivityRow({ row, now }: ActivityRowProps): React.ReactElement {
  const visual = activityVisual(row);
  const running = row.status === 'running';
  const name = row.label.trim() === '' ? LABELS.units.empty : row.label;
  /**
   * The family word *is* the row's name for every classified tool row, so the
   * second line repeated it verbatim (`执行测试` over `执行测试 · 2.1s`). Keep it
   * only when it says something the name does not: a redacted row, whose name is
   * masked, or an unclassified tool, where the name is the raw tool id.
   */
  const kind = kindAddsInfo(visual.kind, name) ? visual.kind : undefined;
  const duration = typeof row.duration === 'number' ? formatDuration(row.duration) : undefined;
  const hasSub = kind !== undefined || visual.target !== undefined || duration !== undefined;

  return (
    <li className="no-row" data-redacted={row.redacted === true ? 'true' : 'false'}>
      <span className="no-badge" style={cssVars({ '--no-cat': visual.color })} aria-hidden="true">
        {visual.glyph}
      </span>
      <span className="no-row-main">
        <span className="no-row-name">{name}</span>
        {hasSub ? (
          <span className="no-row-sub">
            {kind === undefined ? null : <span className="no-row-kind">{kind}</span>}
            {visual.target ? (
              <span className="no-row-target" title={visual.target}>
                {visual.target}
              </span>
            ) : null}
            {duration === undefined ? null : <span className="no-row-dur">{duration}</span>}
          </span>
        ) : null}
      </span>
      <span className="no-row-meta">
        <span
          className={running ? 'no-row-dot no-pulse' : 'no-row-dot'}
          style={cssVars({ '--no-status': statusColor(row.status) })}
          aria-hidden="true"
        />
        <span className="no-row-time">{relativeTime(row.startedAt, now)}</span>
      </span>
    </li>
  );
}
