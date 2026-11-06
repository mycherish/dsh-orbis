/**
 * Client state: one zustand store for the snapshot, the transport state, the
 * panel visibility, the user's animation settings and the HUD's own flags
 * (folded by hand / pinned).
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
 *
 * Booleans are collected by walking `DEFAULT_SETTINGS`, so a new switch costs
 * one line in `contracts.ts` instead of an edit here — and the result is always
 * a complete object, which is what makes `sanitizeSettings(x)` equal to
 * `DEFAULT_SETTINGS` for garbage input. The three unions (display mode, frame
 * rate, particle density, reduce-motion) are validated explicitly.
 * Pure: no storage access, never throws.
 */
export function sanitizeSettings(raw: unknown): OrbitSettings {
  const source: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof OrbitSettings)[]) {
    const fallback = DEFAULT_SETTINGS[key];
    if (typeof fallback === 'boolean') next[key] = pickBoolean(source[key], fallback);
  }
  next.displayMode =
    source.displayMode === 'auto' || source.displayMode === 'compact' || source.displayMode === 'orb'
      ? source.displayMode
      : DEFAULT_SETTINGS.displayMode;
  next.fps = source.fps === 60 ? 60 : 30;
  next.particles =
    source.particles === 'low' || source.particles === 'medium' || source.particles === 'high'
      ? source.particles
      : DEFAULT_SETTINGS.particles;
  next.reduceMotion =
    source.reduceMotion === 'on' || source.reduceMotion === 'off' || source.reduceMotion === 'system'
      ? source.reduceMotion
      : DEFAULT_SETTINGS.reduceMotion;
  return next as unknown as OrbitSettings;
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
 * The HUD's own two flags. They share one key (`neural-orbit.hud.v1`) and one
 * object, because they describe the same panel:
 *
 *  - `collapsed` — the user folded the card by hand; only a click unfolds it;
 *  - `pinned`    — the user pinned it open, so `auto` mode stops folding it
 *    while the Agent is idle.
 *
 * v2.0 wrote a bare boolean (`true`) and v2.1 wrote `{ collapsed }`; both are
 * still read, so an upgrade keeps the panel exactly as the user left it.
 */
export interface HudFlags {
  collapsed: boolean;
  pinned: boolean;
}

const HUD_FLAGS_IDLE: HudFlags = { collapsed: false, pinned: false };

function readHudFlags(): HudFlags {
  const store = storage();
  if (store === undefined) return { ...HUD_FLAGS_IDLE };
  try {
    const raw = store.getItem(HUD_KEY);
    if (raw === null) return { ...HUD_FLAGS_IDLE };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'boolean') return { collapsed: parsed, pinned: false };
    if (typeof parsed === 'object' && parsed !== null) {
      const row = parsed as { collapsed?: unknown; pinned?: unknown };
      return {
        collapsed: pickBoolean(row.collapsed, false),
        pinned: pickBoolean(row.pinned, false),
      };
    }
    return { ...HUD_FLAGS_IDLE };
  } catch {
    return { ...HUD_FLAGS_IDLE };
  }
}

/**
 * Write the pair, but **omit `pinned` when it is false**: a fold-only payload
 * stays byte-identical to what v2.1 wrote, which is what the persistence test
 * pins with a strict deep equality.
 */
function writeHudFlags(flags: HudFlags): void {
  const store = storage();
  if (store === undefined) return;
  const payload: { collapsed: boolean; pinned?: boolean } = { collapsed: flags.collapsed };
  if (flags.pinned) payload.pinned = true;
  try {
    store.setItem(HUD_KEY, JSON.stringify(payload));
  } catch {
    // Ignore: the flags are a convenience, not data.
  }
}

export function loadHudCollapsed(): boolean {
  return readHudFlags().collapsed;
}

export function loadHudPinned(): boolean {
  return readHudFlags().pinned;
}

export function saveHudCollapsed(collapsed: boolean, pinned: boolean = loadHudPinned()): void {
  writeHudFlags({ collapsed, pinned });
}

export function saveHudPinned(pinned: boolean, collapsed: boolean = loadHudCollapsed()): void {
  writeHudFlags({ collapsed, pinned });
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
  /** The user folded the always-on panel by hand; only a click unfolds it. */
  hudCollapsed: boolean;
  /** The user pinned the panel open: `auto` no longer folds it while idle. */
  hudPinned: boolean;

  setSnapshot: (snapshot: OrbitSnapshot | null) => void;
  setConnection: (connection: OrbitConnection) => void;
  patchSettings: (patch: Partial<OrbitSettings>) => void;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setVisible: (visible: boolean) => void;
  setPosition: (position: LauncherPosition) => void;
  setFps: (fps: number) => void;
  setHudCollapsed: (collapsed: boolean) => void;
  setHudPinned: (pinned: boolean) => void;
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
  hudPinned: loadHudPinned(),

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
    saveHudCollapsed(collapsed, get().hudPinned);
    set({ hudCollapsed: collapsed });
  },
  setHudPinned: (pinned) => {
    saveHudPinned(pinned, get().hudCollapsed);
    set({ hudPinned: pinned });
  },
}));
