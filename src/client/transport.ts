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
    const sessionId = options.sessionId();
    try {
      const response = await fetch(endpoint(STATE_ROUTE, sessionId), {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) {
        options.onConnection('reconnecting');
        return;
      }
      const snapshot = (await response.json()) as OrbitSnapshot;
      if (stopped) return;
      sawFrame = true;
      options.onSnapshot(snapshot);
      options.onConnection('open');
    } catch {
      options.onConnection('reconnecting');
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
