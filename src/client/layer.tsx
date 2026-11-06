/**
 * The overlay root: one entry in `shell.overlay` that owns the launcher, the
 * workspace, both orb renderers, the SSE transport and every lifecycle rule
 * (pause when hidden, release on close, follow the displayed Session).
 */
import * as React from 'react';
import { LAUNCHER_SIZE, type OrbQuality, type OrbRenderer, type OrbVisualState } from './contracts';
import { createOrbRenderer } from './orb';
import { Launcher, LauncherRestore } from './launcher';
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
  const setSnapshot = useOrbitStore((state) => state.setSnapshot);
  const setConnection = useOrbitStore((state) => state.setConnection);
  const setOpen = useOrbitStore((state) => state.setOpen);
  const setVisible = useOrbitStore((state) => state.setVisible);
  const setPosition = useOrbitStore((state) => state.setPosition);
  const patchSettings = useOrbitStore((state) => state.patchSettings);
  const setFps = useOrbitStore((state) => state.setFps);

  // ---- follow the Session the main column displays ------------------------
  const displayed = props.useSessions?.(selectDisplayedSession);
  if (displayed !== undefined && displayed !== '') lastSessionId = displayed;
  const sessionId = displayed ?? lastSessionId;

  // ---- transport ----------------------------------------------------------
  const transportRef = React.useRef<Transport | null>(null);
  const sessionRef = React.useRef<string | undefined>(sessionId);
  sessionRef.current = sessionId;

  React.useEffect(() => {
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
  }, [setConnection, setSnapshot]);

  // Restart the stream when the followed Session changes.
  React.useEffect(() => {
    transportRef.current?.restart();
  }, [sessionId]);

  // ---- OS reduce-motion preference ---------------------------------------
  const [systemReduce, setSystemReduce] = React.useState(prefersReduceMotion);
  React.useEffect(() => watchReduceMotion(setSystemReduce), []);

  // ---- window focus / visibility -----------------------------------------
  const [hidden, setHidden] = React.useState(
    typeof document === 'undefined' ? false : document.visibilityState === 'hidden',
  );
  const [focused, setFocused] = React.useState(true);

  React.useEffect(() => {
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
  }, []);

  const suspended = settings.pauseWhenHidden && (hidden || !focused);

  // ---- derived renderer inputs -------------------------------------------
  const visual = React.useMemo(() => deriveVisual(snapshot, connection), [snapshot, connection]);
  const quality = React.useMemo(() => resolveQuality(settings, systemReduce), [settings, systemReduce]);

  const [launcherCanvas, setLauncherCanvas] = React.useState<HTMLCanvasElement | null>(null);
  const [workspaceCanvas, setWorkspaceCanvas] = React.useState<HTMLCanvasElement | null>(null);

  // The launcher rests while the workspace is open: two live contexts at once
  // would spend GPU on something the panel already covers.
  const launcherActive = visible && !open && !suspended;
  const launcher = useOrbRenderer(launcherCanvas, visual, quality, launcherActive);
  const workspace = useOrbRenderer(workspaceCanvas, visual, quality, open && !suspended);

  React.useEffect(() => {
    setFps(open ? workspace.fps : launcher.fps);
  }, [launcher.fps, workspace.fps, open, setFps]);

  // ---- ESC closes the workspace ------------------------------------------
  React.useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, setOpen]);

  const bindLauncherCanvas = React.useCallback((canvas: HTMLCanvasElement | null) => {
    setLauncherCanvas(canvas);
  }, []);

  const bindWorkspaceCanvas = React.useCallback((canvas: HTMLCanvasElement | null) => {
    setWorkspaceCanvas(canvas);
  }, []);

  const agentState = snapshot?.agentState ?? 'idle';
  const activeTools = snapshot?.activeTools ?? 0;

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
      <span hidden aria-hidden="true" data-neural-orbit-launcher-size={LAUNCHER_SIZE} />
    </React.Fragment>
  );
}
