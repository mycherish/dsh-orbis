/**
 * The Workspace panel stylesheet, generated once from the design palette.
 *
 * Rules:
 * - every selector starts with `.no-`, so the sheet is namespaced and dies with
 *   the component that injected it;
 * - every colour is either a palette literal or a `color-mix()` derivative of
 *   one, so the whole panel stays inside spec §3.1 — no host theme variables,
 *   no ad-hoc hex values;
 * - motion is opt-out through `[data-motion]` plus `prefers-reduced-motion`.
 */
import type * as React from 'react';
import { ORBIT_PALETTE } from '../contracts';

/** `a(ORBIT_PALETTE.blue, 20)` → blue at 20% alpha, derived, never hard-coded. */
const a = (color: string, pct: number): string =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

/** Mix two palette colours (used for gradient midpoints). */
const mix = (from: string, to: string, pct: number): string =>
  `color-mix(in srgb, ${from} ${100 - pct}%, ${to})`;

const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';

/**
 * React's `CSSProperties` cannot express custom properties, so panel components
 * hand their `--no-*` variables through this one typed escape hatch instead of
 * sprinkling `as any` around.
 */
export const cssVars = (vars: Record<string, string | number>): React.CSSProperties =>
  vars as unknown as React.CSSProperties;

export function buildStyles(): string {
  const P = ORBIT_PALETTE;

  return `
/* ---------- shell ---------- */
.no-root {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
  z-index: 2147483000;
  font-family: ${SANS};
  color: ${P.label};
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.no-root *, .no-root *::before, .no-root *::after { box-sizing: border-box; }

.no-panel {
  position: relative;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  width: min(780px, 94vw);
  height: min(600px, 88vh);
  overflow: hidden;
  border-radius: 20px;
  border: 1px solid ${a(P.label, 10)};
  background-color: ${P.glass};
  background-image:
    radial-gradient(120% 90% at 8% -14%, ${a(P.blue, 16)} 0%, ${a(P.blue, 0)} 58%),
    radial-gradient(95% 80% at 96% -6%, ${a(P.purple, 18)} 0%, ${a(P.purple, 0)} 56%),
    radial-gradient(140% 120% at 50% 120%, ${a(P.cyan, 7)} 0%, ${a(P.cyan, 0)} 60%),
    linear-gradient(178deg, ${a(P.surface, 26)} 0%, ${a(P.bg, 34)} 100%);
  -webkit-backdrop-filter: blur(24px) saturate(150%);
  backdrop-filter: blur(24px) saturate(150%);
  box-shadow:
    0 40px 90px -40px ${a(P.bg, 96)},
    0 8px 26px -14px ${a(P.bg, 80)},
    0 0 0 1px ${a(P.blue, 5)},
    0 0 90px -34px ${a(P.purple, 42)},
    inset 0 1px 0 ${a(P.label, 9)},
    inset 0 -1px 0 ${a(P.bg, 42)};
  animation: no-panel-in 260ms cubic-bezier(0.22, 0.68, 0.28, 1) both;
  outline: none;
  font-size: 12px;
  line-height: 1.4;
}
.no-panel:focus-visible { outline: 1px solid ${a(P.blue, 42)}; outline-offset: 2px; }

@supports not ((backdrop-filter: blur(4px)) or (-webkit-backdrop-filter: blur(4px))) {
  .no-panel { background-color: ${mix(P.surface, P.bg, 30)}; }
}
.no-panel ::selection { background: ${a(P.blue, 30)}; color: ${P.label}; }

/* thin, quiet scrollbars */
.no-panel ::-webkit-scrollbar { width: 8px; height: 8px; }
.no-panel ::-webkit-scrollbar-track { background: transparent; }
.no-panel ::-webkit-scrollbar-thumb {
  background: ${a(P.label, 12)};
  border: 2px solid transparent;
  background-clip: padding-box;
  border-radius: 999px;
}
.no-panel ::-webkit-scrollbar-thumb:hover { background: ${a(P.label, 22)}; background-clip: padding-box; }

/* ---------- header ---------- */
.no-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  flex: none;
  padding: 13px 14px 12px 18px;
  border-bottom: 1px solid ${a(P.label, 7)};
}
.no-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.no-mark { flex: none; display: block; filter: drop-shadow(0 0 8px ${a(P.cyan, 42)}); }
.no-word {
  font-size: 13.5px;
  font-weight: 620;
  letter-spacing: 0.012em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: ${P.label};
}
@supports ((background-clip: text) or (-webkit-background-clip: text)) {
  .no-word {
    background-image: linear-gradient(96deg, ${P.label} 0%, ${mix(P.label, P.blue, 62)} 48%, ${mix(P.blue, P.purple, 55)} 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
}

.no-chip-wrap { display: flex; justify-content: center; min-width: 0; }
.no-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px 5px 9px;
  border-radius: 999px;
  white-space: nowrap;
  border: 1px solid color-mix(in srgb, var(--no-state) 34%, transparent);
  background: color-mix(in srgb, var(--no-state) 11%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--no-state) 12%, transparent);
}
.no-chip-dot {
  width: 7px; height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--no-state);
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--no-state) 15%, transparent),
    0 0 10px color-mix(in srgb, var(--no-state) 60%, transparent);
}
.no-chip-zh { font-size: 11.5px; font-weight: 600; color: ${P.label}; letter-spacing: 0.02em; }
.no-chip-en {
  font-family: ${MONO};
  font-size: 8.5px;
  letter-spacing: 0.16em;
  color: color-mix(in srgb, var(--no-state) 62%, ${P.labelDim});
  padding-left: 1px;
}

.no-head-right { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; }
.no-conn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 3px 8px 3px 7px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--no-conn) 22%, transparent);
  background: color-mix(in srgb, var(--no-conn) 7%, transparent);
}
.no-conn-dot {
  width: 5px; height: 5px;
  flex: none;
  border-radius: 50%;
  background: var(--no-conn);
  box-shadow: 0 0 8px color-mix(in srgb, var(--no-conn) 72%, transparent);
}
.no-conn-zh {
  font-size: 10.5px;
  color: color-mix(in srgb, var(--no-conn) 58%, ${P.label});
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.no-conn-en {
  font-family: ${MONO};
  font-size: 8px;
  letter-spacing: 0.14em;
  color: color-mix(in srgb, var(--no-conn) 44%, ${P.labelDim});
}
.no-head-div { width: 1px; height: 16px; flex: none; background: ${a(P.label, 9)}; margin: 0 1px; }

.no-icon-btn {
  width: 27px; height: 27px;
  flex: none;
  display: grid;
  place-items: center;
  padding: 0;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: ${P.labelDim};
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
}
.no-icon-btn:hover { background: ${a(P.label, 7)}; border-color: ${a(P.label, 10)}; color: ${P.label}; }
.no-icon-btn:active { background: ${a(P.label, 11)}; }
.no-icon-btn:focus-visible { outline: 2px solid ${a(P.blue, 68)}; outline-offset: 1px; color: ${P.label}; }
.no-icon-btn[aria-expanded="true"] {
  background: ${a(P.blue, 15)};
  border-color: ${a(P.blue, 30)};
  color: ${mix(P.label, P.blue, 30)};
}
.no-close:hover { background: ${a(P.error, 14)}; border-color: ${a(P.error, 32)}; color: ${P.error}; }

/* ---------- connection banner ---------- */
.no-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  margin: 10px 16px 0;
  padding: 7px 11px;
  border-radius: 10px;
  font-size: 11px;
  line-height: 1.35;
  color: color-mix(in srgb, var(--no-conn) 42%, ${P.label});
  background: color-mix(in srgb, var(--no-conn) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--no-conn) 26%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--no-conn) 10%, transparent);
}
.no-banner-dot {
  width: 6px; height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--no-conn);
  box-shadow: 0 0 9px color-mix(in srgb, var(--no-conn) 70%, transparent);
}
.no-banner-text { min-width: 0; }

/* ---------- body ---------- */
.no-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 42fr 58fr;
}
.no-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 11px;
  min-width: 0;
  min-height: 0;
  padding: 14px 16px 12px 18px;
}
.no-stage::after {
  content: "";
  position: absolute;
  top: 7%;
  right: 0;
  width: 1px;
  height: 86%;
  background: linear-gradient(180deg, ${a(P.label, 0)} 0%, ${a(P.label, 11)} 22%, ${a(P.label, 11)} 78%, ${a(P.label, 0)} 100%);
}
.no-canvas-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  border-radius: 16px;
  overflow: hidden;
  border: 1px solid ${a(P.label, 8)};
  background-color: ${a(P.bg, 46)};
  background-image:
    radial-gradient(68% 68% at 50% 44%, ${a(P.purple, 13)} 0%, ${a(P.purple, 0)} 68%),
    radial-gradient(100% 100% at 50% 118%, ${a(P.blue, 9)} 0%, ${a(P.blue, 0)} 60%);
  box-shadow:
    inset 0 0 44px -14px ${a(P.bg, 90)},
    inset 0 1px 0 ${a(P.label, 5)};
}
.no-canvas-wrap::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: 16px;
  box-shadow: inset 0 0 0 1px ${a(P.label, 4)};
}
.no-canvas-slot { position: absolute; inset: 0; display: block; width: 100%; height: 100%; }

/* static stand-in drawn over the canvas when WebGL is unavailable */
.no-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 13px;
  pointer-events: none;
  background: radial-gradient(60% 60% at 50% 45%, ${a(P.bg, 42)} 0%, ${a(P.bg, 16)} 70%, ${a(P.bg, 0)} 100%);
}
.no-fallback-stage { position: relative; width: 122px; height: 122px; display: grid; place-items: center; }
.no-fallback-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px dashed color-mix(in srgb, var(--no-state) 32%, transparent);
  transform: rotate(-16deg) scaleY(0.42);
}
.no-fallback-core {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: radial-gradient(
    circle at 50% 36%,
    color-mix(in srgb, var(--no-state) 62%, ${P.label}) 0%,
    var(--no-state) 32%,
    ${a(P.purple, 40)} 62%,
    ${a(P.blue, 0)} 100%
  );
  box-shadow:
    0 0 38px -6px color-mix(in srgb, var(--no-state) 58%, transparent),
    inset 0 0 18px -6px color-mix(in srgb, var(--no-state) 40%, transparent);
}
.no-fallback-dot {
  position: absolute;
  right: 1px;
  top: 50%;
  width: 6px; height: 6px;
  border-radius: 50%;
  transform: translate(50%, -50%);
  background: color-mix(in srgb, var(--no-state) 78%, ${P.label});
  box-shadow: 0 0 10px color-mix(in srgb, var(--no-state) 72%, transparent);
}
.no-fallback-text {
  font-family: ${MONO};
  font-size: 9px;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: ${a(P.labelDim, 84)};
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid ${a(P.label, 8)};
  background: ${a(P.bg, 36)};
}

.no-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 13px; flex: none; margin: 0; padding: 0 2px; list-style: none; }
.no-legend-title {
  font-family: ${MONO};
  font-size: 8.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: ${a(P.labelDim, 62)};
}
.no-legend-item { display: inline-flex; align-items: center; gap: 5px; }
.no-legend-swatch {
  width: 6px; height: 6px;
  flex: none;
  border-radius: 2px;
  background: var(--no-cat);
  box-shadow: 0 0 8px color-mix(in srgb, var(--no-cat) 55%, transparent);
}
.no-legend-label { font-size: 10px; color: ${P.labelDim}; letter-spacing: 0.01em; white-space: nowrap; }

/* ---------- activity stream ---------- */
.no-stream {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 14px 12px 6px 14px;
}
.no-stream-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex: none; padding: 0 4px 9px 2px; }
.no-stream-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: ${P.label};
}
.no-stream-count {
  font-family: ${MONO};
  font-size: 9.5px;
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
  color: ${a(P.labelDim, 78)};
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid ${a(P.label, 8)};
  background: ${a(P.label, 4)};
}

.no-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0 6px 0 0;
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: ${a(P.label, 14)} transparent;
  -webkit-mask-image: linear-gradient(180deg, ${P.bg} 0, ${P.bg} calc(100% - 22px), transparent 100%);
  mask-image: linear-gradient(180deg, ${P.bg} 0, ${P.bg} calc(100% - 22px), transparent 100%);
}

.no-row {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 6px 8px;
  border-radius: 10px;
  border: 1px solid transparent;
  transition: background-color 130ms ease, border-color 130ms ease;
  animation: no-row-in 200ms ease-out both;
}
.no-row:hover { background: ${a(P.label, 5)}; border-color: ${a(P.label, 8)}; }

.no-badge {
  width: 22px; height: 22px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  font-family: ${MONO};
  font-size: 10.5px;
  font-weight: 700;
  line-height: 1;
  color: var(--no-cat);
  background: color-mix(in srgb, var(--no-cat) 13%, transparent);
  border: 1px solid color-mix(in srgb, var(--no-cat) 28%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--no-cat) 12%, transparent);
}

.no-row-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.no-row-name {
  font-size: 12px;
  font-weight: 500;
  color: ${P.label};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: 0.004em;
}
.no-row-sub {
  display: flex;
  align-items: center;
  gap: 0;
  min-width: 0;
  font-size: 10px;
  color: ${a(P.labelDim, 92)};
}
.no-row-sub > * + *::before {
  content: "·";
  margin: 0 5px;
  color: ${a(P.labelDim, 46)};
}
.no-row-kind { flex: none; white-space: nowrap; }
.no-row-target {
  flex: 0 1 auto;
  min-width: 0;
  font-family: ${MONO};
  font-size: 9.5px;
  color: ${a(P.labelDim, 82)};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.no-row-dur {
  flex: none;
  font-family: ${MONO};
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  color: ${a(P.labelDim, 74)};
  white-space: nowrap;
}

.no-row-meta { display: flex; align-items: center; gap: 7px; flex: none; }
.no-row-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--no-status);
  box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--no-status) 13%, transparent);
}
.no-row-time {
  font-family: ${MONO};
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  color: ${a(P.labelDim, 84)};
  min-width: 30px;
  text-align: right;
  white-space: nowrap;
}

/* ---------- empty + skeleton ---------- */
.no-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 18px 14px;
  text-align: center;
}
.no-empty-orb {
  position: relative;
  width: 46px; height: 46px;
  margin-bottom: 8px;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 38%, ${a(P.cyan, 42)} 0%, ${a(P.purple, 26)} 46%, ${a(P.blue, 6)} 72%, ${a(P.blue, 0)} 100%);
  box-shadow:
    0 0 0 1px ${a(P.blue, 18)},
    0 0 34px -6px ${a(P.purple, 52)},
    inset 0 0 18px -4px ${a(P.cyan, 30)};
}
.no-empty-orb::after {
  content: "";
  position: absolute;
  inset: -8px -14px;
  border-radius: 50%;
  border: 1px solid ${a(P.blue, 16)};
  transform: rotate(-18deg) scaleY(0.42);
}
.no-empty-title { font-size: 12.5px; font-weight: 550; color: ${mix(P.label, P.labelDim, 44)}; letter-spacing: 0.02em; }
.no-empty-sub { font-size: 10.5px; color: ${a(P.labelDim, 82)}; max-width: 260px; line-height: 1.5; }

.no-skeleton { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 9px; padding: 4px 8px 0 2px; }
.no-skel-row { display: grid; grid-template-columns: 22px minmax(0, 1fr) 30px; align-items: center; gap: 9px; }
.no-skel-badge { width: 22px; height: 22px; border-radius: 7px; }
.no-skel-lines { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.no-skel-l1 { height: 7px; border-radius: 4px; width: var(--no-w, 62%); }
.no-skel-l2 { height: 5px; border-radius: 3px; width: 38%; opacity: 0.7; }
.no-skel-time { height: 5px; border-radius: 3px; }
.no-skel-foot { margin-top: auto; padding: 10px 2px 6px; text-align: center; }
.no-skel-foot-title { font-size: 11.5px; color: ${mix(P.label, P.labelDim, 50)}; letter-spacing: 0.03em; }
.no-skel-foot-hint { margin-top: 3px; font-family: ${MONO}; font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: ${a(P.labelDim, 62)}; }

.no-shimmer {
  background-color: ${a(P.label, 7)};
  background-image: linear-gradient(90deg, ${a(P.label, 0)} 0%, ${a(P.label, 11)} 46%, ${a(P.label, 0)} 100%);
  background-size: 220% 100%;
  background-repeat: no-repeat;
  animation: no-shimmer 1.7s linear infinite;
}

/* ---------- footer: timeline ---------- */
.no-footer {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 10px 16px 12px 18px;
  border-top: 1px solid ${a(P.label, 7)};
  background: linear-gradient(180deg, ${a(P.bg, 0)} 0%, ${a(P.bg, 26)} 100%);
}
.no-rail-row { display: flex; align-items: center; gap: 10px; }
.no-rail-label {
  flex: none;
  font-family: ${MONO};
  font-size: 8.5px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: ${a(P.labelDim, 62)};
  white-space: nowrap;
}
.no-rail {
  position: relative;
  flex: 1;
  height: 26px;
  min-width: 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid ${a(P.label, 6)};
  background: ${a(P.label, 3)};
}
.no-rail[data-empty="true"] {
  background-image: repeating-linear-gradient(90deg, ${a(P.label, 8)} 0 1px, ${a(P.label, 0)} 1px 9px);
  background-position: 0 50%;
  background-size: 100% 9px;
  background-repeat: no-repeat;
}
.no-rail-mid { position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: ${a(P.label, 8)}; }
.no-rail-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  background: linear-gradient(90deg, ${a(P.blue, 9)} 0%, ${a(P.purple, 16)} 100%);
  transition: width 420ms cubic-bezier(0.22, 0.68, 0.28, 1);
}
.no-rail-mark {
  position: absolute;
  width: 2px;
  border-radius: 2px;
  background: var(--no-mark);
  box-shadow: 0 0 7px color-mix(in srgb, var(--no-mark) 55%, transparent);
  transform: translateX(-1px);
}
.no-rail-mark[data-side="up"] { bottom: 50%; }
.no-rail-mark[data-side="down"] { top: 50%; }
.no-rail-mark[data-active="true"] { box-shadow: 0 0 11px color-mix(in srgb, var(--no-mark) 85%, transparent); }
.no-rail-head {
  position: absolute;
  top: 3px;
  bottom: 3px;
  width: 1.5px;
  transform: translateX(-0.75px);
  border-radius: 2px;
  background: var(--no-state);
  box-shadow: 0 0 12px color-mix(in srgb, var(--no-state) 75%, transparent);
  transition: left 420ms cubic-bezier(0.22, 0.68, 0.28, 1);
}
/* ---------- footer: stats ---------- */
.no-stats { display: flex; align-items: flex-end; gap: 0; min-width: 0; }
.no-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 0 13px;
  border-left: 1px solid ${a(P.label, 7)};
}
.no-stat:first-child { padding-left: 2px; border-left: none; }
.no-stat-value {
  font-family: ${MONO};
  font-size: 12px;
  font-weight: 600;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  color: ${P.label};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.no-stat-label {
  font-family: ${MONO};
  font-size: 8px;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: ${a(P.labelDim, 74)};
  white-space: nowrap;
}
.no-stat-spacer { flex: 1; min-width: 8px; }
.no-stat[data-emphasis="true"] .no-stat-value { color: var(--no-state); }

/* ---------- settings popover ---------- */
.no-settings {
  position: absolute;
  top: 52px;
  right: 14px;
  z-index: 3;
  width: 264px;
  max-height: calc(100% - 70px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px;
  border-radius: 14px;
  background-color: ${a(P.surface, 92)};
  background-image: linear-gradient(170deg, ${a(P.blue, 6)} 0%, ${a(P.purple, 5)} 100%);
  border: 1px solid ${a(P.label, 12)};
  -webkit-backdrop-filter: blur(20px) saturate(150%);
  backdrop-filter: blur(20px) saturate(150%);
  box-shadow:
    0 26px 60px -26px ${a(P.bg, 96)},
    0 0 0 1px ${a(P.blue, 5)},
    inset 0 1px 0 ${a(P.label, 9)};
  animation: no-pop-in 160ms cubic-bezier(0.22, 0.68, 0.28, 1) both;
}
.no-settings-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 0 2px 2px; }
.no-settings-title { font-size: 11.5px; font-weight: 600; color: ${P.label}; letter-spacing: 0.04em; }
.no-settings-hint {
  font-family: ${MONO};
  font-size: 8px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: ${a(P.labelDim, 68)};
}
.no-set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 2px;
  border-top: 1px solid ${a(P.label, 6)};
}
.no-set-row:first-of-type { border-top: none; }
.no-set-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.no-set-label { font-size: 11.5px; color: ${P.label}; white-space: nowrap; }
.no-set-hint { font-size: 9.5px; color: ${a(P.labelDim, 78)}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.no-set-control { flex: none; }

.no-seg {
  display: inline-flex;
  gap: 1px;
  padding: 2px;
  border-radius: 8px;
  background: ${a(P.label, 5)};
  border: 1px solid ${a(P.label, 8)};
}
.no-seg-item { position: relative; display: inline-flex; }
.no-seg-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
}
.no-seg-label {
  display: block;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 10px;
  line-height: 1.35;
  color: ${a(P.labelDim, 96)};
  white-space: nowrap;
  transition: background-color 140ms ease, color 140ms ease, box-shadow 140ms ease;
}
.no-seg-input:checked + .no-seg-label {
  background: ${a(P.blue, 20)};
  color: ${P.label};
  box-shadow: inset 0 0 0 1px ${a(P.blue, 34)}, 0 0 12px -6px ${a(P.blue, 70)};
}
.no-seg-input:hover + .no-seg-label { color: ${P.label}; }
.no-seg-input:focus-visible + .no-seg-label { outline: 2px solid ${a(P.blue, 66)}; outline-offset: 1px; }

.no-switch {
  position: relative;
  width: 34px;
  height: 19px;
  padding: 0;
  flex: none;
  border-radius: 999px;
  border: 1px solid ${a(P.label, 13)};
  background: ${a(P.label, 6)};
  cursor: pointer;
  transition: background-color 160ms ease, border-color 160ms ease;
}
.no-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: ${P.labelDim};
  transition: transform 170ms cubic-bezier(0.22, 0.68, 0.28, 1), background-color 160ms ease;
}
.no-switch[aria-checked="true"] { background: ${a(P.blue, 26)}; border-color: ${a(P.blue, 46)}; }
.no-switch[aria-checked="true"]::after {
  transform: translateX(15px);
  background: ${P.label};
  box-shadow: 0 0 10px ${a(P.blue, 70)};
}
.no-switch:hover { border-color: ${a(P.blue, 40)}; }
.no-switch:focus-visible { outline: 2px solid ${a(P.blue, 66)}; outline-offset: 2px; }

/* ---------- motion ---------- */
@keyframes no-panel-in {
  from { opacity: 0; transform: translateY(8px) scale(0.988); }
  to { opacity: 1; transform: none; }
}
@keyframes no-pop-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
@keyframes no-row-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: none; }
}
@keyframes no-breathe {
  0%, 100% { opacity: 0.62; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.08); }
}
@keyframes no-pulse {
  0%, 100% { opacity: 0.45; box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--no-status) 8%, transparent); }
  50% { opacity: 1; box-shadow: 0 0 0 4px color-mix(in srgb, var(--no-status) 20%, transparent); }
}
@keyframes no-shimmer {
  from { background-position: 140% 0; }
  to { background-position: -60% 0; }
}

.no-breathe { animation: no-breathe 2.8s ease-in-out infinite; }
.no-pulse { animation: no-pulse 1.6s ease-in-out infinite; }

.no-root[data-motion="on"] .no-breathe,
.no-root[data-motion="on"] .no-pulse,
.no-root[data-motion="on"] .no-shimmer,
.no-root[data-motion="on"] .no-rail-fill,
.no-root[data-motion="on"] .no-rail-head,
.no-root[data-motion="on"] .no-row,
.no-root[data-motion="on"] .no-panel,
.no-root[data-motion="on"] .no-settings { animation: none !important; transition: none !important; }

@media (prefers-reduced-motion: reduce) {
  .no-root[data-motion="system"] .no-breathe,
  .no-root[data-motion="system"] .no-pulse,
  .no-root[data-motion="system"] .no-shimmer,
  .no-root[data-motion="system"] .no-panel,
  .no-root[data-motion="system"] .no-settings,
  .no-root[data-motion="system"] .no-row { animation: none !important; }
  .no-root[data-motion="system"] .no-rail-fill,
  .no-root[data-motion="system"] .no-rail-head { transition: none !important; }
}

/* ---------- narrow viewports ---------- */
@media (max-width: 660px) {
  .no-chip-en, .no-conn-en, .no-legend-title { display: none; }
  .no-body { grid-template-columns: 40fr 60fr; }
  .no-stat { padding: 0 9px; }
}
@media (max-width: 520px) {
  .no-conn-zh { display: none; }
  .no-word { font-size: 12.5px; }
  .no-stat:nth-child(6) { display: none; }
}
`;
}
