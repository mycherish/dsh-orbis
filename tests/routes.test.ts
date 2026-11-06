import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbitHub } from '../src/host/hub';
import { registerOrbitRoutes, type WebServerLike } from '../src/host/routes';
import { EVENTS_ROUTE, STATE_ROUTE, type OrbitFrame } from '../src/shared/protocol';

const T0 = 1_700_000_000_000;

interface Registered {
  kind: string;
  path: string;
  resource: (request: Request) => Promise<Response>;
  disposed: boolean;
}

function fakeServer() {
  const routes: Registered[] = [];
  const webServer: WebServerLike = {
    register(route) {
      const entry: Registered = {
        kind: route.kind,
        resource: route.resource,
        path: route.path,
        disposed: false,
      };
      routes.push(entry);
      return () => {
        entry.disposed = true;
      };
    },
  };
  return { routes, webServer };
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<OrbitFrame> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { value, done } = await reader.read();
    if (done === true || value === undefined) throw new Error('stream ended early');
    const text = new TextDecoder().decode(value);
    const line = text.split('\n').find((candidate) => candidate.startsWith('data: '));
    if (line !== undefined) return JSON.parse(line.slice('data: '.length)) as OrbitFrame;
  }
  throw new Error('no data frame received');
}

describe('read-only routes', () => {
  let handle: { dispose(): void; clients(): number } | undefined;

  afterEach(() => {
    handle?.dispose();
    handle = undefined;
    vi.useRealTimers();
  });

  it('registers exactly the two documented paths', () => {
    const hub = new OrbitHub({ now: () => T0 });
    const { routes, webServer } = fakeServer();
    handle = registerOrbitRoutes(hub, webServer);

    expect(routes.map((route) => route.path).sort()).toEqual([EVENTS_ROUTE, STATE_ROUTE].sort());
    expect(routes.every((route) => route.kind === 'exact')).toBe(true);
  });

  it('answers GET /state with the snapshot for the requested Session', async () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleSessionEvent('alpha', { type: 'turn/start', time: T0, data: { turn: 1 } });
    hub.handleSessionEvent('beta', { type: 'turn/start', time: T0 + 1, data: { turn: 1 } });
    const { routes, webServer } = fakeServer();
    handle = registerOrbitRoutes(hub, webServer);

    const state = routes.find((route) => route.path === STATE_ROUTE);
    expect(state).toBeDefined();

    const response = await state?.resource(new Request(`http://local${STATE_ROUTE}?sessionId=beta`));
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toContain('application/json');
    expect(response?.headers.get('cache-control')).toBe('no-store');
    const body = (await response?.json()) as { sessionId?: string; version: number };
    expect(body.sessionId).toBe('beta');
    expect(body.version).toBeGreaterThan(0);
  });

  it('pushes the current snapshot as the first SSE frame', async () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleSessionEvent('s1', {
      type: 'tool/call',
      time: T0,
      data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"/x/plan.md"}' },
    });
    const { routes, webServer } = fakeServer();
    handle = registerOrbitRoutes(hub, webServer);

    const events = routes.find((route) => route.path === EVENTS_ROUTE);
    const response = await events?.resource(new Request(`http://local${EVENTS_ROUTE}?sessionId=s1`));
    expect(response?.headers.get('content-type')).toContain('text/event-stream');
    expect(response?.headers.get('cache-control')).toContain('no-store');
    expect(response?.body).not.toBeNull();

    const reader = response?.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) return;

    const frame = await readFrame(reader);
    expect(frame.type).toBe('snapshot');
    if (frame.type !== 'snapshot') return;
    expect(frame.snapshot.sessionId).toBe('s1');
    expect(frame.snapshot.agentState).toBe('executing');
    expect(frame.snapshot.events[0]?.target).toBe('plan.md');

    // A later change is pushed on the same stream, and versions only increase.
    hub.handleSessionEvent('s1', {
      type: 'tool/result',
      time: T0 + 250,
      data: { turn: 1, step: 1, message: { toolCallId: 'c1' } },
    });
    let settled: OrbitFrame | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = await readFrame(reader);
      if (candidate.type === 'snapshot' && candidate.snapshot.activeTools === 0) {
        settled = candidate;
        break;
      }
    }
    expect(settled).toBeDefined();
    if (settled?.type === 'snapshot') {
      expect(settled.snapshot.version).toBeGreaterThan(frame.snapshot.version);
      expect(settled.snapshot.events[0]?.status).toBe('success');
      expect(settled.snapshot.events[0]?.duration).toBe(250);
    }

    await reader.cancel();
  });

  it('closes live streams and unregisters both routes on dispose', async () => {
    const hub = new OrbitHub({ now: () => T0 });
    const { routes, webServer } = fakeServer();
    const local = registerOrbitRoutes(hub, webServer);

    const events = routes.find((route) => route.path === EVENTS_ROUTE);
    const response = await events?.resource(new Request(`http://local${EVENTS_ROUTE}`));
    const reader = response?.body?.getReader();
    expect(local.clients()).toBe(1);

    local.dispose();
    expect(local.clients()).toBe(0);
    expect(routes.every((route) => route.disposed)).toBe(true);

    // The stream is closed, not left hanging (drain any buffered frame first).
    let closed = false;
    for (let attempt = 0; attempt < 8 && !closed; attempt += 1) {
      const { done } = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
      closed = done;
    }
    expect(closed).toBe(true);
  });
});
