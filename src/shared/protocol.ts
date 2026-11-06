/**
 * Neural Orbit wire protocol — v2.
 *
 * This module is the only contract shared by the Host half and the browser
 * half. It deliberately has no dependency on DSH internals: the Host
 * normalizes DSH events into these shapes and the Client renders them, so the
 * browser never sees a raw tool call, tool argument, tool result body,
 * reasoning fragment, prompt or file content.
 *
 * v2 changes (see `docs/AUDIT-v2.md`):
 *  - the six-state vocabulary grew to eleven states;
 *  - every activity is one unified DTO carrying Session/Turn/Step identity so
 *    the Client can correlate without guessing;
 *  - a quiet dimension reports how long the Agent has been silent.
 */

/** Bumped whenever a field changes meaning, so a stale Client can detect it. */
export const ORBIT_PROTOCOL_VERSION = 2;

/**
 * The eleven Agent states, in ascending visual activity.
 *
 * `starting` / `preparing` / `responding` / `quiet` / `interrupted` are the v2
 * additions; each is derived from a *real* event, never guessed:
 * `turn/start`, `tool-call-delta`, `text-delta`, silence, `turn/end{interrupted}`.
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

/** Whitelisted tool families; the raw tool name never leaves the Host. */
export type OrbitToolCategory =
  | 'file-read'
  | 'file-write'
  | 'shell'
  | 'search'
  | 'test'
  | 'browser'
  | 'subagent'
  | 'reasoning'
  | 'approval'
  | 'other';

/** Activity row kinds: a tool call, a file touch, a lifecycle note, an approval ask. */
export type OrbitActivityType = 'tool' | 'file' | 'agent' | 'approval';

/** Status of one activity node. */
export type OrbitActivityStatus = 'running' | 'success' | 'error' | 'waiting' | 'cancelled';

/** File-node flavour, derived only from the tool that produced it. */
export type OrbitFileKind = 'read' | 'write' | 'edit';

/**
 * One normalized activity row — the v2 unified Activity DTO.
 *
 * Forbidden by construction (there is no field for them): `rawArguments`,
 * `rawCommand`, `fileContent`, `reasoningText`, `userMessage`,
 * `rawToolResult`. See `docs/AUDIT-v2.md` §6.5 and the leak test in
 * `tests/activity-leak.test.ts`.
 */
export interface OrbitActivity {
  /** Stable identity within one Session (tool call id or a Host-synthesized id). */
  id: string;
  /** Session this row belongs to; the Client never mixes two Sessions. */
  sessionId: string;
  /** Durable Turn number when the source event carried one. */
  turn?: number;
  /** Durable Step number when the source event carried one. */
  step?: number;
  type: OrbitActivityType;
  /** Tool family, or the family implied by the row kind. */
  category: OrbitToolCategory;
  /** Safe display name: a tool family label, a basename, or a state word. */
  label: string;
  status: OrbitActivityStatus;
  /** Epoch milliseconds when the activity started. */
  startedAt: number;
  /** Epoch milliseconds when it settled, once known. */
  endedAt?: number;
  /** Milliseconds between start and settlement, when both were observed. */
  duration?: number;
  /** Truncated basename only; never an absolute path, home directory, or user name. */
  safeTarget?: string;
  /** File flavour for `type: 'file'`. */
  fileKind?: OrbitFileKind;
}

/** Aggregate counters shown in the Workspace footer. */
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
  /** 0 (under 10s) · 1 (10–30s) · 2 (30–60s) · 3 (over 60s). */
  quietLevel: 0 | 1 | 2 | 3;
  /** Newest-first activity rows, capped by the Host. */
  events: OrbitActivity[];
  updatedAt: number;
  metrics: OrbitMetrics;
}

/** Server-sent event frames. */
export type OrbitFrame =
  | { type: 'snapshot'; snapshot: OrbitSnapshot }
  | { type: 'heartbeat'; at: number };

/** Maximum activity rows retained per Session. */
export const MAX_ACTIVITY_ROWS = 40;

/** How long the `completed` state holds before falling back to `idle`. */
export const COMPLETED_HOLD_MS = 2500;

/** How long an `interrupted` state holds before falling back to `idle`. */
export const INTERRUPTED_HOLD_MS = 3000;

/** How long the `error` state holds before falling back to `idle`. */
export const ERROR_HOLD_MS = 4000;

/** Silence below this is normal thinking, not quiet (quiet level 1 starts here). */
export const QUIET_AFTER_MS = 10_000;
/** Quiet level 2 starts here. */
export const QUIET_LEVEL2_MS = 30_000;
/** Quiet level 3 starts here. */
export const QUIET_LEVEL3_MS = 60_000;

/** An open tool call older than this is settled as stale instead of leaking. */
export const CALL_TIMEOUT_MS = 10 * 60_000;

/** SSE heartbeat interval. */
export const HEARTBEAT_MS = 30000;

/** Route paths owned by this plugin. */
export const STATE_ROUTE = '/api/neural-orbit/state';
export const EVENTS_ROUTE = '/api/neural-orbit/events';
