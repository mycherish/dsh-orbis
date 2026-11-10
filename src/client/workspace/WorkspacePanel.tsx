/**
 * The Workspace panel shell: header (identity, state, transport, controls),
 * the two-column body (orb stage + activity stream) and the footer timeline.
 *
 * Layout budget, at the default 780×600: 58px header, ~452px body split 42/58,
 * ~90px footer. The whole card shrinks with the viewport through `min()` and
 * never scrolls as a whole — only the activity list does.
 */
import * as React from 'react';
import { MAX_ACTIVITY_ROWS } from '../../shared/protocol';
import type { OrbitAgentState } from '../../shared/protocol';
import type { WorkspaceViewProps } from '../contracts';
import { ActivityList } from './ActivityList';
import { NodeLegend } from './Legend';
import { SettingsPopover } from './SettingsPopover';
import { Timeline } from './Timeline';
import { CloseIcon, OrbitMark, SlidersIcon } from './Icons';
import {
  EMPTY_TIMELINE,
  buildTimeline,
  connectionColor,
  formatCount,
  formatDuration,
  formatFps,
  isDegraded,
  stateColor,
  visibleRows,
} from './format';
import { buildStyles, cssVars } from './styles';
import { LABELS } from './labels';

/** Built once: the sheet is a pure function of the palette. */
const STYLE_SHEET = buildStyles();

/** Stable identity so the "no rows yet" case does not churn on every render. */
const NO_EVENTS = [] as const;

const TICK_MS = 1000;

export function WorkspacePanel(props: WorkspaceViewProps): React.ReactElement {
  const { snapshot, connection, settings, fps, orbUnavailable, onSettingsChange, onClose } = props;

  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const slotRef = React.useRef<HTMLDivElement | null>(null);
  /** Latest binder, so a re-created callback prop never re-binds the canvas. */
  const bindRef = React.useRef(props.bindOrbSlot);
  bindRef.current = props.bindOrbSlot;

  const [now, setNow] = React.useState<number>(() => Date.now());
  const [settingsOpen, setSettingsOpen] = React.useState<boolean>(false);

  /* The clock behind every "刚刚 / 12s / 3m". */
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  /* The panel owns focus for its whole life; ESC handling belongs to the shell. */
  React.useEffect(() => {
    panelRef.current?.focus();
  }, []);

  /* One bind per mount: the shell builds exactly one renderer per canvas. */
  React.useEffect(() => {
    const slot = slotRef.current;
    if (slot) bindRef.current(slot);
    return () => {
      bindRef.current(null);
    };
  }, []);

  const agentState: OrbitAgentState = snapshot ? snapshot.agentState : 'idle';
  const color = stateColor(agentState);
  const connColor = connectionColor(connection);
  const loading = snapshot === null;
  const rows = visibleRows(snapshot ? snapshot.events : NO_EVENTS, MAX_ACTIVITY_ROWS);
  const timeline = snapshot
    ? buildTimeline(snapshot.events, snapshot.metrics.startedAt, snapshot.updatedAt)
    : EMPTY_TIMELINE;

  const startedAt = snapshot ? snapshot.metrics.startedAt : 0;
  const uptime =
    snapshot && Number.isFinite(startedAt) && startedAt > 0 && startedAt <= now
      ? formatDuration(now - startedAt)
      : LABELS.units.empty;

  const empty = LABELS.units.empty;

  return (
    <div className="no-root" data-motion={settings.reduceMotion}>
      <style>{STYLE_SHEET}</style>
      <div
        className="no-panel"
        role="dialog"
        /*
         * Deliberately not `aria-modal="true"`. The panel floats over a
         * conversation that stays live behind it — the Agent keeps working, the
         * user keeps reading — and focus is not trapped inside it. Claiming
         * modality told screen readers the rest of the page was inert, which was
         * never true. `role="dialog"` plus the label is the honest description.
         */
        aria-label={LABELS.panel.ariaLabel}
        data-orbis-surface="workspace"
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="no-header">
          <div className="no-brand">
            <OrbitMark />
            <span className="no-word">{LABELS.panel.product}</span>
          </div>

          <div className="no-chip-wrap">
            <span className="no-chip" style={cssVars({ '--no-state': color })}>
              <span className="no-chip-dot no-breathe" aria-hidden="true" />
              <span className="no-chip-zh">{LABELS.state[agentState]}</span>
              <span className="no-chip-en" aria-hidden="true">
                {LABELS.stateEn[agentState]}
              </span>
            </span>
          </div>

          <div className="no-head-right">
            <span className="no-conn" style={cssVars({ '--no-conn': connColor })}>
              <span className="no-conn-dot" aria-hidden="true" />
              <span className="no-conn-zh">{LABELS.connection[connection]}</span>
              <span className="no-conn-en" aria-hidden="true">
                {LABELS.connectionEn[connection]}
              </span>
            </span>
            <span className="no-head-div" aria-hidden="true" />
            <button
              type="button"
              className="no-icon-btn"
              aria-label={LABELS.panel.settings}
              aria-expanded={settingsOpen}
              aria-controls={settingsOpen ? 'no-orbit-settings' : undefined}
              title={LABELS.panel.settingsTitle}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <SlidersIcon />
            </button>
            <button
              type="button"
              className="no-icon-btn no-close"
              aria-label={LABELS.panel.close}
              title={LABELS.panel.closeTitle}
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        {isDegraded(connection) ? (
          <div className="no-banner" role="status" style={cssVars({ '--no-conn': connColor })}>
            <span className="no-banner-dot" aria-hidden="true" />
            <span className="no-banner-text">
              {connection === 'closed' ? LABELS.banner.closed : LABELS.banner.reconnecting}
            </span>
          </div>
        ) : null}

        <div className="no-body">
          <section className="no-stage" aria-label={LABELS.panel.stageAria}>
            <div className="no-canvas-wrap">
              <div
                ref={slotRef}
                className="no-canvas-slot"
                role={orbUnavailable ? 'presentation' : 'img'}
                aria-label={orbUnavailable ? undefined : LABELS.panel.canvasAria}
              />
              {orbUnavailable ? (
                <div className="no-fallback" style={cssVars({ '--no-state': color })}>
                  <div className="no-fallback-stage" aria-hidden="true">
                    <span className="no-fallback-ring" />
                    <span className="no-fallback-core no-breathe" />
                    <span className="no-fallback-dot" />
                  </div>
                  <span className="no-fallback-text">{LABELS.panel.orbFallback}</span>
                </div>
              ) : null}
            </div>
            <NodeLegend />
          </section>

          {settings.showActivity ? (
            <section className="no-stream" aria-label={LABELS.panel.streamTitle}>
              <div className="no-stream-head">
                <span className="no-stream-title">{LABELS.panel.streamTitle}</span>
                <span className="no-stream-count">{loading ? empty : String(rows.length)}</span>
              </div>
              <ActivityList rows={rows} now={now} loading={loading} />
            </section>
          ) : null}
        </div>

        <footer className="no-footer">
          <div className="no-rail-row">
            <span className="no-rail-label">{LABELS.panel.timelineLabel}</span>
            <Timeline model={timeline} stateColor={color} />
          </div>
          <div className="no-stats">
            <Stat
              value={loading ? empty : formatCount(snapshot.metrics.turns)}
              label={LABELS.stats.turns}
              hint={LABELS.statsHint.turns}
            />
            <Stat
              value={loading ? empty : formatCount(snapshot.metrics.tools)}
              label={LABELS.stats.tools}
              hint={LABELS.statsHint.tools}
            />
            <Stat
              value={loading ? empty : formatCount(snapshot.metrics.files)}
              label={LABELS.stats.files}
              hint={LABELS.statsHint.files}
            />
            <Stat
              value={loading ? empty : formatCount(snapshot.activeTools)}
              label={LABELS.stats.active}
              hint={LABELS.statsHint.active}
            />
            <Stat value={formatFps(fps)} label={LABELS.stats.fps} hint={LABELS.statsHint.fps} />
            <Stat
              value={loading ? empty : LABELS.stateEn[agentState]}
              label={LABELS.stats.state}
              hint={LABELS.statsHint.state}
              accent={color}
            />
            <span className="no-stat-spacer" />
            <Stat value={uptime} label={LABELS.stats.uptime} hint={LABELS.statsHint.uptime} />
          </div>
        </footer>

        {settingsOpen ? <SettingsPopover settings={settings} onChange={onSettingsChange} /> : null}
      </div>
    </div>
  );
}

interface StatProps {
  value: string;
  label: string;
  hint: string;
  /** State colour, when the value itself should carry it. */
  accent?: string;
}

function Stat({ value, label, hint, accent }: StatProps): React.ReactElement {
  const emphasised = typeof accent === 'string';
  return (
    <span
      className="no-stat"
      data-emphasis={emphasised ? 'true' : 'false'}
      style={emphasised ? cssVars({ '--no-state': accent }) : undefined}
      title={hint}
    >
      <span className="no-stat-value">{value}</span>
      <span className="no-stat-label">{label}</span>
    </span>
  );
}
