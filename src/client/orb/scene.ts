/**
 * 场景装配：中心能量球（自定义 ShaderMaterial）+ 外层玻璃壳 + 外围柔光片 + 多层轨道环。
 *
 * 这里只负责「造对象 / 暴露 uniform」，不含任何动画逻辑；动画与生命周期在 index.ts。
 * 所有几何体/材质都在 `dispose()` 里显式释放（本模块不加载任何纹理，故无 texture 需要释放）。
 *
 * 尺寸假设：核心球半径 1.0、玻璃壳 1.09、环 1.20–1.66、粒子 1.30–1.98，
 * 相机取景半径 1.80（见 index.ts 的 CONTENT_RADIUS）。整组按这个基准等比缩放，
 * 因此画布是 76px 还是 320px 都不需要改这里。
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LineLoop,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
} from 'three';
import type { IUniform } from 'three';
import {
  CORE_FRAGMENT,
  CORE_VERTEX,
  GLOW_FRAGMENT,
  GLOW_VERTEX,
  RING_FRAGMENT,
  RING_VERTEX,
  SHELL_FRAGMENT,
  SHELL_VERTEX,
} from './shaders';

export type CoreUniforms = {
  uTime: IUniform<number>;
  uFlow: IUniform<number>;
  uDisplace: IUniform<number>;
  uPulse: IUniform<number>;
  uFlash: IUniform<number>;
  uBurst: IUniform<number>;
  uIntensity: IUniform<number>;
  uFlicker: IUniform<number>;
  uOpacity: IUniform<number>;
  uColorA: IUniform<Color>;
  uColorB: IUniform<Color>;
  uRim: IUniform<Color>;
};

export type ShellUniforms = {
  uTint: IUniform<Color>;
  uRim: IUniform<Color>;
  uBase: IUniform<number>;
  uEdge: IUniform<number>;
  uOpacity: IUniform<number>;
  uPulse: IUniform<number>;
};

export type GlowUniforms = {
  uColor: IUniform<Color>;
  uStrength: IUniform<number>;
};

export type RingUniforms = {
  uColor: IUniform<Color>;
  uHot: IUniform<Color>;
  uPhase: IUniform<number>;
  uTime: IUniform<number>;
  uOpacity: IUniform<number>;
};

/** 一层轨道环。`phase` 每帧按 `speed * 状态倍率` 推进，亮点就绕着环跑。 */
export interface RingLayer {
  group: Group;
  line: LineLoop<BufferGeometry, ShaderMaterial>;
  uniforms: RingUniforms;
  /** 本层基础角速度（rad/s），各层不同。 */
  speed: number;
  /** 本层不透明度基准，各层不同。 */
  opacity: number;
  phase: number;
}

export interface OrbScene {
  /** 缓慢自转的组：核心球 + 玻璃壳 + 轨道环（柔光片与粒子不在其中）。 */
  spinGroup: Group;
  core: Mesh<SphereGeometry, ShaderMaterial>;
  shell: Mesh<SphereGeometry, ShaderMaterial>;
  glow: Mesh<PlaneGeometry, ShaderMaterial>;
  rings: RingLayer[];
  coreUniforms: CoreUniforms;
  shellUniforms: ShellUniforms;
  glowUniforms: GlowUniforms;
  dispose(): void;
}

/** 三层环：半径、倾角、速度、透明度都不同（细线感来自 LineLoop 恒 1px）。 */
const RING_LAYERS = [
  // tiltX 越接近 0 越「正对相机」（圆），越接近 PI/2 越「侧视」（细线）。
  { radius: 1.2, tiltX: 0.34, tiltZ: 0.2, speed: 0.62, opacity: 0.95 },
  { radius: 1.44, tiltX: 1.12, tiltZ: -0.3, speed: -0.44, opacity: 0.72 },
  { radius: 1.66, tiltX: 0.72, tiltZ: 1.02, speed: 0.28, opacity: 0.58 },
] as const;

/** 圆环几何：XY 平面上的 LineLoop，额外带一个 aAngle 供 shader 计算亮点。 */
function createRingGeometry(radius: number, segments: number): BufferGeometry {
  const positions = new Float32Array(segments * 3);
  const angles = new Float32Array(segments);
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = Math.sin(angle) * radius;
    positions[i * 3 + 2] = 0;
    angles[i] = angle;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aAngle', new BufferAttribute(angles, 1));
  return geometry;
}

export function createOrbScene(): OrbScene {
  const spinGroup = new Group();

  // ---- 中心能量球 -------------------------------------------------------
  const coreUniforms: CoreUniforms = {
    uTime: { value: 0 },
    uFlow: { value: 0.5 },
    uDisplace: { value: 0.035 },
    uPulse: { value: 0 },
    uFlash: { value: 0 },
    uBurst: { value: 0 },
    uIntensity: { value: 0.5 },
    uFlicker: { value: 1 },
    uOpacity: { value: 1 },
    uColorA: { value: new Color('#0a1830') },
    uColorB: { value: new Color('#42a5ff') },
    uRim: { value: new Color('#8fd0ff') },
  };
  const coreGeometry = new SphereGeometry(1, 48, 36);
  const coreMaterial = new ShaderMaterial({
    uniforms: coreUniforms,
    vertexShader: CORE_VERTEX,
    fragmentShader: CORE_FRAGMENT,
  });
  const core = new Mesh(coreGeometry, coreMaterial);
  core.frustumCulled = false;
  spinGroup.add(core);

  // ---- 玻璃壳 ----------------------------------------------------------
  const shellUniforms: ShellUniforms = {
    uTint: { value: new Color('#16223b') },
    uRim: { value: new Color('#9fd8ff') },
    uBase: { value: 0.06 },
    uEdge: { value: 0.5 },
    uOpacity: { value: 1 },
    uPulse: { value: 0 },
  };
  const shellGeometry = new SphereGeometry(1.09, 40, 28);
  const shellMaterial = new ShaderMaterial({
    uniforms: shellUniforms,
    vertexShader: SHELL_VERTEX,
    fragmentShader: SHELL_FRAGMENT,
    transparent: true,
    // 半透明 + 不写深度：背面透过来，读作「玻璃」而不是「实心壳」。
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    blending: NormalBlending,
  });
  const shell = new Mesh(shellGeometry, shellMaterial);
  shell.frustumCulled = false;
  shell.renderOrder = 1;
  spinGroup.add(shell);

  // ---- 外围柔光（glow pass；quality.glow === false 时 visible=false）------
  const glowUniforms: GlowUniforms = {
    uColor: { value: new Color('#42a5ff') },
    uStrength: { value: 0.6 },
  };
  const glowGeometry = new PlaneGeometry(4.4, 4.4);
  const glowMaterial = new ShaderMaterial({
    uniforms: glowUniforms,
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
  });
  const glow = new Mesh(glowGeometry, glowMaterial);
  glow.frustumCulled = false;
  // 稍微退到球心之后：加法混合时中间部分会被不透明核心球遮住，只留外圈光晕。
  glow.position.set(0, 0, -0.06);
  glow.renderOrder = 0;

  // ---- 多层轨道环 -------------------------------------------------------
  const rings: RingLayer[] = [];
  for (const layer of RING_LAYERS) {
    const uniforms: RingUniforms = {
      uColor: { value: new Color('#2d6db8') },
      uHot: { value: new Color('#cfe9ff') },
      uPhase: { value: 0 },
      uTime: { value: 0 },
      uOpacity: { value: layer.opacity },
    };
    const geometry = createRingGeometry(layer.radius, 160);
    const material = new ShaderMaterial({
      uniforms,
      vertexShader: RING_VERTEX,
      fragmentShader: RING_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
    });
    const line = new LineLoop(geometry, material);
    line.frustumCulled = false;
    line.renderOrder = 3;

    // 每层套一个 Group 单独设置倾角，方便后续做进动而不再动几何体。
    const group = new Group();
    group.rotation.set(layer.tiltX, 0, layer.tiltZ);
    group.add(line);
    spinGroup.add(group);

    rings.push({ group, line, uniforms, speed: layer.speed, opacity: layer.opacity, phase: 0 });
  }

  return {
    spinGroup,
    core,
    shell,
    glow,
    rings,
    coreUniforms,
    shellUniforms,
    glowUniforms,
    dispose(): void {
      coreGeometry.dispose();
      coreMaterial.dispose();
      shellGeometry.dispose();
      shellMaterial.dispose();
      glowGeometry.dispose();
      glowMaterial.dispose();
      for (const ring of rings) {
        ring.line.geometry.dispose();
        ring.line.material.dispose();
        ring.group.removeFromParent();
      }
      rings.length = 0;
      spinGroup.clear();
      spinGroup.removeFromParent();
      glow.removeFromParent();
    },
  };
}
