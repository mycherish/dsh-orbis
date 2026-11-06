/**
 * The three glyphs the Workspace panel draws itself, as inline SVG.
 *
 * They are inline (not icon fonts, not images) so they inherit no external
 * request, stay crisp at any DPR, and can take their colours straight from the
 * palette instead of hard-coded strokes.
 */
import * as React from 'react';
import { ORBIT_PALETTE } from '../contracts';

/** Small orbit mark next to the wordmark: a core and two inclined rings. */
export function OrbitMark(): React.ReactElement {
  return (
    <svg className="no-mark" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="3.1" fill={ORBIT_PALETTE.cyan} opacity="0.95" />
      <circle cx="11.1" cy="11" r="1.35" fill={ORBIT_PALETTE.label} opacity="0.9" />
      <ellipse
        cx="12"
        cy="12"
        rx="9.3"
        ry="3.9"
        fill="none"
        stroke={ORBIT_PALETTE.blue}
        strokeWidth="1.05"
        strokeOpacity="0.72"
        transform="rotate(-26 12 12)"
      />
      <ellipse
        cx="12"
        cy="12"
        rx="9.3"
        ry="3.9"
        fill="none"
        stroke={ORBIT_PALETTE.purple}
        strokeWidth="1.05"
        strokeOpacity="0.56"
        transform="rotate(34 12 12)"
      />
      <circle cx="20.4" cy="8.1" r="1" fill={ORBIT_PALETTE.label} opacity="0.85" />
    </svg>
  );
}

/** Close cross, drawn with two strokes so it stays pixel-crisp. */
export function CloseIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path
        d="M3.4 3.4 L10.6 10.6 M10.6 3.4 L3.4 10.6"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/** Settings glyph: two sliders with knobs. */
export function SlidersIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3.2 5.4 H12.8 M4.4 10.6 H13.6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
        opacity="0.62"
      />
      <circle cx="6.4" cy="5.4" r="1.8" fill="currentColor" />
      <circle cx="9.6" cy="10.6" r="1.8" fill="currentColor" />
    </svg>
  );
}
