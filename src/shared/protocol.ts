/**
 * Neural Orbit wire protocol.
 *
 * This module is the only contract shared by the Host half and the browser
 * half. It deliberately has no dependency on DSH internals: the Host
 * normalizes DSH events into these shapes and the Client renders them, so the
 * browser never sees a raw tool call, tool argument, or reasoning fragment.
 */

/** Bumped whenever a field changes meaning, so a stale Client can detect it. */
export const ORBIT_PROTOCOL_VERSION = 1;

/** The six Agent states of the spec, in ascending visual activity. */
export type OrbitAgentState =
  | 'idle'
  | 'thinking'
  | 'executing'
  | 'waiting'
  | 'error'
  | 'completed';

/** Whitelisted tool families; the raw tool name never leaves the Host. */
export type OrbitToolCategory =
  | 'shell'
  | 'file-read'
  | 'file-write'
  | 'search'
  | 'browser'
  | 'other';

/** Activity row kinds: a tool call, a file touch, a lifecycle note, an approval ask. */
export type OrbitActivityType = 'tool' | 'file' | 'agent' | 'approval';

/** Status of one activity node. */
export type OrbitActivityStatus = 'running' | 'success' | 'error' | 'waiting';

/** File-node flavour, derived only from the tool that produced it. */
export type OrbitFileKind = 'read' | 'write' | 'edit';

/** One normalized activity row. Never carries arguments, contents, or paths. */
export interface OrbitActivity {
  /** Stable identity within one Session (tool call id or synthesized id). */
  id: string;
  type: OrbitActivityType;
  /** Safe display name: a tool family label, a basename, or a state word. */
  name: string;
  status: OrbitActivityStatus;
  /** Epoch milliseconds when the activity started. */
  timestamp: number;
  /** Milliseconds between start and settlement, when both were observed. */
  duration?: number;
  /** Truncated basename only; never an absolute path, home directory, or user name. */
  target?: string;
  /** Tool family for `type: 'tool'`. */
  category?: OrbitToolCategory;
  /** File flavour for `type: 'file'`. */
  fileKind?: OrbitFileKind;
}

/** Aggregate counters shown in the Workspace footer. */
export interface OrbitMetrics {
  /** Turns observed in this Session since the Host started. */
  turns: number;
  /** Tool calls observed. */
  tools: number;
  /** File touches observed. */
  files: number;
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
  /** Newest-first activity rows, capped by the Host. */
  events: OrbitActivity[];
  updatedAt: number;
  metrics: OrbitMetrics;
}

/** Server-sent event frames. */
export type OrbitFrame =
  | { type: 'snapshot'; snapshot: OrbitSnapshot }
  | { type: 'heartbeat'; at: number };

/** Maximum activity rows retained per Session (spec §2.2). */
export const MAX_ACTIVITY_ROWS = 40;

/** How long the `completed` state holds before falling back to `idle`. */
export const COMPLETED_HOLD_MS = 2500;

/** How long the `error` state holds before falling back to `idle`. */
export const ERROR_HOLD_MS = 4000;

/** SSE heartbeat interval. */
export const HEARTBEAT_MS = 30000;

/** Route paths owned by this plugin. */
export const STATE_ROUTE = '/api/neural-orbit/state';
export const EVENTS_ROUTE = '/api/neural-orbit/events';
