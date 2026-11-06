/**
 * The overlay root: one entry in `shell.overlay` that owns the always-on HUD,
 * the launcher, the workspace, all three orb canvases, the SSE transport and
 * every lifecycle rule (master switch, pause when hidden, release on close,
 * follow the displayed Session).
 *
 * The master switch (`settings.enabled`) is a real switch, not a visual one:
 * while it is off there is no transport, no polling, no renderer and no timer —
 * the overlay renders one small affordance that turns it back on.
 */
import * as React from 'react';
import { LAUNCHER_SIZE, ORBIT_PALETTE, type OrbQuality, type OrbRenderer, type OrbitSettings, type OrbVisualState } from './contracts';
import { createOrbRenderer } from './orb';
import { Launcher, LauncherRestore } from './launcher';
import { NeuralOrbitHUD } from './hud';
import { WorkspaceView } from './workspace';
import { useOrbitStore } from './store';
import { startTransport, type Transport } from './transport';
import {
  deriveVisual,
  prefersReduceMotion,
  resolveQuality,
  selectDisplayedSession,
  watchReduceMotion,
} from './visual';

export interface OrbitLayerProps {
  /** Root-scope standard hook supplied by the slot renderer. */
  useSessions?: (selector: (state: unknown) => string | undefined) => string | undefined;
  /** Locale-bound translate function supplied by the slot renderer. */
  t?: (key: string) => string;
}

const FPS_SAMPLE_MS = 1000;

/**
 * Is the always-on panel allowed to draw right now?
 *
 * Pure, and used twice on purpose: once to decide the HUD ball renderer's
 * `active` flag and once for the JSX, so the canvas can never be animating
 * while the panel itself is hidden (or vice versa).
 */
function hudVisibleFor(settings: OrbitSettings, visible: boolean, open: boolean): boolean {
  return settings.showHud && settings.displayMode !== 'orb' && visible && !open;
}

/** Remember the last Session the main column displayed. */
let lastSessionId: string | undefined;

/** The only thing the overlay draws while the master switch is off. */
const ENABLE_CSS = `
.no-enable{position:fixed;right:24px;bottom:24px;z-index:2147482990;padding:5px 11px;border-radius:14px;border:1px solid rgba(150,175,230,.26);background:rgba(10,17,34,.82);backdrop-filter:blur(10px);color:${ORBIT_PALETTE.labelDim};font:500 11px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;cursor:pointer;opacity:.62;transition:opacity .18s ease,color .18s ease}
.no-enable:hover{opacity:1;color:${ORBIT_PALETTE.label}}
.no-enable:focus-visible{outline:2px solid ${ORBIT_PALETTE.cyan};outline-offset:3px}
@media (max-width:720px){.no-enable{right:12px;bottom:12px}}
`;

interface RendererHandle {
  fps: number;
  failed: boolean;
}

/**
 * Own one renderer for one canvas: created on mount, updated in place for every
 * state/quality change, disposed on unmount. Never re-created per snapshot.
 */
function useOrbRenderer(
  canvas: HTMLCanvasElement | null,
  visual: OrbVisualState,
  quality: OrbQuality,
  active: boolean,
): RendererHandle {
  const rendererRef = React.useRef<OrbRenderer | null>(null);
  const visualRef = React.useRef(visual);
  visualRef.current = visual;
  const [failed, setFailed] = React.useState(false);
  const [fps, setFps] = React.useState(0);

  React.useEffect(() => {
    if (canvas === null) return undefined;
    const renderer = createOrbRenderer({ canvas, state: visualRef.current, quality });
    rendererRef.current = renderer;
    if (renderer === null) {
      setFailed(true);
      return undefined;
    }
    setFailed(false);
    renderer.start();
    const timer = setInterval(() => setFps(renderer.fps()), FPS_SAMPLE_MS);
    return () => {
      clearInterval(timer);
      renderer.dispose();
      rendererRef.current = null;
      setFps(0);
    };
    // `quality` is intentionally excluded: quality changes update in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas]);

  React.useEffect(() => {
    rendererRef.current?.setState(visual);
  }, [visual]);

  React.useEffect(() => {
    rendererRef.current?.setQuality(quality);
  }, [quality]);

  React.useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer === null) return;
    if (active) renderer.start();
    else renderer.pause();
  }, [active, failed]);

  React.useEffect(() => {
    const onResize = (): void => rendererRef.current?.resize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return { fps, failed };
}

export function OrbitLayer(props: OrbitLayerProps): React.ReactElement {
  const translate = React.useCallback(
    (key: string): string => (typeof props.t === 'function' ? props.t(key) : key),
    [props.t],
  );

  const snapshot = useOrbitStore((state) => state.snapshot);
  const connection = useOrbitStore((state) => state.connection);
  const settings = useOrbitStore((state) => state.settings);
  const open = useOrbitStore((state) => state.open);
  const visible = useOrbitStore((state) => state.visible);
  const position = useOrbitStore((state) => state.position);
  const hudCollapsed = useOrbitStore((state) => state.hudCollapsed);
  const hudPinned = useOrbitStore((state) => state.hudPinned);
  const setSnapshot = useOrbitStore((state) => state.setSnapshot);
  const setConnection = useOrbitStore((state) => state.setConnection);
  const setOpen = useOrbitStore((state) => state.setOpen);
  const setVisible = useOrbitStore((state) => state.setVisible);
  const setPosition = useOrbitStore((state) => state.setPosition);
  const setHudCollapsed = useOrbitStore((state) => state.setHudCollapsed);
  const setHudPinned = useOrbitStore((state) => state.setHudPinned);
  const patchSettings = useOrbitStore((state) => state.patchSettings);
  const setFps = useOrbitStore((state) => state.setFps);

  const enabled = settings.enabled;

  // ---- follow the Session the main column displays ------------------------
  const displayed = props.useSessions?.(selectDisplayedSession);
  if (displayed !== undefined && displayed !== '') lastSessionId = displayed;
  const sessionId = displayed ?? lastSessionId;

  // ---- transport (master switch: off means no stream at all) -------------
  const transportRef = React.useRef<Transport | null>(null);
  const sessionRef = React.useRef<string | undefined>(sessionId);
  sessionRef.current = sessionId;

  React.useEffect(() => {
    if (!enabled) return undefined;
    const transport = startTransport({
      sessionId: () => sessionRef.current,
      onSnapshot: setSnapshot,
      onConnection: setConnection,
    });
    transportRef.current = transport;
    return () => {
      transport.stop();
      transportRef.current = null;
    };
  }, [enabled, setConnection, setSnapshot]);

  // Restart the stream when the followed Session changes.
  React.useEffect(() => {
    if (!enabled) return;
    transportRef.current?.restart();
  }, [enabled, sessionId]);

  // Switched off: drop the stale frame instead of showing yesterday's progress
  // the moment it comes back on.
  React.useEffect(() => {
    if (enabled) return;
    setSnapshot(null);
  }, [enabled, setSnapshot]);

  // ---- OS reduce-motion preference ---------------------------------------
  const [systemReduce, setSystemReduce] = React.useState(prefersReduceMotion);
  React.useEffect(() => {
    if (!enabled) return undefined;
    return watchReduceMotion(setSystemReduce);
  }, [enabled]);

  // ---- window focus / visibility -----------------------------------------
  const [hidden, setHidden] = React.useState(
    typeof document === 'undefined' ? false : document.visibilityState === 'hidden',
  );
  const [focused, setFocused] = React.useState(true);

  React.useEffect(() => {
    if (!enabled) return undefined;
    const onVisibility = (): void => setHidden(document.visibilityState === 'hidden');
    const onBlur = (): void => setFocused(false);
    const onFocus = (): void => setFocused(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled]);

  const suspended = enabled && settings.pauseWhenHidden && (hidden || !focused);

  // ---- derived renderer inputs -------------------------------------------
  const visual = React.useMemo(() => deriveVisual(snapshot, connection), [snapshot, connection]);
  const quality = React.useMemo(() => resolveQuality(settings, systemReduce), [settings, systemReduce]);

  const [launcherCanvas, setLauncherCanvas] = React.useState<HTMLCanvasElement | null>(null);
  const [workspaceCanvas, setWorkspaceCanvas] = React.useState<HTMLCanvasElement | null>(null);
  const [hudCanvas, setHudCanvas] = React.useState<HTMLCanvasElement | null>(null);

  // The launcher rests while the workspace is open: two live contexts at once
  // would spend GPU on something the panel already covers. With the master
  // switch off nothing runs at all.
  const launcherActive = enabled && visible && !open && !suspended;
  const launcher = useOrbRenderer(launcherCanvas, visual, quality, launcherActive);
  const workspace = useOrbRenderer(workspaceCanvas, visual, quality, enabled && open && !suspended);

  /*
   * The HUD's own ball is drawn by this same renderer factory (never a second
   * WebGL implementation): the panel only owns a `<canvas>` and hands it up.
   * Closed HUD → `null` → the renderer is disposed and the GPU memory released.
   */
  const hudActive = enabled && hudVisibleFor(settings, visible, open) && !suspended;
  const hud = useOrbRenderer(hudCanvas, visual, quality, hudActive);

  React.useEffect(() => {
    if (!enabled) {
      setFps(0);
      return;
    }
    setFps(open ? workspace.fps : launcher.fps);
  }, [enabled, launcher.fps, workspace.fps, open, setFps]);

  // ---- ESC closes the workspace ------------------------------------------
  React.useEffect(() => {
    if (!enabled || !open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled, open, setOpen]);

  const bindLauncherCanvas = React.useCallback((canvas: HTMLCanvasElement | null) => {
    setLauncherCanvas(canvas);
  }, []);

  const bindWorkspaceCanvas = React.useCallback((canvas: HTMLCanvasElement | null) => {
    setWorkspaceCanvas(canvas);
  }, []);

  const bindHudCanvas = React.useCallback((canvas: HTMLCanvasElement | null) => {
    setHudCanvas(canvas);
  }, []);

  // ---- always-on HUD wiring ----------------------------------------------
  const collapseHud = React.useCallback(() => setHudCollapsed(true), [setHudCollapsed]);
  const expandHud = React.useCallback(() => setHudCollapsed(false), [setHudCollapsed]);
  const pinHud = React.useCallback((next: boolean) => setHudPinned(next), [setHudPinned]);
  const openWorkspace = React.useCallback(() => setOpen(true), [setOpen]);

  // ---- master switch off: one affordance, and nothing else ---------------
  if (!enabled) {
    return (
      <React.Fragment>
        <style>{ENABLE_CSS}</style>
        <button
          type="button"
          className="no-enable"
          title="启用 Neural Orbit"
          aria-label="启用 Neural Orbit"
          onClick={() => patchSettings({ enabled: true })}
        >
          启用 Neural Orbit
        </button>
      </React.Fragment>
    );
  }

  const agentState = snapshot?.agentState ?? 'idle';
  const activeTools = snapshot?.activeTools ?? 0;
  // `orb` mode is the "能量球 only" choice; `showHud: false` hides the panel too.
  const hudVisible = hudVisibleFor(settings, visible, open);

  return (
    <React.Fragment>
      {open ? (
        <WorkspaceView
          snapshot={snapshot}
          connection={connection}
          settings={settings}
          fps={workspace.fps}
          orbUnavailable={workspace.failed}
          bindOrbCanvas={bindWorkspaceCanvas}
          onSettingsChange={patchSettings}
          onClose={() => setOpen(false)}
        />
      ) : null}
      {visible ? (
        <Launcher
          position={position}
          agentState={agentState}
          activeTools={activeTools}
          connection={connection}
          open={open}
          translate={translate}
          onToggle={() => setOpen(!open)}
          onHide={() => setVisible(false)}
          onPositionChange={setPosition}
          bindCanvas={bindLauncherCanvas}
        />
      ) : (
        <LauncherRestore
          position={position}
          agentState={agentState}
          translate={translate}
          onRestore={() => setVisible(true)}
        />
      )}
      {hudVisible ? (
        <NeuralOrbitHUD
          snapshot={snapshot}
          connection={connection}
          settings={settings}
          collapsed={hudCollapsed}
          pinned={hudPinned}
          reduceMotion={quality.reduceMotion}
          orbUnavailable={hud.failed}
          bindOrbCanvas={bindHudCanvas}
          onCollapse={collapseHud}
          onExpand={expandHud}
          onOpenWorkspace={openWorkspace}
          onPin={pinHud}
        />
      ) : null}
      <span hidden aria-hidden="true" data-neural-orbit-launcher-size={LAUNCHER_SIZE} />
    </React.Fragment>
  );
}
