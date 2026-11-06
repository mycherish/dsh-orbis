/**
 * Activity + Task Context types — the v2.0 Task Context Engine contract.
 *
 * This file is the *only* vocabulary the browser may see for "what the Agent is
 * doing". The Host produces it from real DSH events; the Client renders it.
 *
 * There is deliberately no field for a hidden chain of thought, a raw command,
 * a tool argument, a file body, a user message or a tool result body: such data
 * cannot be represented here, so it cannot leak through this pipe.
 */

/** 13 activity families (spec §3.2). `unknown` is the honest fallback. */
export type OrbitToolCategory =
  | 'reasoning'
  | 'file_read'
  | 'file_write'
  | 'command'
  | 'search'
  | 'build'
  | 'test'
  | 'api'
  | 'database'
  | 'inspection'
  | 'approval'
  | 'response'
  | 'unknown';

/** Activity outcome. `unknown` means "started, and that is all we know". */
export type OrbitActivityStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'unknown';

/** Where the row came from: a durable tool call, an approval, or a lifecycle note. */
export type OrbitActivitySource = 'tool' | 'approval' | 'lifecycle' | 'stream';

/** How sure the Host is about what it just inferred (spec §3.1). */
export type OrbitConfidence = 'high' | 'medium' | 'low';

/** File-node flavour, derived only from the tool that produced it. */
export type OrbitFileKind = 'read' | 'write' | 'edit';

/** One normalized activity row. */
export interface OrbitActivity {
  /** Stable identity within one Session (the `callId` for tool rows). */
  id: string;
  sessionId: string;
  /** Durable Turn / Step when the source event carried them. */
  turn?: number;
  step?: number;
  /** DSH `tool/call.callId` — the correlation key, never a FIFO position. */
  callId?: string;
  category: OrbitToolCategory;
  /** Safe display name: a tool family word or a short tool name. Never arguments. */
  label: string;
  status: OrbitActivityStatus;
  /** Epoch milliseconds. */
  startedAt: number;
  /** Epoch milliseconds, once settled. */
  finishedAt?: number;
  /** `finishedAt - startedAt`, once settled. */
  duration?: number;
  source: OrbitActivitySource;
  /** `high` = explicit tool/call + tool/result; `medium` = stream or approval. */
  confidence: OrbitConfidence;
  /** Truncated, redacted basename. Never an absolute path. */
  safeTarget?: string;
  /** True when the target was a sensitive file and had to be masked. */
  redacted?: boolean;
  fileKind?: OrbitFileKind;
}

/* ------------------------------------------------------------------ *
 * Task context
 * ------------------------------------------------------------------ */

/**
 * Inferred working phase (spec §3.4). Every value is reachable from real
 * activities only — there is no "we think it might be…" branch.
 */
export type OrbitTaskPhase =
  | 'idle'
  | 'understanding'
  | 'reading'
  | 'analyzing'
  | 'editing'
  | 'building'
  | 'testing'
  | 'querying'
  | 'verifying'
  | 'answering'
  | 'waiting';

/** Silence buckets (spec §7): 0–30s / 30–60s / 60–180s / >180s. */
export type OrbitSilenceLevel = 0 | 1 | 2 | 3;

export interface OrbitSilence {
  /** Milliseconds since the last observable activity. */
  ms: number;
  level: OrbitSilenceLevel;
  /** Ready-to-render Chinese sentence; never says the Agent is stuck. */
  label: string;
}

/** The whole task readout the HUD needs, computed on the Host. */
export interface OrbitTaskContext {
  /** Session title when the Host has one, else 「当前任务处理中」. */
  taskTitle: string;
  /** Where `taskTitle` came from, so the UI can mark a fallback honestly. */
  titleSource: 'session' | 'fallback';
  phase: OrbitTaskPhase;
  /** Chinese label for `phase`. */
  phaseLabel: string;
  /** One sentence about the newest real action, if there is one. */
  currentAction?: string;
  /** Newest first, capped by the Host (HUD shows 5). */
  recentActivities: OrbitActivity[];
  /** Rows still running. */
  activeActivities: OrbitActivity[];
  /** Counts derived only from observed rows. */
  completedCount: number;
  failedCount: number;
  observedActivityCount: number;
  toolCallCount: number;
  /**
   * Only ever set from a real plan the Agent published (`todo/write`) — never
   * predicted from tool names or history.
   */
  nextStep?: string;
  /** Epoch milliseconds of the first observed event for this Session. */
  startedAt: number;
  /** Epoch milliseconds of the last observable activity. */
  lastActivityAt: number;
  silence: OrbitSilence;
  /** How trustworthy the phase / current action are. */
  confidence: OrbitConfidence;
  /** This plugin never calls a model; the field exists so the UI can say so. */
  extraTokens: 0;
  mode: 'event-only';
}

/** Chinese labels for the 13 categories (spec §3.2 table). */
export const CATEGORY_LABEL: Record<OrbitToolCategory, string> = {
  reasoning: '模型处理中',
  file_read: '读取项目文件',
  file_write: '修改文件',
  command: '执行命令',
  search: '搜索代码或资料',
  build: '构建项目',
  test: '执行测试',
  api: '接口查询',
  database: '数据库操作',
  inspection: '检查与验证',
  approval: '等待审批',
  response: '组织答复',
  unknown: '执行其他操作',
};

/** Chinese labels for the inferred phases (spec §3.4 table). */
export const PHASE_LABEL: Record<OrbitTaskPhase, string> = {
  idle: '待机',
  understanding: '理解需求',
  reading: '阅读项目',
  analyzing: '分析代码',
  editing: '修改代码',
  building: '构建项目',
  testing: '执行测试',
  querying: '查询接口',
  verifying: '验证结果',
  answering: '整理答复',
  waiting: '等待审批',
};

/** Shown when the Host has no session title. Never invented. */
export const TASK_TITLE_FALLBACK = '当前任务处理中';

/** Shown instead of a basename when the target is a secret-bearing file. */
export const SENSITIVE_TARGET_LABEL = '读取敏感配置文件';
