/**
 * 主题层：把「Agent 状态 + 画质开关」翻译成一组可插值的数值目标。
 *
 * 这一层刻意不碰 three 的 Object3D，只产出纯数据，方便单测，也让 index.ts 里的
 * 平滑插值逻辑保持简单：每帧把 current 朝 target 推一点，再把 current 灌进 uniform。
 *
 * 颜色一律来自 contracts.ts 的 `STATE_COLOR`（六状态唯一色源，不在这里另起一套）；
 * accent / rim 是它的程序化派生色，用来在 shader 里做层次。
 */
import { Color } from 'three';
import { STATE_COLOR } from '../contracts';
import type { OrbQuality, OrbVisualState } from '../contracts';
import type { OrbitAgentState } from '../../shared/protocol';

/** 一个状态的「运动形状」。颜色不在这里，见 STATE_COLOR。 */
export interface StateMotion {
  /** 整体自转速度倍率（1 = 基准）。 */
  spin: number;
  /** 呼吸/脉冲振幅，0 表示完全不脉冲。 */
  pulseAmp: number;
  /** 脉冲频率（Hz）。 */
  pulseHz: number;
  /** shader 内能量流体速度倍率。 */
  flow: number;
  /** 轨道环角速度倍率。 */
  ringSpeed: number;
  /** 轨道环不透明度倍率。 */
  ringOpacity: number;
  /** 粒子流动速度倍率。 */
  particleSpeed: number;
  /** 粒子亮度倍率。 */
  particleBrightness: number;
  /** 外围柔光强度倍率。 */
  glow: number;
}

/**
 * 六状态的动画差异（task-1 描述）：
 * - idle     蓝，缓慢呼吸；
 * - thinking 紫，能量脉冲明显、频率更快；
 * - executing 青蓝，流体最快、粒子高速流动；
 * - waiting  琥珀，轨道环明显减速（0.14）、粒子几乎静止；
 * - error    红，短促警示闪（flash 包络也只对它生效）；
 * - completed 绿，聚合—扩散—回落（burst 包络）。
 */
export const STATE_MOTION: Record<OrbitAgentState, StateMotion> = {
  idle: {
    spin: 0.55,
    pulseAmp: 0.3,
    pulseHz: 0.22,
    flow: 0.45,
    ringSpeed: 0.55,
    ringOpacity: 0.55,
    particleSpeed: 0.35,
    particleBrightness: 0.55,
    glow: 0.55,
  },
  thinking: {
    spin: 1.0,
    pulseAmp: 0.85,
    pulseHz: 0.85,
    flow: 1.3,
    ringSpeed: 1.1,
    ringOpacity: 0.72,
    particleSpeed: 0.95,
    particleBrightness: 0.78,
    glow: 0.82,
  },
  executing: {
    spin: 1.55,
    pulseAmp: 0.5,
    pulseHz: 1.35,
    flow: 2.3,
    ringSpeed: 2.0,
    ringOpacity: 0.85,
    particleSpeed: 2.1,
    particleBrightness: 1.0,
    glow: 0.9,
  },
  waiting: {
    spin: 0.22,
    pulseAmp: 0.4,
    pulseHz: 0.15,
    flow: 0.22,
    ringSpeed: 0.14,
    ringOpacity: 0.4,
    particleSpeed: 0.16,
    particleBrightness: 0.45,
    glow: 0.48,
  },
  error: {
    spin: 0.85,
    pulseAmp: 0.65,
    pulseHz: 2.1,
    flow: 1.7,
    ringSpeed: 1.15,
    ringOpacity: 0.62,
    particleSpeed: 1.05,
    particleBrightness: 0.88,
    glow: 1.0,
  },
  completed: {
    spin: 0.8,
    pulseAmp: 0.45,
    pulseHz: 0.75,
    flow: 0.95,
    ringSpeed: 1.45,
    ringOpacity: 0.92,
    particleSpeed: 1.35,
    particleBrightness: 1.0,
    glow: 1.0,
  },
};

/** 六状态的基准色（唯一色源：contracts.STATE_COLOR），在模块内预计算一次。 */
export interface StateColors {
  color: Color;
  accent: Color;
  rim: Color;
}

export function buildStateColors(): Record<OrbitAgentState, StateColors> {
  const table: Partial<Record<OrbitAgentState, StateColors>> = {};
  for (const state of Object.keys(STATE_COLOR) as OrbitAgentState[]) {
    const base = new Color(STATE_COLOR[state]);
    // accent：同色相略亮，用于能量丝与粒子高光。
    // 刻意只加 0.14 亮度：加太多会让球变成惨白的「泡泡糖」，丢掉深空感。
    const accent = base.clone().offsetHSL(0, -0.04, 0.14);
    // rim：同色相更饱和更亮，用于 Fresnel 边缘光。
    const rim = base.clone().offsetHSL(0, 0.08, 0.16);
    table[state] = { color: base, accent, rim };
  }
  return table as Record<OrbitAgentState, StateColors>;
}

/** 一帧要喂给 shader 的完整目标值（颜色 + 标量 + 包络）。 */
export interface OrbTargets {
  color: Color;
  accent: Color;
  rim: Color;
  spin: number;
  flow: number;
  ringSpeed: number;
  ringOpacity: number;
  particleSpeed: number;
  particleBrightness: number;
  glow: number;
  /** 呼吸/脉冲振幅（由 index.ts 用相位累加器变成 0..1 的包络）。 */
  pulseAmp: number;
  /** 脉冲频率（Hz），与振幅一起被平滑插值。 */
  pulseHz: number;
  /** error 警示闪 0..1（reduceMotion 恒为 0）。 */
  flash: number;
  /** completed 聚合爆发 0..1。 */
  burst: number;
  /** 活性强度 0..1（来自 OrbVisualState.intensity）。 */
  intensity: number;
  /** 闪烁权重：reduceMotion 时为 0，shader 据此去掉高频闪烁。 */
  flicker: number;
}

export function createTargets(): OrbTargets {
  return {
    color: new Color(0, 0, 0),
    accent: new Color(0, 0, 0),
    rim: new Color(0, 0, 0),
    spin: 0,
    flow: 0,
    ringSpeed: 0,
    ringOpacity: 0,
    particleSpeed: 0,
    particleBrightness: 0,
    glow: 0,
    pulseAmp: 0,
    pulseHz: 0,
    flash: 0,
    burst: 0,
    intensity: 0,
    flicker: 1,
  };
}

/** 状态切换的平滑时间常数：约 0.85s 达到目标值的 95%（落在 0.5–1.2s 区间）。 */
export const SMOOTH_TAU_SECONDS = 0.28;

/**
 * 与帧率无关的指数平滑系数 k = 1 - e^(-dt/tau)。
 * k=0 表示完全不动（不瞬变），dt 越大越接近 1。
 */
export function smoothingFactor(dt: number, tau = SMOOTH_TAU_SECONDS): number {
  if (!(dt > 0)) return 0;
  return 1 - Math.exp(-dt / Math.max(1e-4, tau));
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function smoothstep01(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * error 的「短促警示闪」：sin 取正后 14 次幂 → 极短尖峰。
 * reduceMotion 由调用方保证不调用（flicker=0），这里再兜一层，绝不闪。
 */
export function flashEnvelope(sinceSeconds: number, hz: number, enabled: boolean): number {
  if (!enabled || sinceSeconds <= 0) return 0;
  const wave = Math.sin(sinceSeconds * hz * Math.PI * 2);
  return Math.pow(Math.max(wave, 0), 14);
}

/**
 * completed 的「聚合 → 扩散 → 回落」：约 0.18s 冲到 1，
 * 之后按 0.45s 时间常数指数回落，约 1.8s 归零（视觉上是一次干净的爆发）。
 */
export function burstEnvelope(sinceSeconds: number): number {
  if (sinceSeconds <= 0) return 0;
  const rise = smoothstep01(0, 0.18, sinceSeconds);
  const decay = Math.exp(-Math.max(0, sinceSeconds - 0.18) / 0.45);
  return rise * decay;
}

/**
 * 计算这一帧的目标值。
 *
 * @param sinceSeconds 进入当前状态后经过的秒数（只在状态切换时重置）。
 */
export function resolveTargets(
  targets: OrbTargets,
  ui: OrbVisualState,
  quality: OrbQuality,
  baseColors: Record<OrbitAgentState, StateColors>,
  sinceSeconds: number,
): void {
  const motion = STATE_MOTION[ui.agentState];
  const colors = baseColors[ui.agentState];
  const reduce = quality.reduceMotion;

  // reduceMotion：转速降到 40%，脉冲、闪烁、警示闪全部归零。
  const speedScale = reduce ? 0.4 : 1;
  const intensity = clamp01(ui.intensity);

  targets.color.copy(colors.color);
  targets.accent.copy(colors.accent);
  targets.rim.copy(colors.rim);

  targets.spin = motion.spin * speedScale;
  targets.flow = motion.flow * speedScale * (0.75 + 0.5 * intensity);
  targets.ringSpeed = motion.ringSpeed * speedScale;
  targets.ringOpacity = motion.ringOpacity;
  targets.particleSpeed = motion.particleSpeed * speedScale * (0.65 + 0.7 * intensity);
  targets.particleBrightness = motion.particleBrightness * (0.7 + 0.5 * intensity);
  targets.glow = motion.glow;
  targets.intensity = intensity;
  targets.flicker = reduce ? 0 : 1;

  // 呼吸/脉冲：reduceMotion 时振幅为 0，即完全不脉冲；相位由 index.ts 累加，
  // 这样频率变化时相位连续、不会跳。
  targets.pulseAmp = reduce ? 0 : motion.pulseAmp * (0.7 + 0.6 * intensity);
  targets.pulseHz = motion.pulseHz;

  // error 才有警示闪；completed 才有爆发。
  targets.flash = ui.agentState === 'error' ? flashEnvelope(sinceSeconds, 2.4, !reduce) : 0;
  targets.burst = ui.agentState === 'completed' ? burstEnvelope(sinceSeconds) : 0;
}
