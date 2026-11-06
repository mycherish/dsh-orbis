/**
 * 「当前状态」: exactly one sentence, plus the plan step when — and only when —
 * the Agent actually published one.
 *
 * The sentence order is the truth order of `currentStatusText()`: the Host's
 * silence reminder (when the user kept that switch on), then the newest real
 * action, then a fixed sentence for the state. Nothing here ever claims the
 * Agent is stuck or unresponsive.
 */
import * as React from 'react';
import type { OrbitAgentState, OrbitTaskContext } from '../../shared/protocol';
import { currentStatusText, nextStepLabel } from './progress';

export interface CurrentStatusProps {
  task: OrbitTaskContext | null;
  state: OrbitAgentState;
  /** `settings.showSilenceAlert`: the user can silence the reminder for good. */
  showSilenceAlert: boolean;
}

function InfoIcon(): React.ReactElement {
  return (
    <svg className="no-hud-status-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.2v3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="5.1" r="0.85" fill="currentColor" />
    </svg>
  );
}

function StatusDotIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.45" />
    </svg>
  );
}

export function CurrentStatus(props: CurrentStatusProps): React.ReactElement {
  const sentence = currentStatusText(props.task, props.state, props.showSilenceAlert);
  const next = nextStepLabel(props.task);

  return (
    <section className="no-hud-section" aria-label="当前状态">
      <h3 className="no-hud-section-head" data-kind="status">
        <StatusDotIcon />
        当前状态
      </h3>
      <div className="no-hud-status">
        <InfoIcon />
        <p className="no-hud-status-text" aria-live="polite">
          {sentence}
        </p>
      </div>
      {next === undefined ? null : (
        <p className="no-hud-next" title={next}>
          <b>下一步：</b>
          <span>{next}</span>
        </p>
      )}
    </section>
  );
}
