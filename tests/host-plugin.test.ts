import { describe, expect, it } from 'vitest';
import { apply, describe as describePlugin } from '../src/host/index';

const T0 = 1_700_000_000_000;

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

interface FakeRoute {
  kind: string;
  path: string;
  disposed: boolean;
  resource: (request: Request) => Promise<Response>;
}

/**
 * Minimal Host context: records listeners, effects and route registrations.
 *
 * `title` stands in for the Harness `sessionTitle` fold service; `titleThrows`
 * covers a service that misbehaves while being read.
 */
function fakeHost(options: { webServer?: boolean; title?: string; titleThrows?: boolean } = {}) {
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
      if (name === 'sessionTitle') {
        if (options.title === undefined && options.titleThrows !== true) return undefined;
        return {
          get() {
            if (options.titleThrows === true) throw new Error('session-title fold exploded');
            return { title: options.title, messageSeqs: [], source: { kind: 'fallback' } };
          },
        };
      }
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
        'agent/assistant-stream',
        'agent/disposed',
        'agent/error',
        'agent/status',
        'agent/turn-stopping',
        'approval/request',
        'session/event',
        'user-questions/request',
      ]);
      expect(host.routes.map((route) => route.path).sort()).toEqual([
        '/api/orbis/events',
        '/api/orbis/state',
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
      onEvent(
        { id: 's1' },
        {
          type: 'tool/call',
          time: T0,
          data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: '{"file_path":"/Users/x/y.ts"}' },
        },
      );

      const stateRoute = host.routes.find((route) => route.path === '/api/orbis/state');
      expect(stateRoute).toBeDefined();
      const read = async (): Promise<Record<string, unknown>> => {
        const response = await stateRoute?.resource(pageRequest('/api/orbis/state?sessionId=s1'));
        return (await response?.json()) as Record<string, unknown>;
      };

      let body = await read();
      expect(body.agentState).toBe('executing');
      expect(body.activeTools).toBe(1);
      const rows = body.events as Array<Record<string, unknown>>;
      expect(rows[0]?.fileKind).toBe('edit');
      expect(rows[0]?.safeTarget).toBe('y.ts');
      // The Host never forwards the directory or the user name.
      expect(JSON.stringify(body)).not.toContain('/Users');

      onEvent(
        { id: 's1' },
        {
          type: 'tool/result',
          time: T0 + 40,
          data: { turn: 1, step: 1, message: { toolCallId: 'c1' } },
        },
      );
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
      expect((body.events as Array<Record<string, unknown>>)[0]?.label).toBe('QUOTA');
    } finally {
      host.restoreConsole();
    }
  });

  it('backfills a Session title the reloaded Host never saw as an event', async () => {
    const host = fakeHost({ title: '修复重复悬浮球' });
    try {
      apply(host.ctx as never);
      const onEvent = host.listeners.get('session/event') as (session: unknown, event: unknown) => void;
      // Only a mid-Session event survives a reload: `session/title` already fired.
      onEvent(
        { id: 's1' },
        {
          type: 'tool/call',
          time: T0,
          data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
        },
      );
      const stateRoute = host.routes.find((route) => route.path === '/api/orbis/state');
      const body = (await (
        await stateRoute?.resource(pageRequest('/api/orbis/state?sessionId=s1'))
      )?.json()) as Record<string, unknown>;
      expect((body.task as Record<string, unknown>).taskTitle).toBe('修复重复悬浮球');
    } finally {
      host.restoreConsole();
    }
  });

  it('lets a live session/title event override the backfilled title', async () => {
    const host = fakeHost({ title: '旧标题' });
    try {
      apply(host.ctx as never);
      const onEvent = host.listeners.get('session/event') as (session: unknown, event: unknown) => void;
      onEvent(
        { id: 's1' },
        {
          type: 'tool/call',
          time: T0,
          data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
        },
      );
      onEvent(
        { id: 's1' },
        {
          type: 'session/title',
          time: T0 + 1,
          data: { title: '新标题', messageSeqs: [1], source: { kind: 'user' } },
        },
      );
      const stateRoute = host.routes.find((route) => route.path === '/api/orbis/state');
      const body = (await (
        await stateRoute?.resource(pageRequest('/api/orbis/state?sessionId=s1'))
      )?.json()) as Record<string, unknown>;
      expect((body.task as Record<string, unknown>).taskTitle).toBe('新标题');
    } finally {
      host.restoreConsole();
    }
  });

  it('survives a sessionTitle service that throws', () => {
    const host = fakeHost({ titleThrows: true });
    try {
      apply(host.ctx as never);
      const onEvent = host.listeners.get('session/event') as (session: unknown, event: unknown) => void;
      expect(() =>
        onEvent(
          { id: 's1' },
          {
            type: 'tool/call',
            time: T0,
            data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
          },
        ),
      ).not.toThrow();
    } finally {
      host.restoreConsole();
    }
  });

  /*
   * The question waterfall is the one signal the plugin used to miss entirely, so
   * the HUD kept reporting "executing" while the Agent sat waiting for an answer.
   */
  it('observes a question waterfall, reports waiting, then releases it', async () => {
    const host = fakeHost();
    try {
      apply(host.ctx as never);
      const onEvent = host.listeners.get('session/event') as (session: unknown, event: unknown) => void;
      const onStatus = host.listeners.get('agent/status') as (payload: unknown) => void;
      const onQuestion = host.listeners.get('user-questions/request') as (
        request: unknown,
        next: () => Promise<unknown>,
      ) => Promise<unknown>;

      const stateRoute = host.routes.find((route) => route.path === '/api/orbis/state');
      expect(stateRoute).toBeDefined();
      const read = async (): Promise<Record<string, unknown>> =>
        (await (await stateRoute!.resource(pageRequest('/api/orbis/state?sessionId=s1'))).json()) as Record<
          string,
          unknown
        >;

      onStatus({ agent: { id: 's1' }, status: 'running' });
      onEvent(
        { id: 's1' },
        {
          type: 'tool/call',
          time: T0,
          data: { turn: 1, step: 1, callId: 'c1', name: 'ask_user_question', arguments: '{}' },
        },
      );

      let delegated = false;
      const pending = onQuestion(
        {
          agent: { id: 's1' },
          callId: 'c1',
          toolName: 'ask_user_question',
          questions: [{ question: 'SECRET-QUESTION-TEXT' }],
        },
        async () => {
          delegated = true;
          return { answers: ['ok'] };
        },
      );
      // The waterfall contract: we observe, we never decide.
      expect(delegated).toBe(true);

      let body = await read();
      expect(body.agentState).toBe('waiting');
      const task = body.task as Record<string, unknown>;
      expect(task.waitingReason).toBe('question');
      expect(task.phaseLabel).toBe('等待回答');
      // The question text is content and never reaches the browser.
      expect(JSON.stringify(body)).not.toContain('SECRET-QUESTION-TEXT');

      await pending;
      await Promise.resolve();
      body = await read();
      expect(body.agentState).not.toBe('waiting');
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
    expect(info.name).toBe('orbis');
    expect(info.persistence).toBe('none');
  });
});
