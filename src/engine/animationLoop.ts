/**
 * Auxiliary RAF driver for *target-side* work (currently: dark-mode reflections).
 *
 * The shared GL renderer in `renderer.ts` already runs its own RAF loop that
 * paints every registered metal-fx instance. Reflection targets don't belong
 * to a specific instance — they listen on multiple anchors at once and need
 * to repaint whenever ANY anchor's bitmap is dirty (i.e. every frame). To
 * avoid spinning a second RAF for each target we expose a single subscriber
 * hook that the renderer's tick calls (via `onAfterFrame`) once per frame.
 */
import { paintReflections } from './reflection';

let scheduled = false;

/**
 * Request a reflection repaint on the next frame. Cheap to call repeatedly —
 * subsequent calls within the same frame are coalesced.
 */
export function scheduleReflectionPaint(): void {
  if (scheduled) return;
  scheduled = true;
  if (typeof requestAnimationFrame === 'undefined') return;
  requestAnimationFrame(() => {
    scheduled = false;
    paintReflections();
  });
}
