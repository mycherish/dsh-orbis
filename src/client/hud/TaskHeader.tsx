/**
 * The HUD's title bar: logo ring, product name, live status pill, and the three
 * chrome buttons (工作区 / 固定 / 收起).
 *
 * The logo is an inline SVG on purpose — no image file to ship, and it inherits
 * `currentColor`-free explicit palette stops so it cannot be recoloured by a
 * host theme.
 */
import * as React from 'react';
import { ORBIT_PALETTE, type OrbitConnection } from '../contracts';
import type { OrbitAgentState } from '../../shared/protocol';
import { hudChipText } from './progress';

export interface TaskHeaderProps {
  /** Eleven-state vocabulary, drives the pill word and its motion. */
  state: OrbitAgentState;
  connection: OrbitConnection;
  /** The user pinned the panel; the pin button renders pressed + glowing. */
  pinned: boolean;
  onCollapse: () => void;
  onOpenWorkspace: () => void;
  onPin: (next: boolean) => void;
}

const P = ORBIT_PALETTE;

/**
 * Two concentric rings plus one off-axis satellite: the product mark.
 *
 * Exported so the collapsed chip draws the exact same mark at a smaller size
 * instead of carrying a second copy of the geometry.
 */
export function HudMark({ className }: { className: string }): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="no-hud-logo-stroke" x1="5" y1="4" x2="27" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={P.purple} />
          <stop offset="1" stopColor={P.blue} />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="12.1" fill="none" stroke="url(#no-hud-logo-stroke)" strokeWidth="1.5" />
      <ellipse
        cx="16"
        cy="16"
        rx="12.1"
        ry="5.1"
        fill="none"
        stroke={P.blue}
        strokeWidth="0.9"
        opacity="0.45"
        transform="rotate(-26 16 16)"
      />
      <circle cx="16" cy="16" r="4.4" fill="none" stroke={P.purple} strokeWidth="1.1" opacity="0.75" />
      <circle cx="16" cy="16" r="2.1" fill={P.purple} />
      <circle cx="26.1" cy="9.9" r="1.6" fill={P.cyan} />
    </svg>
  );
}

function MoreIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="3.4" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12.6" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}

function PinIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M6.1 1.7h3.8l-.55 3.2 2.45 2.25-.32 1.15H9.4v3.45L8 14.4l-1.4-2.65V8.3H4.52L4.2 7.15 6.65 4.9 6.1 1.7Z"
        fill="currentColor"
        opacity="0.95"
      />
    </svg>
  );
}

function CollapseIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3.7 9.9 8 5.7l4.3 4.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TaskHeader(props: TaskHeaderProps): React.ReactElement {
  const chip = hudChipText(props.state, props.connection);
  return (
    <header className="no-hud-head">
      <HudMark className="no-hud-logo" />
      <span className="no-hud-name">Caelum Orbis</span>
      <span className="no-hud-chip" role="status" aria-live="polite">
        <i className="no-hud-chip-dot" aria-hidden="true" />
        {chip}
      </span>
      <div className="no-hud-actions">
        {/*
         * Always present. It used to be gated on a `showWorkspace` switch that could
         * hide the panel *and* the settings sheet inside it, stranding the user with
         * no way back; the switch is gone, so the entry always is here.
         */}
        <button
          type="button"
          className="no-hud-ibtn"
          data-hud-open-workspace=""
          title="打开工作区"
          aria-label="打开工作区"
          onClick={props.onOpenWorkspace}
        >
          <MoreIcon />
        </button>
        <button
          type="button"
          className="no-hud-ibtn"
          aria-pressed={props.pinned}
          title={props.pinned ? '取消固定面板' : '固定面板'}
          aria-label={props.pinned ? '取消固定面板' : '固定面板'}
          onClick={() => props.onPin(!props.pinned)}
        >
          <PinIcon />
        </button>
        <button
          type="button"
          className="no-hud-ibtn"
          title="收起面板"
          aria-label="收起面板"
          onClick={props.onCollapse}
        >
          <CollapseIcon />
        </button>
      </div>
    </header>
  );
}
