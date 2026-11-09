import { describe, expect, it, vi } from 'vitest';
import { createOrbOwner } from '../src/client/orb-owner';
import type { CreateOrbRenderer, OrbQuality, OrbRenderer, OrbVisualState } from '../src/client/contracts';

const visual: OrbVisualState = { agentState: 'idle', activeTools: 0, intensity: 0.1, streaming: false };
const quality: OrbQuality = { fps: 30, particles: 'medium', rings: true, glow: true, reduceMotion: false };

/** A renderer stand-in that records every lifecycle call. */
function fakeRenderer() {
  return {
    setState: vi.fn(),
    setQuality: vi.fn(),
    start: vi.fn(),
    pause: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    fps: vi.fn(() => 30),
  } satisfies OrbRenderer;
}

function fakeCanvas(name: string): HTMLCanvasElement {
  return { name } as unknown as HTMLCanvasElement;
}

describe('orb owner: one renderer for the whole plugin', () => {
  it('creates the renderer once and starts it', () => {
    const renderer = fakeRenderer();
    const created: OrbRenderer[] = [];
    const create: CreateOrbRenderer = () => {
      created.push(renderer);
      return renderer;
    };
    const owner = createOrbOwner(create);
    owner.attach(fakeCanvas('launcher'), visual, quality);

    expect(created).toHaveLength(1);
    expect(owner.created).toBe(1);
    expect(owner.attached).toBe(true);
    expect(renderer.start).toHaveBeenCalledTimes(1);
  });

  /*
   * A renderer outliving its WebGL context used to be invisible: the frame loop
   * kept its rAF, `failed` stayed false, and the surfaces kept drawing an empty
   * box instead of their static fallback.
   */
  it('reports a lost context to its watchers and flips failed', () => {
    let report: (() => void) | undefined;
    const create: CreateOrbRenderer = (options) => {
      report = options.onUnavailable;
      return fakeRenderer();
    };
    const owner = createOrbOwner(create);
    const watcher = vi.fn();
    const unsubscribe = owner.watchUnavailable(watcher);

    owner.attach(fakeCanvas('hud'), visual, quality);
    expect(owner.failed).toBe(false);
    expect(report).toBeDefined();

    // The renderer reports the loss the way the real one does.
    report?.();
    expect(owner.failed).toBe(true);
    expect(watcher).toHaveBeenCalledTimes(1);

    // A watcher that threw must not stop the others.
    const other = vi.fn();
    owner.watchUnavailable(() => {
      throw new Error('a bad listener');
    });
    owner.watchUnavailable(other);
    report?.();
    expect(other).toHaveBeenCalledTimes(1);
    expect(watcher).toHaveBeenCalledTimes(2);

    // Unsubscribing stops that listener only.
    unsubscribe();
    report?.();
    expect(watcher).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(2);
  });

  it('re-binding the same canvas never builds a second renderer', () => {
    const renderer = fakeRenderer();
    const create = vi.fn(() => renderer);
    const owner = createOrbOwner(create);
    const canvas = fakeCanvas('hud');

    owner.attach(canvas, visual, quality);
    owner.attach(canvas, { ...visual, agentState: 'thinking' }, quality);

    expect(create).toHaveBeenCalledTimes(1);
    expect(owner.created).toBe(1);
    // The state still reaches the existing renderer.
    expect(renderer.setState).toHaveBeenLastCalledWith(expect.objectContaining({ agentState: 'thinking' }));
  });

  it('moving to another slot releases the old context before creating a new one', () => {
    const make = (): OrbRenderer => fakeRenderer();
    const create = vi.fn(() => make());
    const owner = createOrbOwner(create);

    owner.attach(fakeCanvas('launcher'), visual, quality);
    const first = create.mock.results[0]?.value as OrbRenderer;
    owner.attach(fakeCanvas('hud'), visual, quality);

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    // …but only one is alive at a time.
    expect(owner.attached).toBe(true);
  });

  it('reports a WebGL failure instead of throwing', () => {
    const owner = createOrbOwner(() => null);
    owner.attach(fakeCanvas('launcher'), visual, quality);
    expect(owner.failed).toBe(true);
    expect(owner.attached).toBe(false);
    expect(owner.fps()).toBe(0);
    // Lifecycle calls must stay safe with no renderer.
    expect(() => {
      owner.start();
      owner.pause();
      owner.resize();
      owner.update(visual, quality);
    }).not.toThrow();
  });

  it('disposes exactly once and forgets the canvas', () => {
    const renderer = fakeRenderer();
    const owner = createOrbOwner(() => renderer);
    owner.attach(fakeCanvas('workspace'), visual, quality);

    owner.detach();
    owner.detach();

    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(owner.attached).toBe(false);
    expect(owner.created).toBe(1);
  });

  it('never starts a renderer after the owner was released', () => {
    const renderer = fakeRenderer();
    const owner = createOrbOwner(() => renderer);
    owner.attach(fakeCanvas('hud'), visual, quality);
    owner.detach();
    owner.start();
    expect(renderer.start).toHaveBeenCalledTimes(1);
  });

  it('forwards updates and fps to the live renderer only', () => {
    const renderer = fakeRenderer();
    const owner = createOrbOwner(() => renderer);
    owner.attach(fakeCanvas('hud'), visual, quality);

    owner.update({ ...visual, intensity: 0.9 }, { ...quality, fps: 60 });
    expect(renderer.setState).toHaveBeenCalledTimes(1);
    expect(renderer.setQuality).toHaveBeenCalledWith(expect.objectContaining({ fps: 60 }));
    expect(owner.fps()).toBe(30);
  });
});
