/**
 * Caelum Orbis — Host half.
 *
 * Wires DSH events into the `OrbitHub` state fold and exposes the read-only
 * snapshot/SSE routes. It never calls the LLM, never executes a tool, and never
 * persists anything: it only observes events the Harness already emits, so the
 * plugin cannot add token cost.
 *
 * Everything registered here is owned by a `ctx.effect`, so unloading the
 * plugin removes the listeners, the ticker, the routes and every open stream.
 */
import type { OrbitHub } from './hub';
import { OrbitHub as Hub } from './hub';
import type { SessionEventLike, SessionLike } from './hub';
import { registerOrbitRoutes, type RouteHandle, type WebServerLike } from './routes';
import { ORBIT_PROTOCOL_VERSION } from '../shared/protocol';

/** How often held states, silence buckets and stale calls are re-evaluated. */
const TICK_MS = 250;

/**
 * Minimum gap between title reads for a Session that has no title yet.
 *
 * `sessionTitle.get()` folds the whole Session log, so it is not free; reading it
 * on every event would tax the Host for a value that only changes rarely.
 */
const TITLE_RETRY_MS = 5_000;

/** A session id may arrive as a bare value or as an object carrying `id`. */
interface AgentLike {
  id: unknown;
  session?: { id: unknown };
}

interface ListenerOptions {
  /** Listen across every Agent scope, not only this plugin's own. */
  global?: boolean;
}

/** Structural view of the Harness `sessionTitle` fold service. */
interface SessionTitleServiceLike {
  get(session: unknown): { title?: unknown } | undefined;
}

/** Structural view of the Cordis Host context this plugin depends on. */
interface HostContextLike {
  on(
    name: 'session/event',
    listener: (session: SessionLike, event: SessionEventLike) => void,
    options?: ListenerOptions,
  ): () => void;
  on(
    name: 'agent/status',
    listener: (payload: { agent: AgentLike; status: 'idle' | 'running' }) => void,
    options?: ListenerOptions,
  ): () => void;
  on(
    name: 'agent/turn-stopping',
    listener: (payload: { agent: AgentLike; turn?: number }) => void,
    options?: ListenerOptions,
  ): () => void;
  on(
    name: 'agent/error',
    listener: (payload: { agent: AgentLike; error?: unknown }) => void,
    options?: ListenerOptions,
  ): () => void;
  on(
    name: 'agent/disposed',
    listener: (payload: { agent: AgentLike }) => void,
    options?: ListenerOptions,
  ): () => void;
  on(
    name: 'agent/assistant-stream',
    listener: (payload: { agent: AgentLike; frame: unknown }) => void,
    options?: ListenerOptions,
  ): () => void;
  on(
    name: 'user-questions/request',
    listener: (
      request: { agent: AgentLike; callId?: string; toolName?: string },
      next: () => Promise<unknown>,
    ) => Promise<unknown>,
    options?: ListenerOptions,
  ): () => void;
  on(
    name: 'approval/request',
    listener: (
      request: { agent: AgentLike; toolName?: string; callId?: string },
      next: () => Promise<unknown>,
    ) => Promise<unknown>,
    options?: ListenerOptions,
  ): () => void;
  effect(callback: () => (() => void) | void, label?: string): () => void;
  get(name: string): unknown;
}

function idOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id !== '') return id;
  }
  return undefined;
}

/** Resolve the Session an Agent-scoped payload belongs to. */
function sessionIdOf(agent: AgentLike | undefined): string | undefined {
  if (agent === undefined || agent === null) return undefined;
  const direct = idOf(agent.session);
  if (direct !== undefined) return direct;
  return idOf(agent);
}

/** Best-effort failure code from an opaque DSH error object. */
function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export const name = 'orbis';

export function apply(ctx: HostContextLike): void {
  const hub: OrbitHub = new Hub();
  let routes: RouteHandle | undefined;
  let webServerWarned = false;
  let conversions = 0;

  const report = (label: string, error: unknown): void => {
    conversions += 1;
    if (conversions > 3) return; // Never let diagnostics become the problem.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[orbis] ${label} failed: ${message}`);
  };

  // Cross-Agent coverage: the built-in controllers listen with `{ global: true }`
  // for the same reason — a plugin mounted at the profile root must still see
  // events of Agents it did not create (sub-agents, teammates).
  const GLOBAL: ListenerOptions = { global: true };

  // `session/title` fires once per title change, so a Session that already had a
  // title when the Host last reloaded never replays it. Backfill from the
  // Harness' own fold instead of showing the fallback title forever.
  const titled = new Set<string>();
  const titleCheckedAt = new Map<string, number>();

  const seedTitle = (session: SessionLike, sessionId: string): void => {
    if (titled.has(sessionId)) return;
    const now = Date.now();
    const previous = titleCheckedAt.get(sessionId);
    if (previous !== undefined && now - previous < TITLE_RETRY_MS) return;
    if (titleCheckedAt.size > 256) titleCheckedAt.clear();
    titleCheckedAt.set(sessionId, now);
    let service: SessionTitleServiceLike | undefined;
    try {
      service = ctx.get('sessionTitle') as SessionTitleServiceLike | undefined;
    } catch {
      return; // Service unavailable: the fallback title stays, nothing breaks.
    }
    if (service === undefined || service === null || typeof service.get !== 'function') return;
    try {
      const title = service.get(session)?.title;
      if (typeof title !== 'string' || title.trim() === '') return;
      titled.add(sessionId);
      titleCheckedAt.delete(sessionId);
      hub.seedTitle(sessionId, title);
    } catch (error) {
      report('session title read', error);
    }
  };

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      const sessionId = idOf(session);
      if (sessionId === undefined) return;
      hub.handleSessionEvent(sessionId, event);
      seedTitle(session, sessionId);
    } catch (error) {
      report('session event normalization', error);
    }
  }, GLOBAL), 'orbis: session events');

  ctx.effect(() => ctx.on('agent/status', (payload) => {
    try {
      const sessionId = sessionIdOf(payload?.agent);
      if (sessionId === undefined) return;
      hub.handleStatus(sessionId, payload.status);
    } catch (error) {
      report('agent status', error);
    }
  }, GLOBAL), 'orbis: agent status');

  ctx.effect(() => ctx.on('agent/turn-stopping', (payload) => {
    try {
      const sessionId = sessionIdOf(payload?.agent);
      if (sessionId === undefined) return;
      hub.handleTurnStopping(sessionId);
    } catch (error) {
      report('turn stopping', error);
    }
  }, GLOBAL), 'orbis: turn stopping');

  ctx.effect(() => ctx.on('agent/error', (payload) => {
    try {
      const sessionId = sessionIdOf(payload?.agent);
      if (sessionId === undefined) return;
      hub.handleError(sessionId, codeOf(payload.error));
    } catch (error) {
      report('agent error', error);
    }
  }, GLOBAL), 'orbis: agent error');

  ctx.effect(() => ctx.on('agent/disposed', (payload) => {
    try {
      const sessionId = sessionIdOf(payload?.agent);
      if (sessionId === undefined) return;
      hub.handleDisposed(sessionId);
    } catch (error) {
      report('agent disposed', error);
    }
  }, GLOBAL), 'orbis: agent disposed');

  // Transient model frames: the only real-time signal available, and the only
  // place the plugin can see "thinking" versus "answering" while it happens.
  // Only the frame's type tags are read (see `host/stream.ts`).
  ctx.effect(() => ctx.on('agent/assistant-stream', (payload) => {
    try {
      const sessionId = sessionIdOf(payload?.agent);
      if (sessionId === undefined) return;
      hub.handleStream(sessionId, payload.frame);
    } catch (error) {
      report('assistant stream', error);
    }
  }, GLOBAL), 'orbis: assistant stream');

  // Waterfall: observe the ask, then always delegate the decision.
  ctx.effect(() => ctx.on('approval/request', (request, next) => {
    try {
      const sessionId = sessionIdOf(request?.agent);
      if (sessionId !== undefined) hub.handleApproval(sessionId, request.toolName, request.callId);
    } catch (error) {
      report('approval observation', error);
    }
    return next();
  }, GLOBAL), 'orbis: approvals');

  // Waterfall: observe the ask, then always delegate the decision. The questions
  // themselves are content and are never read — only the Agent and the call id.
  // Settling is observed on the same promise the pipeline awaits, so a cancelled
  // or rejected ask stops reporting a block too.
  ctx.effect(() => ctx.on('user-questions/request', (request, next) => {
    let sessionId: string | undefined;
    try {
      sessionId = sessionIdOf(request?.agent);
      if (sessionId !== undefined) {
        hub.handleQuestion(sessionId, typeof request.toolName === 'string' ? request.toolName : undefined, idOf(request.callId));
      }
    } catch (error) {
      report('question observation', error);
    }
    const pending = next();
    const released = (): void => {
      if (sessionId === undefined) return;
      try {
        hub.handleQuestionSettled(sessionId);
      } catch (error) {
        report('question release', error);
      }
    };
    void Promise.resolve(pending).then(released, released);
    return pending;
  }, GLOBAL), 'orbis: user questions');

  /**
   * The web carrier may activate after this row. Registration is retried from
   * the ticker until it succeeds, and a missing carrier only disables the HTTP
   * surface — state tracking keeps working.
   */
  const ensureRoutes = (): boolean => {
    if (routes !== undefined) return true;
    let webServer: WebServerLike | undefined;
    try {
      webServer = ctx.get('webServer') as WebServerLike | undefined;
    } catch {
      webServer = undefined;
    }
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      if (!webServerWarned) {
        webServerWarned = true;
        console.warn('[orbis] webServer service unavailable; HTTP routes stay disabled');
      }
      return false;
    }
    try {
      routes = registerOrbitRoutes(hub, webServer);
      return true;
    } catch (error) {
      report('route registration', error);
      return false;
    }
  };

  ctx.effect(() => {
    ensureRoutes();
    const timer = setInterval(() => {
      hub.tick();
      if (routes === undefined) ensureRoutes();
    }, TICK_MS);
    return () => {
      clearInterval(timer);
      routes?.dispose();
      routes = undefined;
    };
  }, 'orbis: ticker and routes');

  ctx.effect(() => () => {
    hub.dispose();
  }, 'orbis: hub teardown');
}

/** Diagnostics for the Plugin Manager detail page and for `dsh doctor`-style checks. */
export function describe(): Record<string, unknown> {
  return {
    name,
    protocol: ORBIT_PROTOCOL_VERSION,
    routes: ['/api/orbis/state', '/api/orbis/events'],
    persistence: 'none',
    llmCalls: 0,
  };
}
