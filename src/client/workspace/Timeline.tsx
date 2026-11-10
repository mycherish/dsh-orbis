/**
 * The footer timeline: every event timestamp normalised onto one thin rail.
 *
 * Ticks alternate above and below the centre line so a burst of activity reads
 * as a waveform instead of a solid block, and the fill/head show how far the
 * session has actually run.
 */
import * as React from 'react';
import type { TimelineModel } from './format';
import { cssVars } from './styles';
import { LABELS } from './labels';

export interface TimelineProps {
  model: TimelineModel;
  /** Colour of the leading edge — always the current Agent state colour. */
  stateColor: string;
}

export function Timeline({ model, stateColor }: TimelineProps): React.ReactElement {
  return (
    <div
      className="no-rail"
      data-empty={model.empty ? 'true' : 'false'}
      role="img"
      aria-label={`${LABELS.panel.railAria} · ${model.span}`}
    >
      <span className="no-rail-mid" />
      {model.empty ? null : <span className="no-rail-fill" style={cssVars({ width: `${model.headPct}%` })} />}
      {model.marks.map((mark) => (
        <span
          className="no-rail-mark"
          key={mark.id}
          data-side={mark.side}
          data-active={mark.active ? 'true' : 'false'}
          style={cssVars({
            '--no-mark': mark.color,
            left: `${mark.leftPct}%`,
            height: `${mark.heightPct}%`,
          })}
        />
      ))}
      {model.empty ? null : (
        <span
          className="no-rail-head"
          style={cssVars({ '--no-state': stateColor, left: `${model.headPct}%` })}
        />
      )}
    </div>
  );
}
