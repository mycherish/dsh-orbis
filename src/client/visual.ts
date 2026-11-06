/**
 * Derivation from wire data to renderer inputs.
 *
 * Kept free of React and three.js so both the shell and (if needed) the orb
 * module can be reasoned about independently.
 */
import {
  type OrbQuality,
  type OrbVisualState,
  type OrbitConnection,
  type OrbitSettings,
} from './contracts';
import type { OrbitAgentState, OrbitSnapshot } from '../shared/protocol';

/** Base visual energy of each state, before recent-activity boost. */
const STATE_INTENSITY: Record<OrbitAgentState, number> = {
  idle: 0.08,
  starting: 0.3,
  thinking: 0.5,
  preparing: 0.42,
  executing: 0.8,
  responding: 0.66,
  waiting: 0.35,
  quiet: 0.16,
  interrupted: 0.3,
  error: 0.9,
  completed: 0.62,
};

const RECENT_WINDOW_MS = 8000;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** What the orb draws for one snapshot. */
export function deriveVisual(
  snapshot: OrbitSnapshot | null,
  connection: OrbitConnection,
): OrbVisualState {
  if (snapshot === null) {
    return {
      agentState: 'idle',
      activeTools: 0,
      intensity: connection === 'open' ? 0.08 : 0.02,
      streaming: false,
    };
  }
  const now = Date.now();
  const recent = snapshot.events.filter((event) => now - event.startedAt <= RECENT_WINDOW_MS).length;
  const boost = Math.min(0.25, recent * 0.03);
  return {
    agentState: snapshot.agentState,
    activeTools: snapshot.activeTools,
    intensity: clamp01(STATE_INTENSITY[snapshot.agentState] + boost),
    streaming: connection === 'open' && snapshot.agentState !== 'idle',
  };
}

/** Resolve the user's settings plus the OS preference into renderer knobs. */
export function resolveQuality(settings: OrbitSettings, systemReduceMotion: boolean): OrbQuality {
  const reduceMotion =
    settings.reduceMotion === 'system' ? systemReduceMotion : settings.reduceMotion === 'on';
  // Low-performance posture: honour reduce-motion by shedding the expensive parts.
  return {
    fps: settings.fps,
    particles: reduceMotion ? 'low' : settings.particles,
    rings: settings.rings,
    glow: reduceMotion ? false : settings.glow,
    reduceMotion,
  };
}

/** True when the OS asks for reduced motion; safe when `matchMedia` is absent. */
export function prefersReduceMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/** Subscribe to the OS reduce-motion preference. */
export function watchReduceMotion(onChange: (reduce: boolean) => void): () => void {
  try {
    const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (query === undefined || typeof query.addEventListener !== 'function') return () => {};
    const listener = (event: MediaQueryListEvent): void => onChange(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  } catch {
    return () => {};
  }
}

/** The one Session the overlay follows: whatever the main column displays. */
export function selectDisplayedSession(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const byId = (state as { byId?: unknown }).byId;
  if (typeof byId !== 'object' || byId === null) return undefined;
  const rows = byId as Record<string, unknown>;
  for (const id of Object.keys(rows)) {
    const row = rows[id];
    if (typeof row !== 'object' || row === null) continue;
    const retained = (row as { retainedBy?: unknown }).retainedBy;
    if (typeof retained !== 'object' || retained === null) continue;
    const mainView = (retained as { mainView?: unknown }).mainView;
    if (typeof mainView === 'number' && mainView > 0) return id;
  }
  return undefined;
}
