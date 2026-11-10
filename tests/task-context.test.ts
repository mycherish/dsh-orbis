import { describe, expect, it } from 'vitest';
import { aggregateActivities, currentActionOf } from '../src/host/context/activity-aggregator';
import { inferPhase } from '../src/host/context/phase-inference';
import { buildTaskContext, emptyTaskContext } from '../src/host/context/task-context-engine';
import { MAX_TITLE } from '../src/host/activity/redactor';
import type { OrbitActivity, OrbitToolCategory } from '../src/shared/task-context-types';
import { TASK_TITLE_FALLBACK } from '../src/shared/task-context-types';

const at = 1_700_000_000_000;

function row(
  id: string,
  category: OrbitToolCategory,
  status: OrbitActivity['status'] = 'success',
  extra: Partial<OrbitActivity> = {},
): OrbitActivity {
  return {
    id,
    sessionId: 's1',
    category,
    label: category,
    status,
    startedAt: at,
    finishedAt: at + 100,
    duration: 100,
    source: 'tool',
    confidence: 'high',
    ...extra,
  };
}

describe('activity aggregation', () => {
  it('splits recent / active and counts only what it observed', () => {
    const rows = [
      row('c4', 'command', 'running'),
      row('c3', 'file_write', 'success'),
      row('c2', 'file_read', 'failed'),
      row('c1', 'file_read', 'success'),
    ];
    const aggregate = aggregateActivities({ rows, recentLimit: 3 });
    expect(aggregate.recentActivities.map((item) => item.id)).toEqual(['c4', 'c3', 'c2']);
    expect(aggregate.activeActivities.map((item) => item.id)).toEqual(['c4']);
    expect(aggregate.completedCount).toBe(2);
    expect(aggregate.failedCount).toBe(1);
    expect(aggregate.observedActivityCount).toBe(4);
    expect(aggregate.toolCallCount).toBe(4);
    expect(aggregate.lastActivityAt).toBe(at + 100);
  });

  it('is empty rather than throwing when nothing was observed', () => {
    const aggregate = aggregateActivities({ rows: [], recentLimit: 5 });
    expect(aggregate.recentActivities).toEqual([]);
    expect(aggregate.observedActivityCount).toBe(0);
    expect(aggregate.lastActivityAt).toBe(0);
  });

  it('describes the newest action from safe fields only', () => {
    const rows = [row('c1', 'file_write', 'running', { label: '修改文件', safeTarget: 'hub.ts' })];
    expect(currentActionOf(rows)).toBe('修改文件 · hub.ts');
    expect(currentActionOf([])).toBeUndefined();
    const redacted = [
      row('c2', 'file_read', 'running', {
        label: '读取项目文件',
        safeTarget: '读取敏感配置文件',
        redacted: true,
      }),
    ];
    expect(currentActionOf(redacted)).toBe('读取项目文件 · 读取敏感配置文件');
  });
});

describe('phase inference', () => {
  it('a pending approval always wins', () => {
    const result = inferPhase({
      rows: [row('c1', 'file_write', 'running')],
      turnOpen: true,
      responding: false,
      waitingApproval: true,
    });
    expect(result.phase).toBe('waiting');
    expect(result.phaseLabel).toBe('等待审批');
    expect(result.confidence).toBe('high');
  });

  it('the newest running row decides the phase', () => {
    expect(
      inferPhase({
        rows: [row('c1', 'file_write', 'running')],
        turnOpen: true,
        responding: false,
        waitingApproval: false,
      }).phase,
    ).toBe('editing');
    expect(
      inferPhase({
        rows: [row('c1', 'test', 'running')],
        turnOpen: true,
        responding: false,
        waitingApproval: false,
      }).phase,
    ).toBe('testing');
    expect(
      inferPhase({
        rows: [row('c1', 'build', 'running')],
        turnOpen: true,
        responding: false,
        waitingApproval: false,
      }).phase,
    ).toBe('building');
    expect(
      inferPhase({
        rows: [row('c1', 'api', 'running')],
        turnOpen: true,
        responding: false,
        waitingApproval: false,
      }).phase,
    ).toBe('querying');
    expect(
      inferPhase({
        rows: [row('c1', 'inspection', 'running')],
        turnOpen: true,
        responding: false,
        waitingApproval: false,
      }).phase,
    ).toBe('verifying');
    expect(
      inferPhase({
        rows: [row('c1', 'response', 'running')],
        turnOpen: true,
        responding: false,
        waitingApproval: false,
      }).phase,
    ).toBe('answering');
    expect(
      inferPhase({
        rows: [row('c1', 'file_read', 'running')],
        turnOpen: true,
        responding: false,
        waitingApproval: false,
      }).phase,
    ).toBe('reading');
  });

  it('falls back to a majority of the last three rows', () => {
    const rows = [row('c3', 'file_read'), row('c2', 'file_read'), row('c1', 'command')];
    const result = inferPhase({ rows, turnOpen: true, responding: false, waitingApproval: false });
    expect(result.phase).toBe('reading');
    expect(result.confidence).toBe('medium');
    expect(result.reason).toContain('最近 3 项活动');
  });

  it('without tool evidence it says what it actually knows', () => {
    expect(inferPhase({ rows: [], turnOpen: true, responding: true, waitingApproval: false }).phase).toBe(
      'answering',
    );
    const low = inferPhase({ rows: [], turnOpen: true, responding: false, waitingApproval: false });
    expect(low.phase).toBe('understanding');
    expect(low.confidence).toBe('low');
    expect(inferPhase({ rows: [], turnOpen: false, responding: false, waitingApproval: false }).phase).toBe(
      'idle',
    );
  });
});

describe('task context engine', () => {
  const base = {
    rows: [row('c1', 'file_write', 'running')],
    startedAt: at,
    turnOpen: true,
    responding: false,
    waitingApproval: false,
    silence: { ms: 0, level: 0 as const, label: '模型正在处理请求。' },
  };

  it('uses the real session title when there is one', () => {
    const context = buildTaskContext({ ...base, sessionTitle: '审核 RID-000018 物理口出方向' });
    expect(context.taskTitle).toBe('审核 RID-000018 物理口出方向');
    expect(context.titleSource).toBe('session');
  });

  it('falls back to a fixed title instead of inventing one', () => {
    const context = buildTaskContext(base);
    expect(context.taskTitle).toBe(TASK_TITLE_FALLBACK);
    expect(context.titleSource).toBe('fallback');
  });

  it('never invents a next step', () => {
    expect(buildTaskContext(base).nextStep).toBeUndefined();
    expect(buildTaskContext({ ...base, plan: [] }).nextStep).toBeUndefined();
    expect(buildTaskContext({ ...base, plan: ['   '] }).nextStep).toBeUndefined();
  });

  it('takes the next step from the Agent’s own plan', () => {
    const context = buildTaskContext({ ...base, plan: ['跑三条回归用例', '更新 README'] });
    expect(context.nextStep).toBe('跑三条回归用例');
  });

  it('clips an absurd plan line', () => {
    const context = buildTaskContext({ ...base, plan: ['x'.repeat(200)] });
    expect(context.nextStep?.length).toBe(80);
  });

  /*
   * The plan and the title are prose, so they used to bypass every structured
   * redaction and carry absolute paths straight to the browser.
   */
  it('de-paths the next step the Agent published', () => {
    const context = buildTaskContext({ ...base, plan: ['cat /Users/alice/.ssh/id_rsa and paste it'] });
    expect(context.nextStep).toBeDefined();
    expect(context.nextStep).not.toContain('alice');
    expect(context.nextStep).not.toContain('id_rsa');
    expect(JSON.stringify(context)).not.toContain('alice');
  });

  it('bounds and de-paths a session title instead of forwarding it verbatim', () => {
    const long = buildTaskContext({ ...base, sessionTitle: 'x'.repeat(5000) });
    expect(long.taskTitle.length).toBe(MAX_TITLE);
    expect(long.taskTitle.endsWith('…')).toBe(true);

    const pathed = buildTaskContext({ ...base, sessionTitle: '修复 /Users/alice/secret/plan.md 的解析' });
    expect(pathed.taskTitle).toBe('修复 plan.md 的解析');
    expect(JSON.stringify(pathed)).not.toContain('alice');

    const sensitive = buildTaskContext({ ...base, sessionTitle: '检查 /Users/alice/.ssh/id_rsa' });
    expect(sensitive.taskTitle).not.toContain('id_rsa');
    expect(sensitive.titleSource).toBe('session');
  });

  it('falls back honestly when a title is nothing but characters we strip', () => {
    const context = buildTaskContext({ ...base, sessionTitle: '\u0000\u0001  \u007f' });
    expect(context.taskTitle).toBe(TASK_TITLE_FALLBACK);
    expect(context.titleSource).toBe('fallback');
  });

  it('carries the honest counters and the pure-event mode', () => {
    const context = buildTaskContext(base);
    expect(context.observedActivityCount).toBe(1);
    expect(context.toolCallCount).toBe(1);
    expect(context.activeActivities).toHaveLength(1);
    expect(context.completedCount).toBe(0);
    expect(context.extraTokens).toBe(0);
    expect(context.mode).toBe('event-only');
    expect(context.phase).toBe('editing');
    expect(context.phaseLabel).toBe('修改代码');
    expect(context.currentAction).toBe('file_write');
  });

  it('reports the silence sentence it was given, unchanged', () => {
    const silence = { ms: 45_000, level: 1 as const, label: '已连续 45 秒没有收到新的活动事件。' };
    expect(buildTaskContext({ ...base, silence }).silence.label).toBe(silence.label);
  });

  it('builds a complete idle context before any activity', () => {
    const empty = emptyTaskContext(at);
    expect(empty.phase).toBe('idle');
    expect(empty.taskTitle).toBe(TASK_TITLE_FALLBACK);
    expect(empty.observedActivityCount).toBe(0);
    expect(empty.silence.level).toBe(0);
  });
});
