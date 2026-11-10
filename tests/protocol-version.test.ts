/**
 * The wire-protocol handshake that is not a handshake.
 *
 * Host and Client ship in one tarball, so they agree at install time — and then the
 * page keeps the `client.js` it loaded in memory while the Host process restarts on
 * a newer version. That is the upgrade path every single user takes, and it is the
 * only way the two halves can be loaded at different versions.
 *
 * The rule this file pins: a mismatch is **not** an exception, not an empty screen
 * and not stale data. The snapshot is dropped, one flag is raised, and the shell
 * says "刷新页面" — the only sentence the user can act on.
 */
import { describe, expect, it } from 'vitest';
import {
  EVENTS_ROUTE,
  ORBIT_PROTOCOL_VERSION,
  STATE_ROUTE,
  isProtocolCompatible,
  type OrbitSnapshot,
} from '../src/shared/protocol';
import { OrbitHub } from '../src/host/hub';
import { registerOrbitRoutes, type WebServerLike } from '../src/host/routes';
import { useOrbitStore } from '../src/client/store';

const T0 = 1_700_000_000_000;

const snapshotWith = (protocol: number | undefined): OrbitSnapshot => {
  const hub = new OrbitHub({ now: () => T0 });
  const snapshot = hub.snapshot(null);
  hub.dispose();
  const { protocol: _omitted, ...rest } = snapshot;
  return (protocol === undefined ? rest : { ...rest, protocol }) as OrbitSnapshot;
};

describe('isProtocolCompatible', () => {
  it('accepts the version this bundle was built for', () => {
    expect(isProtocolCompatible({ protocol: ORBIT_PROTOCOL_VERSION })).toBe(true);
  });

  it('rejects any other version, in either direction', () => {
    expect(isProtocolCompatible({ protocol: ORBIT_PROTOCOL_VERSION + 1 })).toBe(false);
    expect(isProtocolCompatible({ protocol: ORBIT_PROTOCOL_VERSION - 1 })).toBe(false);
  });

  it('rejects a Host too old to send the field at all', () => {
    expect(isProtocolCompatible({})).toBe(false);
  });

  it('has nothing to reject when there is no snapshot', () => {
    expect(isProtocolCompatible(null)).toBe(true);
    expect(isProtocolCompatible(undefined)).toBe(true);
  });
});

describe('the Host stamps every snapshot', () => {
  it('carries the protocol on an empty Hub, before any event arrives', () => {
    const hub = new OrbitHub({ now: () => T0 });
    expect(hub.snapshot(null).protocol).toBe(ORBIT_PROTOCOL_VERSION);
    hub.dispose();
  });

  it('carries it on a populated Session too', () => {
    const hub = new OrbitHub({ now: () => T0 });
    hub.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } });
    expect(hub.snapshot('s1').protocol).toBe(ORBIT_PROTOCOL_VERSION);
    hub.dispose();
  });

  it('ships it over the real route, so a browser can check it', async () => {
    const hub = new OrbitHub({ now: () => T0 });
    const registered: Array<(request: Request) => Promise<Response>> = [];
    const webServer: WebServerLike = {
      register(route) {
        registered.push(route.resource);
        return () => {};
      },
    };
    const local = registerOrbitRoutes(hub, webServer);
    try {
      expect(registered).toHaveLength(2);
      // The carrier hands a resource a placeholder origin and the real authority in
      // `Host`; a request without it looks like a bare client and is refused.
      const response = await registered[0]?.(
        new Request(`http://x${STATE_ROUTE}`, {
          headers: { host: '127.0.0.1:4123', 'sec-fetch-site': 'same-origin' },
        }),
      );
      expect(response?.status).toBe(200);
      const body = (await response?.json()) as { protocol?: number };
      expect(body.protocol).toBe(ORBIT_PROTOCOL_VERSION);
      // The two routes are state then events; this test only walks the first.
      expect(EVENTS_ROUTE).not.toBe(STATE_ROUTE);
    } finally {
      local.dispose();
      hub.dispose();
    }
  });
});

describe('the Client drops a snapshot it cannot read', () => {
  it('refuses data from a Host with another protocol and raises the flag', () => {
    useOrbitStore.setState({ snapshot: null, stale: false });
    useOrbitStore.getState().setSnapshot(snapshotWith(ORBIT_PROTOCOL_VERSION + 1));
    expect(useOrbitStore.getState().stale).toBe(true);
    // Nothing from that Host is kept: a half-understood panel is worse than none.
    expect(useOrbitStore.getState().snapshot).toBeNull();
  });

  it('refuses data from a Host old enough to omit the field', () => {
    useOrbitStore.setState({ snapshot: null, stale: false });
    useOrbitStore.getState().setSnapshot(snapshotWith(undefined));
    expect(useOrbitStore.getState().stale).toBe(true);
    expect(useOrbitStore.getState().snapshot).toBeNull();
  });

  it('clears the flag as soon as a compatible snapshot arrives', () => {
    useOrbitStore.setState({ snapshot: null, stale: false });
    useOrbitStore.getState().setSnapshot(snapshotWith(ORBIT_PROTOCOL_VERSION + 1));
    expect(useOrbitStore.getState().stale).toBe(true);

    const good = snapshotWith(ORBIT_PROTOCOL_VERSION);
    useOrbitStore.getState().setSnapshot(good);
    expect(useOrbitStore.getState().stale).toBe(false);
    expect(useOrbitStore.getState().snapshot).not.toBeNull();
  });

  it('clears the flag even when the compatible frame is a duplicate', () => {
    // The duplicate guard returns early; it must not swallow the recovery.
    const good = snapshotWith(ORBIT_PROTOCOL_VERSION);
    useOrbitStore.setState({ snapshot: good, stale: true });
    useOrbitStore.getState().setSnapshot({ ...good });
    expect(useOrbitStore.getState().stale).toBe(false);
  });
});
