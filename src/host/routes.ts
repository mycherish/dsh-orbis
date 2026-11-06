/**
 * The read-only HTTP surface (spec §6).
 *
 * Two exact routes on the DSH web carrier:
 *   GET /api/neural-orbit/state  → the current snapshot as JSON
 *   GET /api/neural-orbit/events → the same snapshot, then every change, over SSE
 *
 * Both go through `webServer.register({ resource })`, so they answer with a
 * standard `Request`/`Response` pair, stay same-origin with the GUI, and are
 * unregistered when the plugin unloads.
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
  /** Highest snapshot version already written to this stream. */
  lastVersion: number;
  send(text: string): void;
  end(): void;
}

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

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
    client.lastVersion = snapshot.version;
    client.send(encodeFrame({ type: 'snapshot', snapshot }));
  };

  const unsubscribe = hub.subscribe(() => {
    if (disposed) return;
    for (const client of clients) pushSnapshot(client);
  });

  const heartbeat = setInterval(() => {
    if (disposed) return;
    const text = encodeFrame({ type: 'heartbeat', at: Date.now() });
    for (const client of clients) client.send(text);
  }, HEARTBEAT_MS);
  // A timer must not keep the Host process alive on its own.
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  const disposeState = webServer.register({
    kind: 'exact',
    path: STATE_ROUTE,
    resource: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const snapshot = hub.snapshot(url.searchParams.get('sessionId'));
      return new Response(JSON.stringify(snapshot), { headers: JSON_HEADERS });
    },
  });

  const disposeEvents = webServer.register({
    kind: 'exact',
    path: EVENTS_ROUTE,
    resource: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      let client: Client | undefined;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const opening = hub.snapshot(sessionId);
          client = {
            sessionId,
            lastVersion: opening.version,
            send(text: string) {
              try {
                controller.enqueue(encoder.encode(text));
              } catch {
                // The peer went away between the write and the flush.
              }
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
        cancel() {
          if (client !== undefined) clients.delete(client);
        },
      });

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
