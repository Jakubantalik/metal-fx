/**
 * "New" badge — Figma: Portfolio › tab 3 (1458:40880), applied verbatim.
 *
 *   45×25, pill r 55.556. Layers bottom→top:
 *     1. white fill
 *     2. metal texture (a static PNG in Figma — here the live shader, via a
 *        full-pill mask so it covers the fill)
 *     3. gradient rgba(255,255,255,.6) → 0, top→bottom
 *     3b. clean white core under the label — transitions.dev get-pro-button
 *         mechanism inverted: radial ellipse 46%, solid to `core`, ramp over
 *         `coreBlur`, so the text sits on white and metal creeps in at the rim
 *     4. text: Inter Semi Bold 12.222/1.4 #323232, box 26.667×13.333
 *     5. inset shadows: 0 0 8.333 #fff ×2, 0 0 0 0.833 rgba(255,255,255,.5),
 *        0 0.833 0 rgba(255,255,255,.78)
 *
 * The gradient AND the inset shadows have to sit above the metal canvas
 * (z 0) and below the text (content z 5) — on the root they'd be painted
 * under the opaque metal and vanish. Both live on one overlay inside the
 * content layer, one level down: MetalFx normalises the *direct* child's
 * background/box-shadow to transparent/none, so the overlay is nested under
 * a plain wrapper to keep them.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MetalFx, type MaskFn, type MetalFxTheme } from '../../src';
import { BADGE, subscribeBadge } from '../lib/badge';

const RADIUS = 55.556;
const W = 45, H = 25;
const TEXT_W = 26.667, TEXT_H = 13.333;
const PAD_X = (W - TEXT_W) / 2;

/** `glow` scales the two soft inner glows; the hairline rims stay as designed. */
const shadowFor = (k: number, glow: number) =>
  `inset 0px 0px ${8.333 * k}px 0px rgba(255,255,255,${glow}), ` +
  `inset 0px 0px ${8.333 * k}px 0px rgba(255,255,255,${glow}), ` +
  `inset 0px 0px 0px ${0.833 * k}px rgba(255,255,255,0.5), ` +
  `inset 0px ${0.833 * k}px 0px 0px rgba(255,255,255,0.78)`;

export function NewBadge({
  strength = 1,
  theme,
  scale = 1,
}: {
  strength?: number;
  theme?: MetalFxTheme;
  /** Size multiplier on the Figma metrics (45×25, 12.222px). */
  scale?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [opacity, setOpacity] = useState(BADGE.newOpacity);
  const [shaderScale, setShaderScale] = useState(BADGE.newShaderScale);
  const readCore = () => ({ r: BADGE.newCore, blur: BADGE.newCoreBlur, a: BADGE.newCoreStrength, size: BADGE.newCoreSize });
  const [core, setCore] = useState(readCore);
  const [gradient, setGradient] = useState(BADGE.newGradient);
  const [glow, setGlow] = useState(BADGE.newGlow);
  useEffect(() => subscribeBadge(() => {
    setOpacity(BADGE.newOpacity);
    setShaderScale(BADGE.newShaderScale);
    setCore(readCore());
    setGradient(BADGE.newGradient);
    setGlow(BADGE.newGlow);
  }), []);

  // Full-fill mask: the pill itself.
  const mask = useCallback<MaskFn>((ctx, w, h, dpr) => {
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, RADIUS * dpr);
    ctx.fill();
  }, []);

  return (
    <MetalFx
      ref={rootRef}
      preset="chromatic"
      theme={theme}
      strength={strength * opacity}
      shaderScale={shaderScale}
      mask={mask}
      glowMode="ring"
      borderRadius={RADIUS * scale}
      style={{ background: '#ffffff', borderRadius: RADIUS * scale }}
    >
      <div className="relative" style={{ width: W * scale, height: H * scale, borderRadius: RADIUS * scale }}>
        {/* layer 3b — clean white core under the label (rim-only metal) */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            borderRadius: RADIUS * scale,
            // Stops are relative to the ellipse radius, so 100% = its edge.
            background: `radial-gradient(ellipse ${core.size}% ${core.size}% at 50% 50%, rgba(255,255,255,1) ${core.r}%, rgba(255,255,255,0) ${Math.min(100, core.r + core.blur)}%)`,
            opacity: core.a,
          }}
        />
        {/* layers 3 + 5 — white gradient and inset rims, over the metal */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            borderRadius: RADIUS * scale,
            background: `linear-gradient(to bottom, rgba(255,255,255,${gradient}), rgba(255,255,255,0))`,
            boxShadow: shadowFor(scale, glow),
          }}
        />
        <span
          className="relative flex items-center justify-center"
          style={{
            width: W * scale,
            height: H * scale,
            paddingLeft: PAD_X * scale,
            paddingRight: PAD_X * scale,
            font: `600 ${12.222 * scale}px/1.4 Inter, sans-serif`,
            color: '#323232',
            letterSpacing: 0,
            whiteSpace: 'nowrap',
          }}
          aria-label="New"
        >
          New
        </span>
      </div>
    </MetalFx>
  );
}
