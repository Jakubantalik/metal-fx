/**
 * SVG glow overlay — a luminance-driven halo that tracks the brightest point
 * on the shader's perimeter.
 *
 * How it works:
 *   1. Samples luminance at N points around the component's perimeter.
 *   2. A state machine tracks which perimeter point is brightest, with dwell
 *      timers and fade-in/out transitions when relocating to a new hotspot.
 *   3. Static SVG path elements (blurred strokes at multiple radii) are
 *      positioned at the current hotspot via CSS transform.
 *   4. The stroke color is tinted to match the shader's color at that point.
 */
import { HALO_SEGMENTS, EXTRA_SEGMENTS } from '../perfConfig';
import type { MetalFxInstance, ShaderRGB } from '../renderer/core';
import { sampleShaderLumAt, sampleShaderRGBAt, sampleShaderRGBChromatic } from '../renderer/sampling';
import { type Tween, ease, tween, tweenStart, tweenTick } from '../tween';
import { hsvToRgb, rgbToHsv } from '../color';
import { GLOW } from './config';
import { CURSOR_LIGHT } from '../cursor/light';
import type { DeformFn } from '../renderer/core';
import { createOutlineBuf, outlinePathD, roundRectOutline } from '../renderer/outline';

const _mO = createOutlineBuf();
const _mI = createOutlineBuf();
import {
  type GlowOptions,
  type PerimSample,
  type Pt,
  PERIM_SAMPLES,
  arcAtPoint,
  buildPerimTable,
  buildStaticBlobPath,
  buildSvgMarkup,
  rrPerim,
  sampleAtArc,
  shapePerim,
  smoothstep,
  tangentAngleAtArc,
} from './geometry';

// ─── Constants ────────────────────────────────────────────────────────────

const RELOCATE_DELTA = 0.05;
const WANDER_RETARGET = 120;
const TINT_HOLD_MS = 2000, TINT_FADE_MS = 400;
const LT_SAT_BOOST = 2.625, LT_VAL_MULT = 1.008, LT_MIN_VAL = 0.31;
const REF_W = 140, REF_H = 40, REF_R = 20;

// ─── Types ────────────────────────────────────────────────────────────────

export type { GlowOptions } from './geometry';

export interface GlowHandles {
  svg: SVGSVGElement;
  haloGroup: SVGGElement;
  haloInner: SVGGElement;
  extraGroup: SVGGElement;
  extraInner: SVGGElement;
  fadeCircle: SVGCircleElement;
  /** Ring-mask paths (null in point mode). Rewritten while deforming. */
  maskOuter: SVGPathElement | null;
  maskInner: SVGPathElement | null;
  maskDeformed: boolean;
  /** Last written path data — skip the attribute write (and the SVG filter
   *  re-raster it triggers) when the outline hasn't changed. */
  maskOuterD: string;
  maskInnerD: string;
  /** Current deform, mirrored from the instance so the hotspot rides the dent. */
  deform: DeformFn | null;
  width: number; height: number; cornerRadius: number; kind: 'pill' | 'circle';
  /** Master scale used at injection time so per-frame position math
   *  (GLOW.inset / GLOW.extraOutward) stays consistent with the strokes already
   *  baked into the SVG markup. */
  scale: number;
  perim: PerimSample[];
  /** True when perim is a point set (custom mask) rather than a ring arc. */
  pointMode: boolean;
  currentIdx: number; appearedAt: number; glowOpacity: number;
  /** Appear/disappear envelope, 0..1. Multiplies the final opacity so the
   *  visible fade takes exactly `relocFadeMs` even when `haloOpMul` saturates
   *  the luminance-driven opacity at 1. */
  relocTween: Tween | null; relocNextIdx: number; relocMul: number;
  /** Cursor mode: the hotspot faces `inst.cursorLight` instead of hunting
   *  luminance. `cursorArc` is the smoothed hotspot arc position. */
  cursorMode: boolean; cursorArc: number; cursorTargetArc: number; lastTickMs: number;
  wanderS: number; wanderTargetS: number; wanderFrames: number;
  tintFrom: ShaderRGB; tintTarget: ShaderRGB; tintTween: Tween | null; tintHoldUntil: number;
  lastHaloStroke: string; lastExtraStroke: string;
}

let glowIdSeq = 0;
const _pt: Pt = { x: 0, y: 0 };

// ─── Public API ───────────────────────────────────────────────────────────

export function injectGlow(container: HTMLElement, opts: GlowOptions): GlowHandles {
  const p = `mfxg_${++glowIdSeq}`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'metal-fx-glow-svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('viewBox', `0 0 ${opts.width} ${opts.height}`);
  svg.innerHTML = buildSvgMarkup(opts, p);
  container.appendChild(svg);

  const q = (id: string) => svg.querySelector(`#${p}_${id}`) as SVGElement;
  const haloGroup = q('h') as SVGGElement;
  const haloInner = q('hI') as SVGGElement;
  const extraGroup = q('e') as SVGGElement;
  const extraInner = q('eI') as SVGGElement;
  const fadeCircle = q('fc') as SVGCircleElement;
  const maskOuter = (svg.querySelector(`#${p}_rmO`) as SVGPathElement | null) ?? null;
  const maskInner = (svg.querySelector(`#${p}_rmI`) as SVGPathElement | null) ?? null;

  const ratio = shapePerim(opts.width, opts.height, opts.cornerRadius, opts.kind) / rrPerim(REF_W, REF_H, REF_R);
  const haloHL = Math.max(1, GLOW.haloHalfLen * ratio);
  const extraHL = Math.max(0.6, GLOW.extraHalfLen * ratio);
  const haloD = buildStaticBlobPath(haloHL, HALO_SEGMENTS);
  const extraD = buildStaticBlobPath(extraHL, EXTRA_SEGMENTS);

  const haloPaths = [q('pXl'), q('pLg'), q('pMd'), q('pSm')] as SVGPathElement[];
  const extraPaths = [q('eO'), q('eC')] as SVGPathElement[];
  for (const path of haloPaths) path.setAttribute('d', haloD);
  for (const path of extraPaths) path.setAttribute('d', extraD);

  haloInner.style.transformOrigin = '0 0';
  extraInner.style.transformOrigin = '0 0';
  haloInner.style.willChange = 'transform';
  extraInner.style.willChange = 'transform';
  haloInner.style.transition = 'transform 100ms linear';
  extraInner.style.transition = 'transform 100ms linear';

  haloGroup.style.willChange = 'opacity';
  extraGroup.style.willChange = 'opacity';
  haloGroup.style.transition = 'opacity 100ms linear';
  extraGroup.style.transition = 'opacity 100ms linear';

  fadeCircle.style.willChange = 'transform';

  return {
    svg, haloGroup, haloInner, extraGroup, extraInner, fadeCircle,
    maskOuter, maskInner, maskDeformed: false, maskOuterD: '', maskInnerD: '', deform: null,
    width: opts.width, height: opts.height, cornerRadius: opts.cornerRadius, kind: opts.kind,
    scale: opts.scale ?? 1,
    perim: buildPerimTable(opts),
    pointMode: !!(opts.samplePoints && opts.samplePoints.length > 0),
    currentIdx: 0, appearedAt: 0, glowOpacity: 0,
    relocTween: null, relocNextIdx: -1, relocMul: 0,
    cursorMode: false, cursorArc: 0, cursorTargetArc: 0, lastTickMs: 0,
    wanderS: 0, wanderTargetS: 0, wanderFrames: 0,
    tintFrom: { r: 255, g: 255, b: 255 }, tintTarget: { r: 255, g: 255, b: 255 }, tintTween: null, tintHoldUntil: 0,
    lastHaloStroke: '', lastExtraStroke: '',
  };
}

// ─── Per-frame update ─────────────────────────────────────────────────────

export function updateGlow(h: GlowHandles, inst: MetalFxInstance, nowMs: number, strengthMul: number, theme: 'dark' | 'light' = 'dark'): void {
  const { width: W, height: H, cornerRadius: R, perim } = h;
  if (perim.length === 0) return;

  const halfWin = 2;

  let maxLum = -1, maxIdx = h.currentIdx, curLum = 0;
  for (let i = 0; i < perim.length; i++) {
    const pt = perim[i];
    const lum = sampleShaderLumAt(inst, pt.x, pt.y, halfWin);
    if (lum > maxLum) { maxLum = lum; maxIdx = i; }
    if (i === h.currentIdx) curLum = lum;
  }

  const dwellActive = h.appearedAt > 0 && nowMs - h.appearedAt < GLOW.minDwellMs;
  const targetOp = GLOW.baseOp + (GLOW.peakOp - GLOW.baseOp) * smoothstep(GLOW.lumLo, GLOW.lumHi, curLum);
  const rivalDominates = !dwellActive && maxLum - curLum > RELOCATE_DELTA;

  // Cursor as light source: while the pointer is within reach the hotspot
  // faces it (nearest outline point) and its brightness follows proximity.
  // Ring mode only — glyph masks have no continuous outline to slide along.
  const cl = inst.cursorLight;
  const cursorOn = CURSOR_LIGHT.enabled && CURSOR_LIGHT.catchLight && !h.pointMode && !!cl && cl.w > 0.02;
  const perimLen = shapePerim(W, H, R, h.kind);
  if (cursorOn) h.cursorTargetArc = arcAtPoint(cl!.x, cl!.y, W, H, R, h.kind);
  const cursorOp = cursorOn ? Math.min(1, GLOW.peakOp * CURSOR_LIGHT.catchGain * cl!.w) : 0;
  const dtMs = h.lastTickMs > 0 ? Math.min(100, Math.max(1, nowMs - h.lastTickMs)) : 16;
  h.lastTickMs = nowMs;

  // Relocation rules: a hotspot holds for at least `minDwellMs`; moving is
  // always disappear-in-place (relocFadeMs) then appear at the new point
  // (relocFadeMs). The halo never slides along the ring — except in cursor
  // mode, where the light source itself is moving.
  const fadeMs = Math.max(1, GLOW.relocFadeMs);
  const CURSOR_ENTER = -2, CURSOR_EXIT = -3;
  const fadeIn = () => {
    h.appearedAt = nowMs;
    h.wanderS = 0; h.wanderTargetS = 0; h.wanderFrames = 0;
    h.relocTween = tween(0, 1, fadeMs, ease.smoothstep);
    tweenStart(h.relocTween, nowMs);
  };
  const fadeOut = (next: number) => {
    h.relocNextIdx = next;
    h.relocTween = tween(1, 0, fadeMs, ease.smoothstep);
    tweenStart(h.relocTween, nowMs);
  };
  if (h.relocTween?.done && h.relocTween.to === 0) {
    // Faded out at the old spot: switch, then fade in at the new one.
    let next = h.relocNextIdx;
    if (next === CURSOR_ENTER && !cursorOn) next = CURSOR_EXIT;
    if (next === CURSOR_EXIT) {
      // Back to the luminance hunt — re-appears below as a first appearance.
      h.cursorMode = false; h.appearedAt = 0; h.relocTween = null;
    } else if (next === CURSOR_ENTER) {
      h.cursorMode = true; h.cursorArc = h.cursorTargetArc; h.glowOpacity = cursorOp;
      fadeIn();
    } else {
      h.currentIdx = next;
      const np = perim[h.currentIdx];
      const nl = sampleShaderLumAt(inst, np.x, np.y, halfWin);
      h.glowOpacity = GLOW.baseOp + (GLOW.peakOp - GLOW.baseOp) * smoothstep(GLOW.lumLo, GLOW.lumHi, nl);
      fadeIn();
    }
  }
  if (!h.relocTween || h.relocTween.done) {
    if (h.appearedAt === 0) {
      // First appearance: face the cursor if it's there, else the brightest point.
      if (cursorOn) { h.cursorMode = true; h.cursorArc = h.cursorTargetArc; h.glowOpacity = cursorOp; }
      else { h.cursorMode = false; h.currentIdx = maxIdx; h.glowOpacity = targetOp; }
      fadeIn();
    } else if (cursorOn !== h.cursorMode) {
      fadeOut(cursorOn ? CURSOR_ENTER : CURSOR_EXIT);
    } else if (!h.cursorMode && rivalDominates) {
      fadeOut(maxIdx);
    }
  }
  if (h.cursorMode) {
    // Proximity-weighted, no lag; holds the last value while fading out.
    if (cursorOn) h.glowOpacity = cursorOp;
    const follow = Math.max(0.01, Math.min(1, CURSOR_LIGHT.catchFollow));
    const fa = 1 - Math.pow(1 - follow, dtMs / (1000 / 60));
    let diff = h.cursorTargetArc - h.cursorArc;
    diff = ((((diff % perimLen) + perimLen * 1.5) % perimLen) - perimLen / 2);
    h.cursorArc += diff * fa;
  } else {
    // Luminance tracking runs continuously; the envelope handles appear/disappear.
    h.glowOpacity += (targetOp - h.glowOpacity) * GLOW.fadeRate;
  }
  h.glowOpacity = Math.max(0, Math.min(1, h.glowOpacity));
  h.relocMul = h.relocTween ? tweenTick(h.relocTween, nowMs) : 1;

  const ratio = shapePerim(W, H, R, h.kind) / rrPerim(REF_W, REF_H, REF_R);
  const wanderRange = GLOW.wanderRange * ratio;
  if (h.wanderFrames++ >= WANDER_RETARGET) { h.wanderTargetS = (Math.random() * 2 - 1) * wanderRange; h.wanderFrames = 0; }
  h.wanderS += (h.wanderTargetS - h.wanderS) * GLOW.wanderLerp;

  let blobX: number, blobY: number, tangent: number, exX: number, exY: number;
  if (h.pointMode) {
    // Custom-mask instance: hotspot sits on a sampled glyph point, halo runs
    // horizontally (reads as a glint across the letterforms), wander slides
    // it along x only.
    const p = perim[h.currentIdx];
    blobX = p.x + h.wanderS; blobY = p.y; tangent = 0;
    exX = blobX; exY = blobY;
  } else {
    const blobArc = h.cursorMode ? h.cursorArc : perim[h.currentIdx].arc + h.wanderS;
    // GLOW.inset / GLOW.extraOutward are absolute SVG-unit offsets; multiply by the
    // master scale so the catch-light sits at the right perpendicular distance
    // when the host element is rendered at non-1× layout (e.g. CSS zoom: 2).
    const insetS = GLOW.inset * h.scale;
    sampleAtArc(blobArc, W, H, R, insetS, 0, h.kind, _pt);
    blobX = _pt.x; blobY = _pt.y;
    tangent = tangentAngleAtArc(blobArc, W, H, R, insetS, h.kind);
    const extraOut = GLOW.extraOutward * ratio * h.scale;
    sampleAtArc(blobArc, W, H, R, insetS, extraOut, h.kind, _pt);
    exX = _pt.x; exY = _pt.y;
  }
  if (h.deform) {
    h.deform(blobX, blobY, _pt); blobX = _pt.x; blobY = _pt.y;
    h.deform(exX, exY, _pt); exX = _pt.x; exY = _pt.y;
  }
  h.haloInner.style.transform = `translate(${blobX.toFixed(3)}px,${blobY.toFixed(3)}px) rotate(${tangent.toFixed(4)}rad)`;
  h.extraInner.style.transform = `translate(${exX.toFixed(3)}px,${exY.toFixed(3)}px) rotate(${tangent.toFixed(4)}rad)`;
  h.fadeCircle.style.transform = `translate(${exX.toFixed(3)}px,${exY.toFixed(3)}px)`;

  const light = theme === 'light';
  const samp = light
    ? sampleShaderRGBChromatic(inst, blobX, blobY, halfWin)
    : sampleShaderRGBAt(inst, blobX, blobY, halfWin);

  if (!h.tintTween) {
    h.tintFrom = { ...samp }; h.tintTarget = { ...samp };
    h.tintTween = tween(0, 1, TINT_FADE_MS);
    tweenStart(h.tintTween, nowMs);
    h.tintHoldUntil = light ? 0 : nowMs + TINT_HOLD_MS;
  } else if (h.tintTween.done) {
    if (light) {
      h.tintFrom = {
        r: h.tintFrom.r + (h.tintTarget.r - h.tintFrom.r) * h.tintTween.val,
        g: h.tintFrom.g + (h.tintTarget.g - h.tintFrom.g) * h.tintTween.val,
        b: h.tintFrom.b + (h.tintTarget.b - h.tintFrom.b) * h.tintTween.val,
      };
      h.tintTarget = { ...samp };
      h.tintTween = tween(0, 1, TINT_FADE_MS);
      tweenStart(h.tintTween, nowMs);
    } else if (nowMs >= h.tintHoldUntil) {
      h.tintFrom = { ...h.tintTarget };
      h.tintTarget = { ...samp };
      h.tintTween = tween(0, 1, TINT_FADE_MS);
      tweenStart(h.tintTween, nowMs);
      h.tintHoldUntil = nowMs + TINT_HOLD_MS;
    }
  }
  tweenTick(h.tintTween!, nowMs);
  const ft = h.tintTween!.val;

  let tR: number, tG: number, tB: number;
  if (light) {
    tR = Math.round(h.tintFrom.r + (h.tintTarget.r - h.tintFrom.r) * ft);
    tG = Math.round(h.tintFrom.g + (h.tintTarget.g - h.tintFrom.g) * ft);
    tB = Math.round(h.tintFrom.b + (h.tintTarget.b - h.tintFrom.b) * ft);
  } else {
    const hR = h.tintFrom.r + (h.tintTarget.r - h.tintFrom.r) * ft;
    const hG = h.tintFrom.g + (h.tintTarget.g - h.tintFrom.g) * ft;
    const hB = h.tintFrom.b + (h.tintTarget.b - h.tintFrom.b) * ft;
    const peak = Math.max(hR, hG, hB) || 1;
    tR = Math.round(255 * (hR / peak)); tG = Math.round(255 * (hG / peak)); tB = Math.round(255 * (hB / peak));
  }

  const tinted = `rgb(${tR},${tG},${tB})`;
  if (tinted !== h.lastHaloStroke) { h.lastHaloStroke = tinted; h.haloInner.style.stroke = tinted; }

  if (light) {
    const hsv = rgbToHsv(tR, tG, tB);
    const [er, eg, eb] = hsvToRgb(hsv[0], Math.min(1, hsv[1] * LT_SAT_BOOST), Math.max(LT_MIN_VAL, hsv[2] * LT_VAL_MULT));
    const extraTinted = `rgb(${er},${eg},${eb})`;
    if (extraTinted !== h.lastExtraStroke) { h.lastExtraStroke = extraTinted; h.extraInner.style.stroke = extraTinted; }
  } else if (h.lastExtraStroke !== '#ffffff') {
    h.lastExtraStroke = '#ffffff'; h.extraInner.style.stroke = '#ffffff';
  }

  const m = Math.max(0, Math.min(1, strengthMul)) * (h.pointMode ? GLOW.pointGain : 1);
  h.haloGroup.style.opacity = (Math.min(1, h.glowOpacity * GLOW.haloOpMul * m) * h.relocMul).toFixed(3);
  h.extraGroup.style.opacity = (Math.min(1, h.glowOpacity * GLOW.extraIntensity * m) * h.relocMul).toFixed(3);
}

/**
 * Keep the glow's ring mask (and hotspot) on the deformed outline. Call after
 * every composite while `deform` is set; pass null once to restore the rigid
 * mask. Cheap: two path `d` rewrites of ~150 points.
 */
export function updateGlowMask(h: GlowHandles, deform: DeformFn | null): void {
  h.deform = deform;
  if (!h.maskOuter || !h.maskInner) return;
  const { width: W, height: H, cornerRadius: R } = h;
  const ringInset = h.kind === 'circle' ? 2 : 1;
  const write = (dfn: DeformFn | null) => {
    const dO = outlinePathD(roundRectOutline(0, 0, W, H, R, dfn, _mO));
    const dI = outlinePathD(roundRectOutline(ringInset, ringInset, W - 2 * ringInset, H - 2 * ringInset, Math.max(0, R - ringInset), dfn, _mI));
    if (dO !== h.maskOuterD) { h.maskOuter!.setAttribute('d', dO); h.maskOuterD = dO; }
    if (dI !== h.maskInnerD) { h.maskInner!.setAttribute('d', dI); h.maskInnerD = dI; }
  };
  if (deform) {
    write(deform);
    h.maskDeformed = true;
  } else if (h.maskDeformed) {
    write(null);
    h.maskDeformed = false;
  }
}

export function resizeGlow(handles: GlowHandles, container: HTMLElement, opts: GlowOptions): GlowHandles {
  for (const svg of Array.from(container.querySelectorAll('.metal-fx-glow-svg'))) {
    if (svg.parentNode === container) container.removeChild(svg);
  }
  void handles;
  return injectGlow(container, opts);
}
