/**
 * The overlay mode machine — the single source of truth for "what is on screen".
 *
 * The plugin has exactly one `shell.overlay` entry, and that entry renders
 * exactly one of four mutually exclusive surfaces (spec: 统一为单一 Overlay
 * Root). Keeping the decision in a pure function is what makes the exclusivity
 * testable without a DOM:
 *
 *   compact   → one orb only
 *   expanded  → the HUD, whose ball is the same single orb
 *   workspace → the detailed panel, whose ball is the same single orb
 *   hidden    → nothing floating at all
 *
 * There is no mode in which an orb and a second floating orb coexist, because
 * `surfacesOf()` can never return `orb: 2`.
 */
import type { OrbitDisplayMode } from './contracts';
import type { OrbitAgentState } from '../shared/protocol';

export type OverlayMode = 'compact' | 'expanded' | 'workspace' | 'hidden';

export interface OverlayInput {
  /** Master switch. Off means hidden, with no subscription and no GPU work. */
  enabled: boolean;
  displayMode: OrbitDisplayMode;
  /** Show the always-on panel at all (off ⇒ energy ball only). */
  showHud: boolean;
  /** Allow the detailed Workspace panel. */
  showWorkspace: boolean;
  /** Workspace open. */
  open: boolean;
  /** User hid the floating surface with ×. */
  visible: boolean;
  /** The user folded the panel by hand; only a click clears it. */
  collapsed: boolean;
  /** Pin keeps the panel expanded while the Agent is idle. */
  pinned: boolean;
  /** Current Agent state. */
  state: OrbitAgentState;
}

/** States that mean "the Agent is doing something worth a panel". */
export function isActiveState(state: OrbitAgentState): boolean {
  return state !== 'idle' && state !== 'quiet';
}

/**
 * Resolve the one active mode.
 *
 * Order matters: the master switch and an explicit hide win over everything; an
 * open Workspace wins over the panel; an explicit display mode wins over
 * automatic expansion.
 */
export function overlayModeOf(input: OverlayInput): OverlayMode {
  if (!input.enabled) return 'hidden';
  if (!input.visible) return 'hidden';
  if (input.open && input.showWorkspace) return 'workspace';
  // `compact` and `orb` both mean "ball only"; `showHud: false` says the same.
  if (input.displayMode === 'compact' || input.displayMode === 'orb' || !input.showHud) return 'compact';
  const wantsPanel = input.pinned || isActiveState(input.state);
  return wantsPanel && !input.collapsed ? 'expanded' : 'compact';
}

/** Which surfaces one mode may mount. `orb` is a count, and it is never above 1. */
export interface OverlaySurfaces {
  mode: OverlayMode;
  orb: 0 | 1;
  hud: boolean;
  workspace: boolean;
  /** The tiny restore dot after the user hid the orb; not an orb. */
  restore: boolean;
}

/** Map a mode to what may be mounted for it. */
export function surfacesOf(mode: OverlayMode): OverlaySurfaces {
  switch (mode) {
    case 'compact':
      return { mode, orb: 1, hud: false, workspace: false, restore: false };
    case 'expanded':
      return { mode, orb: 1, hud: true, workspace: false, restore: false };
    case 'workspace':
      return { mode, orb: 1, hud: false, workspace: true, restore: false };
    case 'hidden':
    default:
      return { mode: 'hidden', orb: 0, hud: false, workspace: false, restore: false };
  }
}

/**
 * The restore affordance is the *only* thing hidden mode may show, and only
 * when the user hid a still-enabled plugin (otherwise there is no way back).
 */
export function showsRestoreDot(
  input: Pick<OverlayInput, 'enabled' | 'visible'>,
  mode: OverlayMode,
): boolean {
  return mode === 'hidden' && input.enabled && !input.visible;
}

/** Total number of orb instances a mode may have mounted. Always 0 or 1. */
export function orbCountOf(mode: OverlayMode): 0 | 1 {
  return surfacesOf(mode).orb;
}
