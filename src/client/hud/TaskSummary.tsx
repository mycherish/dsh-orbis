/**
 * The identity block: the 3D energy ball on the left, the task title / phase /
 * current action on the right.
 *
 * The canvas here is **only a surface**: the shell (layer.tsx) creates the one
 * WebGL renderer that draws into it and disposes it on unmount. This component
 * never touches three.js, so a second context can never appear by accident.
 */
import * as React from 'react';
import type { OrbitAgentState, OrbitTaskContext } from '../../shared/protocol';
import { phaseTextOf, taskTitleOf } from './progress';

export interface TaskSummaryProps {
  task: OrbitTaskContext | null;
  /** Used only to keep the fallback sentence honest before the first snapshot. */
  state: OrbitAgentState;
  /** Hand the ball canvas to the shell; called with `null` on unmount. */
  bindOrbCanvas: (canvas: HTMLCanvasElement | null) => void;
  /** WebGL could not start: draw the static dot instead of a blank square. */
  orbUnavailable?: boolean;
  /** No spinning orbit ring when the user asked for reduced motion. */
  reduceMotion: boolean;
}

function TaskSummaryImpl(props: TaskSummaryProps): React.ReactElement {
  const ball = React.useCallback(
    (canvas: HTMLCanvasElement | null): void => props.bindOrbCanvas(canvas),
    [props.bindOrbCanvas],
  );

  const title = taskTitleOf(props.task);
  const phase = phaseTextOf(props.task, props.state);
  const rawAction = props.task?.currentAction;
  const action = typeof rawAction === 'string' ? rawAction.trim() : '';

  return (
    <section className="no-hud-summary" aria-label="当前任务">
      <div className="no-hud-ball">
        <canvas
          ref={ball}
          className="no-hud-ball-canvas"
          role="img"
          aria-label="Agent 3D 能量球"
        />
        {props.orbUnavailable === true ? (
          <span className="no-hud-ball-fallback" aria-hidden="true">
            <i />
          </span>
        ) : null}
        <span className="no-hud-ball-ring" aria-hidden="true" />
        {props.reduceMotion ? null : <span className="no-hud-ball-spin" aria-hidden="true" />}
      </div>
      <div className="no-hud-meta">
        <h2
          className="no-hud-title"
          data-fallback={title.fallback ? 'true' : 'false'}
          title={title.text}
        >
          {title.text}
        </h2>
        <p className="no-hud-phase">{phase}</p>
        {action === '' ? null : (
          <p className="no-hud-action" title={action}>
            {action}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Memoised so the one-second clock tick in the shell never re-runs the canvas
 * ref: a changing ref identity would make the shell dispose and rebuild the
 * renderer every second.
 */
export const TaskSummary = React.memo(TaskSummaryImpl);
