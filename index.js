// src/shared/protocol.ts
var ORBIT_PROTOCOL_VERSION = 2;
var MAX_ACTIVITY_ROWS = 40;
var COMPLETED_HOLD_MS = 2500;
var INTERRUPTED_HOLD_MS = 3e3;
var ERROR_HOLD_MS = 4e3;
var QUIET_AFTER_MS = 1e4;
var QUIET_LEVEL2_MS = 3e4;
var QUIET_LEVEL3_MS = 6e4;
var CALL_TIMEOUT_MS = 10 * 6e4;
var HEARTBEAT_MS = 3e4;
var STATE_ROUTE = "/api/neural-orbit/state";
var EVENTS_ROUTE = "/api/neural-orbit/events";

// src/host/correlation.ts
var DEFAULT_MAX_EARLY = 32;
var DEFAULT_MAX_SETTLED = 128;
var CallRegistry = class _CallRegistry {
  open = /* @__PURE__ */ new Map();
  early = /* @__PURE__ */ new Map();
  settled = /* @__PURE__ */ new Map();
  maxEarly;
  maxSettled;
  constructor(options = {}) {
    this.maxEarly = Math.max(1, options.maxEarly ?? DEFAULT_MAX_EARLY);
    this.maxSettled = Math.max(1, options.maxSettled ?? DEFAULT_MAX_SETTLED);
  }
  /** Remember a bounded map with first-in/first-out eviction. */
  static remember(map, key, value, cap) {
    map.delete(key);
    map.set(key, value);
    while (map.size > cap) {
      const oldest = map.keys().next();
      if (oldest.done === true) return;
      map.delete(oldest.value);
    }
  }
  /** Register a started call. Idempotent per `callId`. */
  start(meta, startedAt = meta.at) {
    const { callId } = meta;
    if (callId === "") return { kind: "duplicate" };
    const already = this.settled.get(callId);
    if (already !== void 0) return { kind: "already-settled", status: already };
    if (this.open.has(callId)) return { kind: "duplicate" };
    const early = this.early.get(callId);
    if (early !== void 0) {
      this.early.delete(callId);
      _CallRegistry.remember(this.settled, callId, early, this.maxSettled);
      return { kind: "pre-settled", status: early };
    }
    const call = { ...meta, startedAt };
    this.open.set(callId, call);
    return { kind: "new", call };
  }
  /**
   * Settle a call. Returns the running record when one was open, or `undefined`
   * when the call is unknown (the result is then remembered for a late call) or
   * already settled (duplicate result).
   */
  settle(callId, status) {
    if (callId === "") return void 0;
    const call = this.open.get(callId);
    if (call !== void 0) {
      this.open.delete(callId);
      _CallRegistry.remember(this.settled, callId, status, this.maxSettled);
      return call;
    }
    if (this.settled.has(callId)) return void 0;
    _CallRegistry.remember(this.early, callId, status, this.maxEarly);
    return void 0;
  }
  /** Every call still open, in start order. */
  running() {
    return [...this.open.values()];
  }
  /** True when at least one call is open. */
  get size() {
    return this.open.size;
  }
  /**
   * Settle calls that outlived `timeoutMs`. Returns what was closed so the
   * caller can settle their rows; an orphaned call must not stay `running`
   * forever, which would pin the Agent to `executing`.
   */
  expire(now, timeoutMs, status = "cancelled") {
    const expired = [];
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return expired;
    for (const [callId, call] of this.open) {
      if (now - call.startedAt < timeoutMs) continue;
      this.open.delete(callId);
      _CallRegistry.remember(this.settled, callId, status, this.maxSettled);
      expired.push(call);
    }
    return expired;
  }
  /**
   * Close every open call — used when a Turn ends, an Agent errors, or a
   * Session is disposed. Returns the closed records so rows can be settled.
   */
  drain(status) {
    const closed = [...this.open.values()];
    for (const call of closed) {
      _CallRegistry.remember(this.settled, call.callId, status, this.maxSettled);
    }
    this.open.clear();
    return closed;
  }
  clear() {
    this.open.clear();
    this.early.clear();
    this.settled.clear();
  }
};

// src/host/quiet.ts
function quietLevelOf(silenceMs) {
  if (typeof silenceMs !== "number" || !Number.isFinite(silenceMs) || silenceMs < QUIET_AFTER_MS) return 0;
  if (silenceMs < QUIET_LEVEL2_MS) return 1;
  if (silenceMs < QUIET_LEVEL3_MS) return 2;
  return 3;
}

// src/host/state-machine.ts
function createMachine(now) {
  return {
    running: false,
    phase: "none",
    openTools: [],
    approvalId: null,
    errorUntil: 0,
    interruptedUntil: 0,
    completedUntil: 0,
    lastActivityAt: now,
    agentState: "idle",
    updatedAt: now
  };
}
function silenceOf(state, at) {
  const silence = at - state.lastActivityAt;
  return Number.isFinite(silence) && silence > 0 ? silence : 0;
}
function quietLevelFor(state, at) {
  return quietLevelOf(silenceOf(state, at));
}
function computeState(state, at) {
  if (state.approvalId !== null) return "waiting";
  if (state.errorUntil > at) return "error";
  if (state.interruptedUntil > at) return "interrupted";
  if (state.completedUntil > at) return "completed";
  if (state.openTools.length > 0) return "executing";
  if (!state.running) return "idle";
  if (silenceOf(state, at) >= QUIET_AFTER_MS) return "quiet";
  if (state.phase === "responding") return "responding";
  if (state.phase === "preparing") return "preparing";
  if (state.phase === "thinking") return "thinking";
  if (state.step !== void 0) return "thinking";
  return "starting";
}
function settle(state, at) {
  state.updatedAt = at;
  state.agentState = computeState(state, at);
  return state;
}
function clearHolds(state) {
  state.completedUntil = 0;
  state.errorUntil = 0;
  state.interruptedUntil = 0;
}
function applyEvent(input, event) {
  const state = input;
  const before = state.agentState;
  switch (event.kind) {
    case "status":
      state.running = event.status === "running";
      if (state.running) {
        state.lastActivityAt = event.at;
        state.phase = state.phase === "none" ? "none" : state.phase;
        clearHolds(state);
        state.approvalId = null;
      } else {
        state.phase = "none";
      }
      break;
    case "turn-start":
      state.running = true;
      state.turn = event.turn;
      state.step = void 0;
      state.phase = "none";
      state.approvalId = null;
      state.lastActivityAt = event.at;
      clearHolds(state);
      break;
    case "step-start":
      state.running = true;
      state.turn = event.turn ?? state.turn;
      state.step = event.step;
      state.phase = "none";
      state.lastActivityAt = event.at;
      clearHolds(state);
      break;
    case "stream":
      state.running = true;
      if (event.phase !== "none") state.phase = event.phase;
      state.lastActivityAt = event.at;
      clearHolds(state);
      break;
    case "tool-start":
      state.running = true;
      state.phase = "none";
      state.approvalId = null;
      if (!state.openTools.includes(event.id)) state.openTools = [...state.openTools, event.id];
      state.lastActivityAt = event.at;
      clearHolds(state);
      break;
    case "tool-end":
      state.openTools = state.openTools.filter((id) => id !== event.id);
      state.lastActivityAt = event.at;
      break;
    case "approval-asked":
      state.approvalId = event.id;
      state.lastActivityAt = event.at;
      break;
    case "approval-decided":
      state.approvalId = null;
      state.lastActivityAt = event.at;
      break;
    case "turn-end":
      state.running = false;
      state.openTools = [];
      state.phase = "none";
      state.approvalId = null;
      state.step = void 0;
      switch (event.reason) {
        case "completed":
        case "max-tokens":
          state.completedUntil = event.at + COMPLETED_HOLD_MS;
          break;
        case "interrupted":
        case "aborted":
          state.interruptedUntil = event.at + INTERRUPTED_HOLD_MS;
          break;
        case "error":
        case "blocked":
          state.errorUntil = event.at + ERROR_HOLD_MS;
          break;
        default:
          break;
      }
      break;
    case "turn-stopping":
      state.completedUntil = event.at + COMPLETED_HOLD_MS;
      state.lastActivityAt = event.at;
      break;
    case "interrupted":
      state.phase = "none";
      state.interruptedUntil = event.at + INTERRUPTED_HOLD_MS;
      state.lastActivityAt = event.at;
      break;
    case "error":
      state.approvalId = null;
      state.phase = "none";
      state.errorUntil = event.at + ERROR_HOLD_MS;
      state.lastActivityAt = event.at;
      break;
    case "tick":
      break;
  }
  settle(state, event.at);
  return { state, changed: state.agentState !== before };
}
function hasPendingHold(state, at) {
  if (state.errorUntil > at || state.completedUntil > at || state.interruptedUntil > at) return true;
  if (state.approvalId !== null) return true;
  if (!state.running) return false;
  return state.agentState !== "quiet" || quietLevelOf(silenceOf(state, at)) < 3;
}

// src/host/categories.ts
var REGISTRY = {
  // ---- shell / process -----------------------------------------------------
  bash: "shell",
  run_code: "shell",
  run_command: "shell",
  execute: "shell",
  exec: "shell",
  terminal_open: "shell",
  terminal_send: "shell",
  terminal_read: "shell",
  terminal_close: "shell",
  terminal_list: "shell",
  terminal_signal: "shell",
  pwsh: "shell",
  powershell: "shell",
  job_output: "shell",
  job_kill: "shell",
  job_list: "shell",
  // ---- file reads ----------------------------------------------------------
  read: "file-read",
  read_image: "file-read",
  ls: "file-read",
  view: "file-read",
  lsp_diagnostics: "file-read",
  lsp_symbols: "file-read",
  lsp_completion: "file-read",
  lsp_signature: "file-read",
  lsp_inlay_hints: "file-read",
  // ---- file writes ---------------------------------------------------------
  write: "file-write",
  edit: "file-write",
  apply_patch: "file-write",
  str_replace: "file-write",
  str_replace_editor: "file-write",
  lsp_rename: "file-write",
  lsp_format: "file-write",
  create_directory: "file-write",
  mkdir: "file-write",
  // ---- search --------------------------------------------------------------
  glob: "search",
  grep: "search",
  search: "search",
  find: "search",
  web_search: "search",
  session_search: "search",
  session_event_search: "search",
  session_event_read: "search",
  session_trace: "search",
  session_event_trace: "search",
  session_query: "search",
  find_skills: "search",
  skill: "search",
  // ---- tests ---------------------------------------------------------------
  run_tests: "test",
  test: "test",
  tests: "test",
  vitest: "test",
  pytest: "test",
  jest: "test",
  cargo_test: "test",
  go_test: "test",
  // ---- browser / network ---------------------------------------------------
  web_fetch: "browser",
  browser: "browser",
  browser_use: "browser",
  computer_use: "browser",
  cua: "browser",
  // ---- orchestration -------------------------------------------------------
  subagent: "subagent",
  subagent_fork: "subagent",
  spawn_teammate: "subagent",
  send_message: "subagent",
  wait_agent: "subagent",
  list_agents: "subagent",
  interrupt_agent: "subagent",
  list_subagent_models: "subagent",
  workflow: "subagent",
  team_task_create: "subagent",
  team_task_get: "subagent",
  team_task_list: "subagent",
  team_task_update: "subagent",
  // ---- reasoning / planning ------------------------------------------------
  todo_write: "reasoning",
  create_goal: "reasoning",
  update_goal: "reasoning",
  get_goal: "reasoning",
  ask_user_question: "reasoning",
  plan: "reasoning",
  plan_mode: "reasoning"
};
var PREFIXES = [
  ["terminal", "shell"],
  ["bash", "shell"],
  ["pwsh", "shell"],
  ["job_", "shell"],
  ["lsp_", "file-read"],
  ["read", "file-read"],
  ["write", "file-write"],
  ["edit", "file-write"],
  ["glob", "search"],
  ["grep", "search"],
  ["session_", "search"],
  ["web_", "browser"],
  ["browser", "browser"],
  ["cua_", "browser"],
  ["team_", "subagent"],
  ["subagent", "subagent"],
  ["todo", "reasoning"],
  ["goal", "reasoning"],
  ["schedule_", "reasoning"],
  ["skill", "search"]
];
function categoryOf(rawName) {
  const name2 = typeof rawName === "string" ? rawName.trim().toLowerCase() : "";
  if (name2 === "") return "other";
  const exact = REGISTRY[name2];
  if (exact !== void 0) return exact;
  for (const [prefix, category] of PREFIXES) {
    if (name2.startsWith(prefix)) return category;
  }
  return "other";
}
function fileKindOf(rawName) {
  const name2 = typeof rawName === "string" ? rawName.trim().toLowerCase() : "";
  if (name2 === "") return void 0;
  if (name2 === "write" || name2 === "create_directory" || name2 === "mkdir") return "write";
  if (name2 === "edit" || name2 === "apply_patch" || name2 === "lsp_rename" || name2 === "lsp_format" || name2 === "str_replace" || name2 === "str_replace_editor") {
    return "edit";
  }
  if (name2.startsWith("read") || REGISTRY[name2] === "file-read") return "read";
  return void 0;
}
var CATEGORY_LABEL = {
  "file-read": "\u8BFB\u53D6\u6587\u4EF6",
  "file-write": "\u5199\u5165\u6587\u4EF6",
  shell: "\u6267\u884C\u547D\u4EE4",
  search: "\u641C\u7D22",
  test: "\u8FD0\u884C\u6D4B\u8BD5",
  browser: "\u8BBF\u95EE\u7F51\u7EDC",
  subagent: "\u534F\u4F5C\u4EE3\u7406",
  reasoning: "\u6574\u7406\u601D\u8DEF",
  approval: "\u7B49\u5F85\u5BA1\u6279",
  other: "\u8C03\u7528\u5DE5\u5177"
};

// src/host/normalize.ts
var MAX_LABEL = 40;
var MAX_TOOL_NAME = 32;
var TARGET_KEYS = ["file_path", "filePath", "path", "target", "pattern", "name"];
function sanitizeBasename(value) {
  if (typeof value !== "string") return void 0;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned === "") return void 0;
  const segments = cleaned.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (segments.length === 0) return void 0;
  const last = segments[segments.length - 1] ?? "";
  if (/^[a-zA-Z]:$/.test(last)) return void 0;
  const withoutQuery = last.replace(/[?#].*$/, "").replace(/[<>"|:]/g, "").trim();
  if (withoutQuery === "" || withoutQuery === "~") return void 0;
  return withoutQuery.length > MAX_LABEL ? `${withoutQuery.slice(0, MAX_LABEL - 1)}\u2026` : withoutQuery;
}
function targetFromArguments(rawArguments) {
  if (typeof rawArguments !== "string" || rawArguments.trim() === "") return void 0;
  let parsed;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
  const record = parsed;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    const target = sanitizeBasename(value);
    if (target !== void 0) return target;
  }
  return void 0;
}
function toolActivity(input) {
  const category = categoryOf(input.rawName);
  const fileKind = fileKindOf(input.rawName);
  const wantsTarget = fileKind !== void 0 || category === "search";
  const target = wantsTarget ? targetFromArguments(input.argumentsJson) : void 0;
  const raw = typeof input.rawName === "string" ? input.rawName.trim() : "";
  const label = (raw === "" ? CATEGORY_LABEL[category] : raw).slice(0, MAX_TOOL_NAME);
  const base = {
    id: input.id,
    sessionId: input.sessionId,
    type: "tool",
    category,
    label,
    status: "running",
    startedAt: input.at,
    ...input.turn === void 0 ? {} : { turn: input.turn },
    ...input.step === void 0 ? {} : { step: input.step },
    ...target === void 0 ? {} : { safeTarget: target }
  };
  if (fileKind !== void 0) {
    const row = { ...base, type: "file", fileKind };
    if (target !== void 0) row.safeTarget = target;
    return row;
  }
  return base;
}
function approvalActivity(at, id, sessionId, toolName, location) {
  const target = typeof toolName === "string" ? sanitizeBasename(toolName) : void 0;
  return {
    id,
    sessionId,
    type: "approval",
    category: "approval",
    label: "approval",
    status: "waiting",
    startedAt: at,
    ...location?.turn === void 0 ? {} : { turn: location.turn },
    ...location?.step === void 0 ? {} : { step: location.step },
    ...target === void 0 ? {} : { safeTarget: target }
  };
}
function errorActivity(at, id, sessionId, code) {
  const label = typeof code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : "agent-error";
  return {
    id,
    sessionId,
    type: "agent",
    category: "other",
    label,
    status: "error",
    startedAt: at
  };
}
function retryActivity(at, id, sessionId, attempt) {
  const label = Number.isFinite(attempt) && attempt > 0 ? `retry-${Math.floor(attempt)}` : "retry";
  return {
    id,
    sessionId,
    type: "agent",
    category: "reasoning",
    label,
    status: "waiting",
    startedAt: at
  };
}
function settledActivity(row, status, at) {
  const duration = Math.max(0, at - row.startedAt);
  return { ...row, status, endedAt: at, duration };
}

// src/host/stream.ts
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : void 0;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function signalOfChunk(type) {
  switch (type) {
    case "reasoning-delta":
    case "block-start":
      return type === "reasoning-delta" ? "reasoning" : void 0;
    case "text-delta":
      return "text";
    case "tool-call-delta":
      return "tool-call";
    case "finish":
      return "finish";
    default:
      return void 0;
  }
}
function streamSignalOf(frame) {
  const record = asRecord(frame);
  if (record === void 0) return void 0;
  const type = record.type;
  const turn = asNumber(record.turn);
  const step = asNumber(record.step);
  if (type === "start") return { kind: "attempt-start", turn, step };
  if (type === "end") return { kind: "attempt-end", turn, step };
  if (type !== "chunk") return void 0;
  const chunk = asRecord(record.chunk);
  if (chunk === void 0) return void 0;
  const kind = signalOfChunk(chunk.type);
  if (kind === void 0) return void 0;
  return { kind, turn, step };
}
function phaseOfSignal(signal) {
  switch (signal.kind) {
    case "attempt-start":
      return "thinking";
    case "reasoning":
      return "thinking";
    case "tool-call":
      return "preparing";
    case "text":
      return "responding";
    default:
      return void 0;
  }
}

// src/host/hub.ts
function recordOf(value, key) {
  return typeof value === "object" && value !== null ? value[key] : void 0;
}
function asString(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function asNumber2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function turnEndKindOf(reason) {
  switch (reason) {
    case "completed":
    case "interrupted":
    case "aborted":
    case "blocked":
    case "error":
    case "max-tokens":
    case "forked":
      return reason;
    default:
      return "other";
  }
}
function drainStatusOf(reason) {
  if (reason === "error" || reason === "blocked") return "error";
  if (reason === "interrupted" || reason === "aborted") return "cancelled";
  return "success";
}
var OrbitHub = class {
  records = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  maxSessions;
  maxActivities;
  clock;
  mono;
  callTimeoutMs;
  streamNotifyMs;
  notifyQueued = false;
  streamTimer = null;
  sequence = 0;
  lastTouched;
  constructor(options = {}) {
    this.maxSessions = options.maxSessions ?? 8;
    this.maxActivities = options.maxActivities ?? MAX_ACTIVITY_ROWS;
    this.clock = options.now ?? (() => Date.now());
    this.mono = options.mono ?? this.clock;
    this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.streamNotifyMs = Math.max(0, options.streamNotifyMs ?? 120);
  }
  // ---------------------------------------------------------------- records
  ensure(sessionId) {
    const existing = this.records.get(sessionId);
    if (existing !== void 0) return existing;
    const now = this.clock();
    const record = {
      sessionId,
      machine: createMachine(this.mono()),
      activities: [],
      calls: new CallRegistry(),
      metrics: { turns: 0, steps: 0, tools: 0, files: 0, approvals: 0, retries: 0, startedAt: now },
      version: 1,
      quietLevel: 0,
      updatedAt: now
    };
    this.records.set(sessionId, record);
    this.evictIfNeeded(sessionId);
    return record;
  }
  evictIfNeeded(keep) {
    while (this.records.size > this.maxSessions) {
      let oldestId;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, record] of this.records) {
        if (id === keep) continue;
        if (record.updatedAt < oldestAt) {
          oldestAt = record.updatedAt;
          oldestId = id;
        }
      }
      if (oldestId === void 0) return;
      this.records.get(oldestId)?.calls.clear();
      this.records.delete(oldestId);
      if (this.lastTouched === oldestId) this.lastTouched = keep;
    }
  }
  /**
   * Recompute the published state after a mutation and queue a notification.
   *
   * `stream` uses the throttled channel: transient frames arrive dozens of
   * times per second and each one still advances the version (so a Client that
   * polls `/state` sees the truth), but subscribers are only told at most once
   * per window.
   */
  touch(record, at, channel = "event") {
    record.machine.agentState = computeState(record.machine, at);
    record.quietLevel = quietLevelFor(record.machine, at);
    record.machine.updatedAt = at;
    record.updatedAt = this.clock();
    this.lastTouched = record.sessionId;
    record.version += 1;
    if (channel === "stream") this.queueStreamNotify();
    else this.queueNotify();
  }
  queueNotify() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      this.emit();
    });
  }
  /**
   * Transient frames can arrive dozens of times per second; the state machine
   * applies every one of them, but subscribers are told at most once per
   * window, which keeps the SSE stream and the Client cheap during streaming.
   */
  queueStreamNotify() {
    if (this.streamTimer !== null) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      if (this.listeners.size === 0) return;
      this.emit();
    }, this.streamNotifyMs);
    this.streamTimer.unref?.();
  }
  emit() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
      }
    }
  }
  pushActivity(record, activity) {
    record.activities.unshift(activity);
    if (record.activities.length > this.maxActivities) {
      record.activities.length = this.maxActivities;
    }
  }
  /** Settle one row by id. Returns the settled row, or `undefined` when absent. */
  settleRow(record, id, status, at) {
    const index = record.activities.findIndex((row) => row.id === id);
    if (index < 0) return void 0;
    const current = record.activities[index];
    if (current === void 0) return void 0;
    if (current.status !== "running" && current.status !== "waiting") return void 0;
    const settled = settledActivity(current, status, at);
    record.activities[index] = settled;
    return settled;
  }
  nextId(prefix) {
    this.sequence += 1;
    return `${prefix}:${this.sequence}`;
  }
  // ------------------------------------------------------------------ folds
  /** Fold one durable DSH Session event. Unknown event types are ignored. */
  handleSessionEvent(sessionId, event) {
    if (typeof sessionId !== "string" || sessionId === "") return;
    if (typeof event !== "object" || event === null) return;
    const epoch = asNumber2(event.time) ?? this.clock();
    const at = this.mono();
    const data = event.data;
    switch (event.type) {
      case "turn/start": {
        const record = this.ensure(sessionId);
        record.metrics.turns += 1;
        applyEvent(record.machine, { kind: "turn-start", turn: asNumber2(recordOf(data, "turn")), at });
        this.touch(record, at);
        return;
      }
      case "step/start": {
        const record = this.ensure(sessionId);
        record.metrics.steps += 1;
        applyEvent(record.machine, {
          kind: "step-start",
          turn: asNumber2(recordOf(data, "turn")),
          step: asNumber2(recordOf(data, "step")),
          at
        });
        this.touch(record, at);
        return;
      }
      case "tool/call": {
        const record = this.ensure(sessionId);
        const callId = asString(recordOf(data, "callId"));
        const name2 = asString(recordOf(data, "name"));
        if (callId === void 0 || name2 === void 0) return;
        const argumentsJson = typeof recordOf(data, "arguments") === "string" ? recordOf(data, "arguments") : "";
        const turn = asNumber2(recordOf(data, "turn"));
        const step = asNumber2(recordOf(data, "step"));
        const outcome = record.calls.start({ callId, name: name2, turn, step, at: epoch }, at);
        if (outcome.kind === "duplicate" || outcome.kind === "already-settled") return;
        const row = toolActivity({ id: callId, sessionId, rawName: name2, argumentsJson, at: epoch, turn, step });
        record.metrics.tools += 1;
        if (row.type === "file") record.metrics.files += 1;
        if (turn !== void 0) record.machine.turn = turn;
        if (step !== void 0) record.machine.step = step;
        if (outcome.kind === "pre-settled") {
          this.pushActivity(record, settledActivity(row, outcome.status, epoch));
          this.touch(record, at);
          return;
        }
        this.pushActivity(record, row);
        for (const activity of record.activities) {
          if (activity.type === "approval" && activity.status === "waiting") {
            this.settleRow(record, activity.id, "success", epoch);
          }
        }
        applyEvent(record.machine, { kind: "tool-start", id: callId, at });
        this.touch(record, at);
        return;
      }
      case "tool/result": {
        const record = this.ensure(sessionId);
        const message = recordOf(data, "message");
        const callId = asString(recordOf(message, "toolCallId"));
        if (callId === void 0) return;
        const error = recordOf(data, "error");
        const errorCode = asString(recordOf(error, "code"));
        const failed = recordOf(message, "isError") === true || error !== void 0;
        const status = failed ? errorCode === "ABORTED" || errorCode === "CANCELLED" ? "cancelled" : "error" : "success";
        const call = record.calls.settle(callId, status);
        if (call === void 0) {
          return;
        }
        const resultTurn = asNumber2(recordOf(data, "turn"));
        const resultStep = asNumber2(recordOf(data, "step"));
        if (resultTurn !== void 0) record.machine.turn = resultTurn;
        if (resultStep !== void 0) record.machine.step = resultStep;
        this.settleRow(record, callId, status, epoch);
        applyEvent(record.machine, { kind: "tool-end", id: callId, at });
        this.touch(record, at);
        return;
      }
      case "approval/asked": {
        const record = this.ensure(sessionId);
        const approvalId = asString(recordOf(data, "id"));
        if (approvalId === void 0) return;
        const toolName = asString(recordOf(data, "toolName"));
        const turn = asNumber2(recordOf(data, "turn"));
        const step = asNumber2(recordOf(data, "step"));
        record.metrics.approvals += 1;
        const bridgeIndex = record.activities.findIndex(
          (row) => row.type === "approval" && row.status === "waiting" && row.id.startsWith("bridge:")
        );
        if (bridgeIndex >= 0) {
          const bridge = record.activities[bridgeIndex];
          if (bridge !== void 0) {
            record.activities[bridgeIndex] = {
              ...bridge,
              id: approvalId,
              label: "approval",
              ...turn === void 0 ? {} : { turn },
              ...step === void 0 ? {} : { step },
              ...bridge.safeTarget === void 0 && toolName !== void 0 ? { safeTarget: toolName.slice(0, 40) } : {}
            };
          }
        } else {
          this.pushActivity(record, approvalActivity(epoch, approvalId, sessionId, toolName, { turn, step }));
        }
        applyEvent(record.machine, { kind: "approval-asked", id: approvalId, at });
        this.touch(record, at);
        return;
      }
      case "approval/decided": {
        const record = this.ensure(sessionId);
        const approvalId = asString(recordOf(data, "id"));
        const outcome = asString(recordOf(data, "outcome"));
        this.settleRow(record, approvalId ?? "", this.approvalStatus(outcome), epoch);
        applyEvent(record.machine, { kind: "approval-decided", at });
        this.touch(record, at);
        return;
      }
      case "llm/retry": {
        const record = this.ensure(sessionId);
        const attempt = asNumber2(recordOf(data, "retry")) ?? 0;
        record.metrics.retries += 1;
        const turn = asNumber2(recordOf(data, "turn"));
        const step = asNumber2(recordOf(data, "step"));
        const id = `retry:${turn ?? 0}:${step ?? 0}:${attempt}`;
        if (!record.activities.some((row) => row.id === id)) {
          this.pushActivity(record, retryActivity(epoch, id, sessionId, attempt));
        }
        applyEvent(record.machine, { kind: "stream", phase: "thinking", at });
        this.touch(record, at);
        return;
      }
      case "assistant/message": {
        const record = this.ensure(sessionId);
        if (recordOf(data, "interrupted") !== true) return;
        applyEvent(record.machine, { kind: "interrupted", at });
        this.touch(record, at);
        return;
      }
      case "turn/end": {
        const record = this.ensure(sessionId);
        const reason = turnEndKindOf(asString(recordOf(recordOf(data, "reason"), "kind")));
        for (const call of record.calls.drain(drainStatusOf(reason))) {
          this.settleRow(record, call.callId, drainStatusOf(reason), epoch);
        }
        applyEvent(record.machine, { kind: "turn-end", reason, at });
        this.touch(record, at);
        return;
      }
      default:
        return;
    }
  }
  approvalStatus(outcome) {
    switch (outcome) {
      case "allowed-once":
        return "success";
      case "cancelled":
        return "cancelled";
      case "rejected":
      case "unavailable":
        return "error";
      default:
        return "error";
    }
  }
  /**
   * Fold one transient `agent/assistant-stream` frame.
   *
   * Only the frame's type tags are inspected; the deltas themselves are never
   * read, so no reasoning or answer text can reach the Client through this path.
   */
  handleStream(sessionId, frame) {
    if (typeof sessionId !== "string" || sessionId === "") return;
    const signal = streamSignalOf(frame);
    if (signal === void 0) return;
    const record = this.ensure(sessionId);
    if (signal.turn !== void 0 && record.machine.turn !== void 0 && signal.turn < record.machine.turn) {
      return;
    }
    const at = this.mono();
    const phase = phaseOfSignal(signal) ?? "none";
    applyEvent(record.machine, { kind: "stream", phase, at });
    if (signal.turn !== void 0) record.machine.turn = signal.turn;
    if (signal.step !== void 0) record.machine.step = signal.step;
    this.touch(record, at, "stream");
  }
  handleStatus(sessionId, status) {
    if (typeof sessionId !== "string" || sessionId === "") return;
    const record = this.ensure(sessionId);
    const at = this.mono();
    applyEvent(record.machine, { kind: "status", status, at });
    this.touch(record, at);
  }
  handleTurnStopping(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return;
    const record = this.ensure(sessionId);
    const at = this.mono();
    applyEvent(record.machine, { kind: "turn-stopping", at });
    this.touch(record, at);
  }
  /**
   * Optimistic bridge for the `approval/request` waterfall, which fires before
   * the durable `approval/asked`. The row is tagged so the durable event can
   * adopt it rather than showing the same decision twice.
   */
  handleApproval(sessionId, toolName, callId) {
    if (typeof sessionId !== "string" || sessionId === "") return;
    const record = this.ensure(sessionId);
    const epoch = this.clock();
    const at = this.mono();
    const id = callId === void 0 ? this.nextId("bridge") : `bridge:${callId}`;
    const existing = record.activities.find((row) => row.id === id);
    if (existing === void 0) {
      this.pushActivity(record, approvalActivity(epoch, id, sessionId, toolName));
    }
    applyEvent(record.machine, { kind: "approval-asked", id, at });
    this.touch(record, at);
  }
  handleError(sessionId, code) {
    if (typeof sessionId !== "string" || sessionId === "") return;
    const record = this.ensure(sessionId);
    const epoch = this.clock();
    const at = this.mono();
    for (const call of record.calls.drain("error")) {
      this.settleRow(record, call.callId, "error", epoch);
    }
    this.pushActivity(record, errorActivity(epoch, this.nextId("error"), sessionId, code));
    applyEvent(record.machine, { kind: "error", at });
    this.touch(record, at);
  }
  /** Drop a Session completely: its Agent will never report again. */
  handleDisposed(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return;
    const record = this.records.get(sessionId);
    if (record === void 0) return;
    record.calls.clear();
    record.calls = new CallRegistry();
    this.records.delete(sessionId);
    if (this.lastTouched === sessionId) this.lastTouched = void 0;
    this.queueNotify();
  }
  /** Expire held states and stale calls. Cheap when nothing is pending. */
  tick() {
    const at = this.mono();
    const epoch = this.clock();
    for (const record of this.records.values()) {
      const expired = record.calls.expire(at, this.callTimeoutMs, "cancelled");
      if (expired.length > 0) {
        for (const call of expired) {
          this.settleRow(record, call.callId, "cancelled", epoch);
          applyEvent(record.machine, { kind: "tool-end", id: call.callId, at });
        }
        record.version += 1;
        record.updatedAt = epoch;
        this.queueNotify();
        continue;
      }
      if (!hasPendingHold(record.machine, at)) continue;
      const next = computeState(record.machine, at);
      const level = quietLevelFor(record.machine, at);
      if (next === record.machine.agentState && level === record.quietLevel) continue;
      record.machine.agentState = next;
      record.quietLevel = level;
      record.machine.updatedAt = at;
      record.updatedAt = epoch;
      record.version += 1;
      this.queueNotify();
    }
  }
  // ---------------------------------------------------------------- reading
  /** Session ids, most recently updated first. */
  sessionIds() {
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((record) => record.sessionId);
  }
  /** Resolve which Session a snapshot request means. */
  resolveSession(requested) {
    if (typeof requested === "string" && requested !== "") return requested;
    if (this.lastTouched !== void 0 && this.records.has(this.lastTouched)) return this.lastTouched;
    return this.sessionIds()[0];
  }
  snapshot(requested) {
    const sessionId = this.resolveSession(requested);
    const record = sessionId === void 0 ? void 0 : this.records.get(sessionId);
    const now = this.clock();
    if (record === void 0) {
      return {
        version: 0,
        agentState: "idle",
        activeTools: 0,
        silenceMs: 0,
        quietLevel: 0,
        events: [],
        updatedAt: now,
        metrics: { turns: 0, steps: 0, tools: 0, files: 0, approvals: 0, retries: 0, startedAt: now }
      };
    }
    const at = this.mono();
    const machine = record.machine;
    const agentState = computeState(machine, at);
    return {
      version: record.version,
      sessionId: record.sessionId,
      agentState,
      activeTools: machine.openTools.length,
      ...machine.turn === void 0 ? {} : { turn: machine.turn },
      ...machine.step === void 0 ? {} : { step: machine.step },
      silenceMs: Math.round(silenceOf(machine, at)),
      quietLevel: quietLevelFor(machine, at),
      events: record.activities.slice(0, this.maxActivities),
      updatedAt: record.updatedAt,
      metrics: { ...record.metrics }
    };
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose() {
    if (this.streamTimer !== null) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    this.listeners.clear();
    for (const record of this.records.values()) record.calls.clear();
    this.records.clear();
    this.lastTouched = void 0;
  }
};

// src/host/routes.ts
var JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};
var SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  "connection": "keep-alive",
  // Belt and braces for any proxying layer that would otherwise buffer.
  "x-accel-buffering": "no"
};
function registerOrbitRoutes(hub, webServer) {
  const encoder = new TextEncoder();
  const clients = /* @__PURE__ */ new Set();
  let disposed = false;
  const encodeFrame = (frame) => `data: ${JSON.stringify(frame)}

`;
  const pushSnapshot = (client) => {
    const snapshot = hub.snapshot(client.sessionId);
    if (snapshot.version <= client.lastVersion) return;
    client.lastVersion = snapshot.version;
    client.send(encodeFrame({ type: "snapshot", snapshot }));
  };
  const unsubscribe = hub.subscribe(() => {
    if (disposed) return;
    for (const client of clients) pushSnapshot(client);
  });
  const heartbeat = setInterval(() => {
    if (disposed) return;
    const text = encodeFrame({ type: "heartbeat", at: Date.now() });
    for (const client of clients) client.send(text);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  const disposeState = webServer.register({
    kind: "exact",
    path: STATE_ROUTE,
    resource: async (request) => {
      const url = new URL(request.url);
      const snapshot = hub.snapshot(url.searchParams.get("sessionId"));
      return new Response(JSON.stringify(snapshot), { headers: JSON_HEADERS });
    }
  });
  const disposeEvents = webServer.register({
    kind: "exact",
    path: EVENTS_ROUTE,
    resource: async (request) => {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get("sessionId") ?? void 0;
      let client;
      const stream = new ReadableStream({
        start(controller) {
          const opening = hub.snapshot(sessionId);
          client = {
            sessionId,
            lastVersion: opening.version,
            send(text) {
              try {
                controller.enqueue(encoder.encode(text));
              } catch {
              }
            },
            end() {
              try {
                controller.close();
              } catch {
              }
            }
          };
          clients.add(client);
          controller.enqueue(encoder.encode("retry: 3000\n\n".concat(
            encodeFrame({ type: "snapshot", snapshot: opening })
          )));
        },
        cancel() {
          if (client !== void 0) clients.delete(client);
        }
      });
      const detach = () => {
        if (client === void 0) return;
        clients.delete(client);
        client.end();
      };
      request.signal.addEventListener("abort", detach, { once: true });
      return new Response(stream, { headers: SSE_HEADERS });
    }
  });
  return {
    clients: () => clients.size,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(heartbeat);
      unsubscribe();
      for (const client of clients) client.end();
      clients.clear();
      disposeState();
      disposeEvents();
    }
  };
}

// src/host/index.ts
var TICK_MS = 250;
function idOf(value) {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "object" && value !== null) {
    const id = value.id;
    if (typeof id === "string" && id !== "") return id;
  }
  return void 0;
}
function sessionIdOf(agent) {
  if (agent === void 0 || agent === null) return void 0;
  const direct = idOf(agent.session);
  if (direct !== void 0) return direct;
  return idOf(agent);
}
function codeOf(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const code = value.code;
  return typeof code === "string" ? code : void 0;
}
var name = "neural-orbit";
function apply(ctx) {
  const hub = new OrbitHub();
  let routes;
  let webServerWarned = false;
  let conversions = 0;
  const report = (label, error) => {
    conversions += 1;
    if (conversions > 3) return;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[neural-orbit] ${label} failed: ${message}`);
  };
  const GLOBAL = { global: true };
  ctx.effect(() => ctx.on("session/event", (session, event) => {
    try {
      const sessionId = idOf(session);
      if (sessionId === void 0) return;
      hub.handleSessionEvent(sessionId, event);
    } catch (error) {
      report("session event normalization", error);
    }
  }, GLOBAL), "neural-orbit: session events");
  ctx.effect(() => ctx.on("agent/status", (payload) => {
    try {
      const sessionId = sessionIdOf(payload?.agent);
      if (sessionId === void 0) return;
      hub.handleStatus(sessionId, payload.status);
    } catch (error) {
      report("agent status", error);
    }
  }, GLOBAL), "neural-orbit: agent status");
  ctx.effect(() => ctx.on("agent/turn-stopping", (payload) => {
    try {
      const sessionId = sessionIdOf(payload?.agent);
      if (sessionId === void 0) return;
      hub.handleTurnStopping(sessionId);
    } catch (error) {
      report("turn stopping", error);
    }
  }, GLOBAL), "neural-orbit: turn stopping");
  ctx.effect(() => ctx.on("agent/error", (payload) => {
    try {
      const sessionId = sessionIdOf(payload?.agent);
      if (sessionId === void 0) return;
      hub.handleError(sessionId, codeOf(payload.error));
    } catch (error) {
      report("agent error", error);
    }
  }, GLOBAL), "neural-orbit: agent error");
  ctx.effect(() => ctx.on("agent/disposed", (payload) => {
    try {
      const sessionId = sessionIdOf(payload?.agent);
      if (sessionId === void 0) return;
      hub.handleDisposed(sessionId);
    } catch (error) {
      report("agent disposed", error);
    }
  }, GLOBAL), "neural-orbit: agent disposed");
  ctx.effect(() => ctx.on("agent/assistant-stream", (payload) => {
    try {
      const sessionId = sessionIdOf(payload?.agent);
      if (sessionId === void 0) return;
      hub.handleStream(sessionId, payload.frame);
    } catch (error) {
      report("assistant stream", error);
    }
  }, GLOBAL), "neural-orbit: assistant stream");
  ctx.effect(() => ctx.on("approval/request", (request, next) => {
    try {
      const sessionId = sessionIdOf(request?.agent);
      if (sessionId !== void 0) hub.handleApproval(sessionId, request.toolName, request.callId);
    } catch (error) {
      report("approval observation", error);
    }
    return next();
  }, GLOBAL), "neural-orbit: approvals");
  const ensureRoutes = () => {
    if (routes !== void 0) return true;
    let webServer;
    try {
      webServer = ctx.get("webServer");
    } catch {
      webServer = void 0;
    }
    if (webServer === void 0 || webServer === null || typeof webServer.register !== "function") {
      if (!webServerWarned) {
        webServerWarned = true;
        console.warn("[neural-orbit] webServer service unavailable; HTTP routes stay disabled");
      }
      return false;
    }
    try {
      routes = registerOrbitRoutes(hub, webServer);
      return true;
    } catch (error) {
      report("route registration", error);
      return false;
    }
  };
  ctx.effect(() => {
    ensureRoutes();
    const timer = setInterval(() => {
      hub.tick();
      if (routes === void 0) ensureRoutes();
    }, TICK_MS);
    return () => {
      clearInterval(timer);
      routes?.dispose();
      routes = void 0;
    };
  }, "neural-orbit: ticker and routes");
  ctx.effect(() => () => {
    hub.dispose();
  }, "neural-orbit: hub teardown");
}
function describe() {
  return {
    name,
    protocol: ORBIT_PROTOCOL_VERSION,
    routes: ["/api/neural-orbit/state", "/api/neural-orbit/events"],
    persistence: "none",
    llmCalls: 0
  };
}
export {
  apply,
  describe,
  name
};
