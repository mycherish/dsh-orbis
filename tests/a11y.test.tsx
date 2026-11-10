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
import type { OrbitSnapshot } from '../src/shared/protocol';

const SNAPSHOT = {
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

class SilentEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {}
}

beforeEach(() => {
  vi.stubGlobal('EventSource', SilentEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  );
  useOrbitStore.setState({
    snapshot: SNAPSHOT,
    connection: 'open',
    settings: { ...DEFAULT_SETTINGS, displayMode: 'auto', showHud: true, showWorkspace: true },
    open: false,
    visible: true,
    hudCollapsed: false,
    hudPinned: true,
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
