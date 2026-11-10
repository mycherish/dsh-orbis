/**
 * 「最近活动」: at most five newest-first rows, each one glyph + text + clock +
 * status word.
 *
 * Everything a row may say comes from `activityText()` / `activityIcon()` /
 * `activityColor()`, so this file cannot leak a raw argument or path even if a
 * future Host sends one by mistake. A row whose target was masked by the Host
 * shows the single sentence 「读取敏感配置文件」 instead of a half-redacted name.
 */
import * as React from 'react';
import type { OrbitTaskContext } from '../../shared/protocol';
import {
  activityColor,
  activityIcon,
  activityStatusLabel,
  activityText,
  formatClock,
  hudActivityRows,
} from './progress';
import { cssVars } from './styles';

export interface ActivityTimelineProps {
  task: OrbitTaskContext | null;
}

function BoltIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M9.1 1.8 4.3 8.9h2.9l-.9 5.3 4.9-7.2H8.3l.8-5.2Z" fill="currentColor" opacity="0.92" />
    </svg>
  );
}

export function ActivityTimeline(props: ActivityTimelineProps): React.ReactElement {
  const rows = props.task === null ? [] : hudActivityRows(props.task);

  return (
    <section className="no-hud-section" aria-label="最近活动">
      <h3 className="no-hud-section-head">
        <BoltIcon />
        最近活动
      </h3>
      {rows.length === 0 ? (
        <p className="no-hud-empty">等待第一条活动…</p>
      ) : (
        <ol className="no-hud-rows">
          {rows.map((row) => {
            const text = activityText(row);
            const accent = activityColor(row.category, row.status);
            return (
              <li key={row.id} className="no-hud-row" style={cssVars({ '--no-hud-row': accent })}>
                <span className="no-hud-row-icon" aria-hidden="true">
                  {activityIcon(row.status)}
                </span>
                <span className="no-hud-row-text" title={text}>
                  {text}
                </span>
                <span className="no-hud-row-time">{formatClock(row.startedAt)}</span>
                <span className="no-hud-row-status">{activityStatusLabel(row.status)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
