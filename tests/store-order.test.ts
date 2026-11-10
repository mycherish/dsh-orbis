/**
 * T1 (2.1.6): the store must not go backwards in time.
 *
 * `setSnapshot` claimed "Ignore out-of-order or duplicate frames" but only compared
 * for *equality*: two frames with different versions were always applied, newest
 * last or not. That is what makes the transport race in `transport.ts` reachable —
 * a poll that started before a newer SSE frame can land after it and win.
 *
 * The guard has to be two-sided, which is the whole subtlety here:
 *
 *  - the same Session, an older `version`, and an `updatedAt` that is not newer →
 *    a stale frame, drop it;
 *  - a Host restart re-creates the record with `version` back at 1 while `updatedAt`
 *    is *newer* wall-clock → that is the only live record and must be accepted.
 *
 * A naive "version must never decrease" rule would pin the panel to the pre-restart
 * snapshot forever, so both directions are pinned below.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useOrbitStore } from '../src/client/store';
import { ORBIT_PROTOCOL_VERSION, type OrbitSnapshot } from '../src/shared/protocol';

const snap = (version: number, updatedAt: number, sessionId = 's1'): OrbitSnapshot =>
  ({ protocol: ORBIT_PROTOCOL_VERSION, sessionId, version, updatedAt }) as unknown as OrbitSnapshot;

const current = (): OrbitSnapshot | null => useOrbitStore.getState().snapshot;

describe('T1: snapshot ordering', () => {
  beforeEach(() => {
    useOrbitStore.setState({ snapshot: null, stale: false });
  });

  it('accepts a newer version of the same Session', () => {
    useOrbitStore.getState().setSnapshot(snap(7, 100));
    expect(current()?.version).toBe(7);
  });

  it('drops an older version that arrives late', () => {
    useOrbitStore.getState().setSnapshot(snap(7, 100));
    useOrbitStore.getState().setSnapshot(snap(5, 90));
    expect(current()?.version, 'a late poll must not overwrite a newer frame').toBe(7);
  });

  it('drops an older version even when its updatedAt moved forward', () => {
    // A clock that stepped forward must not launder a stale version.
    useOrbitStore.getState().setSnapshot(snap(7, 100));
    useOrbitStore.getState().setSnapshot(snap(6, 100));
    expect(current()?.version).toBe(7);
  });

  it('accepts a low version when it is a different Session', () => {
    useOrbitStore.getState().setSnapshot(snap(7, 100, 's1'));
    useOrbitStore.getState().setSnapshot(snap(2, 50, 's2'));
    expect(current()?.sessionId).toBe('s2');
    expect(current()?.version).toBe(2);
  });

  it('accepts a version restart from a newer Host process', () => {
    // Host restart: the record is new, so `version` starts over but `updatedAt` is
    // later than anything the previous process produced.
    useOrbitStore.getState().setSnapshot(snap(9, 100));
    useOrbitStore.getState().setSnapshot(snap(1, 500));
    expect(current()?.version, 'a restarted Host must be able to take over').toBe(1);
  });

  it('still treats an identical frame as a no-op', () => {
    useOrbitStore.getState().setSnapshot(snap(4, 100));
    const first = current();
    useOrbitStore.getState().setSnapshot(snap(4, 100));
    expect(current()).toBe(first);
  });
});
