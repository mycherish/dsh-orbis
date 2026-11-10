// @vitest-environment jsdom
/**
 * One canvas, several slots — the hand-off that has to survive a mode switch.
 *
 * The whole plugin owns a single `<canvas>` and *moves* it into whichever surface
 * is mounted, so switching modes costs no WebGL context. That only works if the
 * slot the shell remembers is always the slot that is actually on screen.
 *
 * It was not. Three surfaces hand their slot to the shell, and they used two
 * different mechanisms: the HUD's ball slot is a **ref callback** (React calls it
 * during the layout phase), while the Workspace panel binds from a **passive
 * `useEffect`**. Closing the Workspace therefore ran, in this order, inside one
 * commit:
 *
 *   1. layout phase — the newly mounted HUD's ref fires → slot = HUD
 *   2. passive phase — the unmounting panel's effect cleanup fires → slot = null
 *
 * The shell then removed the canvas from the HUD slot and never put it back: the
 * card was on screen, the ball was a black hole, and nothing recovered until some
 * unrelated re-mount happened to re-bind a slot. Reported from a real session as
 * "卡片 → 展开 Workspace → 收起，球变黑".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';

/*
 * React only treats code inside `act()` as synchronous work when this flag is set.
 * Without it React prints "not configured to support act(...)" and flushes on its
 * own schedule, so an assertion made right after a layout-phase ref would be racing
 * React rather than testing it.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = React;
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_SETTINGS } from '../src/client/contracts';
import { OrbitLayer } from '../src/client/layer';
import { useOrbitStore } from '../src/client/store';
import type { OrbitSnapshot } from '../src/shared/protocol';

/** Enough of a snapshot for the surfaces to render; nothing here reads the rest. */
const SNAPSHOT = {
  version: 1,
  sessionId: 's1',
  agentState: 'idle',
  activeTools: 0,
  silenceMs: 0,
  quietLevel: 0,
  events: [],
  updatedAt: 1,
  metrics: { turns: 0, steps: 0, tools: 0, files: 0, approvals: 0, retries: 0, startedAt: 1 },
  task: null,
} as unknown as OrbitSnapshot;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** The shell subscribes to the state route as soon as it mounts; keep it quiet. */
class SilentEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {}
}

beforeEach(() => {
  vi.stubGlobal('EventSource', SilentEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  );
  // `pinned` keeps the panel expanded while the Agent is idle, which is the state
  // the report was taken in.
  useOrbitStore.setState({
    snapshot: SNAPSHOT,
    connection: 'open',
    settings: { ...DEFAULT_SETTINGS, displayMode: 'auto', showHud: true, showWorkspace: true },
    open: false,
    visible: true,
    hudCollapsed: false,
    hudPinned: true,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<OrbitLayer />));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const hudCanvas = (): HTMLCanvasElement | null =>
  container?.querySelector<HTMLCanvasElement>('.no-hud-ball-slot canvas') ?? null;
const stageCanvas = (): HTMLCanvasElement | null =>
  container?.querySelector<HTMLCanvasElement>('.no-canvas-slot canvas') ?? null;

describe('orb slot hand-off', () => {
  it('puts the canvas in the HUD card on mount', () => {
    expect(hudCanvas()).not.toBeNull();
    expect(stageCanvas()).toBeNull();
  });

  it('moves the canvas into the Workspace stage, then back into the card', () => {
    const canvas = hudCanvas();
    expect(canvas).not.toBeNull();

    act(() => useOrbitStore.setState({ open: true }));
    expect(container?.querySelector('.no-canvas-slot')).not.toBeNull();
    expect(stageCanvas()).toBe(canvas);
    expect(hudCanvas()).toBeNull();

    // Closing it is where the canvas used to be dropped on the floor.
    act(() => useOrbitStore.setState({ open: false }));
    expect(hudCanvas()).toBe(canvas);
    expect(stageCanvas()).toBeNull();
  });

  it('survives the switch happening twice', () => {
    const canvas = hudCanvas();
    for (let round = 0; round < 3; round += 1) {
      act(() => useOrbitStore.setState({ open: true }));
      expect(stageCanvas()).toBe(canvas);
      act(() => useOrbitStore.setState({ open: false }));
      expect(hudCanvas()).toBe(canvas);
    }
  });

  it('never leaves the canvas outside the document', () => {
    const canvas = hudCanvas();
    act(() => useOrbitStore.setState({ open: true }));
    act(() => useOrbitStore.setState({ open: false }));
    expect(canvas?.isConnected).toBe(true);
  });
});
