# metal-fx

Animated WebGL "liquid metal" effect for React. Wrap a button, chip, or icon and it gets a real-time metal ring with optional proximity reflection on neighbouring elements.

[Live demo](https://metal.jakubantalik.com) · [Repository](https://github.com/Jakubantalik/metal-fx) · [Report an issue](https://github.com/Jakubantalik/metal-fx/issues)

## Install

```bash
npm install metal-fx
```

## Quick start

```tsx
import { MetalFx } from 'metal-fx';

function App() {
  return (
    <MetalFx variant="button">
      <button className="upgrade-pill">Upgrade to Pro</button>
    </MetalFx>
  );
}
```

The component wraps a single child host element, measures it, and paints an animated metal ring on top. The child stays fully interactive — overlays sit above it with `pointer-events: none`.

## Variants

```tsx
<MetalFx variant="button">  {/* Pill silhouette, 1 px ring, scale 1.6 */}
  <button>Upgrade to Pro</button>
</MetalFx>

<MetalFx variant="bold">    {/* Compact circle, 2 px ring, scale 1.3 */}
  <button>↑</button>
</MetalFx>
```

## Presets

Three bundled palettes, each with a tuned dark and light mode block:

```tsx
<MetalFx preset="chromatic" />  {/* Iridescent rainbow (default) */}
<MetalFx preset="silver" />     {/* Cool steel */}
<MetalFx preset="gold" />       {/* Warm gold */}
```

## Theme

```tsx
<MetalFx theme="dark" />    {/* Dark backgrounds (default) */}
<MetalFx theme="light" />   {/* Light backgrounds */}
<MetalFx theme="auto" />    {/* Follows prefers-color-scheme */}
```

## Strength

```tsx
<MetalFx strength={0.7}>  {/* 70% effect intensity */}
  <button>Upgrade to Pro</button>
</MetalFx>
```

`strength` runs from `0` (invisible) to `1` (full, default). It scales the canvas and glow opacity without changing the underlying shader animation.

## Paused

```tsx
<MetalFx paused>
  <button>Upgrade to Pro</button>
</MetalFx>
```

Freezes the shader on its current frame. The metal silhouette stays visible.

## Proximity reflection (dark mode only)

Pass refs to neighbouring elements and they receive a soft, mirrored reflection of the metal ring:

```tsx
const sendRef = useRef<HTMLButtonElement>(null);
const chipRef = useRef<HTMLButtonElement>(null);

<>
  <button ref={chipRef}>Tools</button>
  <MetalFx variant="bold" reflectionTargets={[chipRef]}>
    <button ref={sendRef} aria-label="Send">↑</button>
  </MetalFx>
</>
```

Reflections are skipped automatically when the resolved theme is `light` — no DOM scanning, no per-frame work in light mode.

## Performance

- One shared WebGL context is reused across every mounted `<MetalFx>` on the page. The shader is compiled once.
- A single `requestAnimationFrame` loop drives every instance. Per-frame work for one mount: a `gl.drawArrays` plus N×`drawImage` copies (one per visible instance).
- `IntersectionObserver` pauses per-instance copies when the host scrolls offscreen. When every instance is offscreen the GL render is skipped too.
- `ResizeObserver` callbacks are debounced through RAF.
- The GL context, program, and buffer are released when the last `<MetalFx>` unmounts.

## Server-side rendering

The component renders a transparent placeholder during SSR and only mounts the WebGL pipeline after hydration on the client. No flash of broken effect, no SSR errors.

## Custom border radius

By default `MetalFx` reads the computed `border-radius` of the wrapped child each resize. Pass an explicit override when needed:

```tsx
<MetalFx borderRadius={20}>
  <button>Upgrade to Pro</button>
</MetalFx>
```

## License

MIT &copy; [Jakub Antalik](https://github.com/Jakubantalik). See [LICENSE](./LICENSE).
