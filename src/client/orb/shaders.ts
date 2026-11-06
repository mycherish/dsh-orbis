/**
 * GLSL 源码（纯字符串，无副作用）。
 *
 * 设计原则：
 * - 全部为程序化材质，**不加载任何纹理**（无 CDN、无外部图片），因此 dispose 时
 *   只需释放 geometry / material。
 * - 顶点着色器里不使用 `#include <common>` 之类的大块 three chunk，唯一的 include
 *   是片元末尾的 `<colorspace_fragment>`：它负责把线性颜色转成输出色彩空间，
 *   少了它自定义 ShaderMaterial 的颜色会比内置材质偏暗。
 * - 所有 shader 都在「视图空间」算 Fresnel（vViewPos / normalMatrix），这样相机
 *   距离变化（76px 图标与 ~320px 主视图共用同一份资源）时边缘光强度稳定。
 */

/**
 * Ashima Arts / Stefan Gustavson 的 3D simplex noise（MIT）。
 * 直接在 GLSL 里实现，避免引入任何外部资源或额外 JS 噪声库。
 */
export const SIMPLEX_3D = /* glsl */ `
vec3 mod289_3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289_4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289_4(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289_3(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

/** 3 阶 fbm：比 4 阶更平滑，用来出「大块翻涌」的等离子体形状。 */
float fbm3(vec3 p) {
  float value = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    value += amp * snoise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return value;
}

/** 4 阶 fbm：需要更细碎细节时使用。 */
float fbm4(vec3 p) {
  float value = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amp * snoise(p);
    p *= 2.02;
    amp *= 0.5;
  }
  return value;
}
`;

/**
 * 中心能量球：顶点抖动 + 域扭曲 fbm 的「能量流动」，颜色随状态插值。
 *
 * uPulse 由外层按状态计算（呼吸 / 脉冲），uFlash 只给 error 用（短促警示闪），
 * uBurst 只给 completed 用（聚合扩散后回落）——三者都是 0..1 包络。
 */
export const CORE_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uFlow;
uniform float uDisplace;
uniform float uPulse;
uniform float uBurst;

varying vec3 vLocalDir;
varying vec3 vViewNormal;
varying vec3 vViewPos;

${SIMPLEX_3D}

void main() {
  vec3 dir = normalize(position);

  // 表面低频起伏：让能量体轮廓不呆板，但幅度刻意很小，保住「球」的读感。
  float n = snoise(dir * 2.1 + vec3(0.0, uTime * 0.18 * uFlow, uTime * 0.11));
  float disp = n * uDisplace * (0.55 + uPulse * 0.9) + uBurst * 0.10;

  vec3 displaced = position * (1.0 + disp);
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);

  vLocalDir = dir;
  vViewNormal = normalize(normalMatrix * normal);
  vViewPos = mv.xyz;

  gl_Position = projectionMatrix * mv;
}
`;

export const CORE_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uPulse;
uniform float uFlash;
uniform float uBurst;
uniform float uIntensity;
uniform float uFlicker;
uniform float uOpacity;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uRim;

varying vec3 vLocalDir;
varying vec3 vViewNormal;
varying vec3 vViewPos;

${SIMPLEX_3D}

void main() {
  vec3 dir = normalize(vLocalDir);
  float t = uTime * 1.0;

  // 域扭曲：先取一层低频噪声作为偏移，再取第二层 —— 得到大块缓慢翻涌的等离子体，
  // 而不是高频「雪花噪点」（后者会显得廉价）。
  vec3 p = dir * 0.95;
  vec3 warp = vec3(
    fbm3(p + vec3(0.0, t * 0.5, 0.0)),
    fbm3(p + vec3(t * 0.38, 2.7, 0.0)),
    fbm3(p + vec3(0.0, 5.1, t * 0.44))
  );
  float n = fbm3(p * 1.15 + warp * 1.3);

  // 能量丝：噪声零交叉处的细亮线 —— 阈值放宽到 *2.0，让丝更少更干净，
  // 否则高频噪声会糊成一层「毛」，看着廉价。
  float veins = pow(clamp(1.0 - abs(n) * 2.0, 0.0, 1.0), 4.5);
  // 发光团块：只让正半轴的高处发亮，形成大块明暗对比。
  float bands = smoothstep(0.15, 0.95, n);

  // 球体感：正对相机的中心压暗、掠射角变亮，避免读成一张贴图。
  float facing = clamp(abs(dot(normalize(vViewNormal), normalize(-vViewPos))), 0.0, 1.0);
  float rim = pow(1.0 - facing, 2.2);
  float volume = mix(0.32, 1.05, pow(1.0 - facing, 1.15));

  // 深空底色（同色相压到很暗）+ 状态色能量 + 亮丝 + 边缘光
  vec3 col = uColorA * 0.26;                                  // 深空底（不压到死黑）
  col += uColorB * bands * 0.50;                               // 能量主团块
  col += uRim * veins * (0.38 + 0.42 * uIntensity);             // 细亮丝
  col += uRim * rim * (0.22 + 0.40 * uPulse);                   // 边缘光
  // 正对相机的中心给一点内聚光，读作「体内有能量核心」而不是空心壳。
  col += uColorB * pow(facing, 8.0) * 0.12 * (0.6 + 0.6 * uIntensity);

  col *= volume;
  // 状态包络：呼吸 / 警示闪 / 完成爆发。
  col *= 0.82 + 0.22 * uPulse + 0.85 * uFlash + 0.55 * uBurst;
  col *= 0.86 + 0.16 * uIntensity;
  // 统一曝光：高活性状态（green/cyan）很容易糊成霓虹色块，这里压住。
  col *= 0.82;
  // 丝线的高频闪烁（reduceMotion 时 uFlicker=0，完全静止）
  col *= 1.0 + 0.06 * uFlicker * sin(t * 2.3 + n * 6.0);

  gl_FragColor = vec4(col, uOpacity);
  #include <colorspace_fragment>
}
`;

/** 外层玻璃壳：Fresnel 边缘发光 + 顶部高光 + 极低基色，双面渲染（背面给厚度）。 */
export const SHELL_VERTEX = /* glsl */ `
varying vec3 vViewNormal;
varying vec3 vViewPos;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewNormal = normalize(normalMatrix * normal);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

export const SHELL_FRAGMENT = /* glsl */ `
uniform vec3 uTint;
uniform vec3 uRim;
uniform float uBase;
uniform float uEdge;
uniform float uOpacity;
uniform float uPulse;

varying vec3 vViewNormal;
varying vec3 vViewPos;

void main() {
  vec3 n = normalize(vViewNormal);
  vec3 v = normalize(-vViewPos);

  // 取 abs 是为了让背面也同等发光（DoubleSide 时背面法线不会自动翻转）。
  float fres = pow(1.0 - clamp(abs(dot(n, v)), 0.0, 1.0), 3.0);

  // 视图空间里的固定「灯向」——纯装饰高光，不需要真实灯光。
  float spec = pow(max(dot(n, normalize(vec3(0.35, 0.75, 0.55))), 0.0), 28.0);

  vec3 col = mix(uTint, uRim, fres) * (0.75 + fres * 1.4 + spec * 1.6);
  float a = (uBase + fres * uEdge + spec * 0.25) * uOpacity * (0.85 + uPulse * 0.30);

  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
}
`;

/**
 * 新增的「发光 pass」：一块恒朝相机的加法混合方片，用两段衰减模拟 bloom 的观感。
 * quality.glow === false 时直接 visible=false，draw call 归零（不跑这条 pass）。
 */
export const GLOW_VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const GLOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;

varying vec2 vUv;

void main() {
  vec2 c = (vUv - 0.5) * 2.0;
  float r = clamp(length(c), 0.0, 1.0);

  float inner = pow(1.0 - r, 3.2);
  float halo = pow(1.0 - r, 8.0);
  float a = (inner * 0.16 + halo * 0.55) * uStrength;

  gl_FragColor = vec4(uColor, clamp(a, 0.0, 0.85));
  #include <colorspace_fragment>
}
`;

/**
 * 轨道环：LineLoop + 自定义 shader。
 * 环上的「亮点」由 uPhase 驱动（纯 shader 内计算），所以不同层的不同速度真的看得见
 * ——纯 LineLoop 绕自身法线自转在几何上是对称的、肉眼不可见。
 */
export const RING_VERTEX = /* glsl */ `
attribute float aAngle;
varying float vAngle;

void main() {
  vAngle = aAngle;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const RING_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uHot;
uniform float uPhase;
uniform float uTime;
uniform float uOpacity;

varying float vAngle;

void main() {
  float d = mod(vAngle - uPhase, 6.28318530718);

  float head = pow(max(cos(d), 0.0), 12.0);          // 前导亮弧
  float trail = pow(max(cos(d * 0.5 + 1.2), 0.0), 3.0); // 拖尾
  float breathe = 0.85 + 0.15 * sin(uTime * 1.3);     // 呼吸，避免死板

  vec3 col = mix(uColor, uHot, head);
  float a = uOpacity * (0.42 + 0.62 * trail + 1.35 * head) * breathe;

  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
}
`;

/**
 * 外围粒子：每个粒子按自己的速率绕 Y 轴缓慢流动（executing 时明显加快），
 * 圆形软点在片元里用 gl_PointCoord 画出来 —— 不需要任何贴图。
 */
export const PARTICLE_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
uniform float uBrightness;
uniform float uSpread;
uniform float uFlicker;
uniform float uScale;
uniform float uPixelRatio;
uniform float uRefDistance;

attribute float aSeed;
attribute float aScale;

varying float vAlpha;

void main() {
  vec3 p = position;

  // 每颗粒子有自己的角速度，整体就形成「流动」而不是刚体旋转。
  float ang = uTime * uSpeed * (0.35 + aSeed * 0.9);
  float s = sin(ang);
  float c = cos(ang);
  p.xz = mat2(c, -s, s, c) * p.xz;

  // 径向轻呼吸 + 状态带来的整体扩散（completed 时向外推开）。
  p *= uSpread * (1.0 + 0.06 * sin(uTime * uSpeed * 1.7 + aSeed * 6.2831));

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  // 透视衰减：用相机距离做基准，小画布 / 大画布上的点大小保持一致观感。
  gl_PointSize = uScale * aScale * uPixelRatio * (uRefDistance / max(-mv.z, 0.05));

  float flick = 0.45 + 0.55 * abs(sin(uTime * uSpeed * 1.6 + aSeed * 37.0));
  // uFlicker = 0 时（reduceMotion）完全去掉闪烁，只留恒定亮度。
  vAlpha = uBrightness * mix(1.0, flick, uFlicker) * (0.60 + 0.40 * aScale);
}
`;

export const PARTICLE_FRAGMENT = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;

varying float vAlpha;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;

  float a = smoothstep(1.0, 0.12, r) * vAlpha;
  if (a < 0.003) discard;

  vec3 col = mix(uColorA, uColorB, smoothstep(0.15, 1.0, r) * 0.85);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;
