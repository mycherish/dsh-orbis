/**
 * C1 (2.1.6): the orb must survive the master switch being turned off and on.
 *
 * The bug was a self-inflicted context loss. `dispose()` called
 * `renderer.forceContextLoss()`, and the canvas is a **singleton** the shell creates
 * once (`useMemo(() => document.createElement('canvas'), [])` in `layer.tsx`) and
 * moves between surfaces — it is not re-created when the master switch is toggled.
 * Turning the switch back on therefore hands the *same* canvas, whose context was
 * deliberately lost, to `createOrbRenderer` again.
 *
 * The decisive fact is a browser one, so it was measured in real Chrome rather than
 * assumed (headless, SwiftShader):
 *
 *   ::  canvas.getContext('webgl2')                 -> non-null
 *   ::  gl.getExtension('WEBGL_lose_context').loseContext()
 *   ::  gl.isContextLost()                          -> true
 *   ::  canvas.getContext('webgl2') again           -> non-null, SAME object
 *
 * So `hasWebGL()` — which only checks for non-null — reports `true` for a dead
 * canvas, and the renderer is built over a lost context: nothing is ever drawn
 * again and no `webglcontextlost` event fires a second time. Reproduce with:
 *
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --user-data-dir=/tmp/cprof --enable-unsafe-swiftshader \
 *     --dump-dom file:///tmp/c1probe.html
 *
 * jsdom has no WebGL, so this file pins the *code* requirement (never give the
 * context back while the canvas outlives the renderer) instead of pretending to
 * render. The real-browser switch cycle is a manual acceptance step.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The file with comments removed: a comment may name the call it forbids. */
const source = readFileSync('src/client/orb/index.ts', 'utf8');
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

describe('C1: the orb renderer never returns the context it does not own', () => {
  it('does not force a context loss in dispose()', () => {
    /*
     * `forceContextLoss()` frees the GPU context, but the canvas keeps pointing at
     * that dead context forever: `getContext` hands back the same lost object, so a
     * later renderer on the same canvas can never draw. Freeing resources is
     * `renderer.dispose()`'s job; the context goes away with the canvas.
     */
    expect(code).not.toContain('forceContextLoss');
  });

  it('still releases geometry, materials and the draw lists', () => {
    expect(source).toContain('renderer.renderLists.dispose()');
    expect(source).toContain('renderer.dispose()');
    expect(source).toContain('orbScene.dispose()');
    expect(source).toContain('particleField.dispose()');
  });

  it('keeps the context-loss handler, which is a different situation', () => {
    // A *browser-initiated* loss (GPU reset, sleep/wake) must still pause the loop
    // and tell the surfaces to draw their fallback — that guard is unrelated to C1.
    expect(source).toContain("canvas.addEventListener('webglcontextlost'");
    expect(source).toContain('event.preventDefault()');
  });
});
