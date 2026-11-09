/**
 * The single owner of the plugin's one WebGL orb.
 *
 * v2.0 shipped three `useOrbRenderer` call sites (launcher, HUD, workspace) and
 * up to three live contexts. This class replaces them with one renderer that
 * follows whichever surface is currently mounted: the canvas element is created
 * once and *moved* between slots, so switching modes never creates a second
 * renderer and never re-creates a WebGL context.
 *
 * Invariants (all covered by `tests/orb-owner.test.ts`):
 *  - `attach()` creates at most one renderer for a given canvas;
 *  - attaching the same canvas twice is a no-op update, never a second create;
 *  - `detach()` disposes exactly once;
 *  - `created` counts real constructions, so "how many renderers exist" is
 *    answerable instead of guessed.
 */
import type { CreateOrbRenderer, OrbQuality, OrbRenderer, OrbVisualState } from './contracts';

export interface OrbOwner {
  /** Renderers constructed over this owner's lifetime (0 or 1 while attached). */
  readonly created: number;
  readonly attached: boolean;
  /** True when WebGL could not be created; the UI should draw its fallback. */
  readonly failed: boolean;
  /** Bind a canvas (creating the renderer once) or re-bind to a new one. */
  attach(canvas: HTMLCanvasElement, state: OrbVisualState, quality: OrbQuality): void;
  /** Update state/quality in place; never re-creates. */
  update(state: OrbVisualState, quality: OrbQuality): void;
  start(): void;
  pause(): void;
  resize(): void;
  /** Measured FPS, or 0 when nothing is running. */
  fps(): number;
  /**
   * Called when the attached renderer loses its WebGL context.
   *
   * The owner cannot rebuild the UI by itself, so it reports the loss and flips
   * `failed`, which is what makes the surfaces draw their static fallback.
   * Returns an unsubscribe.
   */
  watchUnavailable(listener: () => void): () => void;
  /** Dispose the renderer and forget the canvas. Idempotent. */
  detach(): void;
}

export function createOrbOwner(create: CreateOrbRenderer): OrbOwner {
  let renderer: OrbRenderer | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let created = 0;
  let failed = false;
  let disposed = false;
  const unavailableListeners = new Set<() => void>();

  /**
   * A renderer that outlives its context is now a dead weight: remember the
   * failure so a later `attach` reports it, and tell the mounted surfaces.
   */
  const markUnavailable = (): void => {
    failed = true;
    for (const listener of unavailableListeners) {
      try {
        listener();
      } catch {
        // One bad listener must not stop the rest from being told.
      }
    }
  };

  return {
    get created() {
      return created;
    },
    get attached() {
      return renderer !== null;
    },
    get failed() {
      return failed;
    },

    attach(nextCanvas: HTMLCanvasElement, state: OrbVisualState, quality: OrbQuality): void {
      if (renderer !== null) {
        if (canvas === nextCanvas) {
          // The same surface re-bound (e.g. a re-render): never build a second.
          renderer.setState(state);
          renderer.setQuality(quality);
          return;
        }
        // A different slot took over: release the old context first.
        renderer.dispose();
        renderer = null;
      }
      canvas = nextCanvas;
      created += 1;
      const created2 = create({ canvas: nextCanvas, state, quality, onUnavailable: markUnavailable });
      renderer = created2;
      failed = created2 === null;
      if (created2 !== null) {
        disposed = false;
        created2.start();
      }
    },

    update(state: OrbVisualState, quality: OrbQuality): void {
      renderer?.setState(state);
      renderer?.setQuality(quality);
    },

    start(): void {
      if (renderer === null || disposed) return;
      renderer.start();
    },

    pause(): void {
      renderer?.pause();
    },

    resize(): void {
      renderer?.resize();
    },

    fps(): number {
      return renderer === null ? 0 : renderer.fps();
    },

    watchUnavailable(listener: () => void): () => void {
      unavailableListeners.add(listener);
      return () => {
        unavailableListeners.delete(listener);
      };
    },

    detach(): void {
      if (renderer === null) {
        canvas = null;
        return;
      }
      renderer.dispose();
      renderer = null;
      canvas = null;
      disposed = true;
    },
  };
}
