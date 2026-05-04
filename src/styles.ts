/**
 * One-shot CSS injection for the metal-fx component.
 *
 * The layer order follows `Image loader/index.html` exactly:
 *   z=0  .metal-fx-canvas       — shader bitmap (centre punched)
 *   z=1  .metal-fx-inner        — TRANSPARENT inset spacer that defines where
 *                                 the metal ring meets the interior (inset:3
 *                                 for Button, 1-2 px for Bold). The wrapper bg
 *                                 propagates through to the punched centre —
 *                                 see "Single-surface background" below. Bold's
 *                                 1-px dark hairline is a `box-shadow: inset`
 *                                 on this same element and paints regardless
 *                                 of background.
 *   z=2  .metal-fx-root::before — 50px-wide soft inset highlight
 *   z=3  .metal-fx-glow-svg     — wandering halo + catch-light
 *   z=4  .metal-fx-root::after  — 1px white-10% inset hairline (matches the
 *                                 `<path fill="white" fill-opacity="0.1">`
 *                                 from metal.html's btn-border-svg)
 *   z=5  .metal-fx-content      — wrapped child (label/icon)
 *
 * The wrapper is the visible button surface — it carries the button background
 * color, the border-radius, and IS the actual click target via the wrapped
 * child (which we hoist into `.metal-fx-content`). With `normalizeHostStyles`
 * default-true the child loses any conflicting border / outline / box-shadow
 * + fills with transparent so its visuals stop fighting the metal frame.
 *
 * ─── Single-surface background ─────────────────────────────────────────────
 * Historically the inner div carried its own `background: #272727` (dark) /
 * `#ffffff` (light) — a hardcoded copy of the wrapper bg, intended to "hide"
 * the punched shader centre. That worked when consumers left the wrapper at
 * default colours, but if a consumer overrode ONLY the wrapper bg (e.g. to
 * match a surrounding card), a 2-3 px annulus appeared around the perimeter
 * where the wrapper bg bled through the punched canvas border — a visibly
 * darker / lighter rim mismatching the new interior tone. The fix is to make
 * the inner div transparent so the wrapper bg is the only surface tone in
 * the interior, collapsing the two surfaces into one. Consumers now override
 * a single colour (the wrapper) and the centre follows automatically. Bold's
 * inset box-shadow hairline is unaffected because `inset` shadows paint
 * regardless of the host's background.
 */

const STYLE_ID = 'metal-fx-styles';

const CSS = /* css */ `
.metal-fx-root {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  isolation: isolate;
  overflow: visible;
  /* Dark-mode default fill — matches index.html's '.metal-fx { background: #272727 }'.
     Light mode + theme overrides flip via [data-theme]. Consumers can override
     the background via inline style or className. */
  background: #272727;
  color: #f8f8f8;
}
.metal-fx-root[data-theme='light'] {
  background: #ffffff;
  color: #1d1d1d;
}

/* Wide soft inset highlight (= --upgrade-inset-shadow from metal.html dark
   mode). z=2: sits below the glow so the glow blends on top of it. */
.metal-fx-root::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  z-index: 2;
  box-shadow: inset 0 0 50px 0 rgba(255, 255, 255, 0.02);
}
.metal-fx-root[data-theme='light']::before {
  box-shadow: inset 0 0 50px 0 rgba(0, 0, 0, 0.02);
}

/* 1px inset white-10% hairline (analogue of metal.html's '.btn-border-svg'
   white path at fill-opacity 0.1). z=4: sits ABOVE the glow so the inner
   border line stays crisp on top of the halo, exactly mirroring the source's
   z-stack. */
.metal-fx-root::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  z-index: 4;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
}
.metal-fx-root[data-theme='light']::after {
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
}

/* The shader bitmap. z=0: behind the inner fill so the inner div hides the
   punched centre, leaving only the outer ring of the shader visible. */
.metal-fx-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  z-index: 0;
  pointer-events: none;
  border-radius: inherit;
}

/* The inner spacer — defines the inset geometry where the metal ring meets
   the interior (3 px for Button, 1-2 px for Bold) and carries the Bold dark
   hairline ('box-shadow: inset' rules below). Intentionally transparent so
   the wrapper's background propagates through to the punched shader centre,
   giving consumers a single surface tone to override. See "Single-surface
   background" in the file header for the rationale. */
.metal-fx-inner {
  position: absolute;
  inset: 3px;
  border-radius: inherit;
  z-index: 1;
  pointer-events: none;
}

.metal-fx-root[data-variant='button'][data-shape='pill'] .metal-fx-inner {
  border-radius: calc(var(--mfx-radius, 20px) - 3px);
}
.metal-fx-root[data-variant='button'][data-shape='circle'] .metal-fx-inner {
  border-radius: calc(var(--mfx-radius, 16px) - 3px);
}
.metal-fx-root[data-variant='bold'][data-shape='pill'] .metal-fx-inner {
  inset: 1px;
  border-radius: calc(var(--mfx-radius, 20px) - 1px);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.45);
}
.metal-fx-root[data-variant='bold'][data-shape='circle'] .metal-fx-inner {
  inset: 2px;
  border-radius: calc(var(--mfx-radius, 16px) - 2px);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.45);
}
/* Bold-variant hairline alpha — light mode.
   Source-of-truth: index.html L2261-2267. The 0.45-alpha black inset that
   reads as a single-pixel frame against the dark interior is too heavy
   on a #ffffff inner: it ends up looking like a hard 2-px black ring
   against the iridescent shader. Drop to 0.18 (canonical mid-grey) so the
   hairline reads as a soft edge that just defines the inner silhouette
   without competing with the shader. NOTE: we keep the dark-mode inset
   and border-radius values because — unlike index.html — our renderer
   does NOT overscan the canvas in light mode, so there is no 1-px gap
   between inner element and shader to compensate for. */
.metal-fx-root[data-theme='light'][data-variant='bold'][data-shape='pill'] .metal-fx-inner,
.metal-fx-root[data-theme='light'][data-variant='bold'][data-shape='circle'] .metal-fx-inner {
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18);
}

/* ─── Combined glow SVG (z=3) ──────────────────────────────────────────────
   Single SVG per instance that holds BOTH the wide-halo group
   (#mfx_haloTravel) and the catch-light group (#mfx_extraTravel), exactly
   mirroring canonical's _buildGlowSvgInner (index.html L8078). One
   mix-blend-mode: screen lifts the combined composite onto the shader
   ring; per-frame opacity attributes on each inner group still drive the
   independent fade-in / fade-out cycles for the halo and the catch-light.

   Why a single SVG: the bold variant anchors halo + catch-light at the same
   perimeter point, so they overlap in the bright zone. Two separately-
   screened SVGs would double-screen the overlap (A + B + C - AB - AC -
   BC + ABC instead of A + B + C - AB - AC once both groups composite
   in source-over inside one SVG and then screen against the host once).
   That overlap looked muted versus canonical specifically on the bold
   circle where both layers travel together.

   Source-of-truth opacity: #btnGlowSvg drops to 0.7 in dark and 0.2746 in
   light (index.html L632/L643). */
.metal-fx-glow-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  z-index: 3;
  pointer-events: none;
  mix-blend-mode: screen;
  opacity: 0.7;
}
.metal-fx-root[data-theme='light'] .metal-fx-glow-svg {
  /* Light-mode 1-px overscan mirrors .btn-glow-svg in metal.html so the
     halo stays glued to the visible silhouette (the shader ring there sits
     1 px outside the host's padding box). */
  inset: -1px;
  width: calc(100% + 2px);
  height: calc(100% + 2px);
  mix-blend-mode: multiply;
  /* Source-of-truth: html[data-theme="light"] #btnGlowSvg { opacity: 0.2746 }
     → −35 % from 0.4225 from the original 0.7 dark-mode opacity. */
  opacity: 0.2746;
  filter: saturate(5.355) brightness(0.78);
}
/* Bold light-mode small circles (e.g. 36×36 send button): the geometrically
   shrunk halo loses density when multiplied against #ffffff. Mirror the
   canonical override at index.html L2316 — bump saturation + drop brightness
   so the small glow holds together visually. */
.metal-fx-root[data-variant='bold'][data-shape='circle'][data-theme='light'] .metal-fx-glow-svg {
  filter: saturate(7.5) brightness(0.6);
}

/* The wrapped child — hoisted into z=5 so it sits above every overlay, with
   normalized chrome so consumer button styles don't fight the metal frame. */
.metal-fx-content {
  position: relative;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.metal-fx-content > * {
  pointer-events: auto;
}
.metal-fx-root[data-normalize='true'] .metal-fx-content > * {
  background: transparent !important;
  border: 0 !important;
  outline: 0 !important;
  box-shadow: none !important;
  /* Stretch the host child to fill the metal frame so its hit-area covers the
     whole pill/circle. Padding/margins on the child stay user-controlled. */
  width: 100%;
  height: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.metal-fx-root[data-normalize='true'] .metal-fx-content > * {
  color: inherit;
  font: inherit;
}

/* ─── Proximity reflection (dark mode only) ───────────────────────────────
   Direct port of \`.prox-reflection\` from index.html L366-447.
   A live mirror of the metal-fx anchor's bitmap painted onto every registered
   neighbour: TWO canvases per target stacked inside the wrap so the soft
   blurred fill catch-light and the crisp 1-px shader rim composite
   independently. CSS \`mix-blend-mode: screen\` lifts the shader colour
   onto the host's painted surface; per-canvas \`filter:\` tunes blur +
   saturate + brightness so the result reads as light bouncing off the rim.

   Layer order inside the wrap:
     z=0 .metal-fx-reflection-canvas        — soft blurred fill catch-light
     z=1 .metal-fx-reflection-stroke-canvas — crisp 1-px rim + border highlight
*/
[data-metal-fx-reflection] {
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  overflow: hidden;
  z-index: 0;
  mix-blend-mode: screen;
  isolation: isolate;
}
.metal-fx-reflection-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  /* index.html L417: blur + chroma + brightness so \`screen\` punches the
     shader colour through the host's paint surface. */
  filter: blur(4px) saturate(1.2) brightness(1.58);
}
.metal-fx-reflection-stroke-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  /* index.html L437: stroke layer stays crisp — only chroma + brightness. */
  filter: saturate(1.35) brightness(1.75);
}
/* Hosts that participate as reflection targets need positioning + isolation
   so the wrap composites only against the host (not the parent stack). The
   wrap injects these inline as well, but stating them here keeps reflections
   working on hosts that already have other inline styles applied. */
[data-metal-fx-reflect-host] {
  isolation: isolate;
}
`;

let injected = false;

/** Idempotently inject the metal-fx stylesheet into `document.head`. */
export function ensureStylesInjected(): void {
  if (injected) return;
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) {
    injected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  injected = true;
}
