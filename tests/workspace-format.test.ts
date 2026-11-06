import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  activityVisual,
  categoryVisualLabel,
  stateColor,
  statusColor,
  CATEGORIES,
} from '../src/client/workspace/format';
import { ORBIT_PALETTE } from '../src/client/contracts';
import { LABELS } from '../src/client/workspace/labels';
import { CATEGORY_LABEL, SENSITIVE_TARGET_LABEL } from '../src/shared/task-context-types';
import type {
  OrbitActivity,
  OrbitActivityStatus,
  OrbitAgentState,
  OrbitToolCategory,
} from '../src/shared/protocol';

/** The eleven Agent states, listed literally so a protocol change breaks this test. */
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

/** The thirteen v2.0 activity categories, listed literally for the same reason. */
const CATEGORY_KEYS: readonly OrbitToolCategory[] = [
  'reasoning',
  'file_read',
  'file_write',
  'command',
  'search',
  'build',
  'test',
  'api',
  'database',
  'inspection',
  'approval',
  'response',
  'unknown',
];

/** The five v2.0 activity statuses. */
const STATUSES: readonly OrbitActivityStatus[] = [
  'running',
  'success',
  'failed',
  'cancelled',
  'unknown',
];

/** The legend family each category must borrow (spec §3.2 → five node colours). */
const EXPECTED_FAMILY: Record<OrbitToolCategory, string> = {
  file_read: 'read',
  search: 'read',
  reasoning: 'read',
  response: 'read',
  file_write: 'write',
  build: 'write',
  test: 'write',
  command: 'edit',
  api: 'edit',
  database: 'edit',
  inspection: 'edit',
  approval: 'edit',
  unknown: 'tool',
};

/** Minimal well-formed v2.0 Activity row; every required DTO field is set. */
function activity(overrides: Partial<OrbitActivity> = {}): OrbitActivity {
  return {
    id: 'a1',
    sessionId: 's1',
    category: 'command',
    label: '执行命令',
    status: 'success',
    startedAt: 1_000,
    source: 'tool',
    confidence: 'high',
    ...overrides,
  };
}

describe('activity visual vocabulary', () => {
  it('classifies all thirteen categories without throwing', () => {
    expect(CATEGORY_KEYS).toHaveLength(13);
    for (const category of CATEGORY_KEYS) {
      const visual = activityVisual(activity({ category }));
      expect(visual.color).toBeTruthy();
      expect(visual.glyph.trim().length).toBeGreaterThan(0);
      expect(visual.kind).toBeTruthy();
      expect(CATEGORIES.some((entry) => entry.key === visual.key)).toBe(true);
    }
  });

  it('gives each of the thirteen categories its own glyph', () => {
    const glyphs = CATEGORY_KEYS.map((category) => activityVisual(activity({ category })).glyph);
    expect(glyphs).toHaveLength(13);
    expect(new Set(glyphs).size).toBe(13);
  });

  it('borrows the documented legend family for every category', () => {
    for (const category of CATEGORY_KEYS) {
      expect(activityVisual(activity({ category })).key).toBe(EXPECTED_FAMILY[category]);
    }
  });

  it('keeps the five legend families untouched', () => {
    expect(CATEGORIES.map((entry) => entry.key)).toEqual(['read', 'write', 'edit', 'error', 'tool']);
  });

  it('uses the shared category table verbatim as the kind word', () => {
    for (const category of CATEGORY_KEYS) {
      expect(categoryVisualLabel(category)).toBe(CATEGORY_LABEL[category]);
      expect(activityVisual(activity({ category })).kind).toBe(CATEGORY_LABEL[category]);
      // The local label dictionary mirrors the contract table, so a rename on
      // either side fails here instead of silently shipping two vocabularies.
      expect(LABELS.toolKind[category]).toBe(CATEGORY_LABEL[category]);
    }
    expect(categoryVisualLabel('approval')).toBe('等待审批');
    expect(categoryVisualLabel('unknown')).toBe('执行其他操作');
  });

  it('decides the badge by category alone, never by fileKind', () => {
    // `type` is gone from the wire; `fileKind` no longer forks the badge.
    const plain = activityVisual(activity({ category: 'file_read' }));
    for (const fileKind of ['read', 'write', 'edit'] as const) {
      const visual = activityVisual(activity({ category: 'file_read', fileKind }));
      expect(visual.key).toBe(plain.key);
      expect(visual.glyph).toBe(plain.glyph);
      expect(visual.color).toBe(plain.color);
    }
  });

  it('paints a failed row in the error red whatever the category is', () => {
    for (const category of CATEGORY_KEYS) {
      const visual = activityVisual(activity({ category, status: 'failed' }));
      expect(visual.key).toBe('error');
      expect(visual.color).toBe(ORBIT_PALETTE.error);
      expect(visual.glyph).toBe('!');
      // The family word survives the recolour, so the row is still readable.
      expect(visual.kind).toBe(CATEGORY_LABEL[category]);
    }
  });
});

describe('redacted rows', () => {
  it('replaces the kind word with the redaction sentence and leaks no file name', () => {
    const visual = activityVisual(
      activity({ category: 'file_read', redacted: true, safeTarget: 'prod.env' }),
    );
    expect(visual.kind).toBe(SENSITIVE_TARGET_LABEL);
    expect(SENSITIVE_TARGET_LABEL).toBe('读取敏感配置文件');
    // No target slot at all, so the row can never render a basename.
    expect(visual.target).toBeUndefined();
    expect(JSON.stringify(visual)).not.toContain('prod.env');
    // The category still drives the badge colour.
    expect(visual.key).toBe('read');
  });

  it('still shows the redaction sentence when the Host sent no target at all', () => {
    const visual = activityVisual(activity({ category: 'file_write', redacted: true }));
    expect(visual.kind).toBe(SENSITIVE_TARGET_LABEL);
    expect(visual.target).toBeUndefined();
  });

  it('keeps the redaction sentence on a failed row while going red', () => {
    const visual = activityVisual(
      activity({ category: 'file_write', redacted: true, safeTarget: '.npmrc', status: 'failed' }),
    );
    expect(visual.kind).toBe(SENSITIVE_TARGET_LABEL);
    expect(visual.color).toBe(ORBIT_PALETTE.error);
    expect(JSON.stringify(visual)).not.toContain('.npmrc');
  });

  it('shows the safe basename for a normal row, and nothing when there is none', () => {
    expect(activityVisual(activity({ safeTarget: 'orbit.ts' })).target).toBe('orbit.ts');
    expect(activityVisual(activity()).target).toBeUndefined();
  });
});

describe('status and state colours', () => {
  it('has a colour for all five activity statuses', () => {
    for (const status of STATUSES) {
      expect(statusColor(status)).toBeTruthy();
    }
    expect(statusColor('running')).toBe(ORBIT_PALETTE.cyan);
    expect(statusColor('success')).toBe(ORBIT_PALETTE.success);
    expect(statusColor('failed')).toBe(ORBIT_PALETTE.error);
    // 取消与「只知道开始过」都退到次要色，红色只留给真正的失败。
    expect(statusColor('cancelled')).toBe(ORBIT_PALETTE.labelDim);
    expect(statusColor('unknown')).toBe(ORBIT_PALETTE.labelDim);
    expect(statusColor('cancelled')).not.toBe(statusColor('failed'));
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
    // Anchor 1000 → head at 3000 out of a 1000..5000 domain: the half mark,
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

  it('ranks the five statuses by mark height and colour', () => {
    const model = buildTimeline(
      STATUSES.map((status, index) =>
        activity({ id: status, status, startedAt: 1_000 + index * 1_000 }),
      ),
      1_000,
      5_000,
    );
    const byId = Object.fromEntries(model.marks.map((mark) => [mark.id, mark]));

    expect(byId.running?.heightPct).toBe(52);
    expect(byId.success?.heightPct).toBe(28);
    expect(byId.failed?.heightPct).toBe(76);
    expect(byId.cancelled?.heightPct).toBe(20);
    expect(byId.unknown?.heightPct).toBe(18);

    // A failed spike dominates; the two uncertain outcomes are the quietest.
    expect(byId.failed?.heightPct).toBe(Math.max(...model.marks.map((mark) => mark.heightPct)));
    expect(byId.unknown?.heightPct).toBeLessThan(byId.cancelled?.heightPct ?? 0);
    expect(byId.cancelled?.heightPct).toBeLessThan(byId.success?.heightPct ?? 0);
    expect(byId.success?.heightPct).toBeLessThan(byId.running?.heightPct ?? 0);
    expect(byId.failed?.color).toBe(ORBIT_PALETTE.error);
  });

  it('pulses only running rows', () => {
    const model = buildTimeline(
      STATUSES.map((status) => activity({ id: status, status, startedAt: 2_000 })),
      1_000,
      3_000,
    );
    const active = model.marks.filter((mark) => mark.active).map((mark) => mark.id);
    expect(active).toEqual(['running']);
  });

  it('builds a label from the row label + the v2.0 status word', () => {
    const model = buildTimeline(
      [activity({ id: 'x', label: '执行命令', status: 'cancelled' })],
      1_000,
      1_000,
    );
    expect(model.marks[0]?.label).toBe('执行命令 · 已取消');
  });

  it('falls back to the category word when the row has no label', () => {
    const model = buildTimeline(
      [activity({ id: 'x', category: 'test', label: '  ', status: 'failed' })],
      1_000,
      1_000,
    );
    expect(model.marks[0]?.label).toBe('执行测试 · 失败');
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
    expect(model.span).toBe('—');
  });
});
