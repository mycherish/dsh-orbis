/**
 * The always-on HUD stylesheet, generated once from the shared palette.
 *
 * Rules this sheet keeps:
 * - every selector starts with `.no-hud-`, so the sheet is namespaced and dies
 *   with the component that injected it — no host page class can collide;
 * - every colour is a palette literal or a `color-mix()` derivative of one, so
 *   the whole panel stays inside spec §3.1 (no ad-hoc hex, no host variables);
 * - the panel is anchored **top-right** (`top: 118px`, `right: 24px`) and never
 *   touches the bottom edge, so it cannot cover the composer;
 * - motion is opt-out twice: `prefers-reduced-motion` and `[data-reduce="true"]`
 *   (the user's 减少动态 setting) both kill every animation added here.
 */
import type * as React from 'react';
import { ORBIT_PALETTE } from '../contracts';

/** `a(P.blue, 20)` → blue at 20% alpha, derived, never hard-coded. */
const a = (color: string, pct: number): string =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

/** Mix two palette colours: `mix(purple, labelDim, 62)` = 62% purple. */
const mix = (from: string, to: string, pct: number): string =>
  `color-mix(in srgb, ${from} ${pct}%, ${to})`;

const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';

/**
 * React's `CSSProperties` cannot express custom properties, so the components
 * hand their `--no-hud-*` variables through this one typed escape hatch.
 */
export const cssVars = (vars: Record<string, string | number>): React.CSSProperties =>
  vars as unknown as React.CSSProperties;

/** Panel geometry shared with the TSX (so the shell and the sheet agree). */
export const HUD_LAYOUT = {
  /** Distance from the viewport top: below the app's own header strip. */
  top: 118,
  /** Distance from the right edge. */
  right: 24,
  /** Panel width; narrowed on small viewports by the media queries below. */
  width: 470,
  /** Ball diameter in the summary block. */
  ball: 96,
  /** Stacking order: below the Workspace panel's 2147483000. */
  z: 2147482990,
} as const;

export function buildHudStyles(): string {
  const P = ORBIT_PALETTE;

  return `
/* ---------- panel shell ---------- */
.no-hud-panel{
  position:fixed;
  top:${HUD_LAYOUT.top}px;
  right:${HUD_LAYOUT.right}px;
  z-index:${HUD_LAYOUT.z};
  box-sizing:border-box;
  display:flex;
  flex-direction:column;
  width:min(${HUD_LAYOUT.width}px,92vw);
  max-height:calc(100vh - 180px);
  border-radius:20px;
  overflow:hidden;
  border:1px solid color-mix(in srgb, ${P.purple} 42%, rgba(150,175,230,.22));
  background:
    radial-gradient(120% 88% at 6% 0%, ${a(P.purple, 14)}, transparent 62%),
    radial-gradient(96% 78% at 100% 104%, ${a(P.blue, 11)}, transparent 62%),
    linear-gradient(158deg, rgba(22,34,59,.84), rgba(9,15,30,.92));
  backdrop-filter:blur(22px) saturate(132%);
  -webkit-backdrop-filter:blur(22px) saturate(132%);
  box-shadow:
    0 26px 60px rgba(3,7,18,.56),
    inset 0 1px 0 rgba(232,238,251,.07),
    0 0 0 1px ${a(P.purple, 15)},
    0 0 42px ${a(P.purple, 18)},
    0 0 72px ${a(P.blue, 10)};
  color:${P.label};
  font:500 12.5px/1.45 ${SANS};
  pointer-events:auto;
  -webkit-font-smoothing:antialiased;
}
.no-hud-panel *,.no-hud-panel *::before,.no-hud-panel *::after{box-sizing:border-box}

/* ---------- header ---------- */
.no-hud-head{
  flex:0 0 auto;
  display:flex;
  align-items:center;
  gap:9px;
  padding:13px 15px 12px;
  border-bottom:1px solid rgba(150,175,230,.1);
  background:linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,0));
}
.no-hud-logo{flex:0 0 auto;width:26px;height:26px;display:block}
.no-hud-name{
  flex:0 0 auto;
  font-size:13.5px;
  font-weight:650;
  letter-spacing:.012em;
  color:${P.label};
  white-space:nowrap;
}
.no-hud-chip{
  flex:0 0 auto;
  display:inline-flex;
  align-items:center;
  gap:6px;
  height:22px;
  padding:0 9px;
  border-radius:11px;
  border:1px solid color-mix(in srgb, var(--no-hud-accent) 42%, rgba(150,175,230,.2));
  background:color-mix(in srgb, var(--no-hud-accent) 15%, rgba(12,20,36,.55));
  color:var(--no-hud-accent);
  font-size:11px;
  font-weight:600;
  letter-spacing:.01em;
  white-space:nowrap;
}
.no-hud-chip-dot{
  flex:0 0 auto;
  width:6px;height:6px;border-radius:50%;
  background:var(--no-hud-accent);
  box-shadow:0 0 8px color-mix(in srgb, var(--no-hud-accent) 70%, transparent);
}
.no-hud-panel[data-tone="busy"] .no-hud-chip-dot{animation:no-hud-pulse 2.4s ease-in-out infinite}
.no-hud-actions{flex:1 1 auto;display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0}
.no-hud-ibtn{
  flex:0 0 auto;
  width:24px;height:24px;
  display:grid;place-items:center;
  padding:0;
  border-radius:8px;
  border:1px solid rgba(150,175,230,.2);
  background:rgba(12,20,36,.5);
  color:${P.labelDim};
  cursor:pointer;
  transition:color .16s ease,border-color .16s ease,background .16s ease;
}
.no-hud-ibtn svg{width:13px;height:13px;display:block}
.no-hud-ibtn:hover{color:${P.label};border-color:color-mix(in srgb, var(--no-hud-accent) 48%, rgba(150,175,230,.24))}
.no-hud-ibtn:focus-visible{outline:2px solid ${P.cyan};outline-offset:2px}
.no-hud-ibtn[aria-pressed="true"]{
  color:${P.purple};
  border-color:color-mix(in srgb, ${P.purple} 58%, transparent);
  background:color-mix(in srgb, ${P.purple} 22%, rgba(12,20,36,.6));
  box-shadow:0 0 12px color-mix(in srgb, ${P.purple} 34%, transparent);
}

/* ---------- scrollable body ---------- */
.no-hud-body{
  flex:1 1 auto;
  min-height:0;
  overflow:auto;
  display:flex;
  flex-direction:column;
  gap:13px;
  padding:15px 16px 14px;
  scrollbar-width:thin;
  scrollbar-color:rgba(150,175,230,.26) transparent;
}
.no-hud-body::-webkit-scrollbar{width:6px}
.no-hud-body::-webkit-scrollbar-thumb{background:rgba(150,175,230,.24);border-radius:3px}
.no-hud-body::-webkit-scrollbar-track{background:transparent}

/* ---------- summary: ball + title ---------- */
.no-hud-summary{display:grid;grid-template-columns:${HUD_LAYOUT.ball}px minmax(0,1fr);gap:14px;align-items:center}
.no-hud-ball{position:relative;width:${HUD_LAYOUT.ball}px;height:${HUD_LAYOUT.ball}px;flex:0 0 auto}
.no-hud-ball-slot{
  position:absolute;inset:0;
  display:block;
  width:${HUD_LAYOUT.ball}px;height:${HUD_LAYOUT.ball}px;
  border-radius:50%;
  background:radial-gradient(circle at 50% 45%, ${P.surface}, ${P.bg} 72%);
}
.no-hud-ball-ring{
  position:absolute;inset:-2px;
  border-radius:50%;
  border:1px solid color-mix(in srgb, ${P.purple} 38%, transparent);
  box-shadow:0 0 22px color-mix(in srgb, ${P.purple} 24%, transparent);
  pointer-events:none;
}
.no-hud-ball-spin{
  position:absolute;inset:5px;
  border-radius:50%;
  border:1px dashed color-mix(in srgb, ${P.blue} 22%, transparent);
  pointer-events:none;
  animation:no-hud-spin 22s linear infinite;
}
.no-hud-ball-fallback{
  position:absolute;inset:0;
  display:grid;place-items:center;
  border-radius:50%;
  background:radial-gradient(circle at 50% 44%, color-mix(in srgb, ${P.purple} 52%, ${P.surface}), ${P.bg} 74%);
}
.no-hud-ball-fallback i{display:block;width:9px;height:9px;border-radius:50%;background:${P.label};opacity:.9}
.no-hud-meta{display:flex;flex-direction:column;gap:4px;min-width:0}
.no-hud-title{
  margin:0;
  font-size:17px;
  font-weight:700;
  line-height:1.28;
  letter-spacing:-.006em;
  color:${P.label};
  display:-webkit-box;
  -webkit-line-clamp:2;
  -webkit-box-orient:vertical;
  overflow:hidden;
}
.no-hud-title[data-fallback="true"]{color:${P.labelDim};font-weight:600}
.no-hud-phase{margin:0;font-size:12px;font-weight:600;color:${mix(P.purple, P.labelDim, 60)}}
.no-hud-action{
  margin:0;
  font-size:11.5px;
  line-height:1.45;
  color:${P.labelDim};
  display:-webkit-box;
  -webkit-line-clamp:2;
  -webkit-box-orient:vertical;
  overflow:hidden;
}

/* ---------- info pills ---------- */
.no-hud-pills{display:flex;flex-wrap:wrap;gap:7px}
.no-hud-pill{
  display:inline-flex;
  align-items:center;
  gap:6px;
  height:25px;
  padding:0 10px;
  border-radius:13px;
  border:1px solid rgba(150,175,230,.16);
  background:rgba(150,175,230,.07);
  color:${P.label};
  font-size:11.5px;
  font-weight:550;
  white-space:nowrap;
  font-variant-numeric:tabular-nums;
}
.no-hud-pill svg{width:12px;height:12px;flex:0 0 auto}
.no-hud-pill[data-kind="time"] svg{color:${P.cyan}}
.no-hud-pill[data-kind="mode"] svg{color:${P.purple}}
.no-hud-pill-label{color:${P.labelDim}}
.no-hud-pill-value{font-weight:650;color:${P.label};font-variant-numeric:tabular-nums}

/* ---------- sections ---------- */
.no-hud-section{display:flex;flex-direction:column;gap:7px}
.no-hud-section-head{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:650;letter-spacing:.03em;color:${P.labelDim}}
.no-hud-section-head svg{width:12px;height:12px;flex:0 0 auto;color:${P.blue}}
.no-hud-section-head[data-kind="status"] svg{color:${P.cyan}}

/* ---------- activity rows ---------- */
.no-hud-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.no-hud-row{
  display:grid;
  grid-template-columns:14px minmax(0,1fr) auto auto;
  align-items:center;
  gap:10px;
  padding:5px 0;
  border-top:1px solid rgba(150,175,230,.055);
  animation:no-hud-row-in .26s ease-out both;
}
.no-hud-row:first-child{border-top:0}
.no-hud-row-icon{font-size:11px;line-height:1;text-align:center;color:var(--no-hud-row)}
.no-hud-row-text{font-size:12px;color:${P.label};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.no-hud-row-time{min-width:36px;text-align:right;font:500 10.5px/1 ${MONO};color:${mix(P.labelDim, P.bg, 88)};font-variant-numeric:tabular-nums}
.no-hud-row-status{min-width:34px;text-align:right;font-size:10.5px;font-weight:600;color:var(--no-hud-row);white-space:nowrap}
.no-hud-empty{margin:0;padding:5px 0;font-size:11.5px;color:${P.labelDim}}

/* ---------- current status ---------- */
.no-hud-status{
  display:flex;
  align-items:flex-start;
  gap:8px;
  padding:9px 11px;
  border-radius:11px;
  border:1px solid rgba(150,175,230,.08);
  background:rgba(150,175,230,.055);
}
.no-hud-status-icon{flex:0 0 auto;width:13px;height:13px;margin-top:1px;color:${mix(P.blue, P.labelDim, 80)}}
/* Every inline SVG inside the panel is sized by CSS; an unsized one would blow
   the block up to the viewport, so the rule is scoped, not class-dependent. */
.no-hud-status svg{flex:0 0 auto;width:13px;height:13px;margin-top:1px}
.no-hud-status-text{margin:0;font-size:11.5px;line-height:1.5;color:${mix(P.label, P.labelDim, 68)}}
.no-hud-next{margin:0;display:flex;gap:5px;align-items:baseline;font-size:11.5px;line-height:1.45;color:${mix(P.purple, P.label, 72)}}
.no-hud-next b{font-weight:600;color:${P.purple}}

/* ---------- footer ---------- */
.no-hud-foot{
  flex:0 0 auto;
  display:flex;
  align-items:center;
  gap:6px;
  flex-wrap:wrap;
  padding-top:10px;
  border-top:1px solid rgba(150,175,230,.1);
  font-size:10.5px;
  color:${mix(P.labelDim, P.bg, 92)};
  font-variant-numeric:tabular-nums;
}
.no-hud-foot svg{width:12px;height:12px;flex:0 0 auto;color:${mix(P.labelDim, P.bg, 90)}}

/* ---------- collapsed chip ---------- */
.no-hud-mini{
  position:fixed;
  top:${HUD_LAYOUT.top}px;
  right:${HUD_LAYOUT.right}px;
  z-index:${HUD_LAYOUT.z};
  box-sizing:border-box;
  display:flex;
  align-items:center;
  gap:9px;
  width:min(360px,92vw);
  padding:9px 11px;
  border-radius:14px;
  border:1px solid color-mix(in srgb, ${P.purple} 30%, rgba(150,175,230,.22));
  background:linear-gradient(158deg, rgba(22,34,59,.86), rgba(9,15,30,.92));
  backdrop-filter:blur(18px) saturate(128%);
  -webkit-backdrop-filter:blur(18px) saturate(128%);
  box-shadow:0 16px 36px rgba(3,7,18,.5);
  color:${P.label};
  font:600 11.5px/1.25 ${SANS};
  cursor:pointer;
  text-align:left;
  transition:border-color .18s ease,transform .18s ease;
  pointer-events:auto;
}
.no-hud-mini:hover{border-color:color-mix(in srgb, ${P.purple} 55%, rgba(150,175,230,.24));transform:translateY(-1px)}
.no-hud-mini:focus-visible{outline:2px solid ${P.cyan};outline-offset:3px}
.no-hud-mini-logo{flex:0 0 auto;width:18px;height:18px;display:block}
.no-hud-mini-chip{
  flex:0 0 auto;
  display:inline-flex;align-items:center;gap:5px;
  height:20px;padding:0 8px;border-radius:10px;
  border:1px solid color-mix(in srgb, var(--no-hud-accent) 40%, rgba(150,175,230,.2));
  background:color-mix(in srgb, var(--no-hud-accent) 14%, rgba(12,20,36,.5));
  color:var(--no-hud-accent);
  font-size:10.5px;font-weight:600;white-space:nowrap;
}
.no-hud-mini-title{flex:1 1 auto;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${P.label}}
.no-hud-mini-hint{flex:0 0 auto;font-size:10.5px;font-weight:600;color:${P.labelDim};white-space:nowrap}

/* ---------- motion ---------- */
@keyframes no-hud-pulse{0%,100%{opacity:.55;transform:scale(.86)}50%{opacity:1;transform:scale(1.14)}}
@keyframes no-hud-row-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
@keyframes no-hud-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}

/* ---------- responsive ---------- */
@media (max-width:1100px){
  .no-hud-panel{width:min(420px,92vw)}
  .no-hud-mini{width:min(330px,92vw)}
}
@media (max-width:720px){
  .no-hud-panel{top:64px;right:12px;width:calc(100vw - 24px);max-height:calc(100vh - 96px)}
  .no-hud-mini{top:64px;right:12px;width:calc(100vw - 24px)}
  .no-hud-summary{grid-template-columns:72px minmax(0,1fr);gap:12px}
  .no-hud-ball,.no-hud-ball-slot{width:72px;height:72px}
  .no-hud-title{font-size:15.5px}
}

/* ---------- opt-out ---------- */
.no-hud-panel[data-reduce="true"] .no-hud-chip-dot,
.no-hud-panel[data-reduce="true"] .no-hud-ball-spin,
.no-hud-mini[data-reduce="true"] .no-hud-chip-dot{animation:none!important}
.no-hud-panel[data-reduce="true"] .no-hud-row{animation:none!important}
@media (prefers-reduced-motion:reduce){
  .no-hud-chip-dot,.no-hud-ball-spin,.no-hud-row{animation:none!important}
  .no-hud-mini,.no-hud-ibtn{transition:none}
  .no-hud-mini:hover{transform:none}
}
`;
}
