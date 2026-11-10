import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbitHub } from '../src/host/hub';
import { registerOrbitRoutes, type WebServerLike } from '../src/host/routes';
import {
  EVENTS_ROUTE,
  HEARTBEAT_MS,
  ORBIT_PROTOCOL_VERSION,
  STATE_ROUTE,
  type OrbitFrame,
} from '../src/shared/protocol';

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

/**
 * A request shaped the way the carrier hands one to a resource.
 *
 * `WebServer.serveResource` builds the URL against a placeholder origin
 * (`http://x`) and leaves the real authority in the `Host` header, so a resource
 * can never read the authority off the URL. Every request that is expected to be
 * answered has to look like that — including the `Host` header, which
 * `foreignRequestRefusal` needs in order to tell a page request from a bare client.
 */
const PAGE_AUTHORITY = '127.0.0.1:4123';
function pageRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://x${path}`, { headers: { host: PAGE_AUTHORITY, ...headers } });
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

    const response = await state?.resource(pageRequest(`${STATE_ROUTE}?sessionId=beta`));
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
    const response = await events?.resource(pageRequest(`${EVENTS_ROUTE}?sessionId=s1`));
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
    expect(frame.snapshot.events[0]?.safeTarget).toBe('plan.md');

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

  /*
   * A peer that holds the socket open but stops reading (a frozen background tab,
   * a proxy that will not forward, a paused debugger) used to let every snapshot
   * pile into an unbounded queue while the connection stayed in `clients`.
   */
  it('drops frames instead of buffering without bound when the peer stops reading', async () => {
    const hub = new OrbitHub({ now: () => T0 });
    const { routes, webServer } = fakeServer();
    const local = registerOrbitRoutes(hub, webServer);
    handle = local;

    const events = routes.find((route) => route.path === EVENTS_ROUTE);
    const response = await events?.resource(pageRequest(`${EVENTS_ROUTE}?sessionId=s1`));
    const reader = response?.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) return;

    // Twenty changes, nobody reading: the queue must stay bounded. Hub
    // notifications are coalesced on a microtask, so without yielding between the
    // changes they collapse into a single push and prove nothing.
    for (let index = 0; index < 20; index += 1) {
      hub.handleSessionEvent('s1', { type: 'turn/start', time: T0 + index, data: { turn: index + 1 } });
      await Promise.resolve();
      await Promise.resolve();
    }

    let frames = 0;
    let newest = 0;
    for (let guard = 0; guard < 40; guard += 1) {
      const next = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
      ]);
      if (next === null || next.done === true) break;
      frames += 1;
      const text = new TextDecoder().decode(next.value);
      const line = text.split('\n').find((candidate) => candidate.startsWith('data: '));
      if (line === undefined) continue;
      const frame = JSON.parse(line.slice('data: '.length)) as OrbitFrame;
      if (frame.type === 'snapshot') newest = frame.snapshot.version;
    }

    // One opening frame plus the bounded queue — not twenty-one.
    expect(frames).toBeLessThanOrEqual(6);
    /*
     * And the frames it kept must be the *newest* ones. Dropping the freshest
     * frame while the queue still held stale ones would leave a slow-but-alive
     * peer rendering minutes-old state with nothing scheduled to fix it.
     */
    expect(newest).toBe(hub.snapshot('s1').version);
    await reader.cancel();
  });

  it('evicts a connection that stops accepting frames', async () => {
    // Fake timers must be installed *before* the routes register their interval,
    // or the heartbeat keeps running on the real clock and never advances.
    vi.useFakeTimers();
    const hub = new OrbitHub({ now: () => T0 });
    const { routes, webServer } = fakeServer();
    const local = registerOrbitRoutes(hub, webServer);
    handle = local;

    const events = routes.find((route) => route.path === EVENTS_ROUTE);
    const response = await events?.resource(pageRequest(`${EVENTS_ROUTE}?sessionId=s1`));
    expect(local.clients()).toBe(1);
    void response;

    // Fill the queue, then let three heartbeats fail to land. Hub notifications
    // are coalesced on a microtask, so each change needs one turn of the loop to
    // actually reach the stream.
    for (let index = 0; index < 10; index += 1) {
      hub.handleSessionEvent('s1', { type: 'turn/start', time: T0 + index, data: { turn: index + 1 } });
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(local.clients()).toBe(1);
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(local.clients()).toBe(0);
  });

  it('closes live streams and unregisters both routes on dispose', async () => {
    const hub = new OrbitHub({ now: () => T0 });
    const { routes, webServer } = fakeServer();
    const local = registerOrbitRoutes(hub, webServer);

    const events = routes.find((route) => route.path === EVENTS_ROUTE);
    const response = await events?.resource(pageRequest(`${EVENTS_ROUTE}`));
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

describe('carrier contract', () => {
  it('registers resources, the shape 0.2.2-rc.1 dispatches', () => {
    /*
     * `WebServer` picks a responder in this order:
     *   typeof responder === 'function'  → responder(req, res)
     *   'resource' in responder          → serveResource(req, res, url, resource)
     *   otherwise                        → responder.handler(req, res)
     *
     * The third branch is all 0.2.1-rc.x has (no `resource` concept at all), so a
     * `handler`-only route is a TypeError there and a silent no-op here. A
     * hand-written mock cannot catch that unless it copies this order — this test
     * pins the shape, and `package.json -> engines.dsh` pins the floor that has
     * the `resource` branch.
     */
    const hub = new OrbitHub({ now: () => T0 });
    const { routes, webServer } = fakeServer();
    const local = registerOrbitRoutes(hub, webServer);

    try {
      expect(routes).toHaveLength(2);
      for (const route of routes) {
        expect(typeof route.resource).toBe('function');
        expect('handler' in route).toBe(false);
      }
    } finally {
      local.dispose();
    }
  });
});

/*
 * `WebServer.serveResource`, reproduced from the 0.2.2-rc.1 bundle
 * (`@deepseek-ai/dsh-host-webserver/lib/index.js`).
 *
 * Deliberately a *copy* rather than a devDependency: that package is internal, its
 * npm availability is not promised, and pinning the plugin's release cadence to an
 * unversioned private API is a worse trade than re-reading twelve lines when the
 * Host is upgraded. What it buys is the one thing a shape assertion cannot: proof
 * that the plugin's route actually answers *when dispatched this way*, and that the
 * order (function → resource → handler) is the order we think it is.
 *
 * When bumping `engines.dsh`, re-read that file and re-copy this.
 */
type Responder =
  | ((req: Request) => Promise<Response>)
  | { resource: (req: Request) => Promise<Response> }
  | { handler: (req: Request) => Promise<Response> };

async function serveResource(responder: Responder, req: Request): Promise<Response> {
  if (typeof responder === 'function') return responder(req);
  if ('resource' in responder) return responder.resource(req);
  return responder.handler(req);
}

describe('carrier dispatch (replica of serveResource)', () => {
  it('picks function, then resource, then handler, in that order', async () => {
    const order: string[] = [];
    const asFunction = async (): Promise<Response> => {
      order.push('function');
      return new Response('f');
    };
    await serveResource(asFunction, pageRequest(STATE_ROUTE));
    await serveResource(
      {
        resource: async () => {
          order.push('resource');
          return new Response('r');
        },
      },
      pageRequest(STATE_ROUTE),
    );
    await serveResource(
      {
        handler: async () => {
          order.push('handler');
          return new Response('h');
        },
      },
      pageRequest(STATE_ROUTE),
    );
    expect(order).toEqual(['function', 'resource', 'handler']);
  });

  it("answers the plugin's own route through it, with a real snapshot", async () => {
    const hub = new OrbitHub({ now: () => T0 });
    const { routes, webServer } = fakeServer();
    const local = registerOrbitRoutes(hub, webServer);
    try {
      const route = routes[0];
      expect(route).toBeDefined();
      if (route === undefined) return;
      const response = await serveResource(route, pageRequest(STATE_ROUTE));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = (await response.json()) as { protocol?: number; agentState?: string };
      expect(body.protocol).toBe(ORBIT_PROTOCOL_VERSION);
      expect(body.agentState).toBe('idle');
    } finally {
      local.dispose();
    }
  });

  it('would silently do nothing for a handler-only route, which is why we ship resource', async () => {
    // The negative control: 0.2.1-rc.x has only the last branch, so this is the
    // shape that would work there and the shape that never answers here.
    const asHandlerOnly = {
      handler: async (): Promise<Response> => new Response('never called'),
    };
    expect('resource' in asHandlerOnly).toBe(false);
    const response = await serveResource(asHandlerOnly, pageRequest(STATE_ROUTE));
    expect(await response.text()).toBe('never called');
  });
});

describe('foreign request containment', () => {
  let local: { dispose(): void; clients(): number } | undefined;

  afterEach(() => {
    local?.dispose();
    local = undefined;
  });

  const answer = async (headers: Record<string, string>): Promise<Response | undefined> => {
    const hub = new OrbitHub({ now: () => T0 });
    const { routes, webServer } = fakeServer();
    local = registerOrbitRoutes(hub, webServer);
    const state = routes.find((route) => route.path === STATE_ROUTE);
    return state?.resource(
      new Request(`http://x${STATE_ROUTE}`, { headers: { host: PAGE_AUTHORITY, ...headers } }),
    );
  };

  it('answers the GUI that is served on loopback', async () => {
    const response = await answer({});
    expect(response?.status).toBe(200);
  });

  it('refuses a bare client that reaches a non-loopback authority', async () => {
    // The shape of a plain curl to <lan-ip>:<port>/api/orbis/state: no fetch
    // metadata at all, and an authority that says the listener is exposed. Every
    // other surface in the process answers 401 to exactly this request.
    const response = await answer({ host: '10.0.0.7:4123' });
    expect(response?.status).toBe(403);
  });

  it('refuses cross-site pages', async () => {
    expect((await answer({ 'sec-fetch-site': 'cross-site' }))?.status).toBe(403);
    expect((await answer({ 'sec-fetch-site': 'same-site' }))?.status).toBe(403);
  });

  it('refuses an Origin that names another authority', async () => {
    expect((await answer({ origin: 'http://evil.test' }))?.status).toBe(403);
    const matching = await answer({ origin: `http://${PAGE_AUTHORITY}`, 'sec-fetch-site': 'same-origin' });
    expect(matching?.status).toBe(200);
  });

  /*
   * S2 / option A (2.1.7): the trust root is the authority, not the fetch metadata.
   *
   * This test used to assert the opposite. It read "same-origin means the page got
   * past the host's 401", which is true of a same-machine page and false of a page
   * served from a LAN address — that page is same-origin with itself too, and it
   * could read the whole snapshot. A deployment that is deliberately exposed now
   * loses the panel on other devices instead of silently serving them: fail closed,
   * and the README says so.
   */
  it('refuses a GUI served from a LAN address, even though it is same-origin', async () => {
    const response = await answer({ host: '10.0.0.7:4123', 'sec-fetch-site': 'same-origin' });
    expect(response?.status).toBe(403);
  });

  it('refuses the DNS-rebinding shape: a truthful browser on a foreign host', async () => {
    // A page on `evil.test` whose name resolves to 127.0.0.1 sends its own origin and
    // `same-origin` fetch metadata. The authority is the only part of this request
    // that describes *our* listener rather than the caller, so it decides.
    const rebound = await answer({
      host: 'evil.test:4123',
      origin: 'http://evil.test:4123',
      'sec-fetch-site': 'same-origin',
    });
    expect(rebound?.status).toBe(403);
  });

  it('refuses an opaque origin, which is what a sandboxed or file:// page sends', async () => {
    expect((await answer({ origin: 'null' }))?.status).toBe(403);
  });

  it('answers a loopback page that names its own origin', async () => {
    const response = await answer({ origin: `http://${PAGE_AUTHORITY}`, 'sec-fetch-site': 'same-origin' });
    expect(response?.status).toBe(200);
  });

  it('answers a bare loopback client, which is what `dsh doctor` and curl are', async () => {
    // No fetch metadata at all: the request never came from a browser. Still local.
    expect((await answer({}))?.status).toBe(200);
  });
});

describe('auto-follow subscriptions', () => {
  let local: { dispose(): void; clients(): number } | undefined;

  afterEach(() => {
    local?.dispose();
    local = undefined;
  });

  it('pushes a Session switch even when the new Session has a lower version', async () => {
    let now = T0;
    const hub = new OrbitHub({ now: () => now, mono: () => now });
    // Session `a` reaches a high version; it is what a follow subscription opens on.
    for (let index = 0; index < 11; index += 1) {
      now += 10;
      hub.handleStatus('a', 'running');
    }
    const { routes, webServer } = fakeServer();
    local = registerOrbitRoutes(hub, webServer);
    const events = routes.find((route) => route.path === EVENTS_ROUTE);
    const response = await events?.resource(pageRequest(EVENTS_ROUTE));
    const reader = response?.body?.getReader();
    if (reader === undefined) throw new Error('no stream');

    const opening = await readFrame(reader);
    expect(opening.type).toBe('snapshot');
    if (opening.type !== 'snapshot') return;
    expect(opening.snapshot.sessionId).toBe('a');
    const highVersion = opening.snapshot.version;
    expect(highVersion).toBeGreaterThan(2);

    // Session `b` becomes the most recent one while still at version 2.
    now += 10;
    hub.handleStatus('b', 'running');
    now += 10;
    hub.handleStatus('b', 'running');

    /*
     * Versions are per record, so `2 <= 11` told the stream there was nothing new
     * and this connection stopped updating for good: the GUI showed a Session that
     * had gone quiet while the one the user had switched to never appeared.
     */
    let switched: OrbitFrame | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const candidate = await readFrame(reader);
      if (candidate.type === 'snapshot' && candidate.snapshot.sessionId === 'b') {
        switched = candidate;
        break;
      }
    }
    expect(switched).toBeDefined();
    if (switched?.type === 'snapshot') {
      // The whole point: the new Session is *behind* the old watermark.
      expect(switched.snapshot.version).toBeLessThan(highVersion);
    }

    await reader.cancel();
  });
});
