/**
 * The overlay root: the plugin's **only** entry in `shell.overlay`.
 *
 * It resolves one `OverlayMode` (compact / expanded / workspace / hidden) and
 * mounts exactly the surfaces that mode allows — one orb, at most one panel.
 * The orb itself is a single `<canvas>` created once here and *moved* into
 * whichever slot is mounted, so switching modes never creates a second WebGL
 * renderer (spec: 单一 Overlay Root，禁止同时渲染两个 OrbVisual).
 *
 * The master switch (`settings.enabled`) is a real switch, not a visual one:
 * while it is off there is no transport, no polling, no renderer and no timer —
 * the overlay renders one small affordance that turns it back on.
 */
import * as React from 'react';
import { LAUNCHER_SIZE, ORBIT_PALETTE, type OrbQuality, type OrbitSettings, type OrbVisualState } from './contracts';
import { createOrbRenderer } from './orb';
import { createOrbOwner } from './orb-owner';
import { overlayModeOf, showsRestoreDot, surfacesOf } from './overlay';
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

/** Remember the last Session the main column displayed. */
let lastSessionId: string | undefined;

/** The only thing the overlay draws while the master switch is off. */
const ENABLE_CSS = `
.no-enable{position:fixed;right:24px;bottom:24px;z-index:2147482990;padding:5px 11px;border-radius:14px;border:1px solid rgba(150,175,230,.26);background:rgba(10,17,34,.82);backdrop-filter:blur(10px);color:${ORBIT_PALETTE.labelDim};font:500 11px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;cursor:pointer;opacity:.62;transition:opacity .18s ease,color .18s ease}
.no-enable:hover{opacity:1;color:${ORBIT_PALETTE.label}}
.no-enable:focus-visible{outline:2px solid ${ORBIT_PALETTE.cyan};outline-offset:3px}
@media (max-width:720px){.no-enable{right:12px;bottom:12px}}
`;

/** The one canvas, plus the slot styles it inherits wherever it is mounted. */
const ORB_CSS = `
.no-orb-canvas{display:block;width:100%;height:100%;border-radius:inherit}
.no-orb-slot{position:relative;display:block}
`;

interface RendererHandle {
  fps: number;
  failed: boolean;
}

/**
 * Bind the plugin's single canvas to an owner that never builds a second
 * renderer. The canvas is moved between slots (launcher → HUD → workspace) as
 * the overlay mode changes; the WebGL context is created once and disposed when
 * the overlay unmounts or the master switch turns the overlay off.
 */
function useOrbOwner(
  canvas: HTMLCanvasElement | null,
  visual: OrbVisualState,
  quality: OrbQuality,
  active: boolean,
): RendererHandle {
  const ownerRef = React.useRef<ReturnType<typeof createOrbOwner> | null>(null);
  const visualRef = React.useRef(visual);
  visualRef.current = visual;
  const qualityRef = React.useRef(quality);
  qualityRef.current = quality;
  const [failed, setFailed] = React.useState(false);
  const [fps, setFps] = React.useState(0);

  if (ownerRef.current === null) ownerRef.current = createOrbOwner(createOrbRenderer);
  const owner = ownerRef.current;

  // Create (once) and release on unmount: exactly one renderer per page.
  React.useEffect(() => {
    if (canvas === null) return undefined;
    owner.attach(canvas, visualRef.current, qualityRef.current);
    setFailed(owner.failed);
    return () => {
      owner.detach();
      setFps(0);
    };
  }, [canvas, owner]);

  React.useEffect(() => {
    owner.update(visual, quality);
  }, [owner, visual, quality]);

  React.useEffect(() => {
    if (active) owner.start();
    else owner.pause();
  }, [owner, active]);

  React.useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setFps(owner.fps()), FPS_SAMPLE_MS);
    return () => clearInterval(timer);
  }, [owner, active]);

  React.useEffect(() => {
    const onResize = (): void => owner.resize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [owner]);

  React.useEffect(() => () => {
    ownerRef.current?.detach();
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

  const agentState = snapshot?.agentState ?? 'idle';

  /*
   * One mode decides the whole overlay. Every surface below is gated on it, so
   * two floating entries cannot coexist (spec §3).
   */
  const mode = overlayModeOf({
    enabled,
    displayMode: settings.displayMode,
    showHud: settings.showHud,
    showWorkspace: settings.showWorkspace,
    open,
    visible,
    collapsed: hudCollapsed,
    pinned: hudPinned,
    state: agentState,
  });
  const surfaces = surfacesOf(mode);

  /*
   * One canvas for the whole plugin, created once and moved into whichever
   * slot the current mode mounts. Moving a canvas keeps its WebGL context, so
   * mode switches cost zero contexts and never leave a second renderer behind.
   */
  const orbCanvas = React.useMemo(() => {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.className = 'no-orb-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    return canvas;
  }, []);
  const [orbSlot, setOrbSlot] = React.useState<HTMLElement | null>(null);
  const bindOrbSlot = React.useCallback((el: HTMLElement | null) => {
    setOrbSlot(el);
  }, []);

  React.useEffect(() => {
    if (orbCanvas === null || orbSlot === null) return undefined;
    const current = orbCanvas.parentElement;
    if (current !== orbSlot) orbSlot.appendChild(orbCanvas);
    return () => {
      if (orbCanvas.parentElement === orbSlot) orbSlot.removeChild(orbCanvas);
    };
  }, [orbCanvas, orbSlot]);

  const orbActive = surfaces.orb === 1 && !suspended && settings.animate;
  const orb = useOrbOwner(orbCanvas, visual, quality, orbActive);

  React.useEffect(() => {
    if (!enabled) {
      setFps(0);
      return;
    }
    setFps(orb.fps);
  }, [enabled, orb.fps, setFps]);

  // `showWorkspace: false` must not leave an orphaned panel on screen.
  React.useEffect(() => {
    if (open && !settings.showWorkspace) setOpen(false);
  }, [open, settings.showWorkspace, setOpen]);

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

  // ---- always-on HUD wiring ----------------------------------------------
  const collapseHud = React.useCallback(() => setHudCollapsed(true), [setHudCollapsed]);
  const expandHud = React.useCallback(() => setHudCollapsed(false), [setHudCollapsed]);
  const pinHud = React.useCallback((next: boolean) => setHudPinned(next), [setHudPinned]);
  const openWorkspace = React.useCallback(() => setOpen(true), [setOpen]);
  /**
   * The compact orb is the only entry point in `compact` mode. In `auto` it
   * unfolds the panel; when the user pinned the ball-only mode it opens the
   * detailed Workspace instead, because there is no panel to unfold.
   */
  const activateOrb = React.useCallback(() => {
    if (settings.displayMode === 'compact' || settings.displayMode === 'orb' || !settings.showHud) {
      setOpen(true);
      return;
    }
    setHudCollapsed(false);
  }, [setHudCollapsed, setOpen, settings.displayMode, settings.showHud]);

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

  const activeTools = snapshot?.activeTools ?? 0;

  return (
    <React.Fragment>
      <style>{ORB_CSS}</style>
      {surfaces.workspace ? (
        <WorkspaceView
          snapshot={snapshot}
          connection={connection}
          settings={settings}
          fps={orb.fps}
          orbUnavailable={orb.failed}
          bindOrbSlot={bindOrbSlot}
          onSettingsChange={patchSettings}
          onClose={() => setOpen(false)}
        />
      ) : null}
      {surfaces.hud ? (
        <NeuralOrbitHUD
          snapshot={snapshot}
          connection={connection}
          settings={settings}
          collapsed={hudCollapsed}
          pinned={hudPinned}
          reduceMotion={quality.reduceMotion}
          orbUnavailable={orb.failed}
          bindOrbSlot={bindOrbSlot}
          onCollapse={collapseHud}
          onExpand={expandHud}
          onOpenWorkspace={openWorkspace}
          onPin={pinHud}
        />
      ) : null}
      {mode === 'compact' ? (
        <Launcher
          position={position}
          agentState={agentState}
          activeTools={activeTools}
          connection={connection}
          open={false}
          translate={translate}
          orbUnavailable={orb.failed}
          onToggle={activateOrb}
          onHide={() => setVisible(false)}
          onPositionChange={setPosition}
          bindOrbSlot={bindOrbSlot}
        />
      ) : null}
      {showsRestoreDot({ enabled, visible }, mode) ? (
        <LauncherRestore
          position={position}
          agentState={agentState}
          translate={translate}
          onRestore={() => setVisible(true)}
        />
      ) : null}
      <span hidden aria-hidden="true" data-neural-orbit-launcher-size={LAUNCHER_SIZE} />
    </React.Fragment>
  );
}
