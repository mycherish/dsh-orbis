import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isActiveState,
  orbCountOf,
  overlayModeOf,
  showsRestoreDot,
  surfacesOf,
  usesStaticOrb,
  type OverlayInput,
} from '../src/client/overlay';
import { hudCardMode } from '../src/client/hud/progress';
import { LAUNCHER_SIZE, type OrbitDisplayMode } from '../src/client/contracts';
import { clampLauncherPosition } from '../src/client/launcher';
import type { OrbitAgentState } from '../src/shared/protocol';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src', 'client');

function input(overrides: Partial<OverlayInput> = {}): OverlayInput {
  return {
    enabled: true,
    displayMode: 'auto',
    open: false,
    visible: true,
    collapsed: false,
    pinned: false,
    state: 'idle' as OrbitAgentState,
    ...overrides,
  };
}

describe('overlay mode: one surface at a time', () => {
  it('idle with an auto panel folds down to the ball', () => {
    expect(overlayModeOf(input({ state: 'idle' }))).toBe('compact');
    expect(overlayModeOf(input({ state: 'quiet' }))).toBe('compact');
  });

  it('an active Agent unfolds the panel', () => {
    for (const state of [
      'thinking',
      'executing',
      'responding',
      'waiting',
      'preparing',
      'starting',
    ] as OrbitAgentState[]) {
      expect(overlayModeOf(input({ state }))).toBe('expanded');
    }
  });

  it('honours the explicit display modes, and they mean three different things', () => {
    // `compact` is the chip: the HUD is mounted and folds itself to one line.
    expect(overlayModeOf(input({ state: 'executing', displayMode: 'compact' }))).toBe('expanded');
    expect(overlayModeOf(input({ state: 'idle', displayMode: 'compact' }))).toBe('expanded');
    // `orb` is the 76px ball and nothing else — the only mode that mounts the launcher.
    expect(overlayModeOf(input({ state: 'executing', displayMode: 'orb' }))).toBe('compact');
    expect(overlayModeOf(input({ state: 'idle', displayMode: 'orb' }))).toBe('compact');
  });

  it('a hand-folded panel stays folded until the user unfolds it', () => {
    const folded = input({ state: 'executing', collapsed: true });
    expect(overlayModeOf(folded)).toBe('compact');
    // No event-driven state change reopens it.
    for (const state of ['thinking', 'executing', 'completed', 'error'] as OrbitAgentState[]) {
      expect(overlayModeOf({ ...folded, state })).toBe('compact');
    }
  });

  it('pin keeps the panel open while idle', () => {
    expect(overlayModeOf(input({ state: 'idle', pinned: true }))).toBe('expanded');
  });

  it('an open Workspace wins over the panel', () => {
    expect(overlayModeOf(input({ state: 'executing', open: true }))).toBe('workspace');
    // The `showWorkspace` switch that used to veto this is gone (2.1.9): it could
    // hide the panel *and* the settings sheet inside it, so it could not be undone.
    expect(overlayModeOf(input({ state: 'idle', open: true }))).toBe('workspace');
  });

  it('the master switch and an explicit hide both mean hidden', () => {
    expect(overlayModeOf(input({ enabled: false }))).toBe('hidden');
    expect(overlayModeOf(input({ visible: false }))).toBe('hidden');
    expect(overlayModeOf(input({ enabled: false, open: true }))).toBe('hidden');
  });
});

describe('overlay surfaces: never two orbs', () => {
  it('every mode mounts at most one orb', () => {
    const modes = ['compact', 'expanded', 'workspace', 'hidden'] as const;
    for (const mode of modes) {
      expect(orbCountOf(mode)).toBeLessThanOrEqual(1);
    }
    expect(orbCountOf('compact')).toBe(1);
    expect(orbCountOf('expanded')).toBe(1);
    expect(orbCountOf('workspace')).toBe(1);
    expect(orbCountOf('hidden')).toBe(0);
  });

  it('the panel and the workspace are mutually exclusive', () => {
    const modes = ['compact', 'expanded', 'workspace', 'hidden'] as const;
    for (const mode of modes) {
      const surfaces = surfacesOf(mode);
      expect(surfaces.hud && surfaces.workspace).toBe(false);
    }
  });

  it('compact shows the ball and nothing else; hidden shows nothing', () => {
    expect(surfacesOf('compact')).toMatchObject({ orb: 1, hud: false, workspace: false });
    expect(surfacesOf('hidden')).toMatchObject({ orb: 0, hud: false, workspace: false });
  });

  it('the restore dot only appears when the user hid a live plugin', () => {
    expect(showsRestoreDot({ enabled: true, visible: false }, 'hidden')).toBe(true);
    expect(showsRestoreDot({ enabled: false, visible: false }, 'hidden')).toBe(false);
    expect(showsRestoreDot({ enabled: true, visible: true }, 'compact')).toBe(false);
  });

  it('never returns two of anything across the whole input space', () => {
    const modes: OrbitDisplayMode[] = ['auto', 'compact', 'orb'];
    const states: OrbitAgentState[] = [
      'idle',
      'starting',
      'thinking',
      'preparing',
      'executing',
      'responding',
      'waiting',
      'quiet',
      'completed',
      'interrupted',
      'error',
    ];
    let checked = 0;
    for (const displayMode of modes) {
      for (const state of states) {
        for (const showHud of [true, false]) {
          {
            for (const open of [true, false]) {
              for (const collapsed of [true, false]) {
                for (const pinned of [true, false]) {
                  for (const visible of [true, false]) {
                    for (const enabled of [true, false]) {
                      const mode = overlayModeOf(
                        input({
                          displayMode,
                          state,
                          open,
                          collapsed,
                          pinned,
                          visible,
                          enabled,
                        }),
                      );
                      const surfaces = surfacesOf(mode);
                      expect(surfaces.orb).toBeLessThanOrEqual(1);
                      expect(surfaces.hud && surfaces.workspace).toBe(false);
                      if (surfaces.workspace) expect(open && enabled && visible).toBe(true);
                      if (mode === 'hidden') expect(enabled && visible).toBe(false);
                      checked += 1;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    // modes × states × showHud × open × collapsed × pinned × visible × enabled
    expect(checked).toBe(3 * 11 * 2 * 2 * 2 * 2 * 2 * 2);
  });

  it('treats only idle and quiet as inactive', () => {
    expect(isActiveState('idle')).toBe(false);
    expect(isActiveState('quiet')).toBe(false);
    expect(isActiveState('completed')).toBe(true);
    expect(isActiveState('error')).toBe(true);
  });
});

/*
 * #5: the orb was a dead button in the default configuration. `auto` + `idle`
 * already had `collapsed === false`, so a click that only un-collapsed changed
 * nothing and React bailed out on the identical state.
 */
describe('a click on the orb always lands somewhere visible', () => {
  const orbClick = (state: OrbitAgentState, collapsed: boolean, pinned: boolean) =>
    input({ displayMode: 'auto', state, collapsed, pinned });

  it('unfolds the panel from every resting state, even when it was already unfolded', () => {
    for (const state of ['idle', 'quiet', 'thinking', 'executing', 'waiting'] as const) {
      for (const collapsed of [true, false]) {
        // What activateOrb applies on the panel path.
        const after = { ...orbClick(state, collapsed, false), collapsed: false, pinned: true };
        expect(overlayModeOf(after)).toBe('expanded');
      }
    }
  });

  it('keeps the panel reachable after the user once collapsed it', () => {
    // The old behaviour: collapsed stays true, `wantsPanel` is false while idle,
    // so the panel could never come back without the Agent waking up again.
    const stale = orbClick('idle', true, false);
    expect(overlayModeOf(stale)).toBe('compact');
    const afterClick = { ...stale, collapsed: false, pinned: true };
    expect(overlayModeOf(afterClick)).toBe('expanded');
  });
});

describe('the saved orb position is rebuilt against the current viewport', () => {
  const viewport = { width: 1280, height: 800 };
  const maxRight = viewport.width - LAUNCHER_SIZE - 8;
  const maxBottom = viewport.height - LAUNCHER_SIZE - 8;

  it('pulls a position saved on a bigger screen back inside', () => {
    expect(clampLauncherPosition({ right: 2400, bottom: 1400 }, viewport)).toEqual({
      right: maxRight,
      bottom: maxBottom,
    });
  });

  it('leaves a position that already fits untouched', () => {
    expect(clampLauncherPosition({ right: 24, bottom: 24 }, viewport)).toEqual({ right: 24, bottom: 24 });
  });

  it('never pushes the orb past the top-left edge', () => {
    expect(clampLauncherPosition({ right: -400, bottom: -400 }, viewport)).toEqual({ right: 8, bottom: 8 });
  });
});

describe('mount chain: single overlay root, single orb', () => {
  const client = (file: string): string => readFileSync(join(SRC, file), 'utf8');

  it('registers exactly one shell.overlay entry', () => {
    const source = client('index.tsx');
    const registrations = source.match(/name:\s*'shell\.overlay'/g) ?? [];
    expect(registrations).toHaveLength(1);
    const slotCalls = source.match(/ctx\.slots\.register\(/g) ?? [];
    expect(slotCalls).toHaveLength(1);
  });

  it('creates exactly one canvas for the whole plugin', () => {
    const source = client('layer.tsx');
    // Ignore the import line: only real call sites may construct things.
    const body = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('import '))
      .join('\n');
    expect(body.match(/createElement\('canvas'\)/g) ?? []).toHaveLength(1);
    expect(body.match(/createOrbRenderer/g) ?? []).toHaveLength(1);
    expect(body.match(/createOrbOwner\(createOrbRenderer\)/g) ?? []).toHaveLength(1);
  });

  it('no component renders its own <canvas> any more', () => {
    for (const file of [
      'launcher.tsx',
      'hud/TaskSummary.tsx',
      'workspace/WorkspacePanel.tsx',
      'hud/OrbisHUD.tsx',
    ]) {
      const source = client(file);
      expect(source.includes('<canvas')).toBe(false);
      expect(source.includes('createOrbRenderer')).toBe(false);
    }
  });

  it('layer renders every surface behind the mode, never in parallel', () => {
    const source = client('layer.tsx');
    for (const gate of ['surfaces.workspace', 'surfaces.hud', "mode === 'compact'"]) {
      expect(source.includes(gate)).toBe(true);
    }
    // The old unconditional launcher mount ("visible ?") is what caused the
    // duplicate orb; it must not come back.
    expect(source.includes('{visible ? (')).toBe(false);
  });
});

/*
 * 「3D 动画」off must still show a ball (2.1.9).
 *
 * The only `renderer.render()` call lives inside the rAF loop, so turning animation
 * off left the orb slot *blank* rather than still — the opposite of what the setting
 * says on screen ("关闭后只保留静态球体"). The surfaces already have a static fallback
 * for a dead renderer; this makes the switch use it too.
 */
describe('usesStaticOrb', () => {
  it('draws the static ball when animation is off', () => {
    expect(usesStaticOrb({ failed: false, animate: false })).toBe(true);
  });

  it('draws the static ball when the renderer is gone', () => {
    expect(usesStaticOrb({ failed: true, animate: true })).toBe(true);
  });

  it('uses the live canvas when the renderer is healthy and animation is on', () => {
    expect(usesStaticOrb({ failed: false, animate: true })).toBe(false);
  });
});

/*
 * The three display modes must be three different things (2.1.9, option A).
 *
 * They were not: `compact` and `orb` resolved to the same ball-only mode, and the
 * 「常驻进度卡」 switch produced that mode a third time. The chip the stylesheet draws
 * only appeared when `auto` happened to be idle. This pins the resolved surface of
 * each mode so the three cannot silently collapse again.
 */
describe('the three display modes resolve to three different surfaces', () => {
  const resolved = (displayMode: OrbitDisplayMode, state: OrbitAgentState) => {
    const mode = overlayModeOf(input({ displayMode, state }));
    const surfaces = surfacesOf(mode);
    // What the mounted surface actually draws: the chip is the HUD in compact form.
    const hudForm = surfaces.hud ? hudCardMode(displayMode, state, false) : 'none';
    return `${mode}/${surfaces.hud ? `hud:${hudForm}` : 'launcher'}`;
  };

  it('auto shows the panel while the Agent works, and folds to the ball when idle', () => {
    expect(resolved('auto', 'executing')).toBe('expanded/hud:expanded');
    expect(resolved('auto', 'idle')).toBe('compact/launcher');
    // Pinning is what keeps the chip up while idle — that is the pinned state's job.
    expect(
      resolved('auto', 'idle').length > 0 &&
        overlayModeOf(input({ displayMode: 'auto', state: 'idle', pinned: true })),
    ).toBe('expanded');
  });

  it('compact always shows the chip, busy or idle', () => {
    expect(resolved('compact', 'executing')).toBe('expanded/hud:compact');
    expect(resolved('compact', 'idle')).toBe('expanded/hud:compact');
  });

  it('orb only ever shows the ball', () => {
    expect(resolved('orb', 'executing')).toBe('compact/launcher');
    expect(resolved('orb', 'idle')).toBe('compact/launcher');
  });
});
