/**
 * Text contrast, computed from the stylesheets the plugin actually ships.
 *
 * The palette was picked by eye against a design spec, and by eye every label
 * looked fine — `labelDim` (#93A4C4) on the panel is 6.6:1, comfortably AA. What an
 * eyeball cannot see is the second dimmer stacked on top:
 *
 *  - `color-mix(in srgb, <labelDim> 62%, transparent)` — a colour at 62% alpha;
 *  - `opacity` on the rule, which multiplies the text alpha again.
 *
 * Those two are the whole reason this file parses the sheets instead of asserting
 * the palette: the palette is not what ships, and both dimmers are invisible at a
 * glance in a dark theme.
 *
 * Scope, deliberately narrow:
 *  - only `color:` on rules that also name a `.no-` class (i.e. text the plugin owns);
 *  - the rule's `opacity` is folded into the text alpha, because that is what it
 *    does to text;
 *  - the rule's own `background` (else the glass panel) is the surface behind it;
 *  - every runtime CSS variable is resolved to its **darkest** candidate, so a new
 *    dim orange in the palette cannot pass by being unenumerated.
 *
 * WCAG 2.1 AA wants 4.5:1 for normal text and 3:1 from 18.66px bold / 24px up.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ORBIT_PALETTE, STATE_COLOR } from '../src/client/contracts';
import { buildHudStyles } from '../src/client/hud/styles';
import { buildStyles as buildWorkspaceStyles } from '../src/client/workspace/styles';
import { CATEGORIES, statusColor } from '../src/client/workspace/format';
import type { OrbitActivityStatus } from '../src/shared/protocol';

/** The page behind the panels, and the glass surface itself. */
const PAGE: readonly number[] = [7, 11, 24];
const PANEL: readonly number[] = [18, 28, 49];

const channel = (value: number): number => {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = (rgb: readonly number[]): number =>
  0.2126 * channel(rgb[0] ?? 0) + 0.7152 * channel(rgb[1] ?? 0) + 0.0722 * channel(rgb[2] ?? 0);

const contrast = (a: readonly number[], b: readonly number[]): number => {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
};

interface Colour {
  rgb: number[];
  a: number;
}

const HEX = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i;
/** A `color-mix()` operand: a colour plus the optional percentage CSS allows beside it. */
const OPERAND = /^(.*?)(?:\s+([\d.]+)%)?$/;
const RGB_FN = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i;
const MIX = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+?)\s*\)$/;

/** Resolve one CSS colour expression. Returns `null` for anything not modelled here. */
function resolve(raw: string): Colour | null {
  const value = raw.trim();
  if (value === 'transparent') return { rgb: [0, 0, 0], a: 0 };
  const hex = HEX.exec(value);
  if (hex?.[1] !== undefined) {
    const digits = hex[1];
    const wide = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
    const n = Number.parseInt(wide, 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], a: 1 };
  }
  const fn = RGB_FN.exec(value);
  if (fn !== null) {
    return {
      rgb: [Number(fn[1]), Number(fn[2]), Number(fn[3])],
      a: fn[4] === undefined ? 1 : Number(fn[4]),
    };
  }
  const mix = MIX.exec(value);
  if (mix !== null) {
    // Both operands may repeat their share (`color-mix(in srgb, X 82%, #000 18%)`),
    // and the left one is the share the grammar honours — read it, ignore the other.
    const leftOperand = OPERAND.exec(mix[1]?.trim() ?? '');
    const rightOperand = OPERAND.exec(mix[3]?.trim() ?? '');
    const left = resolve(leftOperand?.[1] ?? '');
    const right = resolve(rightOperand?.[1] ?? '');
    if (left === null || right === null) return null;
    const p = Number(leftOperand?.[2] ?? mix[2]) / 100;
    // color-mix interpolates in premultiplied space: `X 85%, transparent` is X *at
    // 85% alpha*, not a darker X. Scaling rgb here would double-count the alpha and
    // report a colour nobody ever sees.
    const alpha = left.a * p + right.a * (1 - p);
    if (alpha === 0) return { rgb: left.rgb, a: 0 };
    return {
      rgb: [0, 1, 2].map(
        (i) => ((left.rgb[i] ?? 0) * left.a * p + (right.rgb[i] ?? 0) * right.a * (1 - p)) / alpha,
      ),
      a: alpha,
    };
  }
  return null;
}

const over = (colour: Colour, backdrop: readonly number[]): number[] =>
  [0, 1, 2].map((i) => (colour.rgb[i] ?? 0) * colour.a + (backdrop[i] ?? 0) * (1 - colour.a));

/** The darkest of a set of colours: the worst case for light ink on a dark surface. */
function darkest(candidates: readonly string[]): string {
  let best = candidates[0] ?? ORBIT_PALETTE.labelDim;
  let bestLuminance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const colour = resolve(candidate);
    if (colour === null) continue;
    const value = luminance(colour.rgb);
    if (value < bestLuminance) {
      bestLuminance = value;
      best = candidate;
    }
  }
  return best;
}

/**
 * Every runtime variable the sheets read, with all the colours it can hold.
 * `--no-accent` tracks the Agent state, `--no-hud-row` / `--no-state` / `--no-cat`
 * track a status, a state and a category, `--no-conn` tracks the SSE connection.
 */
const VARIABLES: Record<string, string[]> = {
  '--no-accent': Object.values(STATE_COLOR),
  '--no-hud-accent': Object.values(STATE_COLOR),
  '--no-state': Object.values(STATE_COLOR),
  '--no-hud-row': (['running', 'success', 'failed', 'cancelled', 'unknown'] as OrbitActivityStatus[]).map(
    (status) => statusColor(status),
  ),
  '--no-cat': CATEGORIES.map((category) => category.color),
  '--no-conn': [ORBIT_PALETTE.blue, ORBIT_PALETTE.success, ORBIT_PALETTE.warning, ORBIT_PALETTE.error],
};

/** Substitute palette interpolations, then every runtime variable at its worst case. */
function expand(css: string): string {
  let complete = css.replace(/\$\{ORBIT_PALETTE\.(\w+)\}/g, (_match, key: string) => {
    const value = (ORBIT_PALETTE as Record<string, string>)[key];
    if (value === undefined) throw new Error(`unknown palette key ${key}`);
    return value;
  });
  for (const [name, candidates] of Object.entries(VARIABLES)) {
    complete = complete.replace(new RegExp(`var\\(${name}\\)`, 'g'), darkest(candidates));
  }
  return complete;
}

/** The four stylesheets, read the way the browser receives them. */
function sheets(): Array<[name: string, css: string]> {
  const fromSource = (file: string): string => readFileSync(file, 'utf8');
  return [
    ['hud', expand(buildHudStyles())],
    ['workspace', expand(buildWorkspaceStyles())],
    ['launcher', expand(fromSource('src/client/launcher.tsx'))],
    ['shell', expand(fromSource('src/client/layer.tsx'))],
  ];
}

/**
 * Read one declaration out of a rule body.
 *
 * The stylesheets are hand-formatted across several lines, so a declaration does not
 * always start at `^` or follow a `;` immediately — `\n  color:#fff` is normal.
 * Splitting on `;` and trimming is the only form that sees every one; an earlier
 * regex against `(?:^|;)color:` only saw the last declaration of each line.
 */
function declared(body: string, property: string): string | undefined {
  for (const chunk of body.split(';')) {
    const trimmed = chunk.trim();
    if (!trimmed.startsWith(`${property}:`)) continue;
    return trimmed.slice(property.length + 1).trim();
  }
  return undefined;
}

interface Finding {
  sheet: string;
  selector: string;
  ratio: number;
  size: number;
  colour: string;
}

/** Iconography, not text: WCAG 1.4.11 asks 3:1 of graphical objects. */
const ICON = /icon|ibtn|logo|mark|dot|glyph/i;

/** Walk every rule that paints text and record the ones below their AA floor. */
function audit(): Finding[] {
  const findings: Finding[] = [];
  for (const [sheet, css] of sheets()) {
    // A `}` ends a rule. At-rules repeat the pattern; a selector without a `.no-`
    // class is not text this plugin owns.
    for (const block of css.split('}')) {
      const brace = block.indexOf('{');
      if (brace < 0) continue;
      const selector = block.slice(0, brace).split('*/').pop()?.trim().replace(/\s+/g, ' ');
      if (selector === undefined || !selector.includes('.no-')) continue;
      const body = block.slice(brace + 1);
      const colour = declared(body, 'color');
      if (colour === undefined) continue;
      const size = Number(/^([\d.]+)px/.exec(declared(body, 'font-size') ?? '')?.[1] ?? 13);
      const opacity = Number(declared(body, 'opacity') ?? 1);
      // `opacity:0` is the hidden half of a hover reveal, not dim text.
      if (opacity === 0) continue;
      const ownBackground = declared(body, 'background');
      const painted = ownBackground === undefined ? null : resolve(ownBackground);
      const backdrop = painted === null ? PANEL : over(painted, PAGE);
      const base = resolve(colour);
      if (base === null) {
        // A colour this file cannot model must fail loudly rather than be skipped:
        // silently ignoring it is how a 3.58:1 button survived an earlier review.
        findings.push({ sheet, selector, ratio: Number.NaN, size, colour });
        continue;
      }
      const ratio = contrast(over({ rgb: base.rgb, a: base.a * opacity }, backdrop), backdrop);
      // WCAG 1.4.11 asks 3:1 of graphical objects; 4.5:1 is for text. A pressed icon
      // button paints a glyph, and the stylesheet gives it no font size at all.
      const iconography = ICON.test(selector);
      const floor = iconography || size >= 18.66 ? 3 : 4.5;
      if (!(ratio >= floor)) findings.push({ sheet, selector, ratio, size, colour });
    }
  }
  return findings;
}

const describeFinding = (finding: Finding): string =>
  `${finding.sheet} ${finding.selector} ${finding.colour} @${finding.size}px = ` +
  `${Number.isNaN(finding.ratio) ? 'unresolved' : `${finding.ratio.toFixed(2)}:1`}`;

describe('text contrast', () => {
  it('keeps every text colour in every stylesheet at or above WCAG AA', () => {
    expect(audit().map(describeFinding).join('\n')).toBe('');
  });

  it('actually walks every stylesheet, so a refactor cannot silently empty the sweep', () => {
    // Counting what the audit sees is the cheapest way to notice that a bundle
    // stopped being read — otherwise a broken parser reads as "all green".
    for (const [sheet, css] of sheets()) {
      expect(css.includes('.no-'), `${sheet} should contain plugin rules`).toBe(true);
      expect(css, `${sheet} should paint text`).toContain('color:');
    }
    expect(audit().length + 1).toBeGreaterThan(0);
  });

  it('reads the panel backdrop correctly, so a dimmed label is caught', () => {
    // #93A4C4 on the glass panel is 6.6:1 — at 62% alpha it is the reported 3.58:1.
    const base = resolve(ORBIT_PALETTE.labelDim);
    expect(base).not.toBeNull();
    if (base === null) return;
    expect(contrast(over(base, PANEL), PANEL)).toBeGreaterThan(6);
    expect(contrast(over({ rgb: base.rgb, a: base.a * 0.62 }, PANEL), PANEL)).toBeLessThan(4.5);
  });

  it('knows that mixing a colour with transparent is just alpha', () => {
    const mixed = resolve(`color-mix(in srgb, ${ORBIT_PALETTE.labelDim} 50%, transparent)`);
    expect(mixed?.a).toBeCloseTo(0.5, 5);
    const opaque = resolve(`color-mix(in srgb, ${ORBIT_PALETTE.labelDim} 50%, #000 50%)`);
    expect(opaque?.a).toBe(1);
  });
});
