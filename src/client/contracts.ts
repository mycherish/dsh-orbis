/**
 * Client-side contracts shared by the plugin shell and its two rendering
 * modules (the WebGL orb and the workspace UI).
 *
 * The shell owns lifecycle, transport and settings; these types only describe
 * the data those modules receive, so each module stays testable on its own.
 */
import type { OrbitAgentState, OrbitSnapshot } from '../shared/protocol';

/** The visual inputs derived from the snapshot by the shell. */
export interface OrbVisualState {
  agentState: OrbitAgentState;
  /** Tool calls currently in flight. */
  activeTools: number;
  /** 0..1 recent-activity density; drives pulse strength and particle speed. */
  intensity: number;
  /** True while the SSE stream is live and the Agent is producing events. */
  streaming: boolean;
}

export type ParticleDensity = 'low' | 'medium' | 'high';

/** Animation quality knobs (spec §2.6 / §7). */
export interface OrbQuality {
  /** Target frame rate; the renderer must not exceed it. */
  fps: number;
  particles: ParticleDensity;
  /** Orbital rings on/off. */
  rings: boolean;
  /** Bloom-ish glow on/off. */
  glow: boolean;
  /** Honour the OS reduce-motion preference: lower speed, no pulsing. */
  reduceMotion: boolean;
}

export interface OrbRendererOptions {
  canvas: HTMLCanvasElement;
  state: OrbVisualState;
  quality: OrbQuality;
}

/**
 * A renderer owns exactly one WebGL context and one animation loop. It is
 * created once per mounted canvas and must survive every state update.
 */
export interface OrbRenderer {
  setState(next: OrbVisualState): void;
  setQuality(next: OrbQuality): void;
  /** Start (or resume) the animation loop. Idempotent. */
  start(): void;
  /** Stop the animation loop and the GPU work it drives. Idempotent. */
  pause(): void;
  /** Re-read the canvas size and the device pixel ratio cap. */
  resize(): void;
  /** Release every GPU resource, listener and loop. Idempotent. */
  dispose(): void;
  /** Measured frames per second over the last second (0 while paused). */
  fps(): number;
}

/**
 * Creates the orb renderer, or returns `null` when WebGL is unavailable — in
 * which case the UI must fall back to a static status readout.
 */
export type CreateOrbRenderer = (options: OrbRendererOptions) => OrbRenderer | null;

/** Transport state of the SSE stream, surfaced in the Workspace header. */
export type OrbitConnection = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Props of the Workspace panel. The shell owns the SSE transport, the settings
 * store and the renderer; the panel only renders them.
 */
export interface WorkspaceViewProps {
  /** Latest snapshot, or `null` before the first frame arrives. */
  snapshot: OrbitSnapshot | null;
  connection: OrbitConnection;
  settings: OrbitSettings;
  /** Measured orb frame rate, shown in the footer. */
  fps: number;
  /**
   * True when the WebGL renderer could not be created (no WebGL context). The
   * panel must then draw a static status fallback over the canvas area instead
   * of leaving it blank.
   */
  orbUnavailable: boolean;
  /**
   * Hands the canvas the orb draws into to the shell; call with `null` when it
   * unmounts. The panel never creates the renderer itself.
   */
  bindOrbCanvas: (canvas: HTMLCanvasElement | null) => void;
  onSettingsChange: (patch: Partial<OrbitSettings>) => void;
  onClose: () => void;
}

/** Palette from the design spec (§3.1). Artwork may use its own colours. */
export const ORBIT_PALETTE = {
  bg: '#070B18',
  surface: '#10182B',
  glass: 'rgba(22, 34, 59, 0.72)',
  blue: '#42A5FF',
  cyan: '#48E5FF',
  purple: '#9875FF',
  success: '#50D9A0',
  warning: '#FFB95E',
  error: '#FF637C',
  label: '#E8EEFB',
  labelDim: '#93A4C4',
} as const;

/** One colour per Agent state, used by every surface (orb, chip, timeline dot). */
export const STATE_COLOR: Record<OrbitAgentState, string> = {
  idle: ORBIT_PALETTE.blue,
  starting: ORBIT_PALETTE.blue,
  thinking: ORBIT_PALETTE.purple,
  preparing: ORBIT_PALETTE.cyan,
  executing: ORBIT_PALETTE.cyan,
  responding: ORBIT_PALETTE.purple,
  waiting: ORBIT_PALETTE.warning,
  quiet: ORBIT_PALETTE.labelDim,
  interrupted: ORBIT_PALETTE.warning,
  error: ORBIT_PALETTE.error,
  completed: ORBIT_PALETTE.success,
};

/** Display modes for the always-on surface (spec §8: 自动展开 / 始终紧凑 / 仅能量球). */
export type OrbitDisplayMode = 'auto' | 'compact' | 'orb';

/** User-facing settings, persisted in localStorage by the shell. */
export interface OrbitSettings {
  /** The master switch: off means no listener, no stream, no GPU, no timer. */
  enabled: boolean;
  /** How the always-on surface behaves. */
  displayMode: OrbitDisplayMode;
  /** Show the always-on HUD at all. */
  showHud: boolean;
  /** Show the activity list inside the Workspace. */
  showActivity: boolean;
  /** Show the "最近活动" block inside the HUD. */
  showRecentActivity: boolean;
  /** Show the silence reminder when nothing has happened for a while. */
  showSilenceAlert: boolean;
  /** Allow opening the detailed Workspace panel. */
  showWorkspace: boolean;
  /** Keep the 3D orb animating (off = static sphere, zero GPU frames). */
  animate: boolean;
  fps: 30 | 60;
  particles: ParticleDensity;
  rings: boolean;
  glow: boolean;
  /** `system` follows `prefers-reduced-motion`. */
  reduceMotion: 'system' | 'on' | 'off';
  /** Pause the animation loop while the tab is hidden or the window unfocused. */
  pauseWhenHidden: boolean;
}

/** Renderer-side settings subset (everything the orb cares about). */
export type OrbAnimationSettings = Pick<
  OrbitSettings,
  'fps' | 'particles' | 'rings' | 'glow' | 'reduceMotion' | 'pauseWhenHidden' | 'animate'
>;

/** Defaults. The 30 FPS default keeps the always-on card cheap. */
export const DEFAULT_SETTINGS: OrbitSettings = {
  enabled: true,
  displayMode: 'auto',
  showHud: true,
  showActivity: true,
  showRecentActivity: true,
  showSilenceAlert: true,
  showWorkspace: true,
  animate: true,
  fps: 30,
  particles: 'medium',
  rings: true,
  glow: true,
  reduceMotion: 'system',
  pauseWhenHidden: true,
};

/** Workspace layout constants. */
export const WORKSPACE_SIZE = { width: 780, height: 600 } as const;
export const LAUNCHER_SIZE = 76 as const;

/** Always-on HUD geometry (spec §5.1: width 450–480, height content-driven). */
export const HUD_SIZE = { width: 470, minWidth: 420, maxWidth: 480, top: 118, side: 24 } as const;
