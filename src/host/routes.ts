/**
 * The read-only HTTP surface (spec §6).
 *
 * Two exact routes on the DSH web carrier:
 *   GET /api/orbis/state  → the current snapshot as JSON
 *   GET /api/orbis/events → the same snapshot, then every change, over SSE
 *
 * Both are registered as `{ resource }` routes, which is the shape the carrier
 * dispatches through `WebServer.serveResource` — it builds a Fetch `Request`, takes
 * the `Response`, writes it, and aborts the request signal when the socket closes
 * (which is how the SSE stream learns about a vanished peer). That branch landed in
 * DSH 0.2.2-rc.1; 0.2.1-rc.x knows only `handler(req, res)` and would call a
 * `resource`-only route's missing `handler`. `package.json -> engines.dsh` therefore
 * floors the supported host at 0.2.2-rc.1, and `tests/release-contract.test.ts`
 * pins that floor so it cannot silently widen again.
 *
 * Answers stay same-origin with the GUI and are unregistered when the plugin
 * unloads. `foreignRequestRefusal` is the containment check that keeps these two
 * routes from being the one unauthenticated read surface in the process.
 */
import {
  EVENTS_ROUTE,
  HEARTBEAT_MS,
  STATE_ROUTE,
  type OrbitFrame,
} from '../shared/protocol';
import type { OrbitHub } from './hub';

/** Minimal structural view of the DSH `webServer` service. */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    resource: (request: Request, peer?: unknown) => Promise<Response>;
  }): () => void;
}

export interface RouteHandle {
  dispose(): void;
  /** Live SSE connections, for diagnostics. */
  clients(): number;
}

interface Client {
  sessionId: string | undefined;
  /** Highest snapshot version actually written to this stream. */
  lastVersion: number;
  /** Consecutive dropped writes; reset by any successful one. */
  stalled: number;
  /**
   * @param version the snapshot version this frame carries, when it carries one.
   * @returns `true` when the frame was queued, `false` when it was dropped (it is
   *          then held as the pending frame until the peer makes room).
   */
  send(text: string, version?: number): boolean;
  end(): void;
}

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const REFUSAL_HEADERS: Record<string, string> = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store',
};

const REFUSAL_TEXT = 'orbis: this endpoint answers only the page that hosts it.\n';

const LOOPBACK_NAMES = new Set(['localhost', '[::1]', '::1']);

/** True for an authority only a process on this machine can reach. */
export function isLoopbackAuthority(authority: string | null): boolean {
  if (authority === null) return false;
  const name = authority.replace(/:\d+$/, '').toLowerCase();
  if (LOOPBACK_NAMES.has(name)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/**
 * Containment for the read-only surface: when this request must not be answered.
 *
 * Neither route carries any authentication of its own, and the host's adapter
 * (`WebServer.serveResource`, whose only filter is a GET/HEAD method check) adds
 * none. Every other HTTP surface in a Harness process — including `/` itself —
 * answers 401 without the signed cookie that `dsh web` puts in the URL it prints,
 * so these two routes were the one place in the process where a plain `curl` on
 * the network got data back. This is the guard that closes that, and it is
 * deliberately a *containment* check rather than authentication: verifying the
 * host cookie needs a secret this plugin has no supported way to reach.
 *
 * The rules, in order:
 *  1. an `Origin` that names a different authority than the `Host` is a
 *     cross-origin read — refused;
 *  2. a browser that says `Sec-Fetch-Site` is `cross-site` or `same-site` — refused;
 *  3. no fetch metadata at all means a non-browser client. Those are trusted only
 *     from a loopback authority, which is where the desktop app lives;
 *  4. a `same-origin` page is the GUI itself. It got past the host's 401 (or the
 *     operator turned that off on purpose), so it is allowed to read its own
 *     plugin's state — LAN-hosted GUIs keep working this way.
 *
 * Known limit, stated rather than hidden: `Sec-Fetch-Site` is a browser hint and a
 * determined local attacker can forge it. This guard exists so that exposing the
 * port by accident no longer also exposes session titles and activity, not to
 * replace the host's authentication.
 */
export function foreignRequestRefusal(request: Request): Response | undefined {
  const headers = request.headers;
  const host = headers.get('host');
  const origin = headers.get('origin');
  if (host !== null && origin !== null && origin !== 'null') {
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      // Opaque or malformed origin: treat it as foreign rather than guess.
      return refusal();
    }
    if (originHost.toLowerCase() !== host.toLowerCase()) return refusal();
  }
  const site = headers.get('sec-fetch-site');
  if (site !== null) {
    if (site === 'same-origin' || site === 'none') return undefined;
    return refusal();
  }
  return isLoopbackAuthority(host) ? undefined : refusal();
}

function refusal(): Response {
  return new Response(REFUSAL_TEXT, { status: 403, headers: REFUSAL_HEADERS });
}

/**
 * Frames we are willing to buffer for one connection before dropping.
 *
 * A `ReadableStream` has no useful bound of its own: a peer that keeps the socket
 * open but stops reading — a frozen background tab, a proxy that will not
 * forward, a debugger left paused — would otherwise let every snapshot pile up in
 * the queue forever. Dropping is safe because a Client always renders the newest
 * version it receives and versions only increase.
 */
const CLIENT_QUEUE_FRAMES = 4;

/**
 * Heartbeats a connection may fail to accept before it is treated as gone.
 *
 * `request.signal` abort and `cancel()` cover an orderly disconnect. This covers
 * the half-open connection neither of them reports, which used to stay in
 * `clients` forever and made `clients()` a lie.
 */
const CLIENT_STALL_LIMIT = 3;

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  'connection': 'keep-alive',
  // Belt and braces for any proxying layer that would otherwise buffer.
  'x-accel-buffering': 'no',
};

export function registerOrbitRoutes(hub: OrbitHub, webServer: WebServerLike): RouteHandle {
  const encoder = new TextEncoder();
  const clients = new Set<Client>();
  let disposed = false;

  const encodeFrame = (frame: OrbitFrame): string => `data: ${JSON.stringify(frame)}\n\n`;

  /**
   * Write the newest snapshot, but never twice: notifications are coalesced on a
   * microtask, so a queued one can arrive after the client already holds that
   * version. Keeping the stream strictly increasing saves frames and makes the
   * Client's own version check an extra safety net rather than the only one.
   */
  const pushSnapshot = (client: Client): void => {
    const snapshot = hub.snapshot(client.sessionId);
    if (snapshot.version <= client.lastVersion) return;
    /*
     * Advance the watermark only on a real write. Advancing it after a dropped
     * frame would leave that client one version behind with nothing scheduled to
     * retry it; leaving it puts the next change back on the queue instead.
     */
    if (!client.send(encodeFrame({ type: 'snapshot', snapshot }), snapshot.version)) return;
    client.lastVersion = snapshot.version;
    client.stalled = 0;
  };

  const unsubscribe = hub.subscribe(() => {
    if (disposed) return;
    for (const client of clients) pushSnapshot(client);
  });

  const heartbeat = setInterval(() => {
    if (disposed) return;
    const text = encodeFrame({ type: 'heartbeat', at: Date.now() });
    for (const client of clients) {
      if (client.send(text)) {
        client.stalled = 0;
        continue;
      }
      client.stalled += 1;
      if (client.stalled < CLIENT_STALL_LIMIT) continue;
      // Nobody has drained this stream for a full stall window: drop it rather
      // than keep a queue, a hub snapshot and a set entry alive for a peer that
      // is not there.
      clients.delete(client);
      client.end();
    }
  }, HEARTBEAT_MS);
  // A timer must not keep the Host process alive on its own.
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  const disposeState = webServer.register({
    kind: 'exact',
    path: STATE_ROUTE,
    resource: async (request: Request): Promise<Response> => {
      const foreign = foreignRequestRefusal(request);
      if (foreign !== undefined) return foreign;
      const url = new URL(request.url);
      const snapshot = hub.snapshot(url.searchParams.get('sessionId'));
      return new Response(JSON.stringify(snapshot), { headers: JSON_HEADERS });
    },
  });

  const disposeEvents = webServer.register({
    kind: 'exact',
    path: EVENTS_ROUTE,
    resource: async (request: Request): Promise<Response> => {
      const foreign = foreignRequestRefusal(request);
      if (foreign !== undefined) return foreign;
      const url = new URL(request.url);
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      let client: Client | undefined;
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
      /**
       * The newest frame we could not queue, because the peer had stopped reading.
       *
       * Exactly one slot, and a newer frame overwrites it. Dropping the *newest*
       * frame while keeping older ones in the queue would hand a slow-but-alive
       * peer minutes-old state the moment it caught up — the queue has to lose
       * frames, but it must lose the stale ones.
       */
      let pendingFrame: { text: string; version?: number } | null = null;

      const write = (text: string): boolean => {
        if (streamController === null) return false;
        try {
          // `desiredSize` is null only for a stream that cannot report it;
          // otherwise <= 0 means the queue is full and the peer is behind.
          if (streamController.desiredSize !== null && streamController.desiredSize <= 0) return false;
          streamController.enqueue(encoder.encode(text));
          return true;
        } catch {
          // The peer went away between the write and the flush.
          return false;
        }
      };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          const opening = hub.snapshot(sessionId);
          client = {
            sessionId,
            lastVersion: opening.version,
            stalled: 0,
            send(text: string, version?: number): boolean {
              if (write(text)) return true;
              pendingFrame = { text, ...(version === undefined ? {} : { version }) };
              return false;
            },
            end() {
              try {
                controller.close();
              } catch {
                // Already closed.
              }
            },
          };
          clients.add(client);
          // One write: the reconnect hint plus the opening snapshot, so a client
          // never observes a stream that is open but still empty.
          controller.enqueue(encoder.encode('retry: 3000\n\n'.concat(
            encodeFrame({ type: 'snapshot', snapshot: opening }),
          )));
        },
        async pull(): Promise<void> {
          const next = pendingFrame;
          if (next === null) return;
          pendingFrame = null;
          if (!write(next.text)) {
            pendingFrame = next;
            return;
          }
          if (client !== undefined) {
            if (next.version !== undefined) client.lastVersion = next.version;
            client.stalled = 0;
          }
        },
        cancel() {
          if (client !== undefined) clients.delete(client);
        },
      }, { highWaterMark: CLIENT_QUEUE_FRAMES });

      const detach = (): void => {
        if (client === undefined) return;
        clients.delete(client);
        client.end();
      };
      request.signal.addEventListener('abort', detach, { once: true });

      return new Response(stream, { headers: SSE_HEADERS });
    },
  });

  return {
    clients: () => clients.size,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearInterval(heartbeat);
      unsubscribe();
      for (const client of clients) client.end();
      clients.clear();
      disposeState();
      disposeEvents();
    },
  };
}
