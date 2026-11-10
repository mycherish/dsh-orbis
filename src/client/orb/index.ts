/**
 * Caelum Orbis 的 3D 能量球渲染器（Deep Space · Glass · Energy Orb）。
 *
 * 入口导出 `createOrbRenderer: CreateOrbRenderer`，实现见本文件。
 * 模块级**没有任何** DOM / WebGL 访问：所有 canvas、renderer、几何体都在
 * `createOrbRenderer()` 内部创建，因此可以被安全地 import 到无 DOM 的环境里做类型/
 * 纯函数测试。
 *
 * 结构：
 * - theme.ts     状态 → 颜色 / 运动参数的映射（纯数据，零 three 对象）
 * - shaders.ts   自定义 GLSL（核心球 / 玻璃壳 / 柔光 / 轨道环 / 粒子）
 * - scene.ts     几何体与材质装配
 * - particles.ts 粒子场（单 draw call，按档位改绘制数量）
 * - index.ts     生命周期、帧率节流、状态平滑插值（本文件）
 */
import { PerspectiveCamera, Scene, SRGBColorSpace, WebGLRenderer } from 'three';
import type {
  CreateOrbRenderer,
  OrbQuality,
  OrbRenderer,
  OrbRendererOptions,
  OrbVisualState,
} from '../contracts';
import type { OrbitAgentState } from '../../shared/protocol';
import { FrameClock } from './frame-clock';
import { createParticleField } from './particles';
import type { ParticleField } from './particles';
import { createOrbScene } from './scene';
import type { OrbScene } from './scene';
import { buildStateColors, clamp01, createTargets, resolveTargets, smoothingFactor } from './theme';
import type { OrbTargets, StateColors } from './theme';

/** 相机竖直视场角（度）。固定值，取景只靠相机距离适配。 */
const CAMERA_FOV = 40;
/** 需要完整入画的取景半径：包住 1.66 的轨道环，粒子外缘允许轻微出画。 */
const CONTENT_RADIUS = 1.8;
/** devicePixelRatio 硬上限（spec §2.6）。 */
const MAX_PIXEL_RATIO = 1.5;

/** 与 WebGLRenderer 参数保持一致的上下文属性：探测与真正创建必须一致。 */
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: true,
  depth: true,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: 'low-power',
  failIfMajorPerformanceCaveat: false,
};

/** 全局只警告一次，避免控制台刷屏。 */
let warnedUnavailable = false;

function warnUnavailable(reason: string): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  // 唯一允许的控制台输出：宿主据此回退到静态状态展示。
  console.warn(`[orbis] WebGL 不可用，已回退到静态展示：${reason}`);
}

/**
 * 先用真实 canvas 探测上下文，再交给 three 创建 renderer。
 *
 * 这样做的原因：three 在拿不到上下文时会先 console.error 再抛异常；
 * 先把上下文建出来，three 会复用同一个上下文（浏览器对同类型 getContext 返回同一对象），
 * 我们就能在「完全静默」的前提下判断可用性。
 */
function hasWebGL(canvas: HTMLCanvasElement): boolean {
  try {
    const gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
    return gl !== null;
  } catch {
    return false;
  }
}

function sanitizeQuality(quality: OrbQuality): OrbQuality {
  const fps = Number.isFinite(quality.fps) ? Math.min(120, Math.max(1, quality.fps)) : 30;
  const particles =
    quality.particles === 'low' || quality.particles === 'high' ? quality.particles : 'medium';
  return {
    fps,
    particles,
    rings: quality.rings !== false,
    glow: quality.glow !== false,
    reduceMotion: quality.reduceMotion === true,
  };
}

export const createOrbRenderer: CreateOrbRenderer = (options: OrbRendererOptions): OrbRenderer | null => {
  const { canvas } = options;

  if (!hasWebGL(canvas)) {
    warnUnavailable('canvas.getContext("webgl2") 返回 null');
    return null;
  }

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: false,
    });
  } catch (error) {
    warnUnavailable(error instanceof Error ? error.message : 'WebGLRenderer 构造失败');
    return null;
  }

  // ---- 渲染状态 ---------------------------------------------------------
  renderer.outputColorSpace = SRGBColorSpace;
  // 不启用色调映射：颜色由 shader 手工调好，加 ACES 反而会把霓虹压灰。
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);
  camera.position.set(0, 0, 5);

  let parts: OrbScene | null = null;
  let particles: ParticleField | null = null;
  try {
    parts = createOrbScene();
    particles = createParticleField();
    scene.add(parts.spinGroup);
    scene.add(parts.glow);
    scene.add(particles.points);
  } catch (error) {
    // 极端情况下（例如上下文刚被回收）也要安静地回退。
    parts?.dispose();
    particles?.dispose();
    renderer.dispose();
    warnUnavailable(error instanceof Error ? error.message : '场景构建失败');
    return null;
  }

  const orbScene = parts;
  const particleField = particles;

  // ---- 可变状态 ---------------------------------------------------------
  let ui: OrbVisualState = {
    agentState: options.state.agentState,
    activeTools: options.state.activeTools,
    intensity: clamp01(options.state.intensity),
    streaming: options.state.streaming,
  };
  let quality = sanitizeQuality(options.quality);

  let disposed = false;
  let running = false;
  let rafId: number | null = null;
  /** 帧节流与 fps 统计；动画时间也在它里面（只在真正渲染的帧上增长）。 */
  const clock = new FrameClock();
  clock.setTargetFps(options.quality.fps);
  let stateEnteredAt = 0;
  let spinAngle = 0;
  let pulsePhase = 0;

  /** 上次成功测量（CSS 像素）与被压到上限的像素比。fromLayout 表示尺寸来自真实布局。 */
  const size = { width: 0, height: 0, pixelRatio: 0, fromLayout: false };
  /** 尚未拿到真实布局尺寸时，最多每 250ms 重新探一次（避免每帧强制重排）。 */
  let nextSizeProbeAt = 0;

  const baseColors: Record<OrbitAgentState, StateColors> = buildStateColors();
  const target: OrbTargets = createTargets();
  const current: OrbTargets = createTargets();

  // 初始帧直接就位，避免从全黑渐变进来。
  resolveTargets(target, ui, quality, baseColors, 0);
  current.color.copy(target.color);
  current.accent.copy(target.accent);
  current.rim.copy(target.rim);
  current.spin = target.spin;
  current.flow = target.flow;
  current.ringSpeed = target.ringSpeed;
  current.ringOpacity = target.ringOpacity;
  current.particleSpeed = target.particleSpeed;
  current.particleBrightness = target.particleBrightness;
  current.glow = target.glow;
  current.pulseAmp = target.pulseAmp;
  current.pulseHz = target.pulseHz;
  current.intensity = target.intensity;
  current.flicker = target.flicker;

  // ---- 尺寸 / 取景 -----------------------------------------------------
  /**
   * 量画布尺寸（CSS 像素）。
   *
   * 关键教训：**绝不能拿 canvas.width/height 当 CSS 尺寸兜底** —— 那是设备像素的后备
   * 缓冲尺寸（three 默认 300×150，且会被 pixelRatio 放大），拿它当 CSS 尺寸会把相机
   * 宽高比做错（球变椭圆）。所以顺序是：布局尺寸 → 上次测量值 → 一个「正方形」保守估计。
   */
  const readSize = (): { width: number; height: number; fromLayout: boolean } => {
    // 以 clientWidth/Height（布局盒）为准：它不含 CSS transform，
    // 因此即便宿主给悬浮图标加了缩放动画，后备缓冲也不会被“视觉尺寸”污染。
    const width = canvas.clientWidth > 0 ? canvas.clientWidth : canvas.getBoundingClientRect().width;
    const height = canvas.clientHeight > 0 ? canvas.clientHeight : canvas.getBoundingClientRect().height;
    if (width > 0 && height > 0) return { width, height, fromLayout: true };
    // 还没布局（未挂载 / display:none / 刚插入文档）：沿用上次测量值。
    if (size.width > 0 && size.height > 0) {
      return { width: size.width, height: size.height, fromLayout: size.fromLayout };
    }
    // 从未测量过：把后备缓冲边长换算回 CSS 像素，取一个正方形作为临时估计。
    // 只要拿到真实布局，下一帧就会修正（见 frame 里的按需复查）。
    const ratio = Math.min(
      MAX_PIXEL_RATIO,
      typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1,
    );
    const side = Math.max(1, Math.round(Math.max(canvas.width, canvas.height) / ratio));
    return { width: side, height: side, fromLayout: false };
  };

  const applySize = (): void => {
    if (disposed) return;
    const measured = readSize();
    const width = Math.max(1, Math.round(measured.width));
    const height = Math.max(1, Math.round(measured.height));
    const deviceRatio = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const pixelRatio = Math.min(MAX_PIXEL_RATIO, deviceRatio);

    if (size.width !== width || size.height !== height || size.pixelRatio !== pixelRatio) {
      size.width = width;
      size.height = height;
      size.pixelRatio = pixelRatio;
      // updateStyle = false：CSS 尺寸由宿主决定，渲染器只改后备缓冲。
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
    }

    const aspect = width / height;
    const halfVertical = Math.tan((CAMERA_FOV * Math.PI) / 360);
    // 窄画布（竖长/正方小图标）按水平方向取景，保证球不被裁掉。
    const distance = Math.max(CONTENT_RADIUS / halfVertical, CONTENT_RADIUS / (halfVertical * aspect)) * 1.03;
    if (camera.aspect !== aspect || camera.position.z !== distance) {
      camera.aspect = aspect;
      camera.position.set(0, 0, distance);
      camera.updateProjectionMatrix();
    }

    size.fromLayout = measured.fromLayout;
    particleField.setViewport(pixelRatio, camera.position.z, Math.min(width, height));
  };

  // ---- 每帧更新 ---------------------------------------------------------
  const applyVisuals = (dt: number): void => {
    const time = clock.elapsed;
    const sinceStateChange = Math.max(0, time - stateEnteredAt);
    resolveTargets(target, ui, quality, baseColors, sinceStateChange);

    // 指数平滑：与帧率无关，状态切换在 ~0.85s 内到位，绝不瞬变。
    const k = smoothingFactor(dt);
    current.color.lerp(target.color, k);
    current.accent.lerp(target.accent, k);
    current.rim.lerp(target.rim, k);
    current.spin += (target.spin - current.spin) * k;
    current.flow += (target.flow - current.flow) * k;
    current.ringSpeed += (target.ringSpeed - current.ringSpeed) * k;
    current.ringOpacity += (target.ringOpacity - current.ringOpacity) * k;
    current.particleSpeed += (target.particleSpeed - current.particleSpeed) * k;
    current.particleBrightness += (target.particleBrightness - current.particleBrightness) * k;
    current.glow += (target.glow - current.glow) * k;
    current.pulseAmp += (target.pulseAmp - current.pulseAmp) * k;
    current.pulseHz += (target.pulseHz - current.pulseHz) * k;
    current.intensity += (target.intensity - current.intensity) * k;
    current.flicker += (target.flicker - current.flicker) * k;

    // 呼吸相位用累加器（频率平滑变化时相位连续，不会跳）。
    pulsePhase += dt * current.pulseHz * Math.PI * 2;
    const pulseWave = 0.5 + 0.5 * Math.sin(pulsePhase);
    // 注：intensity 已在 theme.resolveTargets 里折进 pulseAmp，这里不再重复相乘。
    const pulse = current.pulseAmp * (0.55 + 0.45 * pulseWave);
    const flash = target.flash;
    const burst = target.burst;

    // 整体缓慢自转
    spinAngle += dt * current.spin;

    // 中心能量球
    const coreUniforms = orbScene.coreUniforms;
    coreUniforms.uTime.value = time;
    coreUniforms.uFlow.value = current.flow;
    coreUniforms.uDisplace.value = 0.02 + 0.03 * current.intensity;
    coreUniforms.uPulse.value = pulse;
    coreUniforms.uFlash.value = flash;
    coreUniforms.uBurst.value = burst;
    coreUniforms.uIntensity.value = current.intensity;
    coreUniforms.uFlicker.value = current.flicker;
    coreUniforms.uColorA.value.copy(current.color);
    coreUniforms.uColorB.value.copy(current.accent);
    coreUniforms.uRim.value.copy(current.rim);
    orbScene.core.rotation.set(spinAngle * 0.16, spinAngle * 0.42, spinAngle * 0.05);
    const coreScale = 1 + 0.03 * pulse + 0.12 * burst + 0.02 * flash;
    orbScene.core.scale.setScalar(coreScale);

    // 玻璃壳：反向慢转 + 跟随呼吸轻微膨胀，读作「一层壳」而不是第二颗球
    const shellUniforms = orbScene.shellUniforms;
    shellUniforms.uTint.value.copy(current.color).multiplyScalar(0.35);
    shellUniforms.uRim.value.copy(current.rim);
    shellUniforms.uPulse.value = pulse;
    shellUniforms.uOpacity.value = 0.85 + 0.15 * current.intensity;
    shellUniforms.uEdge.value = 0.55 + 0.2 * current.intensity;
    orbScene.shell.rotation.set(-spinAngle * 0.09, -spinAngle * 0.2, 0);
    orbScene.shell.scale.setScalar(1 + 0.018 * pulse + 0.06 * burst);

    // 柔光（glow pass）：quality.glow === false 时 visible=false，本段只写 uniform 不提交。
    const glowUniforms = orbScene.glowUniforms;
    glowUniforms.uColor.value.copy(current.accent);
    glowUniforms.uStrength.value =
      current.glow * (0.55 + 0.5 * current.intensity + 0.6 * pulse + 0.9 * flash + 0.5 * burst);
    orbScene.glow.scale.setScalar(1 + 0.06 * pulse + 0.14 * burst);

    // 轨道环
    if (quality.rings) {
      for (const ring of orbScene.rings) {
        ring.phase += dt * ring.speed * current.ringSpeed;
        ring.uniforms.uPhase.value = ring.phase;
        ring.uniforms.uTime.value = time;
        ring.uniforms.uOpacity.value = ring.opacity * current.ringOpacity;
        ring.uniforms.uColor.value.copy(current.color);
        ring.uniforms.uHot.value.copy(current.accent);
        // 轻微进动，让环面不是完全静止的平面
        ring.group.rotation.y += dt * 0.1 * current.spin;
      }
    }

    // 外围粒子
    const particleUniforms = particleField.uniforms;
    particleUniforms.uTime.value = time;
    particleUniforms.uSpeed.value = current.particleSpeed;
    particleUniforms.uBrightness.value = current.particleBrightness;
    particleUniforms.uSpread.value = 1 + 0.05 * pulse + 0.18 * burst;
    particleUniforms.uFlicker.value = current.flicker;
    particleUniforms.uColorA.value.copy(current.color);
    particleUniforms.uColorB.value.copy(current.accent);
  };

  // ---- 帧循环（FrameClock 做累计时间节流，绝不超 quality.fps）-------------
  const frame = (now: number): void => {
    if (!running || disposed) {
      rafId = null;
      return;
    }
    rafId = requestAnimationFrame(frame);

    // 若创建时画布还没进入布局，这里自发复查并在拿到真实尺寸后修正宽高比，
    // 不依赖宿主一定会调用 resize()。
    if (!size.fromLayout && now >= nextSizeProbeAt) {
      nextSizeProbeAt = now + 250;
      applySize();
    }

    const tick = clock.tick(now);
    // render=false 时整帧跳过：既不动 uniform，也不提交 GPU 工作。
    if (!tick.render) return;

    applyVisuals(tick.dt);
    renderer.render(scene, camera);
  };

  /**
   * 画质开关落到场景上：
   * - rings=false → 三层环的 Group 全部 visible=false，draw call 归零；
   * - glow=false  → 柔光片 visible=false，这条额外发光 pass 完全不跑；
   * - particles   → 改 Points 的 drawRange，低档位真的少画顶点。
   */
  const applyQualitySettings = (): void => {
    for (const ring of orbScene.rings) ring.group.visible = quality.rings;
    orbScene.glow.visible = quality.glow;
    particleField.setDensity(quality.particles);
  };

  // ---- 首次布局 ---------------------------------------------------------
  applySize();
  applyQualitySettings();

  /**
   * 上下文丢失（GPU 进程崩溃、驱动重置、macOS 睡眠唤醒、显存压力）之后，
   * 这个 renderer 再也画不出东西了。
   *
   * 必须 `preventDefault()`，否则浏览器不会再尝试恢复；同时停掉帧循环——
   * 否则 rAF 会一直空转在一个已经死掉的上下文上，而界面只看到一块空白。
   * 恢复（`webglcontextrestored`）不在这里处理：重建整个场景交给宿主重新
   * attach 更可靠，这里只负责如实上报「画不了了」。
   */
  let detachContextGuard: (() => void) | null = null;
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    api.pause();
    options.onUnavailable?.();
  };

  const api: OrbRenderer = {
    setState(next: OrbVisualState): void {
      if (disposed) return;
      const changed = next.agentState !== ui.agentState;
      ui = {
        agentState: next.agentState,
        activeTools: next.activeTools,
        intensity: clamp01(next.intensity),
        streaming: next.streaming,
      };
      // 状态切换只重置包络计时（error 闪烁 / completed 爆发的起点），
      // 颜色与速度由 applyVisuals 里的指数插值自然过渡。
      if (changed) stateEnteredAt = clock.elapsed;
    },

    setQuality(next: OrbQuality): void {
      if (disposed) return;
      const previous = quality;
      quality = sanitizeQuality(next);

      // 关掉环 / 柔光时直接改可见性：draw call 真实减少，且不跑那条 pass。
      applyQualitySettings();

      if (previous.fps !== quality.fps) clock.setTargetFps(quality.fps);
      if (previous.reduceMotion !== quality.reduceMotion) {
        // 让 reduceMotion 立刻影响闪烁系数（不必等插值到位）。
        current.flicker = quality.reduceMotion ? 0 : current.flicker;
      }
    },

    start(): void {
      if (disposed || running) return;
      running = true;
      applySize();
      clock.restart();
      if (rafId === null) rafId = requestAnimationFrame(frame);
    },

    pause(): void {
      running = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      // 暂停即视为「没有帧率」：Workspace 页脚据此显示 0。
      clock.stop();
    },

    resize(): void {
      applySize();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      running = false;
      detachContextGuard?.();
      detachContextGuard = null;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      clock.stop();

      scene.remove(orbScene.spinGroup);
      scene.remove(orbScene.glow);
      scene.remove(particleField.points);
      orbScene.dispose();
      particleField.dispose();
      scene.clear();

      renderer.renderLists.dispose();
      renderer.dispose();
      try {
        // 尽量把 GPU 上下文也还回去（76px 图标会反复挂载/卸载）。
        renderer.forceContextLoss();
      } catch {
        // 某些环境不允许主动丢上下文，忽略即可：dispose 已完成主要释放工作。
      }
    },

    fps(): number {
      if (disposed || !running) return 0;
      return clock.fps;
    },
  };

  canvas.addEventListener('webglcontextlost', onContextLost);
  detachContextGuard = () => canvas.removeEventListener('webglcontextlost', onContextLost);

  return api;
};
