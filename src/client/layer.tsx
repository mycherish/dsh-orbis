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
import {
  LAUNCHER_SIZE,
  ORBIT_PALETTE,
  type OrbQuality,
  type OrbitSettings,
  type OrbVisualState,
} from './contracts';
import { createOrbRenderer } from './orb';
import { createOrbOwner } from './orb-owner';
import { overlayModeOf, showsRestoreDot, surfacesOf, usesStaticOrb } from './overlay';
import { clampLauncherPosition, Launcher, LauncherRestore } from './launcher';
import { OrbisHUD } from './hud';
import { WorkspaceView } from './workspace';
import { LABELS } from './workspace/labels';
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

/** The surfaces that can host the one canvas, widest first. */
type OrbSlotKey = 'workspace' | 'hud' | 'launcher';
const EMPTY_ORB_SLOTS: Record<OrbSlotKey, HTMLElement | null> = {
  workspace: null,
  hud: null,
  launcher: null,
};

/** Remember the last Session the main column displayed. */
let lastSessionId: string | undefined;

/** The only thing the overlay draws while the master switch is off. */
const ENABLE_CSS = `
/*
 * The recovery button is deliberately recessed — but recessed is not an excuse to
 * be unreadable. Painting \`labelDim\` at \`opacity:.62\` multiplied the text alpha and
 * landed on 3.58:1, under the 4.5:1 floor (tests/contrast.test.ts computes this from
 * the sheet). Keeping the same 62% recess and starting from \`label\` instead reads at
 * 6.7:1 and looks the same at a glance.
 */
.no-enable{position:fixed;right:24px;bottom:24px;z-index:2147482990;padding:5px 11px;border-radius:14px;border:1px solid rgba(150,175,230,.26);background:rgba(10,17,34,.82);backdrop-filter:blur(10px);color:${ORBIT_PALETTE.label};font:500 11px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;cursor:pointer;opacity:.62;transition:opacity .18s ease,color .18s ease}
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
  /** Re-measure the canvas box; a no-op while no renderer is attached. */
  resize(): void;
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
  enabled: boolean,
  animate: boolean,
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

  /*
   * Create (once) and release on unmount: exactly one renderer per page.
   *
   * `enabled` belongs in the dependencies. Turning the master switch off used to
   * only `pause()` the loop, leaving the renderer — a real WebGL context, the
   * compiled shaders and the whole scene — alive for the rest of the session. A
   * user who never wants this plugin was paying for a context on every page load,
   * which is the opposite of what the README promises.
   */
  React.useEffect(() => {
    /*
     * `animate` belongs here, not only in the start/pause effect below. With
     * animation off there is nothing to draw (the only render call is inside the
     * frame loop), so building a WebGL context would burn one of the browser's ~16
     * contexts to paint nothing — and `attach()` starts the loop on its own, which
     * nothing would ever pause. The surfaces draw their static ball instead.
     */
    if (canvas === null || !enabled || !animate) {
      owner.detach();
      setFailed(false);
      return undefined;
    }
    owner.attach(canvas, visualRef.current, qualityRef.current);
    setFailed(owner.failed);
    return () => {
      owner.detach();
      setFailed(false);
      setFps(0);
    };
  }, [canvas, owner, enabled, animate]);

  // A lost context has to reach React, not just the owner's own flag: the
  // surfaces decide between a live canvas and their static fallback from this.
  React.useEffect(() => owner.watchUnavailable(() => setFailed(true)), [owner]);

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

  React.useEffect(
    () => () => {
      ownerRef.current?.detach();
    },
    [],
  );

  const resize = React.useCallback(() => owner.resize(), [owner]);

  return { fps, failed, resize };
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
  const stale = useOrbitStore((state) => state.stale);
  const setSnapshot = useOrbitStore((state) => state.setSnapshot);
  const setConnection = useOrbitStore((state) => state.setConnection);
  const setOpen = useOrbitStore((state) => state.setOpen);
  const setVisible = useOrbitStore((state) => state.setVisible);
  const setPosition = useOrbitStore((state) => state.setPosition);
  const setPositionLive = useOrbitStore((state) => state.setPositionLive);
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

  /**
   * The stream the current transport was opened for.
   *
   * `startTransport` opens its own connection, so the "restart on Session change"
   * effect below used to fire on mount as well — close, reopen — and every mount
   * cost two `EventSource`s and two `connecting` transitions. Recording which
   * Session the live transport was opened for makes the restart effect idempotent
   * on mount and only act on a real switch.
   */
  const streamedForRef = React.useRef<string | undefined>(sessionId);

  React.useEffect(() => {
    if (!enabled) return undefined;
    const transport = startTransport({
      sessionId: () => sessionRef.current,
      onSnapshot: setSnapshot,
      onConnection: setConnection,
    });
    transportRef.current = transport;
    streamedForRef.current = sessionRef.current;
    return () => {
      transport.stop();
      transportRef.current = null;
    };
  }, [enabled, setConnection, setSnapshot]);

  // Restart the stream when the followed Session changes — and only then.
  React.useEffect(() => {
    if (!enabled) return;
    if (streamedForRef.current === sessionId) return;
    streamedForRef.current = sessionId;
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
  const [slots, setSlots] = React.useState<Record<OrbSlotKey, HTMLElement | null>>(EMPTY_ORB_SLOTS);
  /*
   * One slot per surface, never one shared value.
   *
   * Every surface used to hand its element to a single `setOrbSlot` state, and
   * they do not all hand it over at the same moment: the HUD's ball slot is a ref
   * callback (React calls it in the layout phase) while the Workspace panel binds
   * from a passive `useEffect`. Closing the Workspace therefore ran, inside one
   * commit, "HUD is the slot" and then "no slot" — the later passive cleanup won,
   * the shell removed the canvas from the card it had just been put into, and the
   * orb stayed black until something unrelated re-bound a slot. Keying the binder
   * makes the outcome order-independent: an unmounting surface can only clear its
   * own key, and whichever surface is actually on screen still holds the orb.
   */
  const bindSlotFor = React.useCallback(
    (key: OrbSlotKey) =>
      (el: HTMLElement | null): void => {
        setSlots((prev) => (prev[key] === el ? prev : { ...prev, [key]: el }));
      },
    [],
  );
  const bindWorkspaceSlot = React.useMemo(() => bindSlotFor('workspace'), [bindSlotFor]);
  const bindHudSlot = React.useMemo(() => bindSlotFor('hud'), [bindSlotFor]);
  const bindLauncherSlot = React.useMemo(() => bindSlotFor('launcher'), [bindSlotFor]);
  /** Widest surface wins; only one of them is ever mounted. */
  const orbSlot = slots.workspace ?? slots.hud ?? slots.launcher;

  React.useEffect(() => {
    if (orbCanvas === null || orbSlot === null) return undefined;
    const current = orbCanvas.parentElement;
    if (current !== orbSlot) orbSlot.appendChild(orbCanvas);
    return () => {
      if (orbCanvas.parentElement === orbSlot) orbSlot.removeChild(orbCanvas);
    };
  }, [orbCanvas, orbSlot]);

  const orbActive = surfaces.orb === 1 && !suspended && settings.animate;
  /*
   * No slot means no canvas on screen: the chip (`compact` mode, and `auto` while
   * idle) is text plus an SVG mark, with nothing for the orb to attach to. Handing
   * the hook `null` in that case keeps a WebGL context and a frame loop from being
   * spent on a canvas that is not in the document.
   */
  const orb = useOrbOwner(
    orbSlot === null ? null : orbCanvas,
    visual,
    quality,
    orbActive,
    enabled,
    settings.animate,
  );
  const orbUnavailable = usesStaticOrb({ failed: orb.failed, animate: settings.animate });

  /*
   * Moving the one canvas between slots changes its box, and nothing else
   * re-measures: `window resize` was the only other trigger, and `mode` changes
   * do not fire it. Without this the Workspace stretched a 96px backbuffer over a
   * ~330x450 stage — blurred, and oval because the camera aspect never changed.
   * The observer also covers box changes that never touch the window (a sidebar
   * collapsing, a host theme change).
   */
  /*
   * `orb.resize` — not `orb` — belongs in the dependencies. `useOrbOwner` returns a
   * fresh object literal on every render, and the shell re-renders on every SSE
   * frame and on the one-second fps sample; with `orb` in the list this observer
   * was torn down and rebuilt several times a second, and each rebuild ran a
   * `resize()` that measures layout synchronously. `resize` itself is a `useCallback`
   * keyed on the owner, so it is stable for as long as the renderer is.
   */
  const orbResize = orb.resize;
  React.useEffect(() => {
    if (orbSlot === null || !enabled) return undefined;
    orbResize();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => orbResize());
    observer.observe(orbSlot);
    return () => observer.disconnect();
  }, [orbSlot, orbResize, enabled]);

  React.useEffect(() => {
    if (!enabled) {
      setFps(0);
      return;
    }
    setFps(orb.fps);
  }, [enabled, orb.fps, setFps]);

  // ---- ESC closes the workspace ------------------------------------------
  React.useEffect(() => {
    if (!enabled || !open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      /*
       * Only the Escape that was aimed at our panel closes it.
       *
       * This listens in the capture phase, so it sees every key before anything
       * else on the page does — and it used to `stopPropagation()` unconditionally,
       * which meant that while the panel was open the Host's own Escape shortcut
       * (and every other plugin's) silently stopped working. Whoever the key was
       * meant for, we answered it.
       */
      const target = event.target;
      if (!(target instanceof Element) || target.closest('[data-orbis-surface]') === null) return;
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled, open, setOpen]);

  /*
   * Hand focus back when the panel closes.
   *
   * The panel focuses itself on mount (it is a `role="dialog"`), so closing it left
   * focus on a node React had already removed: the browser drops it on `<body>`
   * and a keyboard or screen-reader user loses their place with nothing announced.
   * Only a *lost* focus is repaired — if the user has meanwhile moved focus
   * somewhere real, that wins.
   */
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const active = document.activeElement;
    /*
     * Focus counts as lost when it sits on `<body>` or on a node that is no longer
     * in the document — which is exactly where it is right after React removes the
     * focused panel. Only then do we move it; a focus the user placed elsewhere in
     * the meantime is theirs to keep.
     */
    const lost = active === null || active === document.body || !active.isConnected;
    if (!lost) return;
    /*
     * A bare `[data-orbis-surface]` matches the panel/card *root* first (document
     * order), and a div without a tabindex cannot take focus — which is why the
     * first attempt at this silently did nothing. Match things that can actually
     * be focused.
     */
    const home = document.querySelector<HTMLElement>(
      '[data-orbis-surface] button:not([disabled]), [data-orbis-surface] [tabindex]:not([tabindex="-1"]), [data-orbis-surface][tabindex]',
    );
    home?.focus({ preventScroll: true });
  }, [open]);

  /*
   * The saved position is viewport-relative, so it goes stale the moment the
   * window changes size — a monitor swap, or simply dragging the app to a smaller
   * screen. Dragging clamped, but mounting never did, so both the orb and its
   * restore dot could come back entirely off-screen with no way to reach them
   * short of clearing localStorage. This runs in the overlay root because it is
   * mounted in every mode, including the ball-only one.
   */
  React.useEffect(() => {
    const sync = (): void => {
      const clamped = clampLauncherPosition(position);
      if (clamped.right !== position.right || clamped.bottom !== position.bottom) {
        setPosition(clamped);
      }
    };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [position, setPosition]);

  // ---- always-on HUD wiring ----------------------------------------------
  const collapseHud = React.useCallback(() => setHudCollapsed(true), [setHudCollapsed]);
  const expandHud = React.useCallback(() => setHudCollapsed(false), [setHudCollapsed]);
  const pinHud = React.useCallback((next: boolean) => setHudPinned(next), [setHudPinned]);
  /**
   * Open the detailed panel.
   *
   * There used to be a `showWorkspace` switch that could hide every way into this
   * panel — including the settings sheet, which only lives inside it — so the switch
   * could not be undone from the UI. It was removed in 2.1.9: opening the panel is
   * the switch.
   */
  const openWorkspace = React.useCallback(() => setOpen(true), [setOpen]);
  /**
   * The compact orb is the only entry point in `compact` mode. In `auto` it
   * unfolds the panel; when the user pinned the ball-only mode it opens the
   * detailed Workspace instead, because there is no panel to unfold.
   */
  const activateOrb = React.useCallback(() => {
    if (settings.displayMode === 'compact' || settings.displayMode === 'orb') {
      setOpen(true);
      return;
    }
    /*
     * Un-collapsing alone is not enough: in the default configuration (auto, idle)
     * `hudCollapsed` is already false, so the click changed nothing and React
     * bailed out on an identical state — the orb was a dead button in the most
     * common situation. Pinning guarantees the panel actually appears, and it is
     * also what the click means: "show me this, keep showing me".
     */
    setHudCollapsed(false);
    setHudPinned(true);
  }, [setHudCollapsed, setHudPinned, setOpen, settings.displayMode]);

  /*
   * A Host that speaks a newer protocol than this bundle. The data is dropped
   * upstream (see `setSnapshot`), so there is nothing honest to draw — but silence
   * looks exactly like "the plugin is broken", which sends the user to the issue
   * tracker instead of the refresh button. Say the one useful thing.
   */
  if (stale) {
    return (
      <React.Fragment>
        <style>{ENABLE_CSS}</style>
        <button
          type="button"
          className="no-enable"
          data-orbis-surface="stale"
          title={LABELS.protocol.stale}
          aria-label={LABELS.protocol.stale}
          onClick={() => {
            window.location.reload();
          }}
        >
          {LABELS.protocol.stale}
        </button>
      </React.Fragment>
    );
  }

  // ---- master switch off: one affordance, and nothing else ---------------
  if (!enabled) {
    return (
      <React.Fragment>
        <style>{ENABLE_CSS}</style>
        <button
          type="button"
          className="no-enable"
          title={LABELS.settings.enabled.label}
          aria-label={LABELS.settings.enabled.label}
          onClick={() => patchSettings({ enabled: true })}
        >
          {LABELS.settings.enabled.label}
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
          orbUnavailable={orbUnavailable}
          bindOrbSlot={bindWorkspaceSlot}
          onSettingsChange={patchSettings}
          onClose={() => setOpen(false)}
        />
      ) : null}
      {surfaces.hud ? (
        <OrbisHUD
          snapshot={snapshot}
          connection={connection}
          settings={settings}
          collapsed={hudCollapsed}
          pinned={hudPinned}
          reduceMotion={quality.reduceMotion}
          orbUnavailable={orbUnavailable}
          bindOrbSlot={bindHudSlot}
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
          orbUnavailable={orbUnavailable}
          onToggle={activateOrb}
          onHide={() => setVisible(false)}
          onPositionChange={setPositionLive}
          onPositionCommit={setPosition}
          bindOrbSlot={bindLauncherSlot}
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
      <span hidden aria-hidden="true" data-orbis-launcher-size={LAUNCHER_SIZE} />
    </React.Fragment>
  );
}
