/**
 * Neural Orbit wire protocol — v2.0.
 *
 * The snapshot is the only thing that crosses the Host → Client boundary. It
 * carries an Agent state, a normalized activity list and one Task Context
 * object; every field in all three is produced by the Host from real DSH
 * events (see `docs/DELIVERY-v2.md`).
 */
import type { OrbitActivity, OrbitTaskContext } from './task-context-types';

export type {
  OrbitActivity,
  OrbitActivityStatus,
  OrbitActivitySource,
  OrbitConfidence,
  OrbitFileKind,
  OrbitSilence,
  OrbitSilenceLevel,
  OrbitTaskContext,
  OrbitTaskPhase,
  OrbitToolCategory,
} from './task-context-types';

/** Bumped whenever a field changes meaning, so a stale Client can detect it. */
export const ORBIT_PROTOCOL_VERSION = 3;

/**
 * The eleven Agent states, in ascending visual activity.
 *
 * `starting` / `preparing` / `responding` / `quiet` / `interrupted` are derived
 * from real signals: `turn/start`, `tool-call-delta`, `text-delta`, silence and
 * `turn/end{interrupted}` respectively.
 */
export type OrbitAgentState =
  | 'idle'
  | 'starting'
  | 'thinking'
  | 'preparing'
  | 'executing'
  | 'responding'
  | 'waiting'
  | 'quiet'
  | 'completed'
  | 'interrupted'
  | 'error';

/** Aggregate counters shown in the HUD footer and the Workspace stat strip. */
export interface OrbitMetrics {
  /** Turns observed in this Session since the Host started. */
  turns: number;
  /** Steps observed (one model request each, normally). */
  steps: number;
  /** Tool calls observed. */
  tools: number;
  /** File touches observed. */
  files: number;
  /** Approvals asked. */
  approvals: number;
  /** Model retries observed (`llm/retry`). */
  retries: number;
  /** Epoch milliseconds of the first observed event for this Session. */
  startedAt: number;
}

/** The complete state pushed to the Client: one snapshot replaces the previous. */
export interface OrbitSnapshot {
  version: number;
  sessionId?: string;
  agentState: OrbitAgentState;
  /** Tool calls currently started but not settled. */
  activeTools: number;
  /** Durable Turn in flight, when one is. */
  turn?: number;
  /** Durable Step in flight, when one is. */
  step?: number;
  /** How long the Agent has been silent, in milliseconds (0 while active). */
  silenceMs: number;
  /** 0 (<30s) · 1 (30–60s) · 2 (60–180s) · 3 (>180s). */
  quietLevel: 0 | 1 | 2 | 3;
  /** Newest-first activity rows, capped by the Host. */
  events: OrbitActivity[];
  /** The Task Context Engine readout (spec §3). */
  task: OrbitTaskContext;
  updatedAt: number;
  metrics: OrbitMetrics;
}

/** Server-sent event frames. */
export type OrbitFrame =
  | { type: 'snapshot'; snapshot: OrbitSnapshot }
  | { type: 'heartbeat'; at: number };

/** Maximum activity rows retained per Session. */
export const MAX_ACTIVITY_ROWS = 40;

/** How many rows the HUD shows (spec §5.1: 最近 5 条). */
export const HUD_RECENT_ROWS = 5;

/** How long the `completed` state holds before falling back to `idle`. */
export const COMPLETED_HOLD_MS = 2500;

/** How long an `interrupted` state holds before falling back to `idle`. */
export const INTERRUPTED_HOLD_MS = 3000;

/** How long the `error` state holds before falling back to `idle`. */
export const ERROR_HOLD_MS = 4000;

/**
 * Silence thresholds (spec §7):
 *   0–30s normal · 30–60s no new activity · 60–180s long silence · >180s flag.
 */
export const SILENCE_LEVEL1_MS = 30_000;
export const SILENCE_LEVEL2_MS = 60_000;
export const SILENCE_LEVEL3_MS = 180_000;

/** An open tool call older than this is settled as cancelled instead of leaking. */
export const CALL_TIMEOUT_MS = 10 * 60_000;

/** SSE heartbeat interval. */
export const HEARTBEAT_MS = 30000;

/** Route paths owned by this plugin. */
export const STATE_ROUTE = '/api/neural-orbit/state';
export const EVENTS_ROUTE = '/api/neural-orbit/events';
