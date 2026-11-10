import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/client/contracts';
import { deriveVisual, resolveQuality } from '../src/client/visual';
import { ORBIT_PROTOCOL_VERSION, type OrbitSnapshot } from '../src/shared/protocol';

function snapshot(overrides: Partial<OrbitSnapshot> = {}): OrbitSnapshot {
  return {
    protocol: ORBIT_PROTOCOL_VERSION,
    version: 1,
    sessionId: 's1',
    agentState: 'idle',
    activeTools: 0,
    silenceMs: 0,
    quietLevel: 0,
    events: [],
    task: {
      taskTitle: '当前任务处理中',
      titleSource: 'fallback',
      phase: 'idle',
      phaseLabel: '待机',
      recentActivities: [],
      activeActivities: [],
      completedCount: 0,
      failedCount: 0,
      observedActivityCount: 0,
      toolCallCount: 0,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      silence: { ms: 0, level: 0, label: '当前没有新的活动。' },
      confidence: 'low',
      extraTokens: 0,
      mode: 'event-only',
    },
    updatedAt: Date.now(),
    metrics: { turns: 0, steps: 0, tools: 0, files: 0, approvals: 0, retries: 0, startedAt: Date.now() },
    ...overrides,
  };
}

describe('visual derivation', () => {
  it('is calm without a snapshot', () => {
    const visual = deriveVisual(null, 'open');
    expect(visual.agentState).toBe('idle');
    expect(visual.streaming).toBe(false);
    expect(visual.intensity).toBeLessThan(0.2);
  });

  it('raises intensity with activity and marks streaming', () => {
    const visual = deriveVisual(snapshot({ agentState: 'executing', activeTools: 2 }), 'open');
    expect(visual.agentState).toBe('executing');
    expect(visual.activeTools).toBe(2);
    expect(visual.streaming).toBe(true);
    expect(visual.intensity).toBeGreaterThan(0.6);
    expect(visual.intensity).toBeLessThanOrEqual(1);
  });

  it('does not stream while disconnected', () => {
    const visual = deriveVisual(snapshot({ agentState: 'thinking' }), 'reconnecting');
    expect(visual.streaming).toBe(false);
  });
});

describe('quality resolution', () => {
  it('passes the user settings through by default', () => {
    const quality = resolveQuality({ ...DEFAULT_SETTINGS, fps: 60, particles: 'high' }, false);
    expect(quality.fps).toBe(60);
    expect(quality.particles).toBe('high');
    expect(quality.glow).toBe(true);
    expect(quality.reduceMotion).toBe(false);
  });

  it('sheds particles and glow under reduce-motion', () => {
    const quality = resolveQuality({ ...DEFAULT_SETTINGS, reduceMotion: 'on' }, false);
    expect(quality.reduceMotion).toBe(true);
    expect(quality.particles).toBe('low');
    expect(quality.glow).toBe(false);
  });

  it('follows the system preference when asked to', () => {
    expect(resolveQuality({ ...DEFAULT_SETTINGS, reduceMotion: 'system' }, true).reduceMotion).toBe(true);
    expect(resolveQuality({ ...DEFAULT_SETTINGS, reduceMotion: 'system' }, false).reduceMotion).toBe(false);
    // An explicit 'off' wins over the system preference.
    expect(resolveQuality({ ...DEFAULT_SETTINGS, reduceMotion: 'off' }, true).reduceMotion).toBe(false);
  });
});
