/**
 * 外围粒子系统：一个 THREE.Points（**单 draw call**），
 * 位置固定烘焙在 buffer 里，流动/扩散/闪烁全在顶点着色器里算，CPU 每帧只写 uniform。
 *
 * 数量策略（spec：总粒子 < 500）：
 * - 一次性按 high 档分配 480 个顶点，切换档位只用 `setDrawRange` 改绘制数量，
 *   不重建 buffer、不增加 draw call：low 120 / medium 280 / high 480。
 * - 低档位真的少画顶点（顶点着色与点精灵填充都变少），不是只改透明度。
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial } from 'three';
import type { IUniform } from 'three';
import type { ParticleDensity } from '../contracts';
import { PARTICLE_FRAGMENT, PARTICLE_VERTEX } from './shaders';

/** 各档位实际绘制的粒子数（high 也必须 < 500）。 */
export const PARTICLE_COUNT: Record<ParticleDensity, number> = {
  low: 120,
  medium: 280,
  high: 480,
};

/**
 * 用 type alias（而不是 interface）声明：object type alias 会获得隐式索引签名，
 * 因此可以直接赋给 ShaderMaterial 需要的 `{ [uniform: string]: IUniform }`。
 */
export type ParticleUniforms = {
  uTime: IUniform<number>;
  uSpeed: IUniform<number>;
  uBrightness: IUniform<number>;
  uSpread: IUniform<number>;
  uFlicker: IUniform<number>;
  uScale: IUniform<number>;
  uPixelRatio: IUniform<number>;
  uRefDistance: IUniform<number>;
  uColorA: IUniform<Color>;
  uColorB: IUniform<Color>;
};

export interface ParticleField {
  points: Points<BufferGeometry, ShaderMaterial>;
  uniforms: ParticleUniforms;
  /** 按档位改绘制数量（幂等，可反复调用）。 */
  setDensity(density: ParticleDensity): void;
  /** 点大小与 devicePixelRatio 随画布尺寸/DPR 变化时更新。 */
  setViewport(pixelRatio: number, referenceDistance: number, minSide: number): void;
  dispose(): void;
}

/** 确定性 PRNG：同一版本每次渲染出的粒子分布一致，便于回归比对。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成粒子分布：主体是略扁的球壳（半径 1.30–1.98），
 * 另有一部分贴着赤道带，形成「星尘 + 轨道尘」两层观感。
 */
/** 粒子允许的最小/最大 3D 半径：最小值必须大于玻璃壳（1.09），否则会藏进球里。 */
const MIN_RADIUS = 1.24;
const MAX_RADIUS = 2.0;

function fillPositions(positions: Float32Array, seeds: Float32Array, scales: Float32Array, count: number): void {
  const random = mulberry32(0x9e3779b9);
  for (let i = 0; i < count; i += 1) {
    const inBand = random() < 0.28;
    let x = 0;
    let y = 0;
    let z = 0;

    if (inBand) {
      const angle = random() * Math.PI * 2;
      const radius = 1.25 + random() * 0.7;
      x = Math.cos(angle) * radius;
      z = Math.sin(angle) * radius;
      y = (random() - 0.5) * 0.22;
    } else {
      // 球面均匀采样（y 稍微压扁，避免看起来像标准球体）。
      const u = random() * 2 - 1;
      const theta = random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const radius = 1.3 + random() * 0.68;
      x = Math.cos(theta) * r * radius;
      y = u * radius * 0.82;
      z = Math.sin(theta) * r * radius;
    }

    // 压扁 y 之后极点附近的点会落进球体内部，统一夹到 [MIN_RADIUS, MAX_RADIUS]。
    const radius3d = Math.hypot(x, y, z);
    if (radius3d > 0) {
      const clamped = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius3d));
      const scale = clamped / radius3d;
      x *= scale;
      y *= scale;
      z *= scale;
    }

    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    seeds[i] = random();
    scales[i] = 0.6 + random() * 1.25;
  }
}

export function createParticleField(): ParticleField {
  const maxCount = PARTICLE_COUNT.high;

  const positions = new Float32Array(maxCount * 3);
  const seeds = new Float32Array(maxCount);
  const scales = new Float32Array(maxCount);
  fillPositions(positions, seeds, scales, maxCount);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
  geometry.setAttribute('aScale', new BufferAttribute(scales, 1));
  // 光晕点不需要按几何体做视锥剔除判断，直接给一个覆盖全场的包围球。
  geometry.boundingSphere = null;
  geometry.computeBoundingSphere();

  const uniforms: ParticleUniforms = {
    uTime: { value: 0 },
    uSpeed: { value: 0.4 },
    uBrightness: { value: 0.6 },
    uSpread: { value: 1 },
    uFlicker: { value: 1 },
    uScale: { value: 2 },
    uPixelRatio: { value: 1 },
    uRefDistance: { value: 5 },
    uColorA: { value: new Color('#ffffff') },
    uColorB: { value: new Color('#ffffff') },
  };

  const material = new ShaderMaterial({
    uniforms,
    vertexShader: PARTICLE_VERTEX,
    fragmentShader: PARTICLE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
  });

  const points = new Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 2;

  const setDensity = (density: ParticleDensity): void => {
    const count = PARTICLE_COUNT[density];
    // drawRange.count 决定真正提交的顶点数：低档位确实少画。
    geometry.setDrawRange(0, Math.min(count, maxCount));
  };
  setDensity('medium');

  return {
    points,
    uniforms,
    setDensity,
    setViewport(pixelRatio: number, referenceDistance: number, minSide: number): void {
      // 点大小跟画布最小边线性关联：76px 图标上是 1~1.5px 的星尘，
      // 320px 主视图上是 3~4px 的颗粒，两边观感一致。
      const scale = Math.min(2.1, Math.max(0.95, minSide * 0.0095));
      uniforms.uScale.value = scale;
      uniforms.uPixelRatio.value = pixelRatio;
      uniforms.uRefDistance.value = Math.max(0.5, referenceDistance);
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
      points.removeFromParent();
    },
  };
}
