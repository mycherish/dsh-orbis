/**
 * The always-on HUD shell: a ~470px glass panel pinned to the **right of the
 * conversation**, 118px below the top of the viewport — not the old lower-right
 * corner card, and never over the composer.
 *
 * It is pure DOM plus one scoped `<style>` block: no new dependency, no WebGL
 * context of its own (the ball canvas is handed to `layer.tsx`, which owns the
 * single renderer), and exactly one timer, the one-second clock tick that keeps
 * 「运行时长」 honest and stops while the panel is folded.
 *
 * Three presentations, decided by `hudCardMode()` (pure, unit-tested):
 *  - `expanded` — header, ball + title, two pills, recent activity, current
 *    status, footer stats;
 *  - `compact`  — the one-line chip (compact mode, or a panel folded by hand);
 *  - `hidden`   — `orb` display mode draws nothing at all.
 */
import * as React from 'react';
import { ORBIT_PALETTE, STATE_COLOR, type OrbitConnection, type OrbitSettings } from '../contracts';
import type { OrbitSnapshot } from '../../shared/protocol';
import { TaskHeader, HudMark } from './TaskHeader';
import { TaskSummary } from './TaskSummary';
import { RuntimeInfo } from './RuntimeInfo';
import { ActivityTimeline } from './ActivityTimeline';
import { CurrentStatus } from './CurrentStatus';
import {
  footerStats,
  formatElapsed,
  hudCardMode,
  hudChipText,
  hudTone,
  runtimePills,
  taskTitleOf,
} from './progress';
import { buildHudStyles, cssVars } from './styles';

export interface OrbisHUDProps {
  snapshot: OrbitSnapshot | null;
  connection: OrbitConnection;
  settings: OrbitSettings;
  /** Persisted manual fold (`hudCollapsed`); only a click clears it. */
  collapsed: boolean;
  /** Persisted `hudPinned`: keep the panel unfolded even while the Agent is idle. */
  pinned: boolean;
  /** Resolved from `settings.reduceMotion` + the OS preference. */
  reduceMotion: boolean;
  /** True when the shell could not create a WebGL context for the ball. */
  orbUnavailable?: boolean;
  /**
   * Hands the orb slot to the shell; call with `null` on unmount. The HUD
   * never creates a renderer itself, so no second WebGL context can appear.
   */
  bindOrbSlot: (el: HTMLElement | null) => void;
  onCollapse: () => void;
  onExpand: () => void;
  onOpenWorkspace: () => void;
  onPin: (next: boolean) => void;
}

/** Built once: the sheet is a constant string, not a per-render allocation. */
const CSS = buildHudStyles();

/** The expanded card`s id, so the folded chip can point `aria-controls` at it. */
const HUD_PANEL_ID = 'orbis-hud-panel';

/** One second between clock ticks; the panel is not a stopwatch. */
const TICK_MS = 1000;

function StatsIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2.4" y="2.9" width="11.2" height="1.9" rx="0.95" fill="currentColor" />
      <rect x="2.4" y="7.05" width="11.2" height="1.9" rx="0.95" fill="currentColor" opacity="0.67" />
      <rect x="2.4" y="11.2" width="7.2" height="1.9" rx="0.95" fill="currentColor" opacity="0.42" />
    </svg>
  );
}

export function OrbisHUD(props: OrbisHUDProps): React.ReactElement | null {
  const { snapshot, connection, settings, reduceMotion } = props;
  const state = snapshot?.agentState ?? 'idle';
  const task = snapshot?.task ?? null;

  const accent = STATE_COLOR[state] ?? ORBIT_PALETTE.blue;
  const tone = hudTone(state);

  /*
   * A pinned panel ignores the "fold while idle" half of `auto`; a fold the user
   * performed by hand still wins, so pinning never traps the panel open.
   */
  const autoExpanded =
    props.pinned && settings.displayMode === 'auto' && !props.collapsed
      ? 'expanded'
      : hudCardMode(settings.displayMode, state, props.collapsed);

  // ---- the only timer: one tick a second, only while the panel is open -----
  const [now, setNow] = React.useState<number>(() => Date.now());
  const ticking = autoExpanded === 'expanded';
  React.useEffect(() => {
    if (!ticking) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);

  // A fresh snapshot is a fresh instant: re-anchor instead of waiting a tick.
  React.useEffect(() => {
    if (snapshot === null) return;
    setNow(Date.now());
  }, [snapshot?.updatedAt]);

  const vars = cssVars({ '--no-hud-accent': accent });
  const reduce = reduceMotion ? 'true' : 'false';
  const chip = hudChipText(state, connection);
  const title = taskTitleOf(task);
  const elapsed = task === null ? formatElapsed(0) : runtimePills(task, connection, now).elapsed;

  if (autoExpanded === 'hidden') return null;

  if (autoExpanded === 'compact') {
    // `auto` folds by hand and unfolds by hand; `compact` opens the Workspace —
    // unless the user disallowed the Workspace, in which case unfold instead.
    const reopen = settings.displayMode === 'auto';
    const hint = reopen ? '展开' : '打开';
    const detail = task === null ? '等待第一条活动…' : footerStats(task, elapsed);
    return (
      <button
        type="button"
        className="no-hud-mini"
        data-tone={tone}
        data-reduce={reduce}
        style={vars}
        title={`${chip} · ${title.text} · ${detail}`}
        aria-label={reopen ? `展开 Caelum Orbis 面板 · ${chip}` : `打开工作区 · ${chip}`}
        /*
         * Two different affordances share this chip, so they need two different
         * ARIA states. Unfolding the panel is a disclosure — `aria-expanded` is
         * correct there (it is `false` by definition, because the chip only exists
         * while the panel is folded, and it names the panel it will expand). Opening
         * the Workspace is not a disclosure at all: it raises a dialog, which is
         * what `aria-haspopup` describes. The old code sent `aria-expanded={false}`
         * for both, which told a screen reader about a collapsed region that the
         * second button never had.
         */
        aria-expanded={reopen ? false : undefined}
        aria-controls={reopen ? HUD_PANEL_ID : undefined}
        aria-haspopup={reopen ? undefined : 'dialog'}
        onClick={reopen ? props.onExpand : props.onOpenWorkspace}
      >
        <style>{CSS}</style>
        <HudMark className="no-hud-mini-logo" />
        <span className="no-hud-mini-chip">
          <i className="no-hud-chip-dot" aria-hidden="true" />
          {chip}
        </span>
        <span className="no-hud-mini-title">{title.text}</span>
        <span className="no-hud-mini-hint">{hint}</span>
      </button>
    );
  }

  return (
    <div
      id={HUD_PANEL_ID}
      className="no-hud-panel"
      data-orbis-surface="hud"
      data-tone={tone}
      data-reduce={reduce}
      data-state={state}
      data-pinned={props.pinned ? 'true' : 'false'}
      data-display-mode={settings.displayMode}
      style={vars}
      role="group"
      aria-label="Caelum Orbis 任务面板"
    >
      <style>{CSS}</style>
      <TaskHeader
        state={state}
        connection={connection}
        pinned={props.pinned}
        onCollapse={props.onCollapse}
        onOpenWorkspace={props.onOpenWorkspace}
        onPin={props.onPin}
      />
      <div className="no-hud-body">
        <TaskSummary
          task={task}
          state={state}
          bindOrbSlot={props.bindOrbSlot}
          orbUnavailable={props.orbUnavailable === true}
          reduceMotion={reduceMotion}
        />
        <RuntimeInfo task={task} connection={connection} now={now} />
        {settings.showRecentActivity ? <ActivityTimeline task={task} /> : null}
        <CurrentStatus task={task} state={state} showSilenceAlert={settings.showSilenceAlert} />
        <div className="no-hud-foot">
          <StatsIcon />
          {footerStats(task, elapsed)}
        </div>
      </div>
    </div>
  );
}
