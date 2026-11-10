/**
 * Transport: DSH same-origin SSE with automatic reconnect, plus a polling
 * fallback for any carrier that buffers a streaming body.
 *
 * SSE is primary because the Host pushes a full snapshot on connect and on every
 * change. If no frame arrives within `FIRST_FRAME_TIMEOUT_MS` — which is what a
 * buffering proxy looks like — the same read-only state route is polled until
 * the stream proves itself.
 */
import { EVENTS_ROUTE, STATE_ROUTE, type OrbitFrame, type OrbitSnapshot } from '../shared/protocol';

const FIRST_FRAME_TIMEOUT_MS = 2500;
const POLL_MS = 900;

export interface TransportOptions {
  /** Session to observe; `undefined` lets the Host pick its most recent one. */
  sessionId: () => string | undefined;
  onSnapshot: (snapshot: OrbitSnapshot) => void;
  onConnection: (connection: 'connecting' | 'open' | 'reconnecting' | 'closed') => void;
}

export interface Transport {
  /** Restart the stream, e.g. after the observed Session changed. */
  restart(): void;
  stop(): void;
}

function endpoint(path: string, sessionId: string | undefined): string {
  if (sessionId === undefined || sessionId === '') return path;
  return `${path}?sessionId=${encodeURIComponent(sessionId)}`;
}

export function startTransport(options: TransportOptions): Transport {
  let source: EventSource | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let firstFrameTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let polling = false;
  let sawFrame = false;
  /**
   * Bumped by every `close()`, i.e. by `restart()` and `stop()`.
   *
   * Anything the previous connection had in flight is stale from that moment on,
   * and a poll has to know it before it writes to the store.
   */
  let pollGeneration = 0;
  let inFlight: AbortController | undefined;

  const clearPoll = (): void => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    polling = false;
  };

  const clearFirstFrame = (): void => {
    if (firstFrameTimer !== undefined) {
      clearTimeout(firstFrameTimer);
      firstFrameTimer = undefined;
    }
  };

  const deliver = (frame: OrbitFrame): void => {
    if (stopped) return;
    if (frame.type === 'snapshot') {
      sawFrame = true;
      clearFirstFrame();
      if (polling) clearPoll();
      options.onSnapshot(frame.snapshot);
      options.onConnection('open');
      return;
    }
    options.onConnection('open');
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    /*
     * One poll at a time. Two in flight is how an older response ends up applied
     * after a newer one; skipping a tick instead keeps the ordering trivially true
     * and costs nothing at a 900 ms cadence against a loopback route.
     */
    if (inFlight !== undefined) return;
    /*
     * A poll belongs to the connection generation it started in. `restart()` and
     * `stop()` bump the generation and abort whatever is in flight, but a response
     * that is already on the wire cannot be recalled — without the stamp it lands
     * after the switch and overwrites the *new* Session's snapshot with the old
     * one's, which is the only way the store can go backwards in time.
     */
    const generation = pollGeneration;
    const sessionId = options.sessionId();
    const controller = new AbortController();
    inFlight = controller;
    try {
      const response = await fetch(endpoint(STATE_ROUTE, sessionId), {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (stopped || generation !== pollGeneration) return;
      if (!response.ok) {
        options.onConnection('reconnecting');
        return;
      }
      const snapshot = (await response.json()) as OrbitSnapshot;
      if (stopped || generation !== pollGeneration) return;
      sawFrame = true;
      options.onSnapshot(snapshot);
      options.onConnection('open');
    } catch {
      // An aborted poll is this module's own doing, not a connection failure.
      if (stopped || generation !== pollGeneration) return;
      options.onConnection('reconnecting');
    } finally {
      if (inFlight === controller) inFlight = undefined;
    }
  };

  const startPolling = (): void => {
    if (polling || stopped) return;
    polling = true;
    void poll();
    pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void poll();
    }, POLL_MS);
  };

  const open = (): void => {
    clearFirstFrame();
    if (stopped) return;
    options.onConnection(sawFrame ? 'reconnecting' : 'connecting');
    const sessionId = options.sessionId();
    try {
      source = new EventSource(endpoint(EVENTS_ROUTE, sessionId));
    } catch {
      source = undefined;
      startPolling();
      return;
    }
    source.onopen = () => {
      if (!stopped) options.onConnection('open');
    };
    source.onmessage = (message: MessageEvent<string>) => {
      if (stopped) return;
      try {
        deliver(JSON.parse(message.data) as OrbitFrame);
      } catch {
        // A malformed frame is a Host bug, not a transport failure: ignore it.
      }
    };
    source.onerror = () => {
      if (stopped) return;
      // EventSource reconnects on its own; the fallback covers a silent stall.
      options.onConnection('reconnecting');
      startPolling();
    };
    firstFrameTimer = setTimeout(() => {
      if (!stopped && !sawFrame) startPolling();
    }, FIRST_FRAME_TIMEOUT_MS);
  };

  const close = (): void => {
    clearFirstFrame();
    clearPoll();
    pollGeneration += 1;
    inFlight?.abort();
    inFlight = undefined;
    if (source !== undefined) {
      source.onopen = null;
      source.onmessage = null;
      source.onerror = null;
      try {
        source.close();
      } catch {
        // Already closed.
      }
      source = undefined;
    }
  };

  open();

  return {
    restart(): void {
      if (stopped) return;
      close();
      sawFrame = false;
      options.onConnection('connecting');
      open();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      close();
      options.onConnection('closed');
    },
  };
}
