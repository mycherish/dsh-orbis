/**
 * The polling fallback, tested without a DOM.
 *
 * The interesting behaviour is not "a poll delivers a snapshot" — that is one
 * `fetch` and one callback — but what a poll does when the connection has already
 * moved on underneath it. Node has no `EventSource`, so `startTransport` falls
 * back to polling on its own, which is exactly the path a carrier that buffers a
 * streaming body puts a user on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTransport, type Transport } from '../src/client/transport';
import type { OrbitSnapshot } from '../src/shared/protocol';

/** Only the identity matters here; the transport never reads the other fields. */
const snap = (sessionId: string, version: number) => ({ sessionId, version }) as unknown as OrbitSnapshot;

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Pending {
  url: string;
  resolve: (response: Response) => void;
}

describe('polling fallback', () => {
  let transport: Transport | undefined;

  afterEach(() => {
    transport?.stop();
    transport = undefined;
    vi.unstubAllGlobals();
  });

  /** A `fetch` whose responses are resolved by hand, in whatever order we like. */
  function manualFetch(): Pending[] {
    const pending: Pending[] = [];
    vi.stubGlobal(
      'fetch',
      (url: string) =>
        new Promise<Response>((resolve) => {
          pending.push({ url, resolve });
        }),
    );
    return pending;
  }

  it('never applies a response that belonged to a previous Session', async () => {
    let sessionId: string | undefined = 'a';
    const seen: string[] = [];
    const pending = manualFetch();

    transport = startTransport({
      sessionId: () => sessionId,
      onSnapshot: (snapshot) => {
        seen.push(snapshot.sessionId ?? '(none)');
      },
      onConnection: () => {},
    });

    expect(pending).toHaveLength(1);
    expect(pending[0]?.url).toContain('sessionId=a');

    // The user switches Session: the stream is restarted, and a second poll starts.
    sessionId = 'b';
    transport.restart();
    expect(pending).toHaveLength(2);
    expect(pending[1]?.url).toContain('sessionId=b');

    /*
     * The new Session answers first, then the abandoned request for `a` comes
     * back. Checking only `stopped` — which is what this did — let that late
     * response overwrite the store with the Session the user had already left.
     */
    pending[1]?.resolve(ok(snap('b', 2)));
    await flush();
    pending[0]?.resolve(ok(snap('a', 99)));
    await flush();

    expect(seen).toEqual(['b']);
  });

  it('applies nothing after stop, however late the response is', async () => {
    const seen: string[] = [];
    const pending = manualFetch();
    transport = startTransport({
      sessionId: () => 'a',
      onSnapshot: (snapshot) => {
        seen.push(snapshot.sessionId ?? '(none)');
      },
      onConnection: () => {},
    });

    transport.stop();
    pending[0]?.resolve(ok(snap('a', 1)));
    await flush();

    expect(seen).toEqual([]);
  });
});
