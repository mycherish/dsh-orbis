/**
 * The master switch's data side, tested without a DOM: settings migration from
 * the v1 key, garbage-tolerance, `enabled: false` survival, and the persisted
 * manual HUD fold.
 *
 * The store module is loaded with a four-line fake `zustand`, because
 * `zustand`'s React entry needs the `react` package and this repository does not
 * install it — the tests here cover persistence, not rendering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('zustand', () => {
  type AnyState = Record<string, unknown>;
  return {
    create: (initializer: (set: (partial: AnyState) => void, get: () => AnyState) => AnyState) => {
      let state = {} as AnyState;
      const listeners = new Set<() => void>();
      const set = (partial: AnyState): void => {
        state = { ...state, ...partial };
        for (const listener of listeners) listener();
      };
      const get = (): AnyState => state;
      state = initializer(set, get);
      const hook = (selector?: (current: AnyState) => unknown): unknown =>
        (typeof selector === 'function' ? selector(state) : state);
      return Object.assign(hook, {
        getState: get,
        setState: set,
        subscribe: (listener: () => void): (() => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      });
    },
  };
});

import { DEFAULT_SETTINGS } from '../src/client/contracts';
import {
  HUD_KEY,
  LEGACY_SETTINGS_KEY,
  POSITION_KEY,
  RENAMED_KEYS,
  SETTINGS_KEY,
  loadHudCollapsed,
  loadPosition,
  loadSettings,
  parseSettings,
  sanitizeSettings,
  saveHudCollapsed,
  saveSettings,
  useOrbitStore,
} from '../src/client/store';

class FakeStorage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    const value = this.map.get(key);
    return value === undefined ? null : value;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

let fake: FakeStorage;

function installStorage(): void {
  fake = new FakeStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: fake,
    configurable: true,
    writable: true,
  });
}

function uninstallStorage(): void {
  Reflect.deleteProperty(globalThis, 'localStorage');
}

/** The six fields a v1 payload could carry. */
const V1_PAYLOAD = {
  fps: 60,
  particles: 'high',
  rings: false,
  glow: false,
  reduceMotion: 'off',
  pauseWhenHidden: false,
} as const;

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  uninstallStorage();
});

describe('settings keys', () => {
  it('pins the keys the migration has to honour', () => {
    expect(SETTINGS_KEY).toBe('orbis.settings.v2');
    expect(LEGACY_SETTINGS_KEY).toBe('orbis.settings.v1');
    expect(HUD_KEY).toBe('orbis.hud.v1');
    expect(POSITION_KEY).toBe('orbis.launcher.v1');
  });
});

describe('pre-rename keys', () => {
  // The plugin shipped as `dsh-neural-orbit` up to v2.0.2. Anyone who installed
  // that build has their switches, their folded panel and their launcher
  // position under the old namespace, and a rename must not look like a reset.
  it('reads settings written under the old namespace', () => {
    fake.setItem(
      RENAMED_KEYS[SETTINGS_KEY] ?? '',
      JSON.stringify({ ...DEFAULT_SETTINGS, enabled: false, fps: 30 }),
    );
    const settings = loadSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.fps).toBe(30);
  });

  it('prefers the current key once anything has been written', () => {
    fake.setItem(RENAMED_KEYS[SETTINGS_KEY] ?? '', JSON.stringify({ ...DEFAULT_SETTINGS, fps: 30 }));
    fake.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, fps: 60 }));
    expect(loadSettings().fps).toBe(60);
  });

  it('keeps the folded panel and the launcher position across the rename', () => {
    fake.setItem(RENAMED_KEYS[HUD_KEY] ?? '', JSON.stringify({ collapsed: true, pinned: true }));
    fake.setItem(RENAMED_KEYS[POSITION_KEY] ?? '', JSON.stringify({ right: 40, bottom: 200 }));
    expect(loadHudCollapsed()).toBe(true);
    expect(loadPosition()).toEqual({ right: 40, bottom: 200 });
  });

  it('writes back under the current key, so the old one is shadowed', () => {
    fake.setItem(RENAMED_KEYS[HUD_KEY] ?? '', JSON.stringify({ collapsed: true }));
    saveHudCollapsed(false);
    expect(JSON.parse(fake.getItem(HUD_KEY) ?? 'null')).toEqual({ collapsed: false });
    // The old entry is read-only: untouched, merely outranked from now on.
    expect(JSON.parse(fake.getItem(RENAMED_KEYS[HUD_KEY] ?? '') ?? 'null')).toEqual({
      collapsed: true,
    });
  });
});

describe('loadSettings — v1 migration', () => {
  it('keeps the six old fields and fills the new ones from the defaults', () => {
    fake.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(V1_PAYLOAD));
    const settings = loadSettings();
    expect(settings.fps).toBe(60);
    expect(settings.particles).toBe('high');
    expect(settings.rings).toBe(false);
    expect(settings.glow).toBe(false);
    expect(settings.reduceMotion).toBe('off');
    expect(settings.pauseWhenHidden).toBe(false);
    // The v2 fields the v1 payload never had.
    expect(settings.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(settings.displayMode).toBe(DEFAULT_SETTINGS.displayMode);
    expect(settings.showHud).toBe(DEFAULT_SETTINGS.showHud);
    expect(settings.showActivity).toBe(DEFAULT_SETTINGS.showActivity);
  });

  it('writes the migrated payload forward under the v2 key', () => {
    fake.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(V1_PAYLOAD));
    loadSettings();
    const migrated = JSON.parse(fake.getItem(SETTINGS_KEY) ?? 'null') as Record<string, unknown>;
    expect(migrated.fps).toBe(60);
    expect(migrated.enabled).toBe(true);
    // The legacy payload is left alone.
    expect(JSON.parse(fake.getItem(LEGACY_SETTINGS_KEY) ?? 'null')).toMatchObject(V1_PAYLOAD);
  });

  it('prefers v2 over the legacy key', () => {
    fake.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(V1_PAYLOAD));
    fake.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, enabled: false, fps: 30 }));
    const settings = loadSettings();
    expect(settings.fps).toBe(30);
    expect(settings.enabled).toBe(false);
  });

  it('falls back to the defaults with no storage at all', () => {
    uninstallStorage();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(loadHudCollapsed()).toBe(false);
    // The writers must not throw either.
    saveSettings(DEFAULT_SETTINGS);
    saveHudCollapsed(true);
  });
});

describe('loadSettings — garbage tolerance', () => {
  const GARBAGE = [
    'not json at all',
    '{',
    '[]',
    'null',
    '42',
    '"a string"',
    '{"fps":59,"particles":"ultra","displayMode":"cinema","reduceMotion":"maybe","enabled":"yes","showHud":1}',
  ];

  it('never throws and always yields the defaults', () => {
    for (const raw of GARBAGE) {
      fake.setItem(SETTINGS_KEY, raw);
      expect(() => loadSettings(), raw).not.toThrow();
      expect(loadSettings(), raw).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('sanitizes field by field, keeping whatever is legal', () => {
    const settings = sanitizeSettings({
      enabled: false,
      displayMode: 'orb',
      showHud: false,
      showActivity: 'nope',
      fps: 60,
      particles: 'low',
      rings: 'yes',
      glow: true,
      reduceMotion: 'system',
      pauseWhenHidden: null,
    });
    expect(settings.enabled).toBe(false);
    expect(settings.displayMode).toBe('orb');
    expect(settings.showHud).toBe(false);
    expect(settings.showActivity).toBe(DEFAULT_SETTINGS.showActivity);
    expect(settings.fps).toBe(60);
    expect(settings.particles).toBe('low');
    expect(settings.rings).toBe(DEFAULT_SETTINGS.rings);
    expect(settings.pauseWhenHidden).toBe(DEFAULT_SETTINGS.pauseWhenHidden);
  });

  it('treats a non-object payload as the defaults', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('master switch persistence', () => {
  it('keeps enabled: false across a reload', () => {
    fake.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, enabled: false }));
    expect(loadSettings().enabled).toBe(false);
  });

  it('survives patchSettings and reloads with the new fields', () => {
    useOrbitStore.getState().patchSettings({ enabled: false, displayMode: 'compact', showHud: false, fps: 60 });
    const reloaded = loadSettings();
    expect(reloaded.enabled).toBe(false);
    expect(reloaded.displayMode).toBe('compact');
    expect(reloaded.showHud).toBe(false);
    expect(reloaded.fps).toBe(60);
  });

  it('rejects an illegal display mode coming through patchSettings', () => {
    useOrbitStore.getState().patchSettings({ displayMode: 'cinema' as never });
    expect(loadSettings().displayMode).toBe(DEFAULT_SETTINGS.displayMode);
  });
});

describe('hudCollapsed persistence', () => {
  it('round-trips through storage', () => {
    expect(loadHudCollapsed()).toBe(false);
    saveHudCollapsed(true);
    expect(loadHudCollapsed()).toBe(true);
    saveHudCollapsed(false);
    expect(loadHudCollapsed()).toBe(false);
  });

  it('writes through the store setter and reads back', () => {
    useOrbitStore.getState().setHudCollapsed(true);
    expect(useOrbitStore.getState().hudCollapsed).toBe(true);
    expect(JSON.parse(fake.getItem(HUD_KEY) ?? 'null')).toEqual({ collapsed: true });
    expect(loadHudCollapsed()).toBe(true);
    useOrbitStore.getState().setHudCollapsed(false);
    expect(loadHudCollapsed()).toBe(false);
  });

  it('tolerates a garbage flag', () => {
    for (const raw of ['nope', '{"collapsed":"yes"}', 'null', '7']) {
      fake.setItem(HUD_KEY, raw);
      expect(loadHudCollapsed(), raw).toBe(false);
    }
    fake.setItem(HUD_KEY, 'true');
    expect(loadHudCollapsed()).toBe(true);
  });
});
