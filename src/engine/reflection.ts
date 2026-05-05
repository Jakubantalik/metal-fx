/**
 * Proximity reflection — direct port of `updateProxReflections` +
 * `_proxAttachReflection` from `Image loader/index.html` L5828–6635.
 *
 * MODEL (matching the canonical engine, not the previous simplified version):
 *
 *   1. Each registered neighbour element gets a wrap injected as its first
 *      child:
 *        <div data-metal-fx-reflection>
 *          <canvas class="metal-fx-reflection-canvas">         <!-- fill   -->
 *          <canvas class="metal-fx-reflection-stroke-canvas">  <!-- stroke -->
 *        </div>
 *      Wrap CSS lives in `styles.ts` and provides:
 *        • `border-radius: inherit` — clips to the host's silhouette
 *        • `overflow: hidden`       — bounded paint
 *        • `mix-blend-mode: screen` — shader colour lifts the host
 *        • `filter: blur(4px) saturate(1.2) brightness(1.58)` on the fill
 *        • `filter: saturate(1.35) brightness(1.75)` on the stroke
 *
 *   2. Per frame `paintReflections` writes to BOTH canvases:
 *        • Fill canvas: anchor bitmap mirror-flipped toward the near rim,
 *          clipped to the host's rounded silhouette, drawn in 1-or-more
 *          alpha chunks via `globalCompositeOperation = 'lighter'` so the
 *          total alpha can stack past 1 (matches canonical's 3.6 cap).
 *        • Stroke canvas: same anchor bitmap drawn through an even-odd
 *          rounded-ring clip (1 px inside the host's edge) plus a separate
 *          rounded-stroke catch-light gradient — together these reproduce the
 *          canonical "shader-coloured 1 px hairline rim" pass.
 *
 *   3. A 3-stop directional gradient (1.0 / 0.85 / 0.0) anchors the reflection
 *      against the rim FACING the anchor and fades to zero across a fixed
 *      `RANGE_PX = 12` band — same value drives the proximity-boost ramp, so
 *      neighbours touching the anchor light up at full alpha and ones beyond
 *      12 px sit at the constant base floor.
 *
 *   4. The source bitmap is mirrored along the gradient axis so the anchor's
 *      NEAR edge anchors against the neighbour's near rim — true mirror, not a
 *      flat copy.
 *
 *   5. Form controls (`<input>`, `<textarea>`, `<select>`, `<option>`) are
 *      explicitly skipped — their UA shadow tree won't render a positioned
 *      child div reliably.
 */
import type { MetalFxInstance } from './renderer';

// ─── Canonical constants (verbatim from index.html L5851-5915) ────────────

/** Band width on neighbour AND distance for full proximity boost. */
const RANGE_PX = 12;
/** Auto-attach range — neighbours whose horizontal gap to the anchor is
 *  beyond this are SKIPPED entirely. Mirrors `PROX_REFLECT_AUTO_RANGE_PX = 32`
 *  from index.html L5930. Combined with the horizontal-only rule (vertical
 *  neighbours are always skipped) this ensures reflections only land on
 *  components that share a row with the metal-fx anchor. */
const ATTACH_RANGE_PX = 32;
/** Minimum vertical overlap (in CSS px) required for a neighbour to count as
 *  "horizontal" — below this it's treated as a stacked (above/below) element
 *  and skipped. Mirrors `verticalOverlap < 1` in `_proxIsHorizontalNeighbour`. */
const HORIZONTAL_OVERLAP_MIN_PX = 1;
/** Always-on alpha floor — applied at any distance within range. */
const BASE_ALPHA = 0.55;
/** Alpha when distance = 0 (target right against the anchor). */
const BOOST_ALPHA = 1.0;
/** Gradient stops along the perpendicular axis. */
const GRAD_NEAR = 1.0;
const GRAD_MID = 0.85;
const GRAD_FAR = 0.0;
/** User-requested +30 % overall reflection gain. */
const INTENSITY_MULT = 1.3;
/** Cap for stacked alpha — 2.4 × 1.5 in the canonical. */
const MAX_ALPHA_STACK = 3.6;
/** Per-pass −30 % attenuation matching canonical "soft halo dimmer". */
const GLOBAL_ATTENUATION = 0.7;
/** Stroke pass — 1 CSS-px wide rim band on the inside of the host edge. */
const STROKE_CSS_PX = 1;
/** Stroke band's own alpha multiplier (canonical 0.52). */
const STROKE_EXTRA_ALPHA = 0.52;
/** Border-highlight (rounded stroke catch-light) thickness. */
const BORDER_HILITE_PX = 1.0;
/** Border-highlight alpha (canonical 0.044). */
const BORDER_HILITE_ALPHA = 0.044;
/** Reference draw width on the neighbour. The canonical uses 235 CSS px
 *  (`PROX_REFLECT_UI_SEARCH_CSS_W`). For non-canonical anchor widths we
 *  scale by `cssW / 140` so a 36-px circle gets a 60-px wide draw rect (not
 *  235) and density stays consistent across anchors. */
const REF_DRAW_CSS_W = 235;
/** Extra alpha on the BLURRED FILL only — canonical 2.535. Stroke /
 *  border-highlight pass at full strength. */
const FILL_EXTRA_ALPHA = 2.535;
/** −30 % on the main fill reflection only (canonical 0.7). */
const FILL_OPACITY_MUL = 0.7;
/** Additional fill-only attenuation (matches canonical engine's
 *  `boldFillAttenuation = 0.5`; renamed to `CIRCLE` here to align with the
 *  public `variant: 'circle'` API). */
const FILL_CIRCLE_ATTENUATION = 0.5;

/** HTML form-control tags whose UA shadow tree won't reliably host a
 *  positioned child div. */
const REFLECTION_BLOCKED_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

// ─── Types ────────────────────────────────────────────────────────────────

/** A single neighbour element receiving a reflection. */
export interface ReflectionTarget {
  el: HTMLElement;
  anchor: MetalFxInstance;
  anchorEl: HTMLElement;
  wrap: HTMLDivElement;
  /** Soft blurred fill catch-light. */
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Crisp 1-px stroke band + border highlight. */
  strokeCanvas: HTMLCanvasElement;
  strokeCtx: CanvasRenderingContext2D;
  /** Detected corner radius of `el` in CSS px (border-box). */
  cornerRadius: number;
  /** Visible hairline thickness (the band we paint the reflected rim on)
   *  in CSS px. Maximum of CSS border-width / inset shadow spread / outset
   *  shadow spread so the reflection ring matches whatever rim the host
   *  paints. */
  hairlineWidth: number;
  /** How far OUTWARD the hairline extends past the wrap's default position
   *  (`inset: 0` = padding-box) in CSS px. The wrap is shifted by this many
   *  pixels on every side so its outer edge lands on the host's visible
   *  silhouette — without this a CSS `border: 1px` ends up 1 px outside the
   *  reflection (wrap lives in the padding-box, border lives between
   *  padding-box and border-box). */
  hairlineOuterCssPx: number;
  /** Whether we toggled the host's `position` from `static` to `relative`. */
  appliedPositionRelative: boolean;
  /** Whether we toggled the host's `isolation` from `auto` to `isolate`. */
  appliedIsolation: boolean;
}

const targets: Set<ReflectionTarget> = new Set();

// ─── Geometry helpers ─────────────────────────────────────────────────────

function readCornerRadius(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  const radii = [
    parseFloat(cs.borderTopLeftRadius) || 0,
    parseFloat(cs.borderTopRightRadius) || 0,
    parseFloat(cs.borderBottomRightRadius) || 0,
    parseFloat(cs.borderBottomLeftRadius) || 0,
  ].filter((v) => v > 0);
  return radii.length ? Math.min.apply(null, radii) : 0;
}

/** Read the visible "hairline" geometry of the host so the 1-px stroke
 *  reflection sits exactly on the host's existing ring — including whether
 *  that ring is painted inside the padding-box (inset shadow), straddles
 *  the border-box edge (CSS `border`), or sits outside the border-box
 *  (outset `box-shadow`).
 *
 *  Returns the visible thickness (`width`) and the OUTWARD extent past the
 *  padding-box edge (`outerCssPx`) — the wrap is overscanned by `outerCssPx`
 *  on every side so its outer rim lines up with the host's visible
 *  silhouette. Without this, an element with `border: 1px` ends up with the
 *  reflection ring painted 1 px INSIDE the visible border (wrap lives in
 *  the padding-box, the border lives between padding-box and border-box).
 *
 *  Source contributions:
 *    - CSS `border-*-width` (max across the 4 sides) — extends OUTWARD
 *      from the padding-box, so contributes BOTH width and outerCssPx.
 *    - smallest `inset` `box-shadow` with spread > 0 — paints INSIDE the
 *      padding-box, contributes only to width.
 *    - smallest outset `box-shadow` with spread > 0 — paints outside the
 *      border-box, contributes BOTH width and outerCssPx.
 *
 *  Fallback: 1 CSS-px wide hairline at the padding-box edge (`outerCssPx = 0`).
 */
function readHairlineSpec(el: HTMLElement): {
  width: number;
  outerCssPx: number;
} {
  const cs = getComputedStyle(el);
  const borderMax = Math.max(
    parseFloat(cs.borderTopWidth) || 0,
    parseFloat(cs.borderRightWidth) || 0,
    parseFloat(cs.borderBottomWidth) || 0,
    parseFloat(cs.borderLeftWidth) || 0
  );

  let smallestInsetSpread = 0;
  let smallestOutsetSpread = 0;
  const shadow = cs.boxShadow;
  if (shadow && shadow !== 'none') {
    // `getComputedStyle` normalises every shadow into:
    //   "rgba(R,G,B,A) Xpx Ypx [BLURpx [SPREADpx]] [inset]"
    // We want the smallest inset / outset shadow whose spread > 0 — that's the
    // visible hairline. Multiple shadows are comma-separated, but commas
    // inside `rgba(...)` need to be respected, so we split on `, ` only at
    // the top level by replacing rgba() commas first.
    const safe = shadow.replace(/rgba?\([^)]*\)/g, (m) => m.replace(/,/g, '\u0000'));
    const parts = safe.split(/,\s*/);
    let inset = Infinity;
    let outset = Infinity;
    for (const part of parts) {
      const nums = part.match(/-?\d+(?:\.\d+)?px/g);
      if (!nums || nums.length < 4) continue;
      // nums[0]=offsetX, nums[1]=offsetY, nums[2]=blur, nums[3]=spread
      const spread = parseFloat(nums[3]);
      if (!(spread > 0)) continue;
      if (/\binset\b/.test(part)) {
        if (spread < inset) inset = spread;
      } else if (spread < outset) {
        outset = spread;
      }
    }
    if (Number.isFinite(inset)) smallestInsetSpread = inset;
    if (Number.isFinite(outset)) smallestOutsetSpread = outset;
  }

  // Outward extent: max of CSS border + outset shadow. Inset shadows live
  // inside the padding-box so they don't push the wrap outward.
  const outerCssPx = Math.max(borderMax, smallestOutsetSpread);
  // Visible hairline thickness — paint band wide enough to cover whichever
  // rim the host actually shows.
  const width =
    Math.max(borderMax, smallestInsetSpread, smallestOutsetSpread) || 1;

  return { width, outerCssPx };
}

function shortestRectDistance(a: DOMRect, b: DOMRect): number {
  const dx = Math.max(a.left - b.right, b.left - a.right, 0);
  const dy = Math.max(a.top - b.bottom, b.top - a.bottom, 0);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Decide whether `target` qualifies as a horizontal neighbour of `anchor`:
 *  it must overlap vertically with the anchor's rect by at least
 *  HORIZONTAL_OVERLAP_MIN_PX, and the horizontal gap must be ≤ ATTACH_RANGE_PX.
 *  Direct port of `_proxIsHorizontalNeighbour` (index.html L5977). Vertical
 *  neighbours (stacked above/below) are intentionally skipped — the canonical
 *  engine never paints reflections on them. */
function isHorizontalNeighbour(anchorRect: DOMRect, targetRect: DOMRect): boolean {
  const verticalOverlap =
    Math.min(anchorRect.bottom, targetRect.bottom) -
    Math.max(anchorRect.top, targetRect.top);
  if (verticalOverlap < HORIZONTAL_OVERLAP_MIN_PX) return false;
  const horizontalGap = Math.max(
    anchorRect.left - targetRect.right,
    targetRect.left - anchorRect.right,
    0
  );
  if (horizontalGap > ATTACH_RANGE_PX) return false;
  return true;
}

/** Port of `_proxRoundRectPath` — fills `ctx`'s current path with a rounded
 *  rect. Uses the native `roundRect` when available. */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const native = (ctx as any).roundRect;
  if (typeof native === 'function') {
    native.call(ctx, x, y, w, h, rr);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
}

interface DrawDst {
  x: number;
  y: number;
  w: number;
  h: number;
  flipX: boolean;
  flipY: boolean;
}

/** Port of `_proxDrawSource` — drawImage with optional X/Y mirror flip so the
 *  anchor's near edge anchors to the neighbour's near rim. */
function drawSource(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  dst: DrawDst
): void {
  if (!dst.flipX && !dst.flipY) {
    ctx.drawImage(src, 0, 0, sw, sh, dst.x, dst.y, dst.w, dst.h);
    return;
  }
  ctx.save();
  if (dst.flipX) {
    ctx.translate(dst.x + dst.w, 0);
    ctx.scale(-1, 1);
  }
  if (dst.flipY) {
    ctx.translate(0, dst.y + dst.h);
    ctx.scale(1, -1);
  }
  ctx.drawImage(
    src,
    0,
    0,
    sw,
    sh,
    dst.flipX ? 0 : dst.x,
    dst.flipY ? 0 : dst.y,
    dst.w,
    dst.h
  );
  ctx.restore();
}

interface BoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

/** Port of `_proxMaskedFillPasses` — paint the source through a rounded
 *  silhouette clip in 1-or-more alpha chunks (each up to globalAlpha=1)
 *  using `'lighter'` after the first chunk so total alpha can stack past 1.
 *  Each chunk masks alpha via the directional gradient + `destination-in`. */
function maskedFillPasses(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  tw: number,
  th: number,
  totalAlpha: number,
  grad: CanvasGradient,
  dst: DrawDst,
  fillBox: BoxRect
): void {
  let remaining = Math.max(0, totalAlpha);
  let firstChunk = true;
  // Safety cap — chunks are at most 1.0 each, so 8 chunks covers the 3.6 max.
  for (let i = 0; i < 8 && remaining > 1e-4; i++) {
    const a = Math.min(1, remaining);
    ctx.save();
    ctx.beginPath();
    roundRectPath(ctx, fillBox.x, fillBox.y, fillBox.w, fillBox.h, fillBox.r);
    ctx.clip();
    ctx.globalCompositeOperation = firstChunk ? 'source-over' : 'lighter';
    firstChunk = false;
    ctx.globalAlpha = a;
    drawSource(ctx, src, sw, sh, dst);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, tw, th);
    ctx.restore();
    remaining -= a;
  }
}

/** Port of `_proxInsideStrokeEvenOddClip` — `evenodd` clip for a `r`-px ring
 *  at the OUTER edge of the host's visible silhouette. Caller already sized
 *  the (x, y, w, h) box to the visible silhouette via the per-side
 *  `hairlineOuterPx` overscan, so the stroke always rides the outermost
 *  ring of the wrap — directly on top of whatever rim (border / inset
 *  shadow / outset shadow) the host paints. */
function insideStrokeEvenOddClip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radiusDevPx: number,
  strokeDevPx: number
): void {
  const r = strokeDevPx | 0;
  if (r < 1) {
    ctx.beginPath();
    roundRectPath(ctx, x, y, w, h, radiusDevPx);
    ctx.clip();
    return;
  }
  if (w <= 2 * r || h <= 2 * r) {
    ctx.beginPath();
    roundRectPath(ctx, x, y, w, h, radiusDevPx);
    ctx.clip();
    return;
  }
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, radiusDevPx);
  roundRectPath(
    ctx,
    x + r,
    y + r,
    w - 2 * r,
    h - 2 * r,
    Math.max(0, radiusDevPx - r)
  );
  ctx.clip('evenodd');
}

/** Port of `_proxMaskedStrokePasses` — same chunked approach as the fill but
 *  clipped to a 1-px even-odd ring so the source paints the host's hairline. */
function maskedStrokePasses(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  tw: number,
  th: number,
  strokeBox: BoxRect,
  intensity: number,
  strokeBandPx: number,
  grad: CanvasGradient,
  strokeExtraAlpha: number,
  dst: DrawDst
): void {
  let remaining = intensity * strokeExtraAlpha;
  let firstChunk = true;
  for (let i = 0; i < 8 && remaining > 1e-4; i++) {
    const a = Math.min(1, remaining);
    ctx.save();
    insideStrokeEvenOddClip(
      ctx,
      strokeBox.x,
      strokeBox.y,
      strokeBox.w,
      strokeBox.h,
      strokeBox.r,
      strokeBandPx
    );
    ctx.globalCompositeOperation = firstChunk ? 'source-over' : 'lighter';
    firstChunk = false;
    ctx.globalAlpha = a;
    drawSource(ctx, src, sw, sh, dst);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, tw, th);
    ctx.restore();
    remaining -= a;
  }
}

/** Port of `_proxDrawBorderHighlight` (dark mode) — strokes a rounded path
 *  inside the same 1-px even-odd clip with a directional white gradient so
 *  the host's hairline gets a crisp catch-light right where the soft fill
 *  reflection lights up. */
function drawBorderHighlight(
  ctx: CanvasRenderingContext2D,
  strokeBox: BoxRect,
  strokeDevPx: number,
  g0x: number,
  g0y: number,
  g1x: number,
  g1y: number,
  alpha: number
): void {
  const grad = ctx.createLinearGradient(g0x, g0y, g1x, g1y);
  grad.addColorStop(0, `rgba(255,255,255,${alpha.toFixed(3)})`);
  grad.addColorStop(0.5, `rgba(255,255,255,${(alpha * 0.45).toFixed(3)})`);
  grad.addColorStop(1, 'rgba(255,255,255,0)');

  ctx.save();
  insideStrokeEvenOddClip(
    ctx,
    strokeBox.x,
    strokeBox.y,
    strokeBox.w,
    strokeBox.h,
    strokeBox.r,
    strokeDevPx
  );
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = strokeDevPx * 2;
  ctx.strokeStyle = grad;
  ctx.beginPath();
  roundRectPath(
    ctx,
    strokeBox.x,
    strokeBox.y,
    strokeBox.w,
    strokeBox.h,
    strokeBox.r
  );
  ctx.stroke();
  ctx.restore();
}

// ─── Public API ───────────────────────────────────────────────────────────

/** Register a new target. Idempotent: re-registering the same element returns
 *  the existing record. Returns `null` only when DOM is unavailable (SSR) or
 *  the element is a blocked form control. */
export function addReflectionTarget(
  el: HTMLElement,
  anchor: MetalFxInstance,
  anchorEl: HTMLElement
): ReflectionTarget | null {
  if (typeof document === 'undefined') return null;
  if (REFLECTION_BLOCKED_TAGS.has(el.tagName)) return null;
  for (const existing of targets) {
    if (existing.el === el) return existing;
  }

  const wrap = document.createElement('div');
  wrap.setAttribute('data-metal-fx-reflection', '');
  wrap.setAttribute('aria-hidden', 'true');

  const canvas = document.createElement('canvas');
  canvas.className = 'metal-fx-reflection-canvas';
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;

  const strokeCanvas = document.createElement('canvas');
  strokeCanvas.className = 'metal-fx-reflection-stroke-canvas';
  const strokeCtx = strokeCanvas.getContext('2d', { alpha: true });
  if (!strokeCtx) return null;

  wrap.appendChild(canvas);
  wrap.appendChild(strokeCanvas);

  // Host must be a positioning ancestor for the wrap's `inset: 0` to work,
  // and a blend-mode isolate so `mix-blend-mode: screen` only composites
  // against THIS host (not whatever sits behind it on the page). Track which
  // ones we set so `removeReflectionTarget` can roll them back.
  const cs = getComputedStyle(el);
  let appliedPositionRelative = false;
  if (cs.position === 'static') {
    el.style.position = 'relative';
    appliedPositionRelative = true;
  }
  let appliedIsolation = false;
  if (cs.isolation !== 'isolate') {
    el.style.isolation = 'isolate';
    appliedIsolation = true;
  }
  el.setAttribute('data-metal-fx-reflect-host', '');
  el.insertBefore(wrap, el.firstChild);

  const initialSpec = readHairlineSpec(el);
  const target: ReflectionTarget = {
    el,
    anchor,
    anchorEl,
    wrap,
    canvas,
    ctx,
    strokeCanvas,
    strokeCtx,
    cornerRadius: readCornerRadius(el),
    hairlineWidth: initialSpec.width,
    hairlineOuterCssPx: initialSpec.outerCssPx,
    appliedPositionRelative,
    appliedIsolation,
  };
  targets.add(target);
  return target;
}

export function removeReflectionTarget(el: HTMLElement): void {
  for (const target of targets) {
    if (target.el === el) {
      if (target.wrap.parentNode === target.el) {
        target.el.removeChild(target.wrap);
      }
      target.el.removeAttribute('data-metal-fx-reflect-host');
      if (target.appliedPositionRelative) target.el.style.position = '';
      if (target.appliedIsolation) target.el.style.isolation = '';
      targets.delete(target);
      return;
    }
  }
}

/** Paint the reflection on every registered target. Called once per frame by
 *  `scheduleReflectionPaint` (set up as the shared renderer's onAfterFrame
 *  callback). Cheap to call when no targets are registered. */
export function paintReflections(): void {
  if (targets.size === 0) return;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  for (const t of targets) {
    const tRect = t.el.getBoundingClientRect();
    const aRect = t.anchorEl.getBoundingClientRect();
    if (tRect.width < 1 || tRect.height < 1) continue;
    if (aRect.width < 1 || aRect.height < 1) continue;

    // ─── Horizontal-only, ≤ 32 px filter ───────────────────────────────
    // Two rules ported from the canonical engine (index.html L5930, L5977):
    //   • Vertical neighbours (stacked above / below) are SKIPPED entirely —
    //     the metal-fx anchor only reflects onto components in the same row.
    //   • Components beyond ATTACH_RANGE_PX (32 CSS px) gap from the anchor
    //     are SKIPPED — the reflection effect is meant to read as light
    //     bouncing onto an immediately adjacent neighbour, not as ambient
    //     spill across the whole layout.
    // When a registered target fails either rule we still clear its canvases
    // so a previously-painted reflection (if the layout shifted into range
    // earlier) doesn't linger.
    if (!isHorizontalNeighbour(aRect, tRect)) {
      if (t.canvas.width !== 1) {
        t.canvas.width = 1;
        t.canvas.height = 1;
      }
      if (t.strokeCanvas.width !== 1) {
        t.strokeCanvas.width = 1;
        t.strokeCanvas.height = 1;
      }
      continue;
    }

    // Refresh corner radius + hairline spec lazily — host themes can change
    // both (e.g. light-mode chips toggle from a CSS border to an inset
    // box-shadow hairline) so we re-read each frame and update the cached
    // values when they drift.
    const newCorner = readCornerRadius(t.el);
    if (Math.abs(newCorner - t.cornerRadius) > 0.01) t.cornerRadius = newCorner;
    const newHairline = readHairlineSpec(t.el);
    if (Math.abs(newHairline.width - t.hairlineWidth) > 0.01) {
      t.hairlineWidth = newHairline.width;
    }
    if (Math.abs(newHairline.outerCssPx - t.hairlineOuterCssPx) > 0.01) {
      t.hairlineOuterCssPx = newHairline.outerCssPx;
    }

    const anchorCanvas = t.anchor.canvas;
    const sw = anchorCanvas.width | 0;
    const sh = anchorCanvas.height | 0;
    if (sw < 4 || sh < 4) continue;

    // Direction vector — anchor center minus target center.
    const acx = (aRect.left + aRect.right) * 0.5;
    const acy = (aRect.top + aRect.bottom) * 0.5;
    const tcx = (tRect.left + tRect.right) * 0.5;
    const tcy = (tRect.top + tRect.bottom) * 0.5;
    const dx = acx - tcx;
    const dy = acy - tcy;

    // Intensity. Always ≥ BASE_ALPHA, with smoothstep boost up to BOOST_ALPHA
    // as edge-to-edge distance shrinks toward 0.
    const dist = shortestRectDistance(aRect, tRect);
    let proximity = 1 - Math.min(1, dist / RANGE_PX);
    proximity = proximity * proximity * (3 - 2 * proximity);
    const intensity = BASE_ALPHA + (BOOST_ALPHA - BASE_ALPHA) * proximity;

    // Soft-halo dim: every pass keys off `reflectionAlpha` so one scalar keeps
    // neighbour spill calmer (canonical's 0.7 multiplier).
    const reflectionAlpha = Math.min(
      MAX_ALPHA_STACK,
      intensity * INTENSITY_MULT * GLOBAL_ATTENUATION
    );

    const hairlineCssPx = Math.max(STROKE_CSS_PX, t.hairlineWidth);
    const strokeBandPx = Math.max(1, Math.round(hairlineCssPx * dpr));
    const borderHighlightPx = Math.max(
      1,
      Math.round(Math.max(BORDER_HILITE_PX, t.hairlineWidth) * dpr)
    );

    // Push the wrap OUTWARD by the same number of CSS px the host's hairline
    // sits past the padding-box. Without this overscan a CSS `border: 1px`
    // would render the reflection's 1-px ring 1 px INSIDE the visible border
    // (because `position: absolute; inset: 0` lays the wrap out against the
    // padding-box, and CSS borders live between padding-box and border-box).
    // For inset shadows `outerCssPx` is 0 → wrap stays at `inset: 0` and
    // still covers the inset hairline. For outset shadows / CSS border /
    // both, the wrap grows to the visible silhouette and the stroke pass
    // rides its outermost ring — so the reflected hairline lands directly on
    // top of whatever rim the host actually paints.
    const overscanCssPx = t.hairlineOuterCssPx;
    t.wrap.style.inset = `${-overscanCssPx}px`;
    // Corner radius on the wrap matches the visible silhouette's rounding —
    // the host's `border-radius` is measured at the OUTER edge of the
    // border-box, so adding `overscanCssPx` for an outset shadow keeps the
    // wrap's outer corner concentric with the host's outer corner. For a CSS
    // border the host's `border-radius` already describes the OUTER curve
    // (border-box edge), so the wrap matches without further adjustment when
    // we push the wrap outward by the border width — the rounding stays
    // visually aligned.
    t.wrap.style.borderRadius = `${Math.max(0, t.cornerRadius)}px`;

    // Sync canvas pixel buffers to the wrap's CSS size × DPR.
    const tw = Math.max(1, Math.round((tRect.width + overscanCssPx * 2) * dpr));
    const th = Math.max(1, Math.round((tRect.height + overscanCssPx * 2) * dpr));
    if (t.canvas.width !== tw) t.canvas.width = tw;
    if (t.canvas.height !== th) t.canvas.height = th;
    if (t.strokeCanvas.width !== tw) t.strokeCanvas.width = tw;
    if (t.strokeCanvas.height !== th) t.strokeCanvas.height = th;

    const ctx = t.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, tw, th);
    const strokeCtx = t.strokeCtx;
    strokeCtx.setTransform(1, 0, 0, 1, 0, 0);
    strokeCtx.clearRect(0, 0, tw, th);

    // The visible silhouette IS the wrap. Both fill clip and stroke clip
    // run against (0, 0, tw, th) so the reflected rim sits on the wrap's
    // OUTERMOST ring — exactly where the host paints its border / inset
    // shadow / outset shadow.
    const hostX = 0;
    const hostY = 0;
    const hostW = tw;
    const hostH = th;

    // Build the directional alpha gradient — same near-edge falloff for fill
    // and stroke + border-highlight. RANGE_PX is BOTH the band width AND the
    // proximity boost distance (one slider, two effects).
    const bandDevPx = Math.min(RANGE_PX * dpr, Math.max(tw, th));
    let g0x: number;
    let g0y: number;
    let g1x: number;
    let g1y: number;
    if (Math.abs(dx) >= Math.abs(dy)) {
      // Anchor on the LEFT or RIGHT — gradient runs horizontally.
      if (dx > 0) {
        g0x = hostX + hostW;
        g1x = hostX + hostW - bandDevPx;
      } else {
        g0x = hostX;
        g1x = hostX + bandDevPx;
      }
      g0y = hostY + hostH * 0.5;
      g1y = hostY + hostH * 0.5;
    } else {
      if (dy > 0) {
        g0y = hostY + hostH;
        g1y = hostY + hostH - bandDevPx;
      } else {
        g0y = hostY;
        g1y = hostY + bandDevPx;
      }
      g0x = hostX + hostW * 0.5;
      g1x = hostX + hostW * 0.5;
    }
    const grad = ctx.createLinearGradient(g0x, g0y, g1x, g1y);
    grad.addColorStop(0, `rgba(0,0,0,${GRAD_NEAR})`);
    grad.addColorStop(0.5, `rgba(0,0,0,${GRAD_MID})`);
    grad.addColorStop(1, `rgba(0,0,0,${GRAD_FAR})`);

    // Source draw rect — width scaled by `cssW / 140` so the canonical 235-px
    // reference doesn't over-stretch small circle anchors. Vertical axis spans
    // the canvas height so the stroke pass still reaches the rim above /
    // below the host's near edge.
    const anchorCssW = sw / dpr;
    const srcRefWidthScale = Math.max(0.1, anchorCssW / 140);
    const refWdpr = Math.max(
      1,
      Math.round(REF_DRAW_CSS_W * srcRefWidthScale * dpr)
    );

    let drawX: number;
    let drawY = 0;
    let drawW = refWdpr;
    let drawH = th;
    let flipX = false;
    let flipY = false;
    if (Math.abs(dx) >= Math.abs(dy)) {
      flipX = true;
      drawX = dx > 0 ? hostX + hostW - refWdpr : hostX;
    } else {
      flipY = true;
      drawW = hostH;
      drawH = refWdpr;
      drawY = dy > 0 ? hostY + hostH - drawH : hostY;
      drawX = Math.round(hostX + (hostW - drawW) * 0.5);
    }
    const drawDst: DrawDst = {
      x: drawX,
      y: drawY,
      w: drawW,
      h: drawH,
      flipX,
      flipY,
    };

    // Visible silhouette inside the wrap, in DPR space. Both fill and
    // stroke clip against this — corner radius is the host's measured
    // border-radius (which already describes the outer curve at the visible
    // silhouette edge, since `getComputedStyle` reports it relative to the
    // border-box and we've expanded the wrap to cover any outset rim).
    const strokeBox: BoxRect = {
      x: hostX,
      y: hostY,
      w: hostW,
      h: hostH,
      r: Math.max(0, t.cornerRadius * dpr),
    };

    // Fill canvas: soft blurred body. The CSS filter on
    // `.metal-fx-reflection-canvas` (blur 4 px + saturate + brightness)
    // turns this into the broad catch-light glow.
    const fillReflectionAlpha = Math.min(
      MAX_ALPHA_STACK,
      reflectionAlpha *
        FILL_EXTRA_ALPHA *
        FILL_OPACITY_MUL *
        FILL_CIRCLE_ATTENUATION
    );
    maskedFillPasses(
      ctx,
      anchorCanvas,
      sw,
      sh,
      tw,
      th,
      fillReflectionAlpha,
      grad,
      drawDst,
      strokeBox
    );

    // Stroke canvas: rim shader band + crisp white border highlight. Band
    // width tracks the host's actual border / inset-shadow hairline so the
    // reflected rim sits exactly on the host's existing visible hairline
    // (a 1-px-bordered chip gets a 1-px reflection band; a 2-px-bordered
    // pill gets a 2-px band). `STROKE_CSS_PX` floors the value so hosts
    // with no detectable hairline still receive the canonical 1 CSS-px band.
    maskedStrokePasses(
      strokeCtx,
      anchorCanvas,
      sw,
      sh,
      tw,
      th,
      strokeBox,
      reflectionAlpha,
      strokeBandPx,
      grad,
      STROKE_EXTRA_ALPHA,
      drawDst
    );

    // The white catch-light highlight rides the same hairline so the bright
    // rim sits on top of the host's actual border — not on an arbitrary
    // 1-px-from-edge ring.
    drawBorderHighlight(
      strokeCtx,
      strokeBox,
      borderHighlightPx,
      g0x,
      g0y,
      g1x,
      g1y,
      Math.min(0.85, BORDER_HILITE_ALPHA * reflectionAlpha)
    );

    ctx.globalCompositeOperation = 'source-over';
    strokeCtx.globalCompositeOperation = 'source-over';
  }
}
