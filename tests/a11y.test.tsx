// @vitest-environment jsdom
/**
 * Keyboard and screen-reader behaviour of the Workspace panel.
 *
 * These three were reported as "Low" and are the kind that never shows up in a
 * screenshot: an Escape that belongs to somebody else, focus dropped on `<body>`
 * when a dialog closes, and a modality claim the panel never delivered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';

/*
 * React only treats code inside `act()` as synchronous work when this flag is set.
 * Without it React prints "not configured to support act(...)" and flushes on its
 * own schedule, so an assertion made right after a layout-phase ref would be racing
 * React rather than testing it.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_SETTINGS } from '../src/client/contracts';
import { OrbitLayer } from '../src/client/layer';
import { useOrbitStore } from '../src/client/store';
import { ORBIT_PROTOCOL_VERSION, type OrbitSnapshot } from '../src/shared/protocol';

const SNAPSHOT = {
  protocol: ORBIT_PROTOCOL_VERSION,
  version: 1,
  sessionId: 's1',
  agentState: 'idle',
  activeTools: 0,
  silenceMs: 0,
  quietLevel: 0,
  events: [],
  updatedAt: 1,
  metrics: { turns: 0, steps: 0, tools: 0, files: 0, approvals: 0, retries: 0, startedAt: 1 },
  task: null,
} as unknown as OrbitSnapshot;

const { act } = React;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** Counts constructions: one mount must open exactly one stream (B3, 2.1.11). */
let eventSourceCount = 0;

class SilentEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    eventSourceCount += 1;
  }
  close(): void {}
}

beforeEach(() => {
  eventSourceCount = 0;
  vi.stubGlobal('EventSource', SilentEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  );
  useOrbitStore.setState({
    snapshot: SNAPSHOT,
    connection: 'open',
    settings: { ...DEFAULT_SETTINGS, displayMode: 'auto' },
    open: false,
    visible: true,
    hudCollapsed: false,
    hudPinned: true,
    stale: false,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<OrbitLayer />));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
});

const panel = (): HTMLElement | null =>
  container?.querySelector<HTMLElement>('[data-orbis-surface="workspace"]') ?? null;
const isOpen = (): boolean => useOrbitStore.getState().open;
const escapeOn = (target: EventTarget): void => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
};

describe('workspace panel semantics', () => {
  it('is a labelled dialog that does not claim to be modal', () => {
    act(() => useOrbitStore.setState({ open: true }));
    const el = panel();
    expect(el).not.toBeNull();
    expect(el?.getAttribute('role')).toBe('dialog');
    expect(el?.getAttribute('aria-label')).toBeTruthy();
    /*
     * `aria-modal="true"` told assistive technology the rest of the page was
     * inert. It is not: the conversation behind the panel stays live, the Agent
     * keeps working, and focus is free to leave. Claiming modality without a focus
     * trap is worse than not claiming it.
     */
    expect(el?.hasAttribute('aria-modal')).toBe(false);
  });
});

describe('Escape', () => {
  it('ignores an Escape that was not aimed at the panel', () => {
    act(() => useOrbitStore.setState({ open: true }));
    // The key is delivered to the page, not to us: the Host's own Escape shortcut
    // must still run. It used to be swallowed by our capture-phase listener.
    escapeOn(document.body);
    expect(isOpen()).toBe(true);
  });

  it('closes the panel when the key lands inside it', () => {
    act(() => useOrbitStore.setState({ open: true }));
    const el = panel();
    expect(el).not.toBeNull();
    if (el === null) return;
    escapeOn(el);
    expect(isOpen()).toBe(false);
  });
});

describe('focus', () => {
  it('does not leave focus on <body> when the panel closes', () => {
    act(() => useOrbitStore.setState({ open: true }));
    const el = panel();
    expect(document.activeElement).toBe(el);

    act(() => useOrbitStore.setState({ open: false }));

    // Something inside the plugin owns focus again, so a keyboard or screen-reader
    // user is still somewhere real. Before, focus fell to `<body>` and the context
    // was lost with nothing announced.
    const active = document.activeElement as HTMLElement | null;
    expect(active).not.toBe(document.body);
    expect(active?.closest('[data-orbis-surface]')).not.toBeNull();
  });

  it('does not steal focus back if the user has already moved it', () => {
    act(() => useOrbitStore.setState({ open: true }));
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    act(() => useOrbitStore.setState({ open: false }));

    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

/*
 * The protocol-mismatch notice. The store drops a snapshot from a Host that speaks
 * another protocol (see tests/protocol-version.test.ts), so the shell has nothing
 * to draw — but a blank pane reads as "the plugin is broken" and sends the user to
 * the issue tracker instead of the refresh button.
 */
describe('protocol mismatch surface', () => {
  it('replaces every surface with one sentence that names the fix', () => {
    act(() => useOrbitStore.setState({ stale: true }));
    expect(container?.querySelector('[data-orbis-surface="workspace"]')).toBeNull();
    const notice = container?.querySelector<HTMLButtonElement>('[data-orbis-surface="stale"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toBe('版本不匹配，请刷新页面');
    expect(notice?.getAttribute('aria-label')).toBe('版本不匹配，请刷新页面');
    expect(notice?.getAttribute('type')).toBe('button');
  });

  it('stays gone once the Host speaks the same protocol again', () => {
    act(() => useOrbitStore.setState({ stale: true }));
    expect(container?.querySelector('[data-orbis-surface="stale"]')).not.toBeNull();
    act(() => useOrbitStore.getState().setSnapshot(SNAPSHOT));
    expect(container?.querySelector('[data-orbis-surface="stale"]')).toBeNull();
  });
});

/*
 * The dead end (found by the user, 2.1.8): turning 「详细 Workspace」 off hid the
 * only button that opens the panel — and the settings sheet lives *inside* that
 * panel, so there was no way back from the UI at all. Clearing localStorage was the
 * only recovery.
 *
 * The repair is that opening also *is* the repair: the click means "show me the
 * panel", so the switch follows the click instead of refusing it.
 */
describe('showWorkspace off must not strand the user', () => {
  it('still offers an entry, and re-enables the panel when clicked', () => {
    act(() => {
      useOrbitStore.setState({
        open: false,
        settings: {
          ...useOrbitStore.getState().settings,
          enabled: true,
        },
      });
    });

    const entry = container?.querySelector<HTMLButtonElement>('[data-hud-open-workspace]');
    expect(entry, 'the header must keep a way into the panel').not.toBeNull();

    act(() => entry?.click());

    expect(container?.querySelector('[data-orbis-surface="workspace"]')).not.toBeNull();
  });
});

/*
 * B3 (2.1.11): one mount, one stream.
 *
 * `startTransport` opens its own `EventSource`, and the "restart when the Session
 * changes" effect also ran on mount — so every mount closed the fresh connection
 * and opened a second one, with a `connecting → reconnecting → open` flap in
 * between. The restart is now keyed on the Session the live transport was opened
 * for, so it is a no-op until the Session actually changes.
 */
describe('B3: the transport is opened once per mount', () => {
  it('constructs exactly one EventSource on mount', () => {
    expect(eventSourceCount).toBe(1);
  });

  it('stays at one when disabling and re-enabling the master switch', () => {
    act(() => useOrbitStore.getState().patchSettings({ enabled: false }));
    act(() => useOrbitStore.getState().patchSettings({ enabled: true }));
    expect(eventSourceCount).toBe(2);
  });
});
