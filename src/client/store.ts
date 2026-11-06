/**
 * Client state: one zustand store for the snapshot, the transport state, the
 * panel visibility, the user's animation settings and the HUD collapse flag.
 * Settings and the launcher position are mirrored into `localStorage`;
 * nothing else is stored.
 *
 * Settings live under a versioned key: `neural-orbit.settings.v2`. v1 payloads
 * (six animation fields, no master switch) are still read once and migrated, so
 * an upgrade never resets the user's choices and never throws.
 */
import { create } from 'zustand';
import {
  DEFAULT_SETTINGS,
  type OrbitConnection,
  type OrbitSettings,
} from './contracts';
import type { OrbitSnapshot } from '../shared/protocol';

/** Exported so the migration test pins the exact legacy key it must read. */
export const SETTINGS_KEY = 'neural-orbit.settings.v2';
/** v1 payload: the six animation fields only, no master switch. */
export const LEGACY_SETTINGS_KEY = 'neural-orbit.settings.v1';
export const POSITION_KEY = 'neural-orbit.launcher.v1';
export const HUD_KEY = 'neural-orbit.hud.v1';

export interface LauncherPosition {
  /** Distance from the right edge, in CSS pixels. */
  right: number;
  /** Distance from the bottom edge, in CSS pixels. */
  bottom: number;
}

export const DEFAULT_POSITION: LauncherPosition = { right: 24, bottom: 24 };

function storage(): Storage | undefined {
  try {
    const candidate = globalThis.localStorage;
    if (candidate === undefined || candidate === null) return undefined;
    const probe = '__neural_orbit_probe__';
    candidate.setItem(probe, '1');
    candidate.removeItem(probe);
    return candidate;
  } catch {
    return undefined;
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Coerce anything that came out of storage into a complete `OrbitSettings`.
 * Missing fields fall back to `DEFAULT_SETTINGS`, illegal values fall back per
 * field, and unknown keys are dropped. Pure: no storage access, never throws.
 */
export function sanitizeSettings(raw: unknown): OrbitSettings {
  const source: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const displayMode =
    source.displayMode === 'auto' || source.displayMode === 'compact' || source.displayMode === 'orb'
      ? source.displayMode
      : DEFAULT_SETTINGS.displayMode;
  return {
    enabled: pickBoolean(source.enabled, DEFAULT_SETTINGS.enabled),
    displayMode,
    showHud: pickBoolean(source.showHud, DEFAULT_SETTINGS.showHud),
    showActivity: pickBoolean(source.showActivity, DEFAULT_SETTINGS.showActivity),
    fps: source.fps === 60 ? 60 : 30,
    particles:
      source.particles === 'low' || source.particles === 'medium' || source.particles === 'high'
        ? source.particles
        : DEFAULT_SETTINGS.particles,
    rings: pickBoolean(source.rings, DEFAULT_SETTINGS.rings),
    glow: pickBoolean(source.glow, DEFAULT_SETTINGS.glow),
    reduceMotion:
      source.reduceMotion === 'on' || source.reduceMotion === 'off' || source.reduceMotion === 'system'
        ? source.reduceMotion
        : DEFAULT_SETTINGS.reduceMotion,
    pauseWhenHidden: pickBoolean(source.pauseWhenHidden, DEFAULT_SETTINGS.pauseWhenHidden),
  };
}

/** Parse one raw localStorage string into settings; a bad payload means defaults. */
export function parseSettings(raw: string | null): OrbitSettings {
  if (raw === null) return { ...DEFAULT_SETTINGS };
  try {
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Read settings: v2 first, then the v1 payload (migrated forward in place so the
 * next read is a v2 hit), then the defaults.
 */
export function loadSettings(): OrbitSettings {
  const store = storage();
  if (store === undefined) return { ...DEFAULT_SETTINGS };
  try {
    const current = store.getItem(SETTINGS_KEY);
    if (current !== null) return parseSettings(current);
    const legacy = store.getItem(LEGACY_SETTINGS_KEY);
    if (legacy === null) return { ...DEFAULT_SETTINGS };
    const migrated = parseSettings(legacy);
    // Best effort: keep the v1 payload untouched, add the v2 mirror.
    try {
      store.setItem(SETTINGS_KEY, JSON.stringify(migrated));
    } catch {
      // Quota or privacy mode: the in-memory value is still correct.
    }
    return migrated;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: OrbitSettings): void {
  const store = storage();
  if (store === undefined) return;
  try {
    store.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Quota or privacy mode: keep working in memory.
  }
}

/**
 * The HUD's manual collapse flag. Persisted on its own key so a collapsed card
 * stays collapsed across reloads and never re-expands on a new event.
 */
export function loadHudCollapsed(): boolean {
  const store = storage();
  if (store === undefined) return false;
  try {
    const raw = store.getItem(HUD_KEY);
    if (raw === null) return false;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'boolean') return parsed;
    if (typeof parsed === 'object' && parsed !== null) {
      return pickBoolean((parsed as { collapsed?: unknown }).collapsed, false);
    }
    return false;
  } catch {
    return false;
  }
}

export function saveHudCollapsed(collapsed: boolean): void {
  const store = storage();
  if (store === undefined) return;
  try {
    store.setItem(HUD_KEY, JSON.stringify({ collapsed }));
  } catch {
    // Ignore: the flag is a convenience, not data.
  }
}

export function loadPosition(): LauncherPosition {
  const store = storage();
  if (store === undefined) return { ...DEFAULT_POSITION };
  try {
    const raw = store.getItem(POSITION_KEY);
    if (raw === null) return { ...DEFAULT_POSITION };
    const parsed = JSON.parse(raw) as Partial<LauncherPosition>;
    return {
      right: clamp(parsed.right, 8, 4000, DEFAULT_POSITION.right),
      bottom: clamp(parsed.bottom, 8, 4000, DEFAULT_POSITION.bottom),
    };
  } catch {
    return { ...DEFAULT_POSITION };
  }
}

export function savePosition(position: LauncherPosition): void {
  const store = storage();
  if (store === undefined) return;
  try {
    store.setItem(POSITION_KEY, JSON.stringify(position));
  } catch {
    // Ignore: the position is a convenience, not data.
  }
}

export interface OrbitStoreState {
  snapshot: OrbitSnapshot | null;
  connection: OrbitConnection;
  settings: OrbitSettings;
  /** Workspace panel open. */
  open: boolean;
  /** Launcher visible; `false` after the user hides it. */
  visible: boolean;
  position: LauncherPosition;
  fps: number;
  /** The user folded the always-on card by hand; only a click unfolds it. */
  hudCollapsed: boolean;

  setSnapshot: (snapshot: OrbitSnapshot | null) => void;
  setConnection: (connection: OrbitConnection) => void;
  patchSettings: (patch: Partial<OrbitSettings>) => void;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setVisible: (visible: boolean) => void;
  setPosition: (position: LauncherPosition) => void;
  setFps: (fps: number) => void;
  setHudCollapsed: (collapsed: boolean) => void;
}

export const useOrbitStore = create<OrbitStoreState>((set, get) => ({
  snapshot: null,
  connection: 'connecting',
  settings: loadSettings(),
  open: false,
  visible: true,
  position: loadPosition(),
  fps: 0,
  hudCollapsed: loadHudCollapsed(),

  setSnapshot: (snapshot) => {
    const current = get().snapshot;
    // Ignore out-of-order or duplicate frames.
    if (snapshot === null) {
      set({ snapshot: null });
      return;
    }
    if (current !== null && current.version === snapshot.version
      && current.sessionId === snapshot.sessionId
      && current.updatedAt === snapshot.updatedAt) {
      return;
    }
    set({ snapshot });
  },
  setConnection: (connection) => set({ connection }),
  patchSettings: (patch) => {
    const next = sanitizeSettings({ ...get().settings, ...patch });
    saveSettings(next);
    set({ settings: next });
  },
  setOpen: (open) => set({ open }),
  toggleOpen: () => set({ open: !get().open }),
  setVisible: (visible) => set({ visible }),
  setPosition: (position) => {
    savePosition(position);
    set({ position });
  },
  setFps: (fps) => {
    if (Math.abs(get().fps - fps) < 0.5) return;
    set({ fps });
  },
  setHudCollapsed: (collapsed) => {
    saveHudCollapsed(collapsed);
    set({ hudCollapsed: collapsed });
  },
}));
