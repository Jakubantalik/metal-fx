import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  addReflectionTarget,
  createInstance,
  destroyInstance,
  injectGlow,
  pauseShared,
  removeReflectionTarget,
  resumeShared,
  scheduleReflectionPaint,
  setInstanceVisible,
  setSharedPreset,
  updateGlow,
  updateInstance,
  type MetalFxInstance,
} from './engine';
import { ensureStylesInjected } from './styles';
import type { MetalFxProps, MetalFxTheme } from './types';

/** Resolve `theme: 'auto'` to a concrete `'dark' | 'light'` value, listening
 *  for system theme changes via `prefers-color-scheme`. */
function useResolvedTheme(theme: MetalFxTheme): 'dark' | 'light' {
  const [resolved, setResolved] = useState<'dark' | 'light'>(() => {
    if (theme !== 'auto') return theme;
    if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    if (theme !== 'auto') {
      setResolved(theme);
      return;
    }
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setResolved(mql.matches ? 'dark' : 'light');
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [theme]);

  return resolved;
}

/**
 * MetalFx — wrap a single child with an animated WebGL metal effect.
 *
 * The wrapper IS the visible button surface (carries the background, corner
 * radius, and the layered overlays). The wrapped child stays the actual
 * interactive element — it receives clicks, focus, keyboard events — but its
 * own border/outline/box-shadow/background are normalized so they don't
 * fight the metal frame.
 *
 * Layer order (matching `Image loader/index.html`):
 *   z=0  shader canvas (centre-punched so only the outer ring is visible)
 *   z=1  `.metal-fx-inner` solid fill
 *   z=2  `::before` soft inset highlight
 *   z=3  glow SVG
 *   z=4  `::after` 1px hairline
 *   z=5  user content
 */
export const MetalFx = forwardRef<HTMLDivElement, MetalFxProps>(function MetalFx(
  {
    children,
    variant = 'button',
    preset = 'chromatic',
    theme = 'dark',
    strength = 1,
    paused = false,
    borderRadius,
    normalizeHostStyles = true,
    reflectionTargets,
    disableGlow = false,
    className,
    style,
    ...rest
  },
  forwardedRef
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const glowHostRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<MetalFxInstance | null>(null);
  const glowHandlesRef = useRef<ReturnType<typeof injectGlow> | null>(null);
  /** Latest resolved theme — read by the per-frame glow tick so theme
   *  switches take effect without rebuilding the RAF closure. */
  const themeRef = useRef<'dark' | 'light'>('dark');

  const resolvedTheme = useResolvedTheme(theme);
  themeRef.current = resolvedTheme;
  /** Variant -> shape mapping. The Bold variant is rendered as a circle, the
   *  Button variant as a pill. The actual silhouette comes from the wrapped
   *  child's measured box, this mapping just feeds the engine + CSS data
   *  attributes for shape-specific tuning. */
  const shape: 'pill' | 'circle' = variant === 'bold' ? 'circle' : 'pill';

  const glowEnabled = !disableGlow;

  useImperativeHandle(forwardedRef, () => rootRef.current as HTMLDivElement, []);

  useLayoutEffect(() => {
    ensureStylesInjected();
  }, []);

  // Push current preset/theme to the shared renderer.
  useEffect(() => {
    setSharedPreset(preset, resolvedTheme);
  }, [preset, resolvedTheme]);

  // Pause / resume the shared renderer on prop change.
  useEffect(() => {
    if (paused) pauseShared();
    else resumeShared();
  }, [paused]);

  // Mount: measure the host (the WRAPPER, since that's the visible surface)
  // and create the per-instance renderer state.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    const glowHost = glowHostRef.current;
    if (!canvas || !root) return;
    if (glowEnabled && !glowHost) return;

    const measure = () => {
      const rect = root.getBoundingClientRect();
      // Round CSS dimensions to whole pixels so the glow SVG viewBox + path
      // perimeter stay in lockstep with the canvas border-radius. Sub-pixel
      // host sizes (e.g. a 36.5 × 36.5 box from a flex parent) push the
      // perimeter walk through a microscopic top/bottom edge that breaks the
      // "perfect circle" assumption — the path-builder's `topLen = w − 2r`
      // becomes 0.5 instead of 0, so the bold's wandering anchor + catch-
      // light snap onto a stadium-with-tiny-flats instead of the visible
      // circular silhouette. Whole pixels here keeps W=H=2R for the bold
      // variant on every host, regardless of the parent's flex math. */
      const cssWidth = Math.max(1, Math.round(rect.width));
      const cssHeight = Math.max(1, Math.round(rect.height));
      const rawRadius = (() => {
        if (typeof borderRadius === 'number') return borderRadius;
        const computed = getComputedStyle(root);
        const parsed = parseFloat(computed.borderTopLeftRadius);
        return Number.isFinite(parsed) ? parsed : 0;
      })();
      // Bold variant intentionally renders as a circle — clamp the corner
      // radius to at least half the smaller side so the host silhouette
      // is a true circle even when the consumer passes a smaller radius
      // than the side count (e.g. `borderRadius={16}` on a 40 × 40 host).
      // Without this clamp the glow's perimeter walk emits a tiny flat
      // edge segment and the catch-light visibly skips off the rim.
      const cornerRadius =
        shape === 'circle'
          ? Math.max(rawRadius, Math.min(cssWidth, cssHeight) / 2)
          : rawRadius;
      return { cssWidth, cssHeight, cornerRadius };
    };

    const initial = measure();
    instanceRef.current = createInstance({
      hostCanvas: canvas,
      cssWidth: initial.cssWidth,
      cssHeight: initial.cssHeight,
      cornerRadius: initial.cornerRadius,
      kind: shape,
      onAfterFrame: scheduleReflectionPaint,
    });
    if (glowEnabled && glowHost) {
      glowHandlesRef.current = injectGlow(glowHost, {
        width: initial.cssWidth,
        height: initial.cssHeight,
        cornerRadius: initial.cornerRadius,
        kind: shape,
      });
    }

    let resizeRaf = 0;
    const ro = new ResizeObserver(() => {
      if (resizeRaf !== 0) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        const next = measure();
        const inst = instanceRef.current;
        if (!inst) return;
        updateInstance(inst, {
          cssWidth: next.cssWidth,
          cssHeight: next.cssHeight,
          cornerRadius: next.cornerRadius,
        });
        // Mirror the resolved corner radius onto the host so the inset-aware
        // rules in styles.ts (`calc(var(--mfx-radius, ...) - inset)`)
        // recompute the inner div + ::before / ::after radii after every
        // size change. Without this, a host that grows past the original
        // measured size keeps its old `--mfx-radius` and the bold's inner
        // hairline + the white outer hairline drift away from the visible
        // silhouette curve.
        root.style.setProperty('--mfx-radius', `${next.cornerRadius}px`);
        if (typeof borderRadius === 'number') {
          root.style.borderRadius = `${next.cornerRadius}px`;
        }
        if (glowEnabled && glowHost) {
          // Wipe + re-inject so the SVG viewBox matches the new dimensions.
          glowHost.innerHTML = '';
          glowHandlesRef.current = injectGlow(glowHost, {
            width: next.cssWidth,
            height: next.cssHeight,
            cornerRadius: next.cornerRadius,
            kind: shape,
          });
        }
      });
    });
    ro.observe(root);

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          const inst = instanceRef.current;
          if (!inst) return;
          for (const entry of entries) {
            setInstanceVisible(inst, entry.isIntersecting);
          }
        },
        { rootMargin: '64px' }
      );
      io.observe(root);
    }

    /* Per-frame glow update — runs on its own RAF so we don't block the
     * shared renderer's loop. The shared loop populates the GL framebuffer
     * sample buffer (`renderer.glowSampleBuf`) before this fires, so the
     * brightness scan inside `updateGlow` reads fresh shader luminance.
     * The shared loop already calls `scheduleReflectionPaint` via
     * `onAfterFrame`; the glow has its own cadence that's allowed to
     * stutter under load without ruining the look. */
    let glowRaf = 0;
    const tickGlow = (now: number) => {
      const handles = glowHandlesRef.current;
      const inst = instanceRef.current;
      if (handles && inst && inst.visible) {
        updateGlow(handles, inst, now, inst.opacityMul, themeRef.current);
      }
      glowRaf = requestAnimationFrame(tickGlow);
    };
    glowRaf = requestAnimationFrame(tickGlow);

    return () => {
      ro.disconnect();
      io?.disconnect();
      if (resizeRaf !== 0) cancelAnimationFrame(resizeRaf);
      if (glowRaf !== 0) cancelAnimationFrame(glowRaf);
      const inst = instanceRef.current;
      if (inst) destroyInstance(inst);
      instanceRef.current = null;
      glowHandlesRef.current = null;
      if (glowHost) glowHost.innerHTML = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, glowEnabled]);

  // Apply strength to instance opacity multiplier — affects canvas alpha each
  // frame (handled in renderer) and glow alpha (handled in updateGlow).
  //
  // The Button variant gets a 0.92 ceiling: per design, "what used to render
  // at strength=0.92" is now the visual 100 % for buttons (i.e. the new full-
  // strength look reads slightly softer than the old raw-1.0 ceiling, which
  // tended to flash too hot on the canonical 134 × 40 pill against a dark
  // surface). The Bold variant is unaffected and continues to map the user's
  // strength 1:1 onto the renderer + glow opacity, so the 36 × 36 circle
  // still hits its full canonical intensity at strength = 1. Mapping happens
  // here at the consumer-facing API boundary, so the engine keeps a single
  // [0..1] semantic and the caller never has to think about the variant.
  useEffect(() => {
    const inst = instanceRef.current;
    if (!inst) return;
    const cap = variant === 'button' ? 0.92 : 1;
    updateInstance(inst, {
      opacityMul: Math.max(0, Math.min(1, strength * cap)),
    });
  }, [strength, variant]);

  // Reflection target registration (dark mode only).
  useEffect(() => {
    const inst = instanceRef.current;
    const root = rootRef.current;
    if (!inst || !root || !reflectionTargets || resolvedTheme !== 'dark') return;
    const live = reflectionTargets.flatMap((r) => (r.current ? [r.current] : []));
    for (const el of live) addReflectionTarget(el, inst, root);
    return () => {
      for (const el of live) removeReflectionTarget(el);
    };
  }, [reflectionTargets, resolvedTheme]);

  // Push corner radius to a CSS var so the inset-aware rules in styles.ts can
  // compute the inner div's radius (= outer − inset). We always write the
  // ENGINE's resolved radius (which the bold variant clamps to half the
  // smaller side) so the inner div stays a true circle even when the user
  // passes `borderRadius` smaller than half the host. Visible host shape
  // also uses the resolved radius for the same reason.
  useEffect(() => {
    const root = rootRef.current;
    const inst = instanceRef.current;
    if (!root || !inst) return;
    root.style.setProperty('--mfx-radius', `${inst.cornerRadius}px`);
    if (typeof borderRadius === 'number') {
      root.style.borderRadius = `${inst.cornerRadius}px`;
    }
  }, [borderRadius, resolvedTheme, variant]);

  const wrapperStyle = useMemo<CSSProperties>(
    () => ({
      ...style,
      ['--mfx-strength' as string]: String(Math.min(1, Math.max(0, strength))),
    }),
    [style, strength]
  );

  return (
    <div
      {...rest}
      ref={rootRef}
      className={['metal-fx-root', className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-shape={shape}
      data-theme={resolvedTheme}
      data-paused={paused ? 'true' : undefined}
      data-normalize={normalizeHostStyles ? 'true' : 'false'}
      style={wrapperStyle}
    >
      <canvas ref={canvasRef} className="metal-fx-canvas" aria-hidden="true" />
      <div ref={innerRef} className="metal-fx-inner" aria-hidden="true" />
      {glowEnabled && (
        <div
          ref={glowHostRef}
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 3,
            borderRadius: 'inherit',
          }}
        />
      )}
      <div ref={contentRef} className="metal-fx-content">
        {children}
      </div>
    </div>
  );
});

MetalFx.displayName = 'MetalFx';
