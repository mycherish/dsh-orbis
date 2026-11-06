/**
 * The five-node legend under the orb: which colour means read, write, edit,
 * error and a generic tool call. Kept as its own module because it is pure
 * vocabulary and never touches snapshot data.
 */
import * as React from 'react';
import { CATEGORIES } from './format';
import { cssVars } from './styles';
import { LABELS } from './labels';

export function NodeLegend(): React.ReactElement {
  return (
    <ul className="no-legend" aria-label={LABELS.panel.legendTitle}>
      <li className="no-legend-title" aria-hidden="true">
        {LABELS.panel.legendMicro}
      </li>
      {CATEGORIES.map((category) => (
        <li className="no-legend-item" key={category.key}>
          <span
            className="no-legend-swatch"
            style={cssVars({ '--no-cat': category.color })}
            aria-hidden="true"
          />
          <span className="no-legend-label">{category.label}</span>
        </li>
      ))}
    </ul>
  );
}
