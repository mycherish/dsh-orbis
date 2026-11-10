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
  /** Allow the detailed Workspace panel. */
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
  if (input.open) return 'workspace';
  /*
   * The three modes have to mean three different things — they did not.
   *
   * `compact` and `orb` both fell through to the same ball-only mode, and a
   * 「常驻进度卡」 switch produced that mode a third time; the compact *chip* the
   * stylesheet styles only ever appeared when `auto` happened to be idle. Now:
   *
   *   auto    — the panel while the Agent works, the chip while it is idle;
   *   compact — always the chip (one line of text, no WebGL at all);
   *   orb     — always the 76px ball, nothing else.
   *
   * `compact` therefore mounts the HUD (which renders its chip) rather than the
   * launcher; `orb` is the only mode that mounts the launcher.
   */
  if (input.displayMode === 'orb') return 'compact';
  if (input.displayMode === 'compact') return 'expanded';
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

/**
 * Should the surfaces draw the static fallback instead of the live canvas?
 *
 * Two situations, one answer:
 *  - the renderer died (a browser-initiated context loss) — there is nothing to draw;
 *  - the user turned 「3D 动画」 off — the *setting* promises "只保留静态球体", and
 *    the only `renderer.render()` lives inside the rAF loop, so with animation off
 *    nothing is ever drawn and the slot would be blank rather than still.
 */
export function usesStaticOrb(input: { failed: boolean; animate: boolean }): boolean {
  return input.failed || !input.animate;
}

/** Total number of orb instances a mode may have mounted. Always 0 or 1. */
export function orbCountOf(mode: OverlayMode): 0 | 1 {
  return surfacesOf(mode).orb;
}
