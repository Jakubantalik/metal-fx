import { useEffect, type RefObject } from 'react';
import { textMaskDataUrl } from '../lib/textMask';

/**
 * Confine a proximity reflection to an element's glyphs.
 *
 * The engine paints reflections into a wrapper it inserts inside the target
 * (`[data-metal-fx-reflection]`, canvases inset:0). For a text node that
 * would light the whole line box and stroke its rectangle. This masks the
 * wrapper with the text rendered white-on-transparent, so only the
 * letterforms catch the light. Re-rendered on resize and once fonts load.
 */
export function useTextReflection(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let disposed = false;
    let tries = 0;

    const apply = () => {
      if (disposed) return;
      const wrap = el.querySelector<HTMLElement>(':scope > [data-metal-fx-reflection]');
      // Engine attaches the wrapper after mount (and only in dark theme) —
      // wait a few seconds for it, then give up quietly.
      if (!wrap) { if (tries++ < 300) raf = requestAnimationFrame(apply); return; }
      tries = 0;
      const url = textMaskDataUrl(el, el);
      if (!url) return;
      const v = `url("${url}")`;
      wrap.style.maskImage = v;
      wrap.style.webkitMaskImage = v;
      wrap.style.maskRepeat = 'no-repeat';
      wrap.style.webkitMaskRepeat = 'no-repeat';
      wrap.style.maskSize = '100% 100%';
      wrap.style.webkitMaskSize = '100% 100%';
      // The reflection is silver over already-light text — as a normal
      // composite it vanishes. Additive blending brightens and tints the
      // strokes instead.
      wrap.style.mixBlendMode = 'plus-lighter';
    };

    apply();
    const ro = new ResizeObserver(() => apply());
    ro.observe(el);
    document.fonts?.ready.then(() => apply());
    // The engine tears down and re-inserts the wrapper whenever the owning
    // MetalFx's reflection effect re-runs — every new wrapper needs the mask.
    const mo = new MutationObserver((recs) => {
      for (const r of recs) {
        for (const n of Array.from(r.addedNodes)) {
          if (n instanceof HTMLElement && n.hasAttribute('data-metal-fx-reflection')) { apply(); return; }
        }
      }
    });
    mo.observe(el, { childList: true });

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref]);
}
