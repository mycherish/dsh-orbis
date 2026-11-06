/**
 * Client state: one zustand store for the snapshot, the transport state, the
 * panel visibility and the user's animation settings. Settings and the
 * launcher position are mirrored into `localStorage`; nothing else is stored.
 */
import { create } from 'zustand';
import {
  DEFAULT_SETTINGS,
  type OrbitConnection,
  type OrbitSettings,
} from './contracts';
import type { OrbitSnapshot } from '../shared/protocol';

const SETTINGS_KEY = 'neural-orbit.settings.v1';
const POSITION_KEY = 'neural-orbit.launcher.v1';

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

export function loadSettings(): OrbitSettings {
  const store = storage();
  if (store === undefined) return { ...DEFAULT_SETTINGS };
  try {
    const raw = store.getItem(SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<OrbitSettings>;
    return {
      fps: parsed.fps === 60 ? 60 : 30,
      particles: parsed.particles === 'low' || parsed.particles === 'high' ? parsed.particles : 'medium',
      rings: typeof parsed.rings === 'boolean' ? parsed.rings : DEFAULT_SETTINGS.rings,
      glow: typeof parsed.glow === 'boolean' ? parsed.glow : DEFAULT_SETTINGS.glow,
      reduceMotion:
        parsed.reduceMotion === 'on' || parsed.reduceMotion === 'off' ? parsed.reduceMotion : 'system',
      pauseWhenHidden:
        typeof parsed.pauseWhenHidden === 'boolean' ? parsed.pauseWhenHidden : DEFAULT_SETTINGS.pauseWhenHidden,
    };
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

  setSnapshot: (snapshot: OrbitSnapshot | null) => void;
  setConnection: (connection: OrbitConnection) => void;
  patchSettings: (patch: Partial<OrbitSettings>) => void;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setVisible: (visible: boolean) => void;
  setPosition: (position: LauncherPosition) => void;
  setFps: (fps: number) => void;
}

export const useOrbitStore = create<OrbitStoreState>((set, get) => ({
  snapshot: null,
  connection: 'connecting',
  settings: loadSettings(),
  open: false,
  visible: true,
  position: loadPosition(),
  fps: 0,

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
    const next = { ...get().settings, ...patch };
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
}));
