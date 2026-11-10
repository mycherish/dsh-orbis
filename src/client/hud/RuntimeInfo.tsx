/**
 * The two info pills under the title: how long this task has been running, and
 * the honest statement that the HUD spends no tokens.
 *
 * Both strings come from pure helpers (`runtimePills`), so the pill is a
 * straight render with no formatting logic of its own. `now` is handed down by
 * the shell's one-second tick — this component never reads the clock.
 */
import * as React from 'react';
import type { OrbitConnection } from '../contracts';
import type { OrbitTaskContext } from '../../shared/protocol';
import { RUNTIME_MODE_LABEL, formatElapsed, runtimePills } from './progress';

export interface RuntimeInfoProps {
  task: OrbitTaskContext | null;
  connection: OrbitConnection;
  /** Epoch ms from the shell's ticker; keeps 运行时长 honest without a second timer. */
  now: number;
}

function ClockIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.9" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.6V8l2.4 1.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function DiamondIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 2.4 13.6 8 8 13.6 2.4 8 8 2.4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function RuntimeInfo(props: RuntimeInfoProps): React.ReactElement {
  const pills =
    props.task === null
      ? { elapsed: formatElapsed(0), mode: RUNTIME_MODE_LABEL }
      : runtimePills(props.task, props.connection, props.now);

  return (
    <div className="no-hud-pills">
      <span className="no-hud-pill" data-kind="time" title="本次任务已运行时长">
        <ClockIcon />
        <span className="no-hud-pill-label">运行中</span>
        <span className="no-hud-pill-value">{pills.elapsed}</span>
      </span>
      <span className="no-hud-pill" data-kind="mode" title="本插件不调用模型，因此没有额外 Token 消耗">
        <DiamondIcon />
        {pills.mode}
      </span>
    </div>
  );
}
