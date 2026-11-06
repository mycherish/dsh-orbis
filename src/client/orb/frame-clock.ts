/**
 * 帧节流 + 帧率统计（纯逻辑，不碰 DOM / WebGL，因此可以在 Node 里直接单测）。
 *
 * 两个硬性要求都在这里保证：
 * 1. **绝不超 `quality.fps`**：用累计时间判断「距上一帧是否已够一个目标帧间隔」，
 *    不够就整帧跳过——跳过意味着连 `renderer.render()` 都不调用，GPU 不提交。
 *    （RAF 在 30fps 目标下会被自然降到「每两帧画一次」。）
 * 2. **fps 用 1 秒滑动窗口统计**：窗口走满 1s 重置，因此 Workspace 页脚读到的是
 *    最近一秒的实测值，而不是瞬时值。pause 后归零。
 */

/** 帧间隔容差（ms）：吸收 RAF 时间戳抖动（60Hz 下两帧可能是 33.2ms 而非 33.33ms），
 *  同时不会让实际帧率明显超过目标值。 */
const FRAME_EPSILON_MS = 0.6;
/** 单帧最大推进时间（秒）：切标签页回来时不要一步跳太远。 */
const MAX_DT_SECONDS = 0.1;
/** 滑动窗口长度（ms）。 */
const FPS_WINDOW_MS = 1000;
/** 窗口内至少积累这么久才给出估算值，避免刚启动时显示 0。 */
const FPS_MIN_SAMPLE_MS = 250;

export interface FrameTick {
  /** 这一帧是否要真正渲染（false = 整帧跳过，GPU 无提交）。 */
  render: boolean;
  /** 距上一帧的秒数，仅 render 为 true 时有意义（首帧为 0）。 */
  dt: number;
}

export class FrameClock {
  /** 目标帧间隔（ms）。 */
  private intervalMs = 1000 / 30;
  private hasFrame = false;
  private lastFrameAt = 0;
  private windowStart = 0;
  private windowFrames = 0;
  private fpsValue = 0;
  /** 累计动画时间（秒），只在真正渲染的帧上累加。 */
  private elapsedSeconds = 0;

  setTargetFps(fps: number): void {
    const safe = Number.isFinite(fps) && fps > 0 ? Math.min(120, fps) : 30;
    this.intervalMs = 1000 / safe;
  }

  /** 决定这一帧画不画，并推进内部计时。 */
  tick(now: number): FrameTick {
    if (!this.hasFrame) {
      // 第一帧立刻出图，动画时间从 0 开始（dt=0，避免首帧大跳）。
      this.hasFrame = true;
      this.lastFrameAt = now;
      this.windowStart = now;
      this.windowFrames = 1;
      this.fpsValue = 0;
      return { render: true, dt: 0 };
    }

    const sinceLast = now - this.lastFrameAt;
    if (sinceLast < this.intervalMs - FRAME_EPSILON_MS) {
      return { render: false, dt: 0 };
    }

    this.lastFrameAt = now;
    const dt = Math.min(sinceLast / 1000, MAX_DT_SECONDS);
    this.elapsedSeconds += dt;

    this.windowFrames += 1;
    const span = now - this.windowStart;
    if (span >= FPS_MIN_SAMPLE_MS) {
      this.fpsValue = (this.windowFrames * 1000) / span;
      if (span >= FPS_WINDOW_MS) {
        this.windowStart = now;
        this.windowFrames = 0;
      }
    }

    return { render: true, dt };
  }

  /** 累计动画时间（秒）；pause 期间不增长。 */
  get elapsed(): number {
    return this.elapsedSeconds;
  }

  /** 最近一秒的实测帧率（四舍五入）；未开始或已暂停时由调用方返回 0。 */
  get fps(): number {
    return Math.round(this.fpsValue);
  }

  /** start() 用：下一帧立刻渲染，帧率统计重新开始（不清动画时间）。 */
  restart(): void {
    this.hasFrame = false;
    this.lastFrameAt = 0;
    this.windowStart = 0;
    this.windowFrames = 0;
    this.fpsValue = 0;
  }

  /** pause() 用：帧率立即归零。 */
  stop(): void {
    this.hasFrame = false;
    this.windowStart = 0;
    this.windowFrames = 0;
    this.fpsValue = 0;
  }
}
