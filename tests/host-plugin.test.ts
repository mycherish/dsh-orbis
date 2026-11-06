import { describe, expect, it } from 'vitest';
import { apply, describe as describePlugin } from '../src/host/index';

const T0 = 1_700_000_000_000;

interface FakeRoute {
  kind: string;
  path: string;
  disposed: boolean;
  resource: (request: Request) => Promise<Response>;
}

/** Minimal Host context: records listeners, effects and route registrations. */
function fakeHost(options: { webServer?: boolean } = {}) {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const disposers: Array<() => void> = [];
  const routes: FakeRoute[] = [];
  const warnings: string[] = [];
  const origin = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  const webServer = {
    register(route: { kind: string; path: string; resource: (request: Request) => Promise<Response> }) {
      const entry: FakeRoute = {
        kind: route.kind,
        path: route.path,
        resource: route.resource,
        disposed: false,
      };
      routes.push(entry);
      return () => {
        entry.disposed = true;
      };
    },
  };

  const ctx = {
    on(name: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(name, listener);
      return () => {
        listeners.delete(name);
      };
    },
    effect(callback: () => (() => void) | void) {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {
        dispose?.();
      };
    },
    get(name: string) {
      if (name === 'webServer') return options.webServer === false ? undefined : webServer;
      return undefined;
    },
  };

  return {
    ctx,
    listeners,
    routes,
    warnings,
    restoreConsole: () => {
      console.warn = origin;
    },
    disposeAll: () => {
      for (const dispose of disposers.reverse()) dispose();
    },
  };
}

describe('host plugin wiring', () => {
  it('subscribes to the documented events and registers both routes', () => {
    const host = fakeHost();
    try {
      apply(host.ctx as never);
      expect([...host.listeners.keys()].sort()).toEqual([
        'agent/error',
        'agent/status',
        'agent/turn-stopping',
        'approval/request',
        'session/event',
      ]);
      expect(host.routes.map((route) => route.path).sort()).toEqual([
        '/api/neural-orbit/events',
        '/api/neural-orbit/state',
      ]);
      expect(host.warnings).toEqual([]);
    } finally {
      host.restoreConsole();
    }
  });

  it('keeps working without a web carrier', () => {
    const host = fakeHost({ webServer: false });
    try {
      apply(host.ctx as never);
      expect(host.routes).toEqual([]);
      expect(host.warnings.some((line) => line.includes('webServer service unavailable'))).toBe(true);
      // Event ingestion still works.
      const onEvent = host.listeners.get('session/event');
      expect(onEvent).toBeDefined();
    } finally {
      host.restoreConsole();
    }
  });

  it('serves end-to-end: DSH events in, snapshot JSON out', async () => {
    const host = fakeHost();
    try {
      apply(host.ctx as never);
      const onEvent = host.listeners.get('session/event') as (session: unknown, event: unknown) => void;
      const onStatus = host.listeners.get('agent/status') as (payload: unknown) => void;
      const onError = host.listeners.get('agent/error') as (payload: unknown) => void;
      const onApproval = host.listeners.get('approval/request') as (
        request: unknown,
        next: () => Promise<unknown>,
      ) => Promise<unknown>;

      onStatus({ agent: { id: 's1' }, status: 'running' });
      onEvent({ id: 's1' }, {
        type: 'tool/call',
        time: T0,
        data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: '{"file_path":"/Users/x/y.ts"}' },
      });

      const stateRoute = host.routes.find((route) => route.path === '/api/neural-orbit/state');
      expect(stateRoute).toBeDefined();
      const read = async (): Promise<Record<string, unknown>> => {
        const response = await stateRoute?.resource(new Request(`http://local/api/neural-orbit/state?sessionId=s1`));
        return (await response?.json()) as Record<string, unknown>;
      };

      let body = await read();
      expect(body.agentState).toBe('executing');
      expect(body.activeTools).toBe(1);
      const rows = body.events as Array<Record<string, unknown>>;
      expect(rows[0]?.fileKind).toBe('edit');
      expect(rows[0]?.target).toBe('y.ts');
      // The Host never forwards the directory or the user name.
      expect(JSON.stringify(body)).not.toContain('/Users');

      onEvent({ id: 's1' }, {
        type: 'tool/result',
        time: T0 + 40,
        data: { turn: 1, step: 1, message: { toolCallId: 'c1' } },
      });
      body = await read();
      expect(body.activeTools).toBe(0);
      expect(body.agentState).toBe('thinking');

      // An approval ask must still reach the answerer (waterfall contract).
      let delegated = false;
      await onApproval({ agent: { id: 's1' }, toolName: 'bash' }, async () => {
        delegated = true;
        return 'allowed-once';
      });
      expect(delegated).toBe(true);
      body = await read();
      expect(body.agentState).toBe('waiting');

      onError({ agent: { id: 's1' }, error: { code: 'QUOTA' } });
      body = await read();
      expect(body.agentState).toBe('error');
      expect((body.events as Array<Record<string, unknown>>)[0]?.name).toBe('QUOTA');
    } finally {
      host.restoreConsole();
    }
  });

  it('never lets a throwing listener escape into the Host', () => {
    const host = fakeHost();
    try {
      apply(host.ctx as never);
      const onEvent = host.listeners.get('session/event') as (session: unknown, event: unknown) => void;
      expect(() => onEvent(null, null)).not.toThrow();
      expect(() => onEvent({ id: 's1' }, { type: 'tool/call', time: T0, data: null })).not.toThrow();
    } finally {
      host.restoreConsole();
    }
  });

  it('releases routes and listeners on unload', () => {
    const host = fakeHost();
    try {
      apply(host.ctx as never);
      expect(host.routes.every((route) => route.disposed)).toBe(false);
      host.disposeAll();
      expect(host.routes.every((route) => route.disposed)).toBe(true);
    } finally {
      host.restoreConsole();
    }
  });

  it('describes itself for diagnostics', () => {
    const info = describePlugin();
    expect(info.name).toBe('neural-orbit');
    expect(info.persistence).toBe('none');
  });
});
