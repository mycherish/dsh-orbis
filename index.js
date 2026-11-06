// src/shared/protocol.ts
var MAX_ACTIVITY_ROWS = 40;
var COMPLETED_HOLD_MS = 2500;
var ERROR_HOLD_MS = 4e3;
var HEARTBEAT_MS = 3e4;
var STATE_ROUTE = "/api/neural-orbit/state";
var EVENTS_ROUTE = "/api/neural-orbit/events";

// src/host/state-machine.ts
function createMachine(now) {
  return {
    running: false,
    openTools: [],
    waiting: false,
    errorUntil: 0,
    completedUntil: 0,
    agentState: "idle",
    updatedAt: now
  };
}
function computeState(state, at) {
  if (state.waiting) return "waiting";
  if (state.errorUntil > at) return "error";
  if (state.completedUntil > at) return "completed";
  if (state.openTools.length > 0) return "executing";
  if (state.running) return "thinking";
  return "idle";
}
function settle(state, at) {
  state.updatedAt = at;
  state.agentState = computeState(state, at);
  return state;
}
function applyEvent(input, event) {
  const state = input;
  const before = state.agentState;
  switch (event.kind) {
    case "status":
      state.running = event.status === "running";
      if (state.running) {
        state.completedUntil = 0;
        state.waiting = false;
      }
      break;
    case "tool-start":
      state.running = true;
      state.waiting = false;
      state.completedUntil = 0;
      state.errorUntil = 0;
      if (!state.openTools.includes(event.id)) state.openTools = [...state.openTools, event.id];
      break;
    case "tool-end":
      state.openTools = state.openTools.filter((id) => id !== event.id);
      state.waiting = false;
      break;
    case "turn-start":
      state.running = true;
      state.waiting = false;
      state.completedUntil = 0;
      state.errorUntil = 0;
      break;
    case "turn-end":
      state.running = false;
      state.waiting = false;
      state.openTools = [];
      if (event.reason === "error") {
        state.errorUntil = event.at + ERROR_HOLD_MS;
      } else {
        state.completedUntil = event.at + COMPLETED_HOLD_MS;
      }
      break;
    case "turn-stopping":
      state.completedUntil = event.at + COMPLETED_HOLD_MS;
      break;
    case "approval":
      state.waiting = true;
      break;
    case "error":
      state.waiting = false;
      state.errorUntil = event.at + ERROR_HOLD_MS;
      break;
    case "tick":
      break;
  }
  settle(state, event.at);
  return { state, changed: state.agentState !== before };
}
function hasPendingHold(state, at) {
  return state.errorUntil > at || state.completedUntil > at || state.waiting;
}

// src/host/normalize.ts
var SHELL_TOOLS = /* @__PURE__ */ new Set([
  "bash",
  "run_code",
  "run_command",
  "terminal_open",
  "terminal_send",
  "terminal_read",
  "terminal_close",
  "terminal_list",
  "terminal_signal"
]);
var FILE_READ_TOOLS = /* @__PURE__ */ new Set([
  "read",
  "read_image",
  "lsp_diagnostics",
  "lsp_symbols",
  "lsp_completion",
  "lsp_signature",
  "lsp_inlay_hints"
]);
var FILE_WRITE_TOOLS = /* @__PURE__ */ new Set(["write", "edit", "apply_patch", "lsp_rename", "lsp_format"]);
var SEARCH_TOOLS = /* @__PURE__ */ new Set([
  "glob",
  "grep",
  "session_search",
  "session_event_search",
  "session_event_read",
  "session_trace",
  "session_event_trace",
  "web_search",
  "find_skills"
]);
var BROWSER_TOOLS = /* @__PURE__ */ new Set(["web_fetch", "browser", "browser_use", "computer_use"]);
var MAX_LABEL = 40;
var MAX_TOOL_NAME = 32;
function classifyTool(rawName) {
  const name2 = normalizeName(rawName);
  if (name2 === "") return "other";
  if (SHELL_TOOLS.has(name2) || name2.startsWith("terminal") || name2.startsWith("bash")) return "shell";
  if (BROWSER_TOOLS.has(name2) || name2.startsWith("browser") || name2.startsWith("cua_")) return "browser";
  if (FILE_WRITE_TOOLS.has(name2)) return "file-write";
  if (FILE_READ_TOOLS.has(name2) || name2.startsWith("read")) return "file-read";
  if (SEARCH_TOOLS.has(name2) || name2.startsWith("glob") || name2.startsWith("grep")) return "search";
  return "other";
}
function fileKindOf(rawName) {
  const name2 = normalizeName(rawName);
  if (name2 === "") return void 0;
  if (name2 === "write") return "write";
  if (name2 === "edit" || name2 === "apply_patch" || name2 === "lsp_rename" || name2 === "lsp_format") {
    return "edit";
  }
  if (name2.startsWith("read") || FILE_READ_TOOLS.has(name2)) return "read";
  return void 0;
}
function normalizeName(rawName) {
  return typeof rawName === "string" ? rawName.trim().toLowerCase() : "";
}
var TARGET_KEYS = ["file_path", "filePath", "path", "target", "pattern", "name", "command"];
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
  const category = classifyTool(input.rawName);
  const fileKind = fileKindOf(input.rawName);
  const wantsTarget = fileKind !== void 0 || category === "search";
  const target = wantsTarget ? targetFromArguments(input.argumentsJson) : void 0;
  const name2 = input.rawName.slice(0, MAX_TOOL_NAME);
  const base = {
    id: input.id,
    name: name2,
    status: "running",
    timestamp: input.at,
    category
  };
  if (fileKind !== void 0) {
    return target === void 0 ? { ...base, type: "file", fileKind } : { ...base, type: "file", fileKind, target };
  }
  return target === void 0 ? { ...base, type: "tool" } : { ...base, type: "tool", target };
}
function approvalActivity(at, toolName, id) {
  const target = typeof toolName === "string" ? sanitizeBasename(toolName) : void 0;
  return target === void 0 ? { id, type: "approval", name: "approval", status: "waiting", timestamp: at } : { id, type: "approval", name: "approval", status: "waiting", timestamp: at, target };
}
function errorActivity(at, code, id) {
  const name2 = typeof code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : "agent-error";
  return { id, type: "agent", name: name2, status: "error", timestamp: at };
}

// src/host/hub.ts
function recordOf(value, key) {
  if (typeof value !== "object" || value === null) return void 0;
  return value[key];
}
function asString(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
var OrbitHub = class {
  records = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  maxSessions;
  maxActivities;
  clock;
  notifyQueued = false;
  sequence = 0;
  lastTouched;
  constructor(options = {}) {
    this.maxSessions = options.maxSessions ?? 8;
    this.maxActivities = options.maxActivities ?? MAX_ACTIVITY_ROWS;
    this.clock = options.now ?? (() => Date.now());
  }
  // ---------------------------------------------------------------- records
  ensure(sessionId) {
    const existing = this.records.get(sessionId);
    if (existing !== void 0) return existing;
    const now = this.clock();
    const record = {
      sessionId,
      machine: createMachine(now),
      activities: [],
      open: /* @__PURE__ */ new Map(),
      metrics: { turns: 0, tools: 0, files: 0, startedAt: now },
      version: 1,
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
      this.records.delete(oldestId);
      if (this.lastTouched === oldestId) this.lastTouched = keep;
    }
  }
  /** Recompute the published state after a mutation and queue one notification. */
  touch(record, at) {
    const next = computeState(record.machine, at);
    const changed = next !== record.machine.agentState;
    record.machine.agentState = next;
    record.machine.updatedAt = at;
    record.updatedAt = at;
    this.lastTouched = record.sessionId;
    if (!changed && record.version === 0) return;
    record.version += 1;
    this.queueNotify();
  }
  queueNotify() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
        }
      }
    });
  }
  pushActivity(record, activity) {
    record.activities.unshift(activity);
    if (record.activities.length > this.maxActivities) {
      record.activities.length = this.maxActivities;
    }
  }
  settleActivity(record, callId, status, at) {
    const index = record.activities.findIndex((row) => row.id === callId && row.status === "running");
    if (index < 0) return void 0;
    const current = record.activities[index];
    if (current === void 0) return void 0;
    const call = record.open.get(callId);
    const duration = Math.max(0, at - (call === void 0 ? current.timestamp : call.startedAt));
    const settled = { ...current, status, duration };
    record.activities[index] = settled;
    record.open.delete(callId);
    return settled;
  }
  // ------------------------------------------------------------------ folds
  nextId(prefix) {
    this.sequence += 1;
    return `${prefix}:${this.sequence}`;
  }
  /** Fold one durable DSH Session event. Unknown event types are ignored. */
  handleSessionEvent(sessionId, event) {
    if (typeof sessionId !== "string" || sessionId === "") return;
    if (typeof event !== "object" || event === null) return;
    const at = asNumber(event.time) ?? this.clock();
    const data = event.data;
    switch (event.type) {
      case "turn/start": {
        const record = this.ensure(sessionId);
        record.metrics.turns += 1;
        applyEvent(record.machine, { kind: "turn-start", at });
        this.touch(record, at);
        return;
      }
      case "tool/call": {
        const record = this.ensure(sessionId);
        const callId = asString(recordOf(data, "callId"));
        const name2 = asString(recordOf(data, "name"));
        if (callId === void 0 || name2 === void 0) return;
        const argumentsJson = typeof recordOf(data, "arguments") === "string" ? recordOf(data, "arguments") : "";
        if (record.open.has(callId)) return;
        const input = { id: callId, rawName: name2, argumentsJson, at };
        const activity = toolActivity(input);
        record.open.set(callId, { id: callId, startedAt: at });
        record.metrics.tools += 1;
        if (activity.type === "file") record.metrics.files += 1;
        this.pushActivity(record, activity);
        for (const row of record.activities) {
          if (row.type === "approval" && row.status === "waiting") row.status = "success";
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
        const isError = recordOf(message, "isError") === true || recordOf(data, "error") !== void 0;
        this.settleActivity(record, callId, isError ? "error" : "success", at);
        applyEvent(record.machine, { kind: "tool-end", id: callId, at });
        this.touch(record, at);
        return;
      }
      case "turn/end": {
        const record = this.ensure(sessionId);
        const reasonKind = asString(recordOf(recordOf(data, "reason"), "kind")) ?? "other";
        const reason = reasonKind === "completed" ? "completed" : reasonKind === "error" ? "error" : reasonKind === "aborted" ? "aborted" : "other";
        for (const call of record.open.values()) {
          this.settleActivity(record, call.id, reason === "error" ? "error" : "success", at);
        }
        record.open.clear();
        applyEvent(record.machine, { kind: "turn-end", reason, at });
        this.touch(record, at);
        return;
      }
      default:
        return;
    }
  }
  handleStatus(sessionId, status) {
    if (typeof sessionId !== "string" || sessionId === "") return;
    const record = this.ensure(sessionId);
    const at = this.clock();
    applyEvent(record.machine, { kind: "status", status, at });
    this.touch(record, at);
  }
  handleTurnStopping(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return;
    const record = this.ensure(sessionId);
    const at = this.clock();
    applyEvent(record.machine, { kind: "turn-stopping", at });
    this.touch(record, at);
  }
  handleApproval(sessionId, toolName) {
    if (typeof sessionId !== "string" || sessionId === "") return;
    const record = this.ensure(sessionId);
    const at = this.clock();
    this.pushActivity(record, approvalActivity(at, toolName, this.nextId("approval")));
    applyEvent(record.machine, { kind: "approval", at });
    this.touch(record, at);
  }
  handleError(sessionId, code) {
    if (typeof sessionId !== "string" || sessionId === "") return;
    const record = this.ensure(sessionId);
    const at = this.clock();
    this.pushActivity(record, errorActivity(at, code, this.nextId("error")));
    applyEvent(record.machine, { kind: "error", at });
    this.touch(record, at);
  }
  /** Expire time-boxed states (`completed`, `error`). Cheap when nothing holds. */
  tick() {
    const at = this.clock();
    for (const record of this.records.values()) {
      if (!hasPendingHold(record.machine, at)) continue;
      const next = computeState(record.machine, at);
      if (next === record.machine.agentState) continue;
      record.machine.agentState = next;
      record.machine.waiting = record.machine.waiting && next === "waiting";
      record.version += 1;
      record.updatedAt = at;
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
    if (typeof requested === "string" && requested !== "") {
      return this.records.has(requested) ? requested : requested;
    }
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
        events: [],
        updatedAt: now,
        metrics: { turns: 0, tools: 0, files: 0, startedAt: now }
      };
    }
    const agentState = computeState(record.machine, now);
    return {
      version: record.version,
      sessionId: record.sessionId,
      agentState,
      activeTools: record.machine.openTools.length,
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
    this.listeners.clear();
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
  ctx.effect(() => ctx.on("session/event", (session, event) => {
    try {
      const sessionId = idOf(session);
      if (sessionId === void 0) return;
      hub.handleSessionEvent(sessionId, event);
    } catch (error) {
      report("session event normalization", error);
    }
  }), "neural-orbit: session events");
  ctx.effect(() => ctx.on("agent/status", (payload) => {
    try {
      const sessionId = idOf(payload?.agent);
      if (sessionId === void 0) return;
      hub.handleStatus(sessionId, payload.status);
    } catch (error) {
      report("agent status", error);
    }
  }), "neural-orbit: agent status");
  ctx.effect(() => ctx.on("agent/turn-stopping", (payload) => {
    try {
      const sessionId = idOf(payload?.agent);
      if (sessionId === void 0) return;
      hub.handleTurnStopping(sessionId);
    } catch (error) {
      report("turn stopping", error);
    }
  }), "neural-orbit: turn stopping");
  ctx.effect(() => ctx.on("agent/error", (payload) => {
    try {
      const sessionId = idOf(payload?.agent);
      if (sessionId === void 0) return;
      hub.handleError(sessionId, codeOf(payload.error));
    } catch (error) {
      report("agent error", error);
    }
  }), "neural-orbit: agent error");
  ctx.effect(() => ctx.on("approval/request", (request, next) => {
    try {
      const sessionId = idOf(request?.agent);
      if (sessionId !== void 0) hub.handleApproval(sessionId, request.toolName);
    } catch (error) {
      report("approval observation", error);
    }
    return next();
  }), "neural-orbit: approvals");
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
    routes: ["/api/neural-orbit/state", "/api/neural-orbit/events"],
    persistence: "none"
  };
}
export {
  apply,
  describe,
  name
};
