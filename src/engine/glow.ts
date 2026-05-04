/**
 * SVG halo overlay around the metal effect.
 *
 * Source-of-truth: `updateBtnGlow` + `_buildRoundedRectBlobPath` +
 * `_sampleRoundedRectAtArc` from `Image loader/index.html` lines 5335–5641.
 *
 * The canonical engine paints **two glow layers** at the same anchor:
 *   1. `#btnGlowTravel` — wide halo, 4 stacked stroke paths (Xl/Lg/Md/Sm)
 *      sharing the same arc-band, blurred 8.4 / 4.8 / 2.1 / 0.9.
 *   2. `#btnGlowExtraTravel` — tight catch-light, 2 stacked stroke paths
 *      inside a soft radial fade mask (blurs 2.0 / 1.35).
 *
 * The position of these layers is **NOT a constant rotation around the
 * perimeter**. It's a brightness-driven anchor + dwell + relocate state
 * machine:
 *
 *   • A discrete table of 48 perimeter samples (`_btnGlowPerim`).
 *   • Every frame the engine scans shader luminance at all 48 samples and
 *     picks the brightest.
 *   • The glow holds at one anchor for at least 3000 ms
 *     (`BTN_GLOW_MIN_DWELL_MS`), with a small ±15 px arc-length wander
 *     superimposed for organic motion (`BTN_GLOW_WANDER_*`).
 *   • If a different perimeter sample becomes brighter than the current
 *     anchor by ≥ 0.05 lum (`BTN_GLOW_RELOCATE_DELTA`), the glow fades to
 *     zero (500 ms), snaps to the new anchor, then fades back in (500 ms).
 *   • Opacity is lerped at rate 0.00875/frame toward
 *     BTN_GLOW_BASE_OPACITY + (BTN_GLOW_PEAK_OPACITY − BTN_GLOW_BASE_OPACITY)
 *     × smoothstep(BTN_GLOW_LO, BTN_GLOW_HI, currentLuminance)
 *
 * The brightness scan reads from the shared GL framebuffer (populated by
 * `gl.readPixels` once per RAF in `renderer.ts`), so the cost is one
 * readback per frame regardless of how many `<MetalFx>` instances are
 * mounted. Each instance maps its own perimeter samples to GL coordinates
 * via `sampleShaderLumAt`.
 */
import type { MetalFxInstance, ShaderRGB } from './renderer';
import {
  sampleShaderLumAt,
  sampleShaderRGBAt,
  sampleShaderRGBChromatic,
} from './renderer';

// ─── Canonical constants (verbatim from index.html L4836–4953) ────────────

const BTN_GLOW_FADE_RATE = 0.00875;
const BTN_GLOW_LO = 0.08;
const BTN_GLOW_HI = 0.32;
const BTN_GLOW_RELOCATE_DELTA = 0.05;
const BTN_GLOW_MIN_DWELL_MS = 3000;
const BTN_GLOW_PEAK_OPACITY = 0.85;
const BTN_GLOW_BASE_OPACITY = 0.34;
const BTN_GLOW_RELOC_FADE_MS = 500;
const BTN_GLOW_PERIM_SAMPLES = 48;
const BTN_GLOW_WANDER_RANGE = 15;
const BTN_GLOW_WANDER_LERP = 0.0075;
const BTN_GLOW_WANDER_RETARGET = 120;

const BTN_GLOW_INSET = 1.5;
const BTN_GLOW_HALO_HALFLEN = 7.8;
const BTN_GLOW_HALO_SEGMENTS = 28;
const BTN_GLOW_HALO_WOBBLE_AMP = 0.4;
const BTN_GLOW_EXTRA_HALFLEN = 9.13952;
const BTN_GLOW_EXTRA_SEGMENTS = 12;
const BTN_GLOW_EXTRA_OUTWARD = 1.0;

/** Catch-light dimensional baselines — direct port of index.html L4893–4897.
 *  These values hold at the canonical 3 px reference stroke. At runtime
 *  each instance multiplies them by `EXTRA_SCALE` (= source-button stroke
 *  / 3) so a small ring shrinks the catch-light proportionally — without
 *  this the baseline 4-px outer + 2-px core with 2.0 / 1.35 stdDev blur
 *  bleeds outside a 36 × 36 silhouette on the right-hand corners. */
const BTN_GLOW_EXTRA_STROKE_OUTER = 4.0;
const BTN_GLOW_EXTRA_STROKE_CORE = 2.0;
const BTN_GLOW_EXTRA_BLUR_OUTER = 2.0;
const BTN_GLOW_EXTRA_BLUR_CORE = 1.35;
const BTN_GLOW_EXTRA_FADE_R = 13.0;

/** Source-button stroke that the canonical chromatic / silver / gold presets
 *  all default to (`btnStrokeWidth: 1` — index.html L7981 / L7993 / L8010 /
 *  L8022 / L8039 / L8051). Canonical's `getBtnGlowExtraScale()` is
 *  `getBtnStrokePx() / 3`, so all aux instances (pill OR bold) inherit the
 *  same 1/3 catch-light scale regardless of the visible ring width. We
 *  match that exactly: a single constant so both variants render the same
 *  proportional dot the canonical demo shows.
 *
 *  Tying scale to per-instance ringCssPx (1 for pill, 2 for bold) doubled the
 *  bold's catch-light vs canonical, which read as a chunky elongated capsule
 *  that "looked like a pill, not a circle" on the 36 × 36 host because the
 *  capsule's blur skirt was wider than the silhouette's curvature. */
const EXTRA_SCALE = 1 / 3;

/** Per-instance opacity multipliers from the canonical engine. */
const MAIN_TINT_GLOW_OPACITY_MUL = 0.8;
const BTN_GLOW_EXTRA_INTENSITY = 3.51;

// ─── Tint constants (verbatim from index.html L4720–4729) ────────────────
/** Dark-mode plateau before crossfading to a new sample. */
const BTN_GLOW_TINT_HOLD_MS = 2000;
/** Crossfade duration between sampled colours. */
const BTN_GLOW_TINT_FADE_MS = 400;
/** Light-mode catch-light HSV boost (saturation × 2.625, value clamp 0.31). */
const BTN_GLOW_LIGHT_EXTRA_SAT_BOOST = 2.625;
const BTN_GLOW_LIGHT_EXTRA_VALUE_MULT = 1.008;
const BTN_GLOW_LIGHT_EXTRA_MIN_VALUE = 0.31;

/** Default base color for the halo (white). The canonical engine lets users
 *  pick a different glow color via a slider; the npm library always uses
 *  white so the tint mix `tR = 255 × (1 − tintAmt × (1 − nR))` reduces to
 *  `255 × nR` at `tintAmt = 1` (the library's default = full shader-color
 *  follow). */
const BASE_GLOW_RGB: ShaderRGB = { r: 255, g: 255, b: 255 };

/** Reference perimeter (140×40 / r20 canonical pill). Used to scale halo
 *  half-lengths and wander range so the glow reads at the same visual
 *  density on smaller hosts. */
const REFERENCE_W = 140;
const REFERENCE_H = 40;
const REFERENCE_R = 20;

// ─── Public types ─────────────────────────────────────────────────────────

interface GlowOptions {
  width: number;
  height: number;
  cornerRadius: number;
  kind: 'pill' | 'circle';
}

interface PerimSample {
  x: number;
  y: number;
  arc: number;
}

let glowIdSeq = 0;

type RelocPhase = 'idle' | 'fadingOut' | 'fadingIn';

export interface GlowHandles {
  /** Single combined SVG that holds both the halo group and the catch-light
   *  group (matches canonical's one-SVG layout from index.html L8078). */
  svg: SVGSVGElement;
  haloGroup: SVGGElement;
  haloPaths: SVGPathElement[];
  extraGroup: SVGGElement;
  extraPaths: SVGPathElement[];
  fadeCircle: SVGCircleElement;
  /** Geometry — captured at injection so per-frame updates can recompute
   *  arc positions without DOM reads. */
  width: number;
  height: number;
  cornerRadius: number;
  kind: 'pill' | 'circle';
  ringInset: number;
  /** Discrete perimeter sample table — 48 points around the silhouette,
   *  rebuilt on resize via `resizeGlow`. */
  perim: PerimSample[];
  // ─── State machine (one set per instance) ──────────────────────────────
  /** Index into `perim` of the current anchor. */
  currentIdx: number;
  /** `performance.now()` when the current anchor committed. */
  appearedAt: number;
  /** Smoothed glow opacity in [0..1]. */
  glowOpacity: number;
  /** Relocation animation phase. */
  relocPhase: RelocPhase;
  relocStartedAt: number;
  relocFromOp: number;
  relocToOp: number;
  relocNextIdx: number;
  /** Wander state — scalar arc-length offset around the current anchor. */
  wanderS: number;
  wanderTargetS: number;
  wanderFrames: number;
  // ─── Tint state machine (port of `_btnGlowTint*` from index.html) ────
  /** Last applied colour (start of the current crossfade). */
  tintPrev: ShaderRGB;
  /** Latest sampled colour (end of the current crossfade). */
  tintTarget: ShaderRGB;
  /** `performance.now()` of the last sample event. < 0 means "no sample
   *  taken yet" so the first frame seeds prev = target = sample. */
  tintLastSampleAt: number;
  /** Cached last stroke string written to the halo paths so we can skip
   *  the four `setAttribute` calls when the colour hasn't changed. */
  lastHaloStroke: string;
  /** Same cache for the catch-light strokes (tinted in light mode only). */
  lastExtraStroke: string;
}

// ─── SVG markup builders ──────────────────────────────────────────────────

/** Build a single combined glow SVG that holds BOTH the wide halo group and
 *  the catch-light group, sharing one region mask — direct port of canonical
 *  `_buildGlowSvgInner` (index.html L8078). The previous two-SVG split was
 *  visually equivalent ONLY when the halo and catch-light didn't overlap;
 *  for the bold variant they're driven from the SAME perimeter anchor, so
 *  applying `mix-blend-mode: screen` twice (one per SVG) over the shared
 *  region produces a noticeably darker composite than canonical's single
 *  screen pass. Folding both groups into one SVG lets the inner compositor
 *  combine them in source-over space first, after which the SINGLE outer
 *  screen pass matches canonical pixel-for-pixel. */
function buildGlowSvgMarkup(opts: GlowOptions, idPrefix: string): string {
  const W = opts.width;
  const H = opts.height;
  const R = opts.cornerRadius;
  const ringInset = opts.kind === 'circle' ? 2 : 1;
  const haloLineCap = 'round';
  const ringInner = Math.max(0, R - ringInset);
  const cx = W * 0.5;
  const cy = H * 0.5;
  const sOuter = BTN_GLOW_EXTRA_STROKE_OUTER * EXTRA_SCALE;
  const sCore = BTN_GLOW_EXTRA_STROKE_CORE * EXTRA_SCALE;
  const blurOuter = BTN_GLOW_EXTRA_BLUR_OUTER * EXTRA_SCALE;
  const blurCore = BTN_GLOW_EXTRA_BLUR_CORE * EXTRA_SCALE;
  const fadeR = BTN_GLOW_EXTRA_FADE_R * EXTRA_SCALE;

  const fr =
    'x="-200" y="-200" width="540" height="440" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"';
  const id = (name: string) => `${idPrefix}_${name}`;

  return [
    '<defs>',
    `<filter id="${id('blurXl')}" ${fr}><feGaussianBlur stdDeviation="8.4"/></filter>`,
    `<filter id="${id('blurLg')}" ${fr}><feGaussianBlur stdDeviation="4.8"/></filter>`,
    `<filter id="${id('blurMd')}" ${fr}><feGaussianBlur stdDeviation="2.1"/></filter>`,
    `<filter id="${id('blurSm')}" ${fr}><feGaussianBlur stdDeviation="0.9"/></filter>`,
    `<filter id="${id('extraBlurOuter')}" ${fr}><feGaussianBlur stdDeviation="${blurOuter.toFixed(3)}"/></filter>`,
    `<filter id="${id('extraBlurCore')}" ${fr}><feGaussianBlur stdDeviation="${blurCore.toFixed(3)}"/></filter>`,
    `<radialGradient id="${id('extraFadeGrad')}" cx="0.5" cy="0.5" r="0.5" fx="0.5" fy="0.5">`,
    '<stop offset="0" stop-color="white"/>',
    '<stop offset="0.30" stop-color="white"/>',
    '<stop offset="0.65" stop-color="#404040"/>',
    '<stop offset="1" stop-color="black"/>',
    '</radialGradient>',
    `<mask id="${id('extraFadeMask')}" maskUnits="userSpaceOnUse" x="-200" y="-200" width="540" height="440">`,
    '<rect x="-200" y="-200" width="540" height="440" fill="black"/>',
    `<circle id="${id('extraFadeCircle')}" cx="${cx}" cy="${cy}" r="${fadeR.toFixed(3)}" fill="url(#${id('extraFadeGrad')})"/>`,
    '</mask>',
    `<mask id="${id('regionMask')}" maskUnits="userSpaceOnUse" x="-200" y="-200" width="540" height="440">`,
    '<rect x="-200" y="-200" width="540" height="440" fill="#808080"/>',
    `<rect x="0" y="0" width="${W}" height="${H}" rx="${R}" ry="${R}" fill="white"/>`,
    `<rect x="${ringInset}" y="${ringInset}" width="${W - ringInset * 2}" height="${H - ringInset * 2}" rx="${ringInner}" ry="${ringInner}" fill="black"/>`,
    '</mask>',
    '</defs>',
    `<g id="${id('haloTravel')}" mask="url(#${id('regionMask')})" opacity="0">`,
    `<path id="${id('pathXl')}" stroke="white" stroke-width="26.4" stroke-linecap="${haloLineCap}" stroke-linejoin="round" fill="none" opacity="0.385" filter="url(#${id('blurXl')})"/>`,
    `<path id="${id('pathLg')}" stroke="white" stroke-width="15.6" stroke-linecap="${haloLineCap}" stroke-linejoin="round" fill="none" opacity="0.595" filter="url(#${id('blurLg')})"/>`,
    `<path id="${id('pathMd')}" stroke="white" stroke-width="7.2"  stroke-linecap="${haloLineCap}" stroke-linejoin="round" fill="none" opacity="0.70"  filter="url(#${id('blurMd')})"/>`,
    `<path id="${id('pathSm')}" stroke="white" stroke-width="3.0"  stroke-linecap="${haloLineCap}" stroke-linejoin="round" fill="none" opacity="0.70"  filter="url(#${id('blurSm')})"/>`,
    '</g>',
    `<g id="${id('extraTravel')}" mask="url(#${id('regionMask')})" opacity="0">`,
    `<g mask="url(#${id('extraFadeMask')})">`,
    `<path id="${id('extraOuter')}" stroke="white" stroke-width="${sOuter.toFixed(3)}" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.85" filter="url(#${id('extraBlurOuter')})"/>`,
    `<path id="${id('extraCore')}"  stroke="white" stroke-width="${sCore.toFixed(3)}" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="1.0"  filter="url(#${id('extraBlurCore')})"/>`,
    '</g>',
    '</g>',
  ].join('');
}

// ─── Geometry helpers ─────────────────────────────────────────────────────

function roundedRectPerim(w: number, h: number, r: number): number {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  return (
    2 * Math.max(0, w - 2 * rr) +
    2 * Math.max(0, h - 2 * rr) +
    2 * Math.PI * rr
  );
}

function shapePerim(
  w: number,
  h: number,
  r: number,
  kind: 'pill' | 'circle'
): number {
  if (kind === 'circle') {
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    return 2 * Math.PI * rr;
  }
  return roundedRectPerim(w, h, r);
}

interface SamplePoint {
  x: number;
  y: number;
}

/** Port of `_sampleRoundedRectAtArc` from index.html. */
function sampleAtArc(
  s: number,
  w: number,
  h: number,
  r: number,
  inset: number,
  outward: number,
  kind: 'pill' | 'circle'
): SamplePoint {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  if (kind === 'circle') {
    const perim = 2 * Math.PI * rr;
    if (perim <= 0.0001) return { x: w * 0.5, y: h * 0.5 };
    s = ((s % perim) + perim) % perim;
    const theta = -Math.PI / 2 + (s / perim) * (Math.PI * 2);
    const rad = Math.max(0, rr - inset + outward);
    const cx = w * 0.5;
    const cy = h * 0.5;
    return { x: cx + rad * Math.cos(theta), y: cy + rad * Math.sin(theta) };
  }
  const topLen = Math.max(0, w - 2 * rr);
  const sideLen = Math.max(0, h - 2 * rr);
  const arcLen = (Math.PI * rr) / 2;
  const perim = 2 * (topLen + sideLen) + 4 * arcLen;
  s = ((s % perim) + perim) % perim;
  const rad = Math.max(0, rr - inset + outward);

  const sampleArc = (cx: number, cy: number, a0: number, local: number): SamplePoint => {
    const theta = a0 + (arcLen > 0 ? local / arcLen : 0) * (Math.PI / 2);
    return { x: cx + rad * Math.cos(theta), y: cy + rad * Math.sin(theta) };
  };

  let d = s;
  if (d < topLen) return { x: rr + d, y: inset - outward };
  d -= topLen;
  if (d < arcLen) return sampleArc(w - rr, rr, -Math.PI / 2, d);
  d -= arcLen;
  if (d < sideLen) return { x: w - inset + outward, y: rr + d };
  d -= sideLen;
  if (d < arcLen) return sampleArc(w - rr, h - rr, 0, d);
  d -= arcLen;
  if (d < topLen) return { x: w - rr - d, y: h - inset + outward };
  d -= topLen;
  if (d < arcLen) return sampleArc(rr, h - rr, Math.PI / 2, d);
  d -= arcLen;
  if (d < sideLen) return { x: inset - outward, y: h - rr - d };
  d -= sideLen;
  return sampleArc(rr, rr, Math.PI, d);
}

/** Port of `_buildRoundedRectBlobPath` from index.html. */
function buildBlobPath(
  w: number,
  h: number,
  r: number,
  kind: 'pill' | 'circle',
  centerArc: number,
  halfLen: number,
  segments: number,
  outward: number,
  wobbleAmp: number,
  nowMs: number
): string {
  const step = (halfLen * 2) / segments;
  const tw = wobbleAmp > 0 ? nowMs * 0.001 : 0;
  let d = '';
  for (let i = 0; i <= segments; i++) {
    const arc = centerArc - halfLen + i * step;
    let off = outward;
    if (wobbleAmp > 0) {
      const wobble =
        Math.sin(arc * 0.55 + tw * 0.9) +
        0.5 * Math.sin(arc * 1.7 + tw * 1.4 + 1.3);
      off += wobble * wobbleAmp;
    }
    const pt = sampleAtArc(arc, w, h, r, BTN_GLOW_INSET, off, kind);
    d += (i === 0 ? 'M ' : 'L ') + pt.x.toFixed(3) + ' ' + pt.y.toFixed(3) + ' ';
  }
  return d;
}

function smoothstep01(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Build the 48-point perimeter sample table — port of `_rebuildBtnGlowPerim`. */
function buildPerimTable(opts: GlowOptions): PerimSample[] {
  const perim = shapePerim(opts.width, opts.height, opts.cornerRadius, opts.kind);
  const table: PerimSample[] = [];
  for (let i = 0; i < BTN_GLOW_PERIM_SAMPLES; i++) {
    const arc = (i / BTN_GLOW_PERIM_SAMPLES) * perim;
    const pt = sampleAtArc(
      arc,
      opts.width,
      opts.height,
      opts.cornerRadius,
      BTN_GLOW_INSET,
      0,
      opts.kind
    );
    table.push({ x: pt.x, y: pt.y, arc });
  }
  return table;
}

// ─── Public API ───────────────────────────────────────────────────────────

/** Inject the combined glow SVG into `container`. The SVG holds both the
 *  halo group (`#mfx_haloTravel`) and the catch-light group
 *  (`#mfx_extraTravel`) so a single `mix-blend-mode: screen` lifts the
 *  composite onto the host — matching canonical (index.html L8078). */
export function injectGlow(
  container: HTMLElement,
  opts: GlowOptions
): GlowHandles {
  const svgNS = 'http://www.w3.org/2000/svg';
  const idPrefix = `mfxg_${++glowIdSeq}`;
  const sid = (name: string) => `#${idPrefix}_${name}`;

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'metal-fx-glow-svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('viewBox', `0 0 ${opts.width} ${opts.height}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = buildGlowSvgMarkup(opts, idPrefix);
  container.appendChild(svg);

  const ringInset = opts.kind === 'circle' ? 2 : 1;
  return {
    svg,
    haloGroup: svg.querySelector(sid('haloTravel')) as SVGGElement,
    haloPaths: [
      svg.querySelector(sid('pathXl')) as SVGPathElement,
      svg.querySelector(sid('pathLg')) as SVGPathElement,
      svg.querySelector(sid('pathMd')) as SVGPathElement,
      svg.querySelector(sid('pathSm')) as SVGPathElement,
    ],
    extraGroup: svg.querySelector(sid('extraTravel')) as SVGGElement,
    extraPaths: [
      svg.querySelector(sid('extraOuter')) as SVGPathElement,
      svg.querySelector(sid('extraCore')) as SVGPathElement,
    ],
    fadeCircle: svg.querySelector(sid('extraFadeCircle')) as SVGCircleElement,
    width: opts.width,
    height: opts.height,
    cornerRadius: opts.cornerRadius,
    kind: opts.kind,
    ringInset,
    perim: buildPerimTable(opts),
    // Initial state — first frame triggers the appearance fade-in.
    currentIdx: 0,
    appearedAt: 0,
    glowOpacity: 0,
    relocPhase: 'idle',
    relocStartedAt: 0,
    relocFromOp: 0,
    relocToOp: 0,
    relocNextIdx: -1,
    wanderS: 0,
    wanderTargetS: 0,
    wanderFrames: 0,
    tintPrev: { r: 255, g: 255, b: 255 },
    tintTarget: { r: 255, g: 255, b: 255 },
    tintLastSampleAt: -1,
    lastHaloStroke: '',
    lastExtraStroke: '',
  };
}

// ─── HSV helpers (verbatim from index.html L3360–3392) ────────────────────
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, v];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  let r = 0, g = 0, b = 0;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** Per-frame update — runs the full canonical state machine.
 *
 *  Mirror of `updateBtnGlow` (index.html L5335) + tint state machine
 *  (index.html L5468–5604). The brightness scan reads shader luminance via
 *  `sampleShaderLumAt`, and the tint sample uses `sampleShaderRGBAt` (dark
 *  mode, averaged) or `sampleShaderRGBChromatic` (light mode, peak-saturation
 *  pixel) so the halo strokes track the local shader colour at the current
 *  anchor. Both sample from the shared GL framebuffer populated once per
 *  RAF in `renderer.ts`.
 *
 *  Geometry of the perimeter is in CSS-px (matches `viewBox` in the SVG).
 *  The brightness sampler expects DPR-space coordinates on the instance
 *  canvas, so each perimeter sample is multiplied by `dpr` before lookup. */
export function updateGlow(
  handles: GlowHandles,
  inst: MetalFxInstance,
  nowMs: number,
  strengthMul: number,
  theme: 'dark' | 'light' = 'dark'
): void {
  const { width: W, height: H, cornerRadius: R } = handles;
  const perim = handles.perim;
  if (perim.length === 0) return;

  // Sample window — 2.5 % of the smaller GL dimension. The canonical engine
  // uses the same ratio (`Math.floor(Math.min(W, H) * 0.025)`) on the 140×40
  // button-display sample; we apply the same fraction directly.
  const halfWin = Math.max(2, Math.floor(Math.min(inst.canvas.width, inst.canvas.height) * 0.025));

  // ─── Step 1: brightness scan over all perimeter samples ──────────────
  let maxLum = -1;
  let maxIdx = handles.currentIdx;
  let curLum = 0;
  for (let i = 0; i < perim.length; i++) {
    const pt = perim[i];
    const lum = sampleShaderLumAt(inst, pt.x * inst.dpr, pt.y * inst.dpr, halfWin);
    if (lum > maxLum) {
      maxLum = lum;
      maxIdx = i;
    }
    if (i === handles.currentIdx) curLum = lum;
  }

  // ─── Step 2: dwell + relocate state machine ──────────────────────────
  const dwellActive = handles.appearedAt > 0 && nowMs - handles.appearedAt < BTN_GLOW_MIN_DWELL_MS;
  const brightnessTargetOp =
    BTN_GLOW_BASE_OPACITY +
    (BTN_GLOW_PEAK_OPACITY - BTN_GLOW_BASE_OPACITY) * smoothstep01(BTN_GLOW_LO, BTN_GLOW_HI, curLum);
  const rivalDominates = !dwellActive && maxLum - curLum > BTN_GLOW_RELOCATE_DELTA;

  if (handles.relocPhase === 'idle') {
    if (handles.appearedAt === 0) {
      handles.currentIdx = maxIdx;
      handles.appearedAt = nowMs;
      handles.wanderS = 0;
      handles.wanderTargetS = 0;
      handles.wanderFrames = 0;
      handles.relocPhase = 'fadingIn';
      handles.relocStartedAt = nowMs;
      handles.relocFromOp = 0;
      handles.relocToOp = brightnessTargetOp;
    } else if (rivalDominates) {
      handles.relocPhase = 'fadingOut';
      handles.relocStartedAt = nowMs;
      handles.relocFromOp = handles.glowOpacity;
      handles.relocToOp = 0;
      handles.relocNextIdx = maxIdx;
    } else {
      handles.glowOpacity += (brightnessTargetOp - handles.glowOpacity) * BTN_GLOW_FADE_RATE;
    }
  }

  if (handles.relocPhase === 'fadingOut') {
    const t = Math.min(1, (nowMs - handles.relocStartedAt) / BTN_GLOW_RELOC_FADE_MS);
    const eased = t * t * (3 - 2 * t);
    handles.glowOpacity = handles.relocFromOp + (handles.relocToOp - handles.relocFromOp) * eased;
    if (t >= 1) {
      handles.currentIdx = handles.relocNextIdx;
      handles.appearedAt = nowMs;
      handles.wanderS = 0;
      handles.wanderTargetS = 0;
      handles.wanderFrames = 0;
      const newPt = perim[handles.currentIdx];
      const newLum = sampleShaderLumAt(inst, newPt.x * inst.dpr, newPt.y * inst.dpr, halfWin);
      const newTarget =
        BTN_GLOW_BASE_OPACITY +
        (BTN_GLOW_PEAK_OPACITY - BTN_GLOW_BASE_OPACITY) * smoothstep01(BTN_GLOW_LO, BTN_GLOW_HI, newLum);
      handles.relocPhase = 'fadingIn';
      handles.relocStartedAt = nowMs;
      handles.relocFromOp = 0;
      handles.relocToOp = newTarget;
    }
  } else if (handles.relocPhase === 'fadingIn') {
    const t = Math.min(1, (nowMs - handles.relocStartedAt) / BTN_GLOW_RELOC_FADE_MS);
    const eased = t * t * (3 - 2 * t);
    handles.glowOpacity = handles.relocFromOp + (handles.relocToOp - handles.relocFromOp) * eased;
    if (t >= 1) handles.relocPhase = 'idle';
  }

  if (handles.glowOpacity < 0) handles.glowOpacity = 0;
  else if (handles.glowOpacity > 1) handles.glowOpacity = 1;

  // ─── Step 3: wander update ───────────────────────────────────────────
  // Wander range scales with the host perimeter so a 36×36 circle doesn't
  // get the full ±15 CSS-px wander designed for a 134×40 pill.
  const refPerim = roundedRectPerim(REFERENCE_W, REFERENCE_H, REFERENCE_R);
  const ratio = shapePerim(W, H, R, handles.kind) / refPerim;
  const wanderRange = BTN_GLOW_WANDER_RANGE * ratio;

  if (handles.wanderFrames++ >= BTN_GLOW_WANDER_RETARGET) {
    handles.wanderTargetS = (Math.random() * 2 - 1) * wanderRange;
    handles.wanderFrames = 0;
  }
  handles.wanderS += (handles.wanderTargetS - handles.wanderS) * BTN_GLOW_WANDER_LERP;

  // ─── Step 4: build path geometry ─────────────────────────────────────
  const cur = perim[handles.currentIdx];
  const blobArc = cur.arc + handles.wanderS;

  const haloHalfLen = Math.max(1, BTN_GLOW_HALO_HALFLEN * ratio);
  const haloD = buildBlobPath(
    W, H, R, handles.kind,
    blobArc,
    haloHalfLen,
    BTN_GLOW_HALO_SEGMENTS,
    0,
    BTN_GLOW_HALO_WOBBLE_AMP * ratio,
    nowMs
  );
  // Mirrors the per-frame `extraHalfLen` / `extraOutward` math in
  // `updateAuxGlow()` (index.html L8448–L8451): `extraScale = source-button
  // stroke / 3` shrinks the catch-light slice with the source ring, while
  // the perimeter `ratio` further compresses it so a 36 × 36 bold gets a
  // tiny ~1 px arc-length capsule (canonical match) and a 134 × 40 pill
  // gets a wider ~3 px one. Outward shift scales by `ratio` only — same as
  // canonical — so the path centerline rides ~1 px outside the ring for
  // the pill and only ~0.35 px outside for the bold, keeping the blur skirt
  // from cresting past the small circle's right corners.
  const extraHalfLen = Math.max(0.6, BTN_GLOW_EXTRA_HALFLEN * EXTRA_SCALE * ratio);
  const extraOutward = BTN_GLOW_EXTRA_OUTWARD * ratio;
  const extraD = buildBlobPath(
    W, H, R, handles.kind,
    blobArc,
    extraHalfLen,
    BTN_GLOW_EXTRA_SEGMENTS,
    extraOutward,
    0,
    nowMs
  );

  for (const p of handles.haloPaths) p.setAttribute('d', haloD);
  for (const p of handles.extraPaths) p.setAttribute('d', extraD);

  const center = sampleAtArc(blobArc, W, H, R, BTN_GLOW_INSET, extraOutward, handles.kind);
  handles.fadeCircle.setAttribute('cx', center.x.toFixed(3));
  handles.fadeCircle.setAttribute('cy', center.y.toFixed(3));

  // ─── Step 4b: tint state machine (port of index.html L5468–5604) ─────
  // Sample the shader colour at the CURRENT blob position (`blobPt`) — not
  // the perimeter anchor — so the tint follows the wandering bright spot.
  // Dark mode uses sample-and-hold (2 s plateau, 400 ms crossfade) so the
  // tint feels deliberate; light mode re-anchors every frame because the
  // most-chromatic pixel choice is naturally jittery and continuous fade
  // smooths it.
  const blobPt = sampleAtArc(blobArc, W, H, R, BTN_GLOW_INSET, 0, handles.kind);
  // Tint mix amount. Both modes set this to 1.0 — full shader-colour
  // follow — exactly mirroring the canonical engine's default for the dark
  // theme (`PRESETS_DATA.chromatic.modes.dark.glowTint = 1`, index.html
  // L4446 / L8052) and the forced light-theme override (`tintAmt = 1` for
  // light, index.html L5485). The 2-second sample-and-hold + 400 ms cross-
  // fade in the tint state machine keeps the halo perceptually stable
  // even when the wandering blob's samples briefly fade to near-black
  // — peak-channel normalisation would otherwise snap (2, 2, 2) to white
  // and produce a bipolar look.
  const lightTheme = theme === 'light';
  const tintAmt = 1;

  let tR: number, tG: number, tB: number;
  if (tintAmt > 0.001) {
    const samp = lightTheme
      ? sampleShaderRGBChromatic(inst, blobPt.x * inst.dpr, blobPt.y * inst.dpr, halfWin)
      : sampleShaderRGBAt(inst, blobPt.x * inst.dpr, blobPt.y * inst.dpr, halfWin);

    if (lightTheme) {
      // Light mode: re-anchor every frame from the currently-displayed tint
      // toward the newest sample over `BTN_GLOW_TINT_FADE_MS`.
      if (handles.tintLastSampleAt < 0) {
        handles.tintPrev = { r: samp.r, g: samp.g, b: samp.b };
        handles.tintTarget = { r: samp.r, g: samp.g, b: samp.b };
        handles.tintLastSampleAt = nowMs;
      } else {
        const curFadeT = Math.min(
          1,
          (nowMs - handles.tintLastSampleAt) / BTN_GLOW_TINT_FADE_MS
        );
        const curR = handles.tintPrev.r + (handles.tintTarget.r - handles.tintPrev.r) * curFadeT;
        const curG = handles.tintPrev.g + (handles.tintTarget.g - handles.tintPrev.g) * curFadeT;
        const curB = handles.tintPrev.b + (handles.tintTarget.b - handles.tintPrev.b) * curFadeT;
        handles.tintPrev = { r: curR, g: curG, b: curB };
        handles.tintTarget = { r: samp.r, g: samp.g, b: samp.b };
        handles.tintLastSampleAt = nowMs;
      }
      const fadeT = Math.min(1, (nowMs - handles.tintLastSampleAt) / BTN_GLOW_TINT_FADE_MS);
      tR = Math.round(handles.tintPrev.r + (handles.tintTarget.r - handles.tintPrev.r) * fadeT);
      tG = Math.round(handles.tintPrev.g + (handles.tintTarget.g - handles.tintPrev.g) * fadeT);
      tB = Math.round(handles.tintPrev.b + (handles.tintTarget.b - handles.tintPrev.b) * fadeT);
    } else {
      // Dark mode: hold the current sample for `BTN_GLOW_TINT_HOLD_MS`,
      // then commit it as the new "prev" and start a `BTN_GLOW_TINT_FADE_MS`
      // crossfade to the freshly-sampled colour.
      if (handles.tintLastSampleAt < 0) {
        handles.tintPrev = { r: samp.r, g: samp.g, b: samp.b };
        handles.tintTarget = { r: samp.r, g: samp.g, b: samp.b };
        handles.tintLastSampleAt = nowMs;
      } else if (nowMs - handles.tintLastSampleAt >= BTN_GLOW_TINT_HOLD_MS) {
        handles.tintPrev = {
          r: handles.tintTarget.r,
          g: handles.tintTarget.g,
          b: handles.tintTarget.b,
        };
        handles.tintTarget = { r: samp.r, g: samp.g, b: samp.b };
        handles.tintLastSampleAt = nowMs;
      }
      const fadeT = Math.min(1, (nowMs - handles.tintLastSampleAt) / BTN_GLOW_TINT_FADE_MS);
      const heldR = handles.tintPrev.r + (handles.tintTarget.r - handles.tintPrev.r) * fadeT;
      const heldG = handles.tintPrev.g + (handles.tintTarget.g - handles.tintPrev.g) * fadeT;
      const heldB = handles.tintPrev.b + (handles.tintTarget.b - handles.tintPrev.b) * fadeT;
      // Normalize by peak channel to preserve hue while dropping value, then
      // multiplicatively tint the base white so the halo stays bright but
      // skews toward the shader hue. With base = white (255,255,255) and
      // tintAmt = 1 this reduces to `255 × normalized`.
      const peak = Math.max(heldR, heldG, heldB) || 1;
      const nR = heldR / peak, nG = heldG / peak, nB = heldB / peak;
      tR = Math.round(BASE_GLOW_RGB.r * (1 - tintAmt * (1 - nR)));
      tG = Math.round(BASE_GLOW_RGB.g * (1 - tintAmt * (1 - nG)));
      tB = Math.round(BASE_GLOW_RGB.b * (1 - tintAmt * (1 - nB)));
    }

    const tinted = `rgb(${tR},${tG},${tB})`;
    if (tinted !== handles.lastHaloStroke) {
      handles.lastHaloStroke = tinted;
      for (const p of handles.haloPaths) p.setAttribute('stroke', tinted);
    }

    if (lightTheme) {
      // Light-mode catch-light: HSV-boosted shader colour so the rim accent
      // stays vivid against the white shell.
      const hsv = rgbToHsv(tR, tG, tB);
      const sat = Math.min(1, hsv[1] * BTN_GLOW_LIGHT_EXTRA_SAT_BOOST);
      const val = Math.max(BTN_GLOW_LIGHT_EXTRA_MIN_VALUE, hsv[2] * BTN_GLOW_LIGHT_EXTRA_VALUE_MULT);
      const [er, eg, eb] = hsvToRgb(hsv[0], sat, val);
      const extraTinted = `rgb(${er},${eg},${eb})`;
      if (extraTinted !== handles.lastExtraStroke) {
        handles.lastExtraStroke = extraTinted;
        for (const p of handles.extraPaths) p.setAttribute('stroke', extraTinted);
      }
    } else if (handles.lastExtraStroke !== '#ffffff') {
      // Dark mode: catch-light stays neutral white so the rim accent reads
      // as a coherent specular highlight regardless of halo tint.
      handles.lastExtraStroke = '#ffffff';
      for (const p of handles.extraPaths) p.setAttribute('stroke', '#ffffff');
    }
  } else {
    // tintAmt = 0: invalidate held sample so the next non-zero tint starts
    // fresh from the current shader colour.
    handles.tintLastSampleAt = -1;
    if (handles.lastHaloStroke !== '#ffffff') {
      handles.lastHaloStroke = '#ffffff';
      for (const p of handles.haloPaths) p.setAttribute('stroke', '#ffffff');
    }
    if (handles.lastExtraStroke !== '#ffffff') {
      handles.lastExtraStroke = '#ffffff';
      for (const p of handles.extraPaths) p.setAttribute('stroke', '#ffffff');
    }
  }

  // ─── Step 5: write opacities ─────────────────────────────────────────
  // Mirrors `updateAuxGlow` (index.html L8462–8470):
  //   haloGroup.opacity  = btnGlowOpacity × MAIN_TINT_GLOW_OPACITY_MUL × strength
  //   extraGroup.opacity = min(1, btnGlowOpacity × BTN_GLOW_EXTRA_INTENSITY × strength)
  const m = Math.max(0, Math.min(1, strengthMul));
  handles.haloGroup.setAttribute(
    'opacity',
    (handles.glowOpacity * MAIN_TINT_GLOW_OPACITY_MUL * m).toFixed(3)
  );
  handles.extraGroup.setAttribute(
    'opacity',
    Math.min(1, handles.glowOpacity * BTN_GLOW_EXTRA_INTENSITY * m).toFixed(3)
  );
}

/** Rebuild the glow when the host's geometry changes. Removes the existing
 *  combined glow SVG and re-injects fresh state — including a freshly-
 *  computed perimeter table — so the wandering anchor and fade circle reset
 *  cleanly to the new dimensions. */
export function resizeGlow(
  handles: GlowHandles,
  container: HTMLElement,
  opts: GlowOptions
): GlowHandles {
  for (const svg of Array.from(container.querySelectorAll('.metal-fx-glow-svg'))) {
    if (svg.parentNode === container) container.removeChild(svg);
  }
  void handles;
  return injectGlow(container, opts);
}
