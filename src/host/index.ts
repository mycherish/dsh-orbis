/**
 * Neural Orbit — Host half.
 *
 * Wires DSH events into the `OrbitHub` state fold and exposes the read-only
 * snapshot/SSE routes. It never calls the LLM, never executes a tool, and never
 * persists anything: it only observes events the Harness already emits.
 *
 * Everything registered here is owned by a `ctx.effect`, so unloading the
 * plugin removes the listeners, the ticker, the routes and every open stream.
 */
import type { OrbitHub } from './hub';
import { OrbitHub as Hub } from './hub';
import type { SessionEventLike, SessionLike } from './hub';
import { registerOrbitRoutes, type RouteHandle, type WebServerLike } from './routes';

/** How often time-boxed states are re-evaluated. */
const TICK_MS = 250;

/** Structural view of the Cordis Host context this plugin depends on. */
interface HostContextLike {
  on(name: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void): () => void;
  on(name: 'agent/status', listener: (payload: { agent: { id: unknown }; status: 'idle' | 'running' }) => void): () => void;
  on(name: 'agent/turn-stopping', listener: (payload: { agent: { id: unknown }; turn?: number }) => void): () => void;
  on(name: 'agent/error', listener: (payload: { agent: { id: unknown }; error?: unknown }) => void): () => void;
  on(name: 'approval/request', listener: (
    request: { agent: { id: unknown }; toolName?: string },
    next: () => Promise<unknown>,
  ) => Promise<unknown>): () => void;
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

/** Best-effort failure code from an opaque DSH error object. */
function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export const name = 'neural-orbit';

export function apply(ctx: HostContextLike): void {
  const hub: OrbitHub = new Hub();
  let routes: RouteHandle | undefined;
  let webServerWarned = false;
  let conversions = 0;

  const report = (label: string, error: unknown): void => {
    conversions += 1;
    if (conversions > 3) return; // Never let diagnostics become the problem.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[neural-orbit] ${label} failed: ${message}`);
  };

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      const sessionId = idOf(session);
      if (sessionId === undefined) return;
      hub.handleSessionEvent(sessionId, event);
    } catch (error) {
      report('session event normalization', error);
    }
  }), 'neural-orbit: session events');

  ctx.effect(() => ctx.on('agent/status', (payload) => {
    try {
      const sessionId = idOf(payload?.agent);
      if (sessionId === undefined) return;
      hub.handleStatus(sessionId, payload.status);
    } catch (error) {
      report('agent status', error);
    }
  }), 'neural-orbit: agent status');

  ctx.effect(() => ctx.on('agent/turn-stopping', (payload) => {
    try {
      const sessionId = idOf(payload?.agent);
      if (sessionId === undefined) return;
      hub.handleTurnStopping(sessionId);
    } catch (error) {
      report('turn stopping', error);
    }
  }), 'neural-orbit: turn stopping');

  ctx.effect(() => ctx.on('agent/error', (payload) => {
    try {
      const sessionId = idOf(payload?.agent);
      if (sessionId === undefined) return;
      hub.handleError(sessionId, codeOf(payload.error));
    } catch (error) {
      report('agent error', error);
    }
  }), 'neural-orbit: agent error');

  // Waterfall: observe the ask, then always delegate the decision.
  ctx.effect(() => ctx.on('approval/request', (request, next) => {
    try {
      const sessionId = idOf(request?.agent);
      if (sessionId !== undefined) hub.handleApproval(sessionId, request.toolName);
    } catch (error) {
      report('approval observation', error);
    }
    return next();
  }), 'neural-orbit: approvals');

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
        console.warn('[neural-orbit] webServer service unavailable; HTTP routes stay disabled');
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
  }, 'neural-orbit: ticker and routes');

  ctx.effect(() => () => {
    hub.dispose();
  }, 'neural-orbit: hub teardown');
}

/** Diagnostics for the Plugin Manager detail page and for `dsh doctor`-style checks. */
export function describe(): Record<string, unknown> {
  return {
    name,
    routes: ['/api/neural-orbit/state', '/api/neural-orbit/events'],
    persistence: 'none',
  };
}
