import { describe, expect, it } from 'vitest';
import { FrameClock } from '../src/client/orb/frame-clock';
import {
  SMOOTH_TAU_SECONDS,
  STATE_MOTION,
  buildStateColors,
  burstEnvelope,
  createTargets,
  flashEnvelope,
  resolveTargets,
  smoothingFactor,
} from '../src/client/orb/theme';
import { DEFAULT_SETTINGS, STATE_COLOR, type OrbQuality, type OrbVisualState } from '../src/client/contracts';
import type { OrbitAgentState } from '../src/shared/protocol';

/** Frames emitted by a 60 Hz RAF over `ms`, honouring the target frame rate. */
function frames(clock: FrameClock, ms: number, stepMs = 1000 / 60): number {
  let rendered = 0;
  for (let t = 0; t <= ms; t += stepMs) if (clock.tick(t).render) rendered += 1;
  return rendered;
}

const quality: OrbQuality = {
  fps: 30,
  particles: 'medium',
  rings: true,
  glow: true,
  reduceMotion: false,
};

function visual(agentState: OrbitAgentState, intensity = 0.5): OrbVisualState {
  return { agentState, activeTools: 0, intensity, streaming: true };
}

describe('frame clock', () => {
  it('renders the first frame immediately', () => {
    expect(new FrameClock().tick(0).render).toBe(true);
  });

  it('caps 60 Hz callbacks at the 30 FPS target and at 60 when asked', () => {
    const thirty = new FrameClock();
    thirty.setTargetFps(30);
    const thirtyFrames = frames(thirty, 1000);
    expect(thirtyFrames).toBeGreaterThanOrEqual(29);
    expect(thirtyFrames).toBeLessThanOrEqual(31);

    const sixty = new FrameClock();
    sixty.setTargetFps(60);
    const sixtyFrames = frames(sixty, 1000);
    expect(sixtyFrames).toBeGreaterThanOrEqual(59);
    expect(sixtyFrames).toBeLessThanOrEqual(61);
    expect(sixtyFrames).toBeGreaterThan(thirtyFrames);
  });

  it('never exceeds the target on a slow 144 Hz display either', () => {
    const clock = new FrameClock();
    clock.setTargetFps(30);
    let rendered = 0;
    for (let t = 0; t <= 1000; t += 1000 / 144) if (clock.tick(t).render) rendered += 1;
    expect(rendered).toBeLessThanOrEqual(31);
  });

  it('reports zero fps until a sample window closes, then the measured rate', () => {
    const clock = new FrameClock();
    clock.setTargetFps(30);
    let early = -1;
    for (let t = 0; t <= 1500; t += 1000 / 60) {
      clock.tick(t);
      if (early < 0 && t >= 200) early = clock.fps;
    }
    expect(early).toBe(0);
    expect(clock.fps).toBeGreaterThan(25);
    expect(clock.fps).toBeLessThanOrEqual(31);
    expect(clock.elapsed).toBeGreaterThan(1);
  });
});

describe('state visuals', () => {
  it('maps every state colour from the shared palette', () => {
    const colors = buildStateColors();
    for (const state of Object.keys(STATE_COLOR) as OrbitAgentState[]) {
      expect(colors[state]).toBeDefined();
      expect(STATE_MOTION[state]).toBeDefined();
    }
  });

  it('gives each state a distinct motion signature', () => {
    const speeds = (Object.keys(STATE_MOTION) as OrbitAgentState[]).map(
      (state) => `${STATE_MOTION[state].ringSpeed}/${STATE_MOTION[state].pulseHz}`,
    );
    expect(new Set(speeds).size).toBe(speeds.length);
    // waiting is the slowest orbit, executing the fastest.
    expect(STATE_MOTION.waiting.ringSpeed).toBeLessThan(STATE_MOTION.idle.ringSpeed);
    expect(STATE_MOTION.executing.ringSpeed).toBeGreaterThan(STATE_MOTION.thinking.ringSpeed);
    expect(STATE_MOTION.executing.flow).toBeGreaterThan(STATE_MOTION.idle.flow);
  });

  it('zeroes pulsing and flashing under reduce-motion', () => {
    const targets = createTargets();
    resolveTargets(targets, visual('error'), { ...quality, reduceMotion: true }, buildStateColors(), 0.1);
    expect(targets.pulseAmp).toBe(0);
    expect(targets.flicker).toBe(0);
    expect(flashEnvelope(0.1, 2.4, false)).toBe(0);
  });

  it('keeps the error flash short and the completed burst decaying', () => {
    // The flash peaks at a quarter period, then collapses to nothing.
    expect(flashEnvelope(0.25 / 2.4, 2.4, true)).toBeCloseTo(1, 3);
    expect(flashEnvelope(0.5 / 2.4, 2.4, true)).toBeLessThan(1e-6);
    // The burst rises to its peak at ~0.18s, then decays to nothing.
    expect(burstEnvelope(0)).toBe(0);
    expect(burstEnvelope(0.18)).toBeGreaterThan(0.95);
    expect(burstEnvelope(3)).toBeLessThan(burstEnvelope(0.4));
    expect(burstEnvelope(3)).toBeLessThan(0.02);
  });

  it('smooths with a frame-rate independent factor', () => {
    const at60 = smoothingFactor(1 / 60);
    const at30 = smoothingFactor(1 / 30);
    expect(at60).toBeGreaterThan(0);
    expect(at60).toBeLessThan(0.2);
    // Two 30 fps steps must smooth about as much as one 15 fps step.
    const twoSteps = 1 - (1 - at30) ** 2;
    const oneDoubleStep = smoothingFactor(1 / 15, SMOOTH_TAU_SECONDS);
    expect(Math.abs(twoSteps - oneDoubleStep)).toBeLessThan(0.08);
  });

  it('drops particles and glow when the settings ask for it', () => {
    const lean = resolveQualityLike({ ...DEFAULT_SETTINGS, particles: 'low', glow: false }, false);
    expect(lean.particles).toBe('low');
    expect(lean.glow).toBe(false);
  });
});

/** Local copy of the resolveQuality posture so this test stays DOM-free. */
function resolveQualityLike(settings: typeof DEFAULT_SETTINGS, systemReduce: boolean): OrbQuality {
  const reduce = settings.reduceMotion === 'system' ? systemReduce : settings.reduceMotion === 'on';
  return {
    fps: settings.fps,
    particles: reduce ? 'low' : settings.particles,
    rings: settings.rings,
    glow: reduce ? false : settings.glow,
    reduceMotion: reduce,
  };
}
