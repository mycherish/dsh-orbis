import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  activityVisual,
  stateColor,
  statusColor,
  CATEGORIES,
} from '../src/client/workspace/format';
import { ORBIT_PALETTE } from '../src/client/contracts';
import type {
  OrbitActivity,
  OrbitActivityStatus,
  OrbitAgentState,
  OrbitToolCategory,
} from '../src/shared/protocol';

/** The eleven v2 states, listed literally so a protocol change breaks this test. */
const STATES: readonly OrbitAgentState[] = [
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

/** The ten v2 tool families. */
const TOOL_CATEGORIES: readonly OrbitToolCategory[] = [
  'file-read',
  'file-write',
  'shell',
  'search',
  'test',
  'browser',
  'subagent',
  'reasoning',
  'approval',
  'other',
];

/** The five v2 activity statuses. */
const STATUSES: readonly OrbitActivityStatus[] = [
  'running',
  'success',
  'error',
  'waiting',
  'cancelled',
];

/** Minimal well-formed v2 Activity row; every field the DTO requires is set. */
function activity(overrides: Partial<OrbitActivity> = {}): OrbitActivity {
  return {
    id: 'a1',
    sessionId: 's1',
    type: 'tool',
    category: 'shell',
    label: '命令',
    status: 'success',
    startedAt: 1_000,
    ...overrides,
  };
}

describe('activity visual vocabulary', () => {
  it('classifies every v2 tool family without throwing', () => {
    for (const category of TOOL_CATEGORIES) {
      const visual = activityVisual(activity({ category }));
      expect(visual.color).toBeTruthy();
      expect(visual.glyph.trim().length).toBeGreaterThan(0);
      expect(visual.kind).toBeTruthy();
      expect(CATEGORIES.some((entry) => entry.key === visual.key)).toBe(true);
    }
  });

  it('borrows a legend colour that matches each new family semantics', () => {
    // test → generic tool, subagent/approval → edit, reasoning → read.
    expect(activityVisual(activity({ category: 'test' })).key).toBe('tool');
    expect(activityVisual(activity({ category: 'subagent' })).key).toBe('edit');
    expect(activityVisual(activity({ category: 'approval' })).key).toBe('edit');
    expect(activityVisual(activity({ category: 'reasoning' })).key).toBe('read');
  });

  it('gives each tool family its own glyph, so one colour still tells rows apart', () => {
    const glyphs = TOOL_CATEGORIES.map((category) => activityVisual(activity({ category })).glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it('keeps the per-tool kind words distinct for the new families', () => {
    const kinds = TOOL_CATEGORIES.map((category) => activityVisual(activity({ category })).kind);
    for (const kind of kinds) expect(kind).toBeTruthy();
    expect(activityVisual(activity({ category: 'test' })).kind).toBe('运行测试');
    expect(activityVisual(activity({ category: 'subagent' })).kind).toBe('协作代理');
    expect(activityVisual(activity({ category: 'reasoning' })).kind).toBe('整理思路');
    expect(activityVisual(activity({ category: 'approval' })).kind).toBe('等待审批');
  });

  it('still paints an error status red whatever the family is', () => {
    for (const category of TOOL_CATEGORIES) {
      const visual = activityVisual(activity({ category, status: 'error' }));
      expect(visual.key).toBe('error');
      expect(visual.color).toBe(ORBIT_PALETTE.error);
      expect(visual.glyph).toBe('!');
    }
  });
});

describe('status and state colours', () => {
  it('has a colour for all five activity statuses', () => {
    for (const status of STATUSES) {
      expect(statusColor(status)).toBeTruthy();
    }
    // `cancelled` is drained, not alarming: it must not reuse the error red.
    expect(statusColor('cancelled')).toBe(ORBIT_PALETTE.labelDim);
    expect(statusColor('cancelled')).not.toBe(statusColor('error'));
  });

  it('has a colour for all eleven agent states', () => {
    for (const state of STATES) {
      expect(stateColor(state)).toBeTruthy();
    }
    expect(stateColor('quiet')).toBe(ORBIT_PALETTE.labelDim);
    expect(stateColor('interrupted')).toBe(ORBIT_PALETTE.warning);
  });
});

describe('buildTimeline', () => {
  it('positions marks by startedAt, not by array order', () => {
    // The Host sends newest-first, so the array order is the reverse of time.
    const model = buildTimeline(
      [
        activity({ id: 'c', startedAt: 3_000 }),
        activity({ id: 'b', startedAt: 2_000 }),
        activity({ id: 'a', startedAt: 1_000 }),
      ],
      1_000,
      5_000,
    );

    expect(model.empty).toBe(false);
    const byId = Object.fromEntries(model.marks.map((mark) => [mark.id, mark]));
    expect(byId.a?.leftPct).toBeLessThan(byId.b?.leftPct ?? 0);
    expect(byId.b?.leftPct).toBeLessThan(byId.c?.leftPct ?? 0);
    // Anchor 1000 → head at 3000 out of a 1000..5000 domain: the quarter mark,
    // mapped into the 1.6%..98.4% inset band.
    expect(byId.a?.leftPct).toBeCloseTo(1.6, 5);
    expect(byId.c?.leftPct).toBeCloseTo(1.6 + 0.5 * 96.8, 5);
    expect(model.headPct).toBeCloseTo(1.6 + 0.5 * 96.8, 5);
    expect(model.span).toBe('4.0s');
  });

  it('anchors on metrics.startedAt so a quiet tail stays visible as rail', () => {
    const anchored = buildTimeline([activity({ startedAt: 10_000 })], 5_000, 15_000);
    const unanchored = buildTimeline([activity({ startedAt: 10_000 })], undefined, undefined);
    // A single point with no domain collapses to the middle of the rail.
    expect(unanchored.marks[0]?.leftPct).toBe(50);
    expect(anchored.marks[0]?.leftPct).toBeCloseTo(50, 5);
    // …but the domain now really spans 10s, which the span string proves.
    expect(anchored.span).toBe('10.0s');
  });

  it('gives cancelled the quietest mark height: present, but not competing', () => {
    const model = buildTimeline(
      [
        activity({ id: 'ok', status: 'success', startedAt: 1_000 }),
        activity({ id: 'gone', status: 'cancelled', startedAt: 2_000 }),
        activity({ id: 'boom', status: 'error', startedAt: 3_000 }),
      ],
      1_000,
      3_000,
    );
    const byId = Object.fromEntries(model.marks.map((mark) => [mark.id, mark]));
    expect(byId.gone?.heightPct).toBe(20);
    // Shorter than a settled success, far shorter than an error spike.
    expect(byId.gone?.heightPct).toBeLessThan(byId.ok?.heightPct ?? 0);
    expect(byId.gone?.heightPct).toBeLessThan(byId.boom?.heightPct ?? 0);
    expect(byId.gone?.color).toBe(ORBIT_PALETTE.labelDim);
    // A cancelled node is not "active": only running/waiting pulse.
    expect(byId.gone?.active).toBe(false);
  });

  it('builds a label from the v2 label + status words', () => {
    const model = buildTimeline([activity({ label: '命令', status: 'cancelled' })], 1_000, 1_000);
    expect(model.marks[0]?.label).toBe('命令 · 已取消');
  });

  it('tolerates rows whose startedAt is not a finite number', () => {
    const model = buildTimeline(
      [
        activity({ id: 'bad', startedAt: Number.NaN }),
        activity({ id: 'good', startedAt: 2_000 }),
      ],
      2_000,
      4_000,
    );
    expect(model.empty).toBe(false);
    expect(model.marks.map((mark) => mark.id)).toEqual(['bad', 'good']);
    expect(Number.isFinite(model.marks[1]?.leftPct)).toBe(true);
  });

  it('returns the empty model for no events', () => {
    const model = buildTimeline([], 1_000, 2_000);
    expect(model.empty).toBe(true);
    expect(model.marks).toEqual([]);
    expect(model.headPct).toBe(0);
  });
});
