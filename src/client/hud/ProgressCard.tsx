/**
 * The always-on progress card (Always-on HUD): a 260–300 × 120–160 fixed card
 * in the lower-right corner, next to — never on top of — the orb and the input
 * box, so the Agent's progress is readable without opening the Workspace.
 *
 * It is pure DOM plus one scoped `<style>` block: no new dependency, no WebGL
 * context, no timer of its own. Every class is `.no-hud-` prefixed and the sheet
 * dies with the component.
 *
 * Three presentations, decided by `hudCardMode()` (pure, unit-tested):
 *  - `expanded` — title line, detail line, thin progress bar, two buttons;
 *  - `compact`  — one single line (compact mode, or a card the user folded);
 *  - `hidden`   — `orb` display mode draws nothing at all.
 */
import * as React from 'react';
import {
  HUD_SIZE,
  ORBIT_PALETTE,
  STATE_COLOR,
  type OrbitConnection,
  type OrbitSettings,
} from '../contracts';
import {
  hudCardMode,
  hudDetail,
  hudProgress,
  hudTitle,
  hudTone,
  type HudTone,
} from './progress';
import type { OrbitSnapshot } from '../../shared/protocol';

export interface ProgressCardProps {
  snapshot: OrbitSnapshot | null;
  connection: OrbitConnection;
  settings: OrbitSettings;
  /** Persisted manual fold (`hudCollapsed`); only a click clears it. */
  collapsed: boolean;
  /** Resolved from `settings.reduceMotion` + the OS preference. */
  reduceMotion: boolean;
  /** Fold the card by hand. */
  onCollapse: () => void;
  /** Unfold a card the user folded earlier. */
  onExpand: () => void;
  /** Open the Workspace panel. */
  onOpenWorkspace: () => void;
  /**
   * Distance from the viewport bottom, in CSS pixels. The shell raises it when
   * the user drags the orb into the card's corner, so the two never overlap.
   */
  bottomOffset?: number;
}

/** Default distance from the viewport bottom: above the orb, below the input. */
const HUD_BOTTOM = 104;

const P = ORBIT_PALETTE;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SANS =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';

/** Tone → accent used for the ring and the progress fill. */
const TONE_COLOR: Record<HudTone, string> = {
  calm: P.labelDim,
  busy: P.cyan,
  alert: P.warning,
  done: P.success,
};

const CSS = `
.no-hud-card{position:fixed;right:24px;bottom:var(--no-hud-bottom,104px);z-index:2147482990;box-sizing:border-box;display:flex;flex-direction:column;gap:7px;width:clamp(${HUD_SIZE.min}px,24vw,${HUD_SIZE.max}px);min-height:${HUD_SIZE.minHeight}px;max-height:${HUD_SIZE.maxHeight}px;padding:12px 14px;border-radius:14px;border:1px solid color-mix(in srgb, var(--no-hud-accent) 34%, rgba(150,175,230,.2));background:linear-gradient(158deg, rgba(22,34,59,.9), rgba(10,17,34,.93));backdrop-filter:blur(14px) saturate(120%);box-shadow:0 14px 32px rgba(4,9,20,.48);color:${P.label};font:500 12px/1.35 ${SANS};pointer-events:auto}
.no-hud-head{display:flex;align-items:center;gap:7px;min-height:16px}
.no-hud-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--no-hud-accent);box-shadow:0 0 10px color-mix(in srgb, var(--no-hud-accent) 62%, transparent)}
.no-hud-card[data-tone="busy"] .no-hud-dot{animation:no-hud-breathe 2.6s ease-in-out infinite}
.no-hud-card[data-reduce="true"] .no-hud-dot{animation:none}
.no-hud-title{flex:1 1 auto;min-width:0;font-size:12.5px;font-weight:600;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${P.label}}
.no-hud-fold{flex:0 0 auto;width:18px;height:18px;padding:0;border-radius:50%;border:1px solid rgba(150,175,230,.26);background:rgba(12,20,36,.72);color:${P.labelDim};font:500 12px/15px ${SANS};text-align:center;cursor:pointer;transition:color .16s ease,border-color .16s ease}
.no-hud-fold:hover{color:${P.label};border-color:color-mix(in srgb, var(--no-hud-accent) 55%, rgba(150,175,230,.3))}
.no-hud-fold:focus-visible{outline:2px solid ${P.cyan};outline-offset:2px}
.no-hud-detail{flex:0 0 auto;font-size:11.5px;line-height:1.45;color:${P.labelDim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.no-hud-track{flex:0 0 auto;position:relative;height:3px;border-radius:2px;background:rgba(150,175,230,.16);overflow:hidden}
.no-hud-fill{display:block;height:100%;border-radius:2px;background:linear-gradient(90deg,color-mix(in srgb, var(--no-hud-accent) 72%, transparent),var(--no-hud-accent));transition:width .38s cubic-bezier(.3,.8,.3,1)}
.no-hud-actions{display:flex;align-items:center;gap:8px;margin-top:auto;min-height:20px}
.no-hud-open{flex:0 0 auto;padding:4px 10px;border-radius:8px;border:1px solid color-mix(in srgb, var(--no-hud-accent) 45%, transparent);background:color-mix(in srgb, var(--no-hud-accent) 16%, rgba(16,24,43,.9));color:${P.label};font:600 11px/1.3 ${SANS};cursor:pointer;white-space:nowrap;transition:background .16s ease,border-color .16s ease}
.no-hud-open:hover{background:color-mix(in srgb, var(--no-hud-accent) 26%, rgba(16,24,43,.9));border-color:color-mix(in srgb, var(--no-hud-accent) 62%, transparent)}
.no-hud-open:focus-visible{outline:2px solid ${P.cyan};outline-offset:2px}
.no-hud-meta{flex:1 1 auto;min-width:0;text-align:right;font:500 10.5px/1.3 ${MONO};color:color-mix(in srgb, ${P.labelDim} 82%, transparent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.no-hud-chip{position:fixed;right:24px;bottom:var(--no-hud-bottom,104px);z-index:2147482990;box-sizing:border-box;display:flex;align-items:center;gap:7px;max-width:clamp(${HUD_SIZE.min}px,38vw,${HUD_SIZE.max}px);height:32px;padding:0 11px;border-radius:16px;border:1px solid color-mix(in srgb, var(--no-hud-accent) 32%, rgba(150,175,230,.2));background:linear-gradient(158deg, rgba(22,34,59,.9), rgba(10,17,34,.93));backdrop-filter:blur(12px) saturate(115%);box-shadow:0 10px 24px rgba(4,9,20,.44);color:${P.label};font:500 11.5px/1 ${SANS};cursor:pointer;transition:border-color .18s ease,transform .18s ease}
.no-hud-chip:hover{border-color:color-mix(in srgb, var(--no-hud-accent) 58%, rgba(150,175,230,.24));transform:translateY(-1px)}
.no-hud-chip:focus-visible{outline:2px solid ${P.cyan};outline-offset:3px}
.no-hud-chip[data-tone="busy"] .no-hud-dot{animation:no-hud-breathe 2.6s ease-in-out infinite}
.no-hud-chip[data-reduce="true"] .no-hud-dot{animation:none}
.no-hud-chip-title{flex:0 0 auto;font-weight:600;white-space:nowrap}
.no-hud-chip-detail{flex:1 1 auto;min-width:0;color:${P.labelDim};font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.no-hud-chip-more{flex:0 0 auto;color:${P.labelDim};font-size:11px;white-space:nowrap}
@keyframes no-hud-breathe{0%,100%{opacity:.55;transform:scale(.86)}50%{opacity:1;transform:scale(1.14)}}
@media (max-width:720px){
.no-hud-card{right:12px;bottom:auto;top:64px;width:min(${HUD_SIZE.min}px,calc(100vw - 24px))}
.no-hud-chip{right:12px;bottom:auto;top:64px;max-width:min(${HUD_SIZE.min}px,calc(100vw - 24px))}
}
@media (prefers-reduced-motion:reduce){
.no-hud-dot{animation:none!important}
.no-hud-fill{transition:none}
.no-hud-chip{transition:none}
.no-hud-chip:hover{transform:none}
}
`;

function percent(progress: number): number {
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}

/** Small right-side counter: in-flight tools, else the connection caveat. */
function metaText(connection: OrbitConnection, activeTools: number): string {
  if (connection === 'closed') return '未连接';
  if (connection === 'reconnecting') return '重连中…';
  if (activeTools > 0) return `工具 ${activeTools}`;
  return '';
}

export function ProgressCard(props: ProgressCardProps): React.ReactElement | null {
  const { snapshot, connection, settings, collapsed, reduceMotion } = props;

  const state = snapshot?.agentState ?? 'idle';
  const mode = hudCardMode(settings.displayMode, state, collapsed);
  const tone = hudTone(state);
  const accent = STATE_COLOR[state] ?? TONE_COLOR[tone];

  const title = snapshot === null ? '正在连接…' : hudTitle(snapshot, connection);
  const detail = snapshot === null ? '等待第一条快照' : hudDetail(snapshot);
  const progress = React.useMemo(
    () => (snapshot === null ? 0 : hudProgress(snapshot)),
    [snapshot],
  );
  const pct = percent(progress);
  const meta = metaText(connection, snapshot?.activeTools ?? 0);

  const vars = {
    '--no-hud-accent': accent,
    '--no-hud-bottom': `${Math.round(props.bottomOffset ?? HUD_BOTTOM)}px`,
  } as React.CSSProperties;
  const reduce = reduceMotion ? 'true' : 'false';

  if (mode === 'hidden') return null;

  if (mode === 'compact') {
    // `auto` folds by hand and unfolds by hand; `compact` opens the Workspace.
    const reopen = settings.displayMode === 'auto';
    const label = reopen ? `展开进度卡片 · ${title}` : `打开 Workspace · ${title}`;
    return (
      <button
        type="button"
        className="no-hud-chip"
        data-tone={tone}
        data-reduce={reduce}
        style={vars}
        title={`${title} · ${detail}`}
        aria-label={label}
        aria-expanded={reopen ? false : undefined}
        onClick={reopen ? props.onExpand : props.onOpenWorkspace}
      >
        <style>{CSS}</style>
        <span className="no-hud-dot" aria-hidden="true" />
        <span className="no-hud-chip-title">{title}</span>
        <span className="no-hud-chip-detail">{detail}</span>
        <span className="no-hud-chip-more" aria-hidden="true">{reopen ? '展开' : '打开'}</span>
      </button>
    );
  }

  return (
    <div
      className="no-hud-card"
      data-tone={tone}
      data-reduce={reduce}
      data-display-mode={settings.displayMode}
      style={vars}
      role="group"
      aria-label="Neural Orbit 进度"
    >
      <style>{CSS}</style>
      <div className="no-hud-head">
        <span className="no-hud-dot" aria-hidden="true" />
        <span className="no-hud-title" title={title}>{title}</span>
        <button
          type="button"
          className="no-hud-fold"
          title="收起进度卡片"
          aria-label="收起进度卡片"
          onClick={props.onCollapse}
        >
          ×
        </button>
      </div>
      <div className="no-hud-detail" aria-live="polite" title={detail}>{detail}</div>
      <div
        className="no-hud-track"
        role="progressbar"
        aria-label="本轮进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <i className="no-hud-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="no-hud-actions">
        <button
          type="button"
          className="no-hud-open"
          onClick={props.onOpenWorkspace}
        >
          展开 Workspace
        </button>
        <span className="no-hud-meta">{meta}</span>
      </div>
    </div>
  );
}
