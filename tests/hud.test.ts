/**
 * The always-on card's rule set, tested as pure functions: copy for all eleven
 * states, the silence wording, the "no raw arguments" guarantee of the detail
 * line, the progress weights and the auto-expand / manual-collapse policy.
 *
 * No jsdom, no React: `hud/progress.ts` owns every decision the card makes.
 */
import { describe, expect, it } from 'vitest';
import {
  HUD_STATE_TITLE,
  formatSilence,
  hudCardMode,
  hudDodgeOffset,
  hudDetail,
  hudProgress,
  hudTitle,
  hudTone,
  isActiveState,
  isSettledState,
  type HudTone,
} from '../src/client/hud/progress';
import type { OrbitActivity, OrbitAgentState, OrbitSnapshot } from '../src/shared/protocol';

const STATES: OrbitAgentState[] = [
  'idle',
  'starting',
  'thinking',
  'preparing',
  'executing',
  'responding',
  'waiting',
  'quiet',
  'completed',
  'interrupted',
  'error',
];

function activity(overrides: Partial<OrbitActivity> = {}): OrbitActivity {
  return {
    id: 'a1',
    sessionId: 's1',
    turn: 1,
    step: 2,
    type: 'tool',
    category: 'file-read',
    label: 'read-file',
    status: 'running',
    startedAt: 1000,
    ...overrides,
  };
}

function snapshot(overrides: Partial<OrbitSnapshot> = {}): OrbitSnapshot {
  return {
    version: 2,
    sessionId: 's1',
    agentState: 'idle',
    activeTools: 0,
    silenceMs: 0,
    quietLevel: 0,
    events: [],
    updatedAt: 1,
    metrics: { turns: 1, steps: 3, tools: 2, files: 1, approvals: 0, retries: 0, startedAt: 0 },
    ...overrides,
  };
}

describe('hudTitle — 11 states', () => {
  it('has a non-empty Chinese subject for every state', () => {
    for (const state of STATES) {
      const title = hudTitle(snapshot({ agentState: state }), 'open');
      expect(title.trim().length, state).toBeGreaterThan(0);
      expect(title, state).toBe(HUD_STATE_TITLE[state]);
    }
  });

  it('keeps the eleven subjects mutually distinct', () => {
    const titles = STATES.map((state) => hudTitle(snapshot({ agentState: state }), 'open'));
    expect(new Set(titles).size).toBe(STATES.length);
    expect(new Set(Object.values(HUD_STATE_TITLE)).size).toBe(STATES.length);
  });

  it('names the drop in the connection instead of lying about the state', () => {
    const live = hudTitle(snapshot({ agentState: 'executing' }), 'open');
    expect(hudTitle(snapshot({ agentState: 'executing' }), 'reconnecting')).toContain(live);
    expect(hudTitle(snapshot({ agentState: 'executing' }), 'reconnecting')).not.toBe(live);
    expect(hudTitle(snapshot({ agentState: 'executing' }), 'closed')).toContain(live);
    expect(hudTitle(snapshot({ agentState: 'executing' }), 'closed')).not.toBe(live);
  });
});

describe('hudDetail', () => {
  it('puts the silence duration on the quiet line', () => {
    const detail = hudDetail(snapshot({ agentState: 'quiet', silenceMs: 23_000, quietLevel: 1 }));
    expect(detail).toBe('已静默 23 秒');
    expect(detail).toContain('23');
    expect(detail).toContain('秒');
  });

  it('switches to minutes once the silence passes a minute', () => {
    expect(hudDetail(snapshot({ agentState: 'quiet', silenceMs: 60_000, quietLevel: 3 }))).toBe('已静默 1 分');
    expect(hudDetail(snapshot({ agentState: 'quiet', silenceMs: 72_000, quietLevel: 3 }))).toBe('已静默 1 分 12 秒');
  });

  it('builds the executing line from label + safeTarget only', () => {
    const leaking = {
      ...activity({ label: '编辑文件', safeTarget: 'report.md', category: 'file-write', fileKind: 'edit' }),
      // Host-forbidden fields, present anyway: they must never reach the card.
      rawArguments: '{"path":"/Users/someone/secret.ts","command":"rm -rf /"}',
      rawCommand: 'rm -rf /',
      fileContent: 'BEGIN PRIVATE KEY',
    } as unknown as OrbitActivity;
    const detail = hudDetail(snapshot({ agentState: 'executing', activeTools: 1, events: [leaking] }));
    expect(detail).toBe('编辑文件 · report.md');
    expect(detail).not.toContain('rm -rf');
    expect(detail).not.toContain('/Users');
    expect(detail).not.toContain('PRIVATE KEY');
    expect(detail).not.toContain('{');
  });

  it('stays on the label when there is no safe target', () => {
    const detail = hudDetail(snapshot({ agentState: 'executing', activeTools: 1, events: [activity({ label: 'run-shell' })] }));
    expect(detail).toBe('run-shell');
  });

  it('falls back to a count when no activity row has arrived yet', () => {
    const detail = hudDetail(snapshot({ agentState: 'executing', activeTools: 3, events: [] }));
    expect(detail).toContain('3');
    expect(detail).not.toContain('undefined');
  });

  it('never returns an empty or undefined-laced line for any state', () => {
    for (const state of STATES) {
      const detail = hudDetail(snapshot({ agentState: state, events: [] }));
      expect(detail.trim().length, state).toBeGreaterThan(0);
      expect(detail, state).not.toContain('undefined');
      expect(detail, state).not.toContain('null');
    }
  });

  it('shows the turn/step counters while it works', () => {
    expect(hudDetail(snapshot({ agentState: 'thinking', turn: 2, step: 5 }))).toContain('第 2 轮');
    expect(hudDetail(snapshot({ agentState: 'thinking', turn: 2, step: 5 }))).toContain('第 5 步');
  });
});

describe('formatSilence', () => {
  it('formats seconds, minutes and bad input', () => {
    expect(formatSilence(0)).toBe('已静默 0 秒');
    expect(formatSilence(5_000)).toBe('已静默 5 秒');
    expect(formatSilence(60_000)).toBe('已静默 1 分');
    expect(formatSilence(125_000)).toBe('已静默 2 分 5 秒');
    expect(formatSilence(-1_000)).toBe('已静默 0 秒');
    expect(formatSilence(Number.NaN)).toBe('已静默 0 秒');
  });
});

describe('hudProgress', () => {
  it('pins the boundaries', () => {
    expect(hudProgress(snapshot({ agentState: 'idle' }))).toBe(0);
    expect(hudProgress(snapshot({ agentState: 'completed' }))).toBe(1);
    expect(hudProgress(snapshot({ agentState: 'error' }))).toBe(1);
    expect(hudProgress(snapshot({ agentState: 'interrupted' }))).toBe(1);
  });

  it('keeps the working states inside 0.3–0.85', () => {
    for (const state of ['executing', 'waiting', 'responding'] as OrbitAgentState[]) {
      const value = hudProgress(snapshot({ agentState: state, activeTools: 2 }));
      expect(value, state).toBeGreaterThanOrEqual(0.3);
      expect(value, state).toBeLessThanOrEqual(0.85);
    }
  });

  it('is monotonic in real work, never in elapsed time', () => {
    const chain = [
      hudProgress(snapshot({ agentState: 'idle' })),
      hudProgress(snapshot({ agentState: 'starting' })),
      hudProgress(snapshot({ agentState: 'thinking' })),
      hudProgress(snapshot({ agentState: 'preparing' })),
      hudProgress(snapshot({ agentState: 'executing', activeTools: 1 })),
      hudProgress(snapshot({ agentState: 'executing', activeTools: 3 })),
      hudProgress(snapshot({ agentState: 'responding' })),
      hudProgress(snapshot({ agentState: 'waiting' })),
      hudProgress(snapshot({ agentState: 'completed' })),
    ];
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i], `step ${i}`).toBeGreaterThanOrEqual(chain[i - 1] as number);
    }
    // More tools in flight cannot lower the bar; it saturates instead.
    expect(hudProgress(snapshot({ agentState: 'executing', activeTools: 12 }))).toBeLessThanOrEqual(0.85);
  });

  it('does not let silence fake progress', () => {
    const levels = ([0, 1, 2, 3] as const).map((quietLevel) =>
      hudProgress(snapshot({ agentState: 'quiet', quietLevel, silenceMs: quietLevel * 30_000 })));
    expect(new Set(levels).size).toBe(1);
    expect(levels[0]).toBeLessThan(0.3);
  });
});

describe('hudTone', () => {
  it('covers the four moods and maps the important states', () => {
    expect(hudTone('idle')).toBe('calm');
    expect(hudTone('quiet')).toBe('calm');
    expect(hudTone('executing')).toBe('busy');
    expect(hudTone('thinking')).toBe('busy');
    expect(hudTone('waiting')).toBe('alert');
    expect(hudTone('error')).toBe('alert');
    expect(hudTone('completed')).toBe('done');
    const allowed: HudTone[] = ['calm', 'busy', 'alert', 'done'];
    for (const state of STATES) expect(allowed).toContain(hudTone(state));
  });

  it('classifies active and settled states', () => {
    expect(isActiveState('idle')).toBe(false);
    expect(isActiveState('quiet')).toBe(false);
    expect(isActiveState('executing')).toBe(true);
    expect(isSettledState('completed')).toBe(true);
    expect(isSettledState('error')).toBe(true);
    expect(isSettledState('thinking')).toBe(false);
  });
});

describe('hudCardMode — auto expand / manual collapse', () => {
  it('renders nothing in orb mode', () => {
    for (const state of STATES) {
      expect(hudCardMode('orb', state, false)).toBe('hidden');
      expect(hudCardMode('orb', state, true)).toBe('hidden');
    }
  });

  it('is always the single line in compact mode', () => {
    for (const state of STATES) {
      expect(hudCardMode('compact', state, false)).toBe('compact');
      expect(hudCardMode('compact', state, true)).toBe('compact');
    }
  });

  it('unfolds by itself while the Agent is active', () => {
    expect(hudCardMode('auto', 'executing', false)).toBe('expanded');
    expect(hudCardMode('auto', 'thinking', false)).toBe('expanded');
    expect(hudCardMode('auto', 'waiting', false)).toBe('expanded');
  });

  it('folds while the Agent is idle or quiet', () => {
    expect(hudCardMode('auto', 'idle', false)).toBe('compact');
    expect(hudCardMode('auto', 'quiet', false)).toBe('compact');
  });

  it('never re-expands on its own after the user folded it', () => {
    for (const state of STATES) {
      expect(hudCardMode('auto', state, true), state).toBe('compact');
    }
  });

  it('stays folded across a whole burst of new events', () => {
    // A live turn would otherwise unfold the card: folded wins every time.
    const burst: OrbitAgentState[] = ['starting', 'thinking', 'preparing', 'executing', 'responding', 'executing', 'waiting', 'error', 'completed'];
    for (const state of burst) {
      expect(hudCardMode('auto', state, true)).toBe('compact');
    }
    // Only clearing the flag (a user click) brings the card back.
    expect(hudCardMode('auto', 'executing', false)).toBe('expanded');
  });
});

describe('hud corner reservation', () => {
  it('keeps the card at its home corner by default', () => {
    // The shipped launcher position: right 24, bottom 24.
    expect(hudDodgeOffset({ right: 24, bottom: 24 }, false)).toBe(104);
    expect(hudDodgeOffset({ right: 24, bottom: 24 }, true)).toBe(104);
  });

  it('steps above the orb once the orb is dragged into the card', () => {
    const offset = hudDodgeOffset({ right: 120, bottom: 160 }, false);
    expect(offset).toBeGreaterThan(104);
    // Just above the orb's top edge plus a gap.
    expect(offset).toBe(160 + 76 + 12);
  });

  it('ignores a launcher parked on the far left', () => {
    expect(hudDodgeOffset({ right: 900, bottom: 200 }, false)).toBe(104);
  });

  it('is deterministic for the same input', () => {
    const a = hudDodgeOffset({ right: 40, bottom: 60 }, false);
    const b = hudDodgeOffset({ right: 40, bottom: 60 }, false);
    expect(a).toBe(b);
  });
});
