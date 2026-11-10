/**
 * The always-on HUD's rule set, tested as pure functions.
 *
 * No jsdom, no React, no renderer: `src/client/hud/progress.ts` owns every
 * decision the panel makes — the eleven status words, the activity icon and
 * colour vocabulary, both clock formatters, the two runtime pills, the
 * expand / fold policy, the silence gate and the footer arithmetic — so all of
 * it is assertable without a DOM.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_ICON,
  HUD_STATUS_CHIP,
  RUNTIME_MODE_LABEL,
  activityColor,
  activityIcon,
  activityStatusLabel,
  activityText,
  currentStatusText,
  footerStats,
  formatClock,
  formatElapsed,
  hudActivityRows,
  hudCardMode,
  hudChipText,
  hudStatusChip,
  hudTone,
  isActiveState,
  isSettledState,
  nextStepLabel,
  phaseTextOf,
  runtimePills,
  shouldShowSilence,
  taskElapsedMs,
  taskTitleOf,
  type HudTone,
} from '../src/client/hud/progress';
import { ORBIT_PALETTE } from '../src/client/contracts';
import type { OrbitActivity, OrbitAgentState, OrbitActivityStatus } from '../src/shared/protocol';
import {
  SENSITIVE_TARGET_LABEL,
  TASK_TITLE_FALLBACK,
  type OrbitTaskContext,
} from '../src/shared/task-context-types';

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

const STATUSES: OrbitActivityStatus[] = ['running', 'success', 'failed', 'cancelled', 'unknown'];

/** 2026-11-06 14:02:33 local time, built from local parts so the TZ cannot skew it. */
const T_1402 = new Date(2026, 10, 6, 14, 2, 33).getTime();

function activity(overrides: Partial<OrbitActivity> = {}): OrbitActivity {
  return {
    id: 'a1',
    sessionId: 's1',
    turn: 1,
    step: 2,
    category: 'file_read',
    label: '读取项目文件',
    status: 'success',
    startedAt: T_1402,
    source: 'tool',
    confidence: 'high',
    ...overrides,
  };
}

function task(overrides: Partial<OrbitTaskContext> = {}): OrbitTaskContext {
  return {
    taskTitle: '联调 Egress VNI API',
    titleSource: 'session',
    phase: 'querying',
    phaseLabel: '查询接口',
    currentAction: '正在查询 Egress API',
    recentActivities: [],
    activeActivities: [],
    completedCount: 0,
    failedCount: 0,
    observedActivityCount: 0,
    toolCallCount: 0,
    startedAt: T_1402,
    lastActivityAt: T_1402 + 942_000,
    silence: { ms: 0, level: 0, label: '正在执行工具调用。' },
    confidence: 'high',
    extraTokens: 0,
    mode: 'event-only',
    ...overrides,
  };
}

describe('hudStatusChip — the eleven state words', () => {
  it('has a non-empty Chinese word for every state', () => {
    for (const state of STATES) {
      const chip = hudStatusChip(state);
      expect(chip.trim().length, state).toBeGreaterThan(0);
      expect(chip, state).not.toContain('undefined');
      expect(chip, state).toBe(HUD_STATUS_CHIP[state]);
    }
  });

  it('keeps the eleven words mutually distinct', () => {
    const chips = STATES.map((state) => hudStatusChip(state));
    expect(new Set(chips).size).toBe(STATES.length);
    expect(new Set(Object.values(HUD_STATUS_CHIP)).size).toBe(STATES.length);
  });

  it('names a dropped connection instead of hiding it', () => {
    const live = hudChipText('executing', 'open');
    expect(hudChipText('executing', 'reconnecting')).toContain(live);
    expect(hudChipText('executing', 'reconnecting')).not.toBe(live);
    expect(hudChipText('executing', 'closed')).toContain(live);
    expect(hudChipText('executing', 'closed')).not.toBe(live);
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

describe('activityIcon — five outcomes', () => {
  it('gives every status a one-character glyph', () => {
    for (const status of STATUSES) {
      const glyph = activityIcon(status);
      expect(glyph.length, status).toBe(1);
      expect(glyph.trim().length, status).toBeGreaterThan(0);
      expect(glyph, status).toBe(ACTIVITY_ICON[status]);
    }
  });

  it('pins the four spec glyphs and keeps all five distinct', () => {
    expect(activityIcon('success')).toBe('✓');
    expect(activityIcon('running')).toBe('◉');
    expect(activityIcon('failed')).toBe('✕');
    expect(activityIcon('cancelled')).toBe('…');
    expect(new Set(STATUSES.map((status) => activityIcon(status))).size).toBe(STATUSES.length);
  });

  it('labels every status, never with a placeholder', () => {
    for (const status of STATUSES) {
      expect(activityStatusLabel(status).trim().length, status).toBeGreaterThan(0);
    }
    expect(activityStatusLabel('running')).toBe('进行中');
  });
});

describe('activityColor', () => {
  it('follows the spec colour roles', () => {
    // 绿 = 成功，蓝 = 执行中，紫 = 模型处理，黄 = 等待审批，红 = 失败
    expect(activityColor('file_read', 'success')).toBe(ORBIT_PALETTE.success);
    expect(activityColor('command', 'running')).toBe(ORBIT_PALETTE.blue);
    expect(activityColor('reasoning', 'running')).toBe(ORBIT_PALETTE.purple);
    expect(activityColor('approval', 'running')).toBe(ORBIT_PALETTE.warning);
    expect(activityColor('command', 'failed')).toBe(ORBIT_PALETTE.error);
  });

  it('lets an outcome win over its category', () => {
    expect(activityColor('reasoning', 'failed')).toBe(ORBIT_PALETTE.error);
    expect(activityColor('approval', 'failed')).toBe(ORBIT_PALETTE.error);
    expect(activityColor('approval', 'cancelled')).toBe(ORBIT_PALETTE.labelDim);
  });
});

describe('activityText — no leaks', () => {
  it('joins the safe label and the whitelisted target', () => {
    expect(activityText(activity({ label: '修改文件', safeTarget: 'report.md' }))).toBe(
      '修改文件 · report.md',
    );
  });

  it('stays on the label when there is no safe target', () => {
    expect(activityText(activity({ label: '执行命令' }))).toBe('执行命令');
  });

  it('collapses a masked row to one fixed sentence', () => {
    const masked = activity({ label: '读取项目文件', redacted: true, safeTarget: 'a1b2c3…' });
    expect(activityText(masked)).toBe(SENSITIVE_TARGET_LABEL);
    // No duplicated copy, and the partial name the Host masked never resurfaces.
    expect(activityText(masked).match(/读取敏感配置文件/g)?.length).toBe(1);
    expect(activityText(masked)).not.toContain('a1b2c3');
  });

  it('falls back to the category word for an empty label', () => {
    expect(activityText(activity({ label: '   ' }))).toBe('读取项目文件');
  });

  it('ignores fields the wire forbids', () => {
    const leaking = {
      ...activity({ label: '修改文件', safeTarget: 'report.md' }),
      rawArguments: '{"path":"/Users/someone/secret.ts","command":"rm -rf /"}',
      rawCommand: 'rm -rf /',
      fileContent: 'BEGIN PRIVATE KEY',
    } as unknown as OrbitActivity;
    const text = activityText(leaking);
    expect(text).toBe('修改文件 · report.md');
    expect(text).not.toContain('rm -rf');
    expect(text).not.toContain('/Users');
    expect(text).not.toContain('PRIVATE KEY');
  });
});

describe('formatClock — pure', () => {
  it('formats a pinned instant as HH:MM', () => {
    expect(formatClock(T_1402)).toBe('14:02');
    expect(formatClock(new Date(2026, 0, 1, 9, 5, 59).getTime())).toBe('09:05');
    expect(formatClock(new Date(2026, 0, 1, 0, 0, 0).getTime())).toBe('00:00');
  });

  it('is a pure function of its argument', () => {
    const first = formatClock(T_1402);
    const second = formatClock(T_1402);
    expect(first).toBe(second);
    // Same epoch a minute later differs, so the value really comes from the input.
    expect(formatClock(T_1402 + 60_000)).toBe('14:03');
  });

  it('degrades instead of throwing on a bad instant', () => {
    expect(formatClock(Number.NaN)).toBe('--:--');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('--:--');
  });
});

describe('formatElapsed — boundaries', () => {
  it('shows seconds below a minute', () => {
    expect(formatElapsed(0)).toBe('0 秒');
    expect(formatElapsed(999)).toBe('0 秒');
    expect(formatElapsed(1_000)).toBe('1 秒');
    expect(formatElapsed(59_999)).toBe('59 秒');
  });

  it('shows minutes and seconds below an hour', () => {
    expect(formatElapsed(60_000)).toBe('1 分');
    expect(formatElapsed(942_000)).toBe('15 分 42 秒');
    expect(formatElapsed(3_599_000)).toBe('59 分 59 秒');
  });

  it('drops the seconds above an hour, zero-padding the minutes', () => {
    expect(formatElapsed(3_600_000)).toBe('1 小时 00 分');
    expect(formatElapsed(3_780_000)).toBe('1 小时 03 分');
    expect(formatElapsed(25_920_000)).toBe('7 小时 12 分');
  });

  it('clamps bad input to zero instead of printing negatives', () => {
    expect(formatElapsed(-1)).toBe('0 秒');
    expect(formatElapsed(Number.NaN)).toBe('0 秒');
  });
});

describe('runtimePills', () => {
  it('always reports the event-only mode', () => {
    const cases = [
      runtimePills(task(), 'open', T_1402 + 942_000),
      runtimePills(task(), 'reconnecting', T_1402 + 942_000),
      runtimePills(task(), 'closed', T_1402 + 942_000),
      runtimePills(task({ extraTokens: 0, mode: 'event-only' })),
    ];
    for (const pills of cases) {
      expect(pills.mode).toBe('纯事件模式 · 0 额外 Token');
      expect(pills.mode).toBe(RUNTIME_MODE_LABEL);
      expect(pills.mode).toContain('0 额外 Token');
    }
  });

  it('measures from the first observed event to the given instant', () => {
    expect(runtimePills(task(), 'open', T_1402 + 942_000).elapsed).toBe('15 分 42 秒');
    expect(runtimePills(task(), 'open', T_1402).elapsed).toBe('0 秒');
    expect(taskElapsedMs(task(), T_1402 - 5_000)).toBe(0);
  });

  it('stops the clock at the last event while the stream is down', () => {
    const later = T_1402 + 942_000;
    expect(runtimePills(task(), 'closed', later + 600_000).elapsed).toBe(
      runtimePills(task(), 'open', later).elapsed,
    );
    expect(runtimePills(task(), 'open', later + 600_000).elapsed).not.toBe('15 分 42 秒');
  });
});

describe('hudCardMode — auto expand / manual fold', () => {
  it('renders nothing in orb mode', () => {
    for (const state of STATES) {
      expect(hudCardMode('orb', state, false)).toBe('hidden');
      expect(hudCardMode('orb', state, true)).toBe('hidden');
    }
  });

  it('is always the chip in compact mode', () => {
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
    const burst: OrbitAgentState[] = [
      'starting',
      'thinking',
      'preparing',
      'executing',
      'responding',
      'waiting',
      'error',
      'completed',
    ];
    for (const state of burst) {
      expect(hudCardMode('auto', state, true), state).toBe('compact');
    }
    // Only clearing the flag (a click) brings the panel back.
    expect(hudCardMode('auto', 'executing', false)).toBe('expanded');
  });
});

describe('shouldShowSilence', () => {
  it('shows nothing at level 0', () => {
    expect(shouldShowSilence(task({ silence: { ms: 5_000, level: 0, label: '…' } }))).toBe(false);
  });

  it('honours the user switch', () => {
    const quiet = task({ silence: { ms: 45_000, level: 1, label: '已有 45 秒没有新活动。' } });
    expect(shouldShowSilence(quiet, true)).toBe(true);
    expect(shouldShowSilence(quiet, false)).toBe(false);
    expect(
      shouldShowSilence(
        task({
          silence: { ms: 200_000, level: 3, label: '已有 3 分钟没有新活动。' },
        }),
        false,
      ),
    ).toBe(false);
  });

  it('is false before the first snapshot', () => {
    expect(shouldShowSilence(null)).toBe(false);
  });
});

describe('nextStepLabel', () => {
  it('returns undefined without a published plan', () => {
    expect(nextStepLabel(null)).toBeUndefined();
    expect(nextStepLabel(task())).toBeUndefined();
    expect(nextStepLabel(task({ nextStep: '   ' }))).toBeUndefined();
  });

  it('returns the real plan step when the Agent published one', () => {
    expect(nextStepLabel(task({ nextStep: '校验设备映射关系' }))).toBe('校验设备映射关系');
  });
});

describe('currentStatusText', () => {
  it('prefers the Host silence sentence when the switch is on', () => {
    const quiet = task({
      currentAction: '正在查询',
      silence: { ms: 45_000, level: 1, label: '已有 45 秒没有新活动。' },
    });
    expect(currentStatusText(quiet, 'quiet', true)).toBe('已有 45 秒没有新活动。');
    // Same task, switch off: the newest real action takes over.
    expect(currentStatusText(quiet, 'quiet', false)).toBe('正在查询');
  });

  it('falls back to a fixed sentence per state, never to a stuck claim', () => {
    const noAction = task({ currentAction: undefined });
    expect(currentStatusText(noAction, 'executing')).toBe('正在执行工具调用。');
    expect(currentStatusText(noAction, 'waiting')).toBe('正在等待用户审批。');
    expect(currentStatusText(noAction, 'responding')).toBe('正在组织答复。');
    expect(currentStatusText(noAction, 'idle')).toBe('当前没有新活动。');
    for (const state of STATES) {
      const text = currentStatusText(noAction, state);
      expect(text.trim().length, state).toBeGreaterThan(0);
      expect(text, state).not.toContain('卡死');
      expect(text, state).not.toContain('无响应');
    }
  });

  it('speaks about the connection, not about a stuck Agent, before the first frame', () => {
    expect(currentStatusText(null, 'idle')).toBe('等待第一条任务事件…');
    expect(currentStatusText(null, 'executing')).toBe('正在执行工具调用。');
  });
});

describe('task title and phase', () => {
  it('marks the generic title as a fallback', () => {
    expect(taskTitleOf(null)).toEqual({ text: TASK_TITLE_FALLBACK, fallback: true });
    expect(taskTitleOf(task({ taskTitle: '  ', titleSource: 'fallback' }))).toEqual({
      text: TASK_TITLE_FALLBACK,
      fallback: true,
    });
    expect(taskTitleOf(task())).toEqual({ text: '联调 Egress VNI API', fallback: false });
  });

  it('never returns an empty phase line', () => {
    expect(phaseTextOf(task(), 'executing')).toBe('查询接口');
    expect(phaseTextOf(task({ phase: 'reading', phaseLabel: '' }), 'executing')).toBe('阅读项目');
    expect(phaseTextOf(null, 'idle')).toBe('等待任务');
  });
});

describe('footerStats', () => {
  it('prints only the counters that are real', () => {
    const counts = task({ observedActivityCount: 5, toolCallCount: 4 });
    expect(footerStats(counts, '15 分 42 秒')).toBe('已观察到 5 项活动 · 工具 4 次 · 运行 15 分 42 秒');
    // No tools yet: the counter is omitted instead of printed as zero.
    expect(footerStats(task({ observedActivityCount: 2, toolCallCount: 0 }), '3 秒')).toBe(
      '已观察到 2 项活动 · 运行 3 秒',
    );
    expect(footerStats(task({ observedActivityCount: 0, toolCallCount: 0 }), '0 秒')).toBe(
      '尚未观察到活动 · 运行 0 秒',
    );
    expect(footerStats(null, '0 秒')).toBe('尚未收到任务事件');
  });
});

describe('hudActivityRows', () => {
  it('caps at five rows and keeps the Host order', () => {
    const rows = Array.from({ length: 8 }, (_, index) =>
      activity({ id: `a${index}`, label: `活动 ${index}` }),
    );
    const shown = hudActivityRows(task({ recentActivities: rows }));
    expect(shown).toHaveLength(5);
    expect(shown.map((row) => row.id)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
  });

  it('returns nothing for an empty task list', () => {
    expect(hudActivityRows(task())).toEqual([]);
    expect(hudActivityRows(task(), 0)).toEqual([]);
  });
});
