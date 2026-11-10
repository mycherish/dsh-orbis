/**
 * The 76px floating energy orb (spec §2.1).
 *
 * It owns no renderer: the shell hands down a canvas ref and the orb module
 * draws into it. The launcher only contributes chrome — glass ring, tooltip,
 * drag handling and the hide affordance — so a WebGL failure degrades to a
 * styled status dot instead of a blank square.
 */
import * as React from 'react';
import { LAUNCHER_SIZE, ORBIT_PALETTE, STATE_COLOR, type OrbitConnection } from './contracts';
import type { LauncherPosition } from './store';
import type { OrbitAgentState } from '../shared/protocol';

export interface LauncherProps {
  position: LauncherPosition;
  agentState: OrbitAgentState;
  activeTools: number;
  connection: OrbitConnection;
  open: boolean;
  translate: (key: string) => string;
  onToggle: () => void;
  onHide: () => void;
  onPositionChange: (position: LauncherPosition) => void;
  /** Bind the shared orb slot; the shell moves the single canvas in here. */
  bindOrbSlot: (el: HTMLElement | null) => void;
  /** True when WebGL is unavailable and the static fallback should draw. */
  orbUnavailable?: boolean;
}

const DRAG_THRESHOLD_PX = 4;
const EDGE_MARGIN_PX = 8;

const CSS = `
.no-launcher{position:fixed;z-index:40;width:${LAUNCHER_SIZE}px;height:${LAUNCHER_SIZE}px;border:0;padding:0;background:transparent;cursor:grab;touch-action:none;filter:drop-shadow(0 8px 22px rgba(6,12,28,.55));transition:transform .22s cubic-bezier(.2,.7,.3,1)}
.no-launcher[data-dragging="true"]{cursor:grabbing;transition:none}
.no-launcher:hover{transform:scale(1.06)}
.no-launcher:focus-visible{outline:2px solid ${ORBIT_PALETTE.cyan};outline-offset:4px;border-radius:50%}
.no-launcher-slot{position:absolute;inset:0;width:${LAUNCHER_SIZE}px;height:${LAUNCHER_SIZE}px;border-radius:50%;display:block;background:radial-gradient(circle at 50% 45%, ${ORBIT_PALETTE.surface}, ${ORBIT_PALETTE.bg} 72%)}
.no-launcher-ring{position:absolute;inset:-3px;border-radius:50%;border:1px solid color-mix(in srgb, var(--no-accent) 42%, transparent);box-shadow:0 0 18px color-mix(in srgb, var(--no-accent) 28%, transparent);pointer-events:none;transition:border-color .4s ease, box-shadow .4s ease}
.no-launcher[data-live="true"] .no-launcher-ring{animation:no-breathe 3.4s ease-in-out infinite}
.no-launcher-fallback[data-active="false"]{display:none}
.no-launcher-fallback{position:absolute;inset:0;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--no-accent) 55%, ${ORBIT_PALETTE.surface}), ${ORBIT_PALETTE.bg} 74%)}
.no-launcher-fallback i{display:block;width:10px;height:10px;border-radius:50%;background:${ORBIT_PALETTE.label};opacity:.9}
.no-launcher-badge{position:absolute;top:-2px;right:-2px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:color-mix(in srgb, var(--no-accent) 82%, #000 18%);color:#04101f;font:600 10px/16px ui-monospace,SFMono-Regular,Menlo,monospace;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.35)}
.no-launcher-tip{position:absolute;right:calc(100% + 10px);top:50%;transform:translateY(-50%);white-space:nowrap;padding:6px 10px;border-radius:10px;background:rgba(12,20,36,.86);backdrop-filter:blur(10px);border:1px solid rgba(140,170,230,.22);color:${ORBIT_PALETTE.label};font:500 11.5px/1.3 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;opacity:0;pointer-events:none;transition:opacity .16s ease}
.no-launcher:hover .no-launcher-tip,.no-launcher:focus-visible .no-launcher-tip{opacity:1}
.no-launcher-tip b{color:var(--no-accent);font-weight:600}
.no-launcher-hide{position:absolute;top:-6px;left:-6px;width:18px;height:18px;border-radius:50%;border:1px solid rgba(150,175,230,.3);background:rgba(12,20,36,.9);color:${ORBIT_PALETTE.labelDim};font:500 11px/16px -apple-system,sans-serif;text-align:center;cursor:pointer;opacity:0;transition:opacity .16s ease}
.no-launcher:hover .no-launcher-hide{opacity:1}
.no-launcher-restore{position:fixed;z-index:40;width:22px;height:22px;border-radius:50%;border:1px solid rgba(150,175,230,.32);background:radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--no-accent) 60%, #0a1122), #070b18 78%);cursor:pointer;opacity:.55;transition:opacity .2s ease, transform .2s ease}
.no-launcher-restore:hover{opacity:1;transform:scale(1.12)}
@keyframes no-breathe{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.045)}}
@media (prefers-reduced-motion:reduce){.no-launcher,.no-launcher-ring{transition:none;animation:none!important}.no-launcher:hover{transform:none}}
`;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originRight: number;
  originBottom: number;
  moved: boolean;
}

/**
 * Keep the orb inside the viewport.
 *
 * Pure and viewport-injectable so the overlay root can apply it even when the
 * launcher is not the mounted surface, and so it is testable without a DOM.
 */
export function clampLauncherPosition(
  next: LauncherPosition,
  viewport?: { width: number; height: number },
): LauncherPosition {
  const width = viewport?.width ?? (typeof window === 'undefined' ? 0 : window.innerWidth);
  const height = viewport?.height ?? (typeof window === 'undefined' ? 0 : window.innerHeight);
  if (width <= 0 || height <= 0) return { ...next };
  const maxRight = Math.max(EDGE_MARGIN_PX, width - LAUNCHER_SIZE - EDGE_MARGIN_PX);
  const maxBottom = Math.max(EDGE_MARGIN_PX, height - LAUNCHER_SIZE - EDGE_MARGIN_PX);
  return {
    right: Math.min(maxRight, Math.max(EDGE_MARGIN_PX, next.right)),
    bottom: Math.min(maxBottom, Math.max(EDGE_MARGIN_PX, next.bottom)),
  };
}

export function Launcher(props: LauncherProps): React.ReactElement {
  const { position, agentState, activeTools, open, translate } = props;
  const [dragging, setDragging] = React.useState(false);
  const dragRef = React.useRef<DragState | null>(null);
  const accent = STATE_COLOR[agentState];

  const slotRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      props.bindOrbSlot(el);
    },
    [props.bindOrbSlot],
  );

  const clampPosition = React.useCallback(
    (next: LauncherPosition): LauncherPosition => clampLauncherPosition(next),
    [],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originRight: position.right,
      originBottom: position.bottom,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    setDragging(true);
    props.onPositionChange(
      clampPosition({
        right: drag.originRight - dx,
        bottom: drag.originBottom - dy,
      }),
    );
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture already released.
    }
    if (!drag.moved) props.onToggle();
  };

  const style = {
    right: `${position.right}px`,
    bottom: `${position.bottom}px`,
    '--no-accent': accent,
  } as React.CSSProperties;

  if (!props.connection || props.connection === 'closed') {
    // Still render the orb: a dropped stream must not remove the entry point.
  }

  return (
    <div
      className="no-launcher"
      data-orbis-surface="launcher"
      role="button"
      tabIndex={0}
      aria-label={`${translate('launcher.label')} · ${translate(`state.${agentState}`)}`}
      aria-expanded={open}
      data-dragging={dragging ? 'true' : 'false'}
      data-live={agentState === 'thinking' || agentState === 'executing' ? 'true' : 'false'}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          props.onToggle();
        }
      }}
    >
      <style>{CSS}</style>
      <span
        className="no-launcher-fallback"
        aria-hidden="true"
        data-active={props.orbUnavailable === true ? 'true' : 'false'}
      >
        <i />
      </span>
      <div ref={slotRef} className="no-launcher-slot" aria-hidden="true" />
      <span className="no-launcher-ring" aria-hidden="true" />
      {activeTools > 0 ? (
        <span className="no-launcher-badge" aria-hidden="true">
          {activeTools > 9 ? '9+' : activeTools}
        </span>
      ) : null}
      <span className="no-launcher-tip" role="tooltip">
        <b>{translate(`state.${agentState}`)}</b>
        {activeTools > 0 ? ` · ${translate('launcher.tools')} ${activeTools}` : ''}
      </span>
      <button
        type="button"
        className="no-launcher-hide"
        aria-label={translate('launcher.hide')}
        title={translate('launcher.hide')}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          props.onHide();
        }}
      >
        ×
      </button>
    </div>
  );
}

/** The tiny dot that brings a hidden launcher back. */
export function LauncherRestore(props: {
  position: LauncherPosition;
  agentState: OrbitAgentState;
  translate: (key: string) => string;
  onRestore: () => void;
}): React.ReactElement {
  const accent = STATE_COLOR[props.agentState];
  return (
    <button
      type="button"
      className="no-launcher-restore"
      aria-label={props.translate('launcher.show')}
      title={props.translate('launcher.show')}
      style={
        {
          right: `${props.position.right + 24}px`,
          bottom: `${props.position.bottom + 24}px`,
          '--no-accent': accent,
        } as React.CSSProperties
      }
      onClick={props.onRestore}
    >
      <style>{CSS}</style>
    </button>
  );
}
