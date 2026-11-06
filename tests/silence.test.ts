import { describe, expect, it } from 'vitest';
import {
  detectSilence,
  monotonicNow,
  msUntilNextSilence,
  silenceLabel,
  silenceLevelOf,
  type SilenceInput,
} from '../src/host/context/silence-detector';

function input(overrides: Partial<SilenceInput> = {}): SilenceInput {
  return { ms: 0, activeTools: 0, waitingApproval: false, responding: false, turnOpen: true, ...overrides };
}

describe('silence levels (spec §7: 0–30 / 30–60 / 60–180 / >180)', () => {
  it('buckets silence into the four documented windows', () => {
    expect(silenceLevelOf(0)).toBe(0);
    expect(silenceLevelOf(29_999)).toBe(0);
    expect(silenceLevelOf(30_000)).toBe(1);
    expect(silenceLevelOf(59_999)).toBe(1);
    expect(silenceLevelOf(60_000)).toBe(2);
    expect(silenceLevelOf(179_999)).toBe(2);
    expect(silenceLevelOf(180_000)).toBe(3);
    expect(silenceLevelOf(1_800_000)).toBe(3);
  });

  it('treats junk as "no silence" instead of crashing', () => {
    expect(silenceLevelOf(Number.NaN)).toBe(0);
    expect(silenceLevelOf(Number.POSITIVE_INFINITY)).toBe(0);
    expect(silenceLevelOf(-5)).toBe(0);
  });

  it('arms the next boundary and stops at the last one', () => {
    expect(msUntilNextSilence(0)).toBe(30_000);
    expect(msUntilNextSilence(45_000)).toBe(15_000);
    expect(msUntilNextSilence(70_000)).toBe(110_000);
    expect(msUntilNextSilence(200_000)).toBeUndefined();
  });
});

describe('silence wording distinguishes six situations, never "stuck"', () => {
  it('normal working state under thirty seconds', () => {
    expect(silenceLabel(input({ ms: 5_000 }))).toContain('模型正在处理请求');
    expect(silenceLabel(input({ ms: 5_000, activeTools: 1 }))).toContain('工具正在执行');
    expect(silenceLabel(input({ ms: 5_000, responding: true }))).toContain('组织答复');
    expect(silenceLabel(input({ ms: 5_000, waitingApproval: true }))).toContain('等待你的审批');
    expect(silenceLabel(input({ ms: 5_000, turnOpen: false }))).toContain('当前没有新的活动');
  });

  it('names the elapsed time once a bucket starts', () => {
    const label = silenceLabel(input({ ms: 45_000 }));
    expect(label).toContain('45 秒');
    expect(label).toContain('没有收到新的活动事件');
  });

  it('separates a long-running tool from a silent model', () => {
    expect(silenceLabel(input({ ms: 90_000, activeTools: 1 }))).toContain('工具仍在执行');
    expect(silenceLabel(input({ ms: 90_000, responding: true }))).toContain('仍在输出');
    expect(silenceLabel(input({ ms: 45_000, activeTools: 1 }))).toContain('工具执行中');
  });

  it('escalates past three minutes without claiming a failure', () => {
    const label = silenceLabel(input({ ms: 200_000, turnOpen: true }));
    expect(label).toContain('建议检查任务状态');
    for (const phrase of ['卡死', '无响应', '失败', '崩溃']) {
      expect(label).not.toContain(phrase);
    }
  });

  it('keeps an approval pending sentence specific', () => {
    expect(silenceLabel(input({ ms: 120_000, waitingApproval: true }))).toContain('等待你的审批');
  });

  it('formats minutes once the silence is long', () => {
    expect(silenceLabel(input({ ms: 125_000 }))).toContain('2 分 05 秒');
  });
});

describe('detectSilence', () => {
  it('returns a rounded, clamped wire object', () => {
    const silence = detectSilence(input({ ms: 45_678.4 }));
    expect(silence.ms).toBe(45_678);
    expect(silence.level).toBe(1);
    expect(silence.label).toContain('秒');
    expect(detectSilence(input({ ms: -10 })).ms).toBe(0);
    expect(detectSilence(input({ ms: Number.NaN })).level).toBe(0);
  });
});

describe('monotonic clock', () => {
  it('only moves forward and is a finite number', async () => {
    const first = monotonicNow();
    await Promise.resolve();
    const second = monotonicNow();
    expect(Number.isFinite(first)).toBe(true);
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
