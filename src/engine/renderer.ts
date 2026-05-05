/**
 * Shared renderer for the metal-fx effect.
 *
 * Architecture (mirrors `Image loader/index.html` 1:1):
 *   • One off-screen 300×300 (×DPR) WebGL canvas runs the Plasma shader.
 *     This is the canonical render target — the same `canvas` used by
 *     `metal.html` to drive its `btnDisplay` 140×40 pipeline.
 *   • A virtual 140×40 (×DPR) "btnDisplay" surface is the per-CSS-px
 *     reference for every aux instance (we don't actually allocate it; the
 *     dimensions are computed). Each instance copies a centred CROP of the
 *     GL canvas onto its own 2D canvas using the SAME per-CSS-px ratio as
 *     the canonical pill, then divides the source window by the instance's
 *     `shaderScale` to zoom features when the host is smaller (circle hosts)
 *     or to dial scale to taste (Button variant uses `1.6`).
 *   • Each instance then punches a rounded-rect inner hole on its own
 *     canvas so only the outer ring of the shader survives. The visible
 *     "metal frame" look comes from the consumer's `.metal-fx-inner` div
 *     covering the hole.
 *
 * This file owns the GL context (one per page), the program, the uniform
 * uploads, the shared RAF loop, and the per-instance copy + punch logic.
 */
import {
  FRAG_SHADER_SRC,
  VERT_SHADER_SRC,
  compileShader,
  linkProgram,
} from './shaders';
import {
  PRESETS,
  hexToRgb,
  type PresetMode,
  type PresetName,
  type PresetTheme,
} from './presets';

/** Canonical WebGL render target — matches `metal.html`'s 300×300 surface. */
const CANONICAL_GL_SIZE = 300;

/** Canonical pill width in CSS px (drives btnDisplay's per-CSS-px ratio). */
export const CANONICAL_PILL_W = 140;
/** Canonical pill height in CSS px. */
export const CANONICAL_PILL_H = 40;

/** Default per-instance source-window divisor for the Button variant (pill).
 *  Matches `index.html`'s `PILL_SHADER_SCALE`. Higher = more zoomed-in. */
export const PILL_SHADER_SCALE = 1.6;
/** Default per-instance source-window divisor for the Circle variant.
 *  Matches `index.html`'s `BOLD_SHADER_SCALE` (legacy name preserved in the
 *  canonical engine for parity, but exported under the Circle name here). */
export const CIRCLE_SHADER_SCALE = 1.3;

/** Shared GL state. Created lazily on the first instance, destroyed when the
 *  last instance unmounts so a long-lived SPA doesn't hold a WebGL slot
 *  forever. */
interface SharedRenderer {
  glCanvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  uniforms: Record<string, WebGLUniformLocation | null>;
  preset: PresetMode;
  /** Wallclock origin for `u_time`. */
  startMs: number;
  /** Accumulated paused-time so resume doesn't snap the animation. */
  pausedMs: number;
  pausedAtMs: number | null;
  rafId: number;
  /** DPR captured on last resize. */
  dpr: number;
  instances: Set<MetalFxInstance>;
  /** Frame counter — incremented every successful `renderSharedFrame`. Used by
   *  glow consumers to invalidate cached scans cheaply. */
  frameCount: number;
}

// (the previous shared GL-fb readback for glow sampling lived here — retired
// in favour of per-instance `getImageData` populated inside
// `copyShaderToInstance`, mirroring index.html's `btnGlowSampleBuf` exactly.)

let SHARED: SharedRenderer | null = null;

function ensureSharedRenderer(): SharedRenderer {
  if (SHARED) return SHARED;

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const glCanvas = document.createElement('canvas');
  glCanvas.width = CANONICAL_GL_SIZE * dpr;
  glCanvas.height = CANONICAL_GL_SIZE * dpr;

  const gl =
    (glCanvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      // Required so per-instance `drawImage` reads the freshest GL output
      // between RAF ticks — without this, sampling an off-screen GL canvas
      // returns transparent black on most desktop drivers.
      preserveDrawingBuffer: true,
    }) as WebGLRenderingContext | null) ||
    (glCanvas.getContext('experimental-webgl') as WebGLRenderingContext | null);

  if (!gl) {
    throw new Error('metal-fx: WebGL is not supported in this browser');
  }

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const vert = compileShader(gl, gl.VERTEX_SHADER, VERT_SHADER_SRC);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SHADER_SRC);
  const program = linkProgram(gl, vert, frag);
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('metal-fx: gl.createBuffer returned null');
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
  );
  const positionLoc = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

  const uniformNames = [
    'u_resolution', 'u_time',
    'u_color1', 'u_color2', 'u_color3', 'u_color4', 'u_color5', 'u_color6', 'u_color7',
    'u_alpha1', 'u_alpha2', 'u_alpha3', 'u_alpha4', 'u_alpha5', 'u_alpha6', 'u_alpha7',
    'u_intensity', 'u_scale', 'u_direction',
    'u_softness', 'u_distortion', 'u_complexity', 'u_shape',
    'u_vignette', 'u_vigOpacity', 'u_blur', 'u_shaderOpacity',
  ];
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of uniformNames) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }

  SHARED = {
    glCanvas,
    gl,
    program,
    buffer,
    uniforms,
    preset: PRESETS.chromatic.modes.dark,
    startMs: performance.now(),
    pausedMs: 0,
    pausedAtMs: null,
    rafId: 0,
    dpr,
    instances: new Set(),
    frameCount: 0,
  };
  return SHARED;
}

/** RGB triple in 0..255 range. */
export interface ShaderRGB {
  r: number;
  g: number;
  b: number;
}

const FALLBACK_WHITE: ShaderRGB = { r: 255, g: 255, b: 255 };

/** Sample shader luminance at instance-canvas pixel `(x, y)` (DPR-aware).
 *  Direct port of `_btnGlowLumAt` (index.html L5316) — reads from the
 *  per-instance 2D-canvas bitmap captured BEFORE the centre punch, using
 *  Rec.709 luminance weights (0.2126 R + 0.7152 G + 0.0722 B). The buffer
 *  is in the SAME coordinate system as the perimeter sample table (DPR-
 *  space pixels on the visible button), so no GL-fb crop math is needed:
 *  the (x,y) caller passes are direct buffer indices.
 *
 *  Returns 0..1 luminance, or 0 when no buffer is available yet (first
 *  frame, paused, or `getImageData` failure). */
export function sampleShaderLumAt(
  inst: MetalFxInstance,
  x: number,
  y: number,
  radius: number
): number {
  const buf = inst.glowSampleBuf;
  if (!buf) return 0;
  const W = inst.glowSampleW;
  const H = inst.glowSampleH;
  const cx = Math.round(x);
  const cy = Math.round(y);
  const r = Math.max(1, radius | 0);
  const x0 = Math.max(0, cx - r);
  const x1 = Math.min(W, cx + r + 1);
  const y0 = Math.max(0, cy - r);
  const y1 = Math.min(H, cy + r + 1);
  let sum = 0;
  let count = 0;
  for (let py = y0; py < y1; py++) {
    const rowBase = py * W;
    for (let px = x0; px < x1; px++) {
      const i = (rowBase + px) * 4;
      sum += (0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]) / 255;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/** Average shader RGB at instance-canvas pixel `(x, y)` over a `radius`
 *  window. Direct port of `_btnGlowRGBAt` (index.html L5259). Used in dark
 *  mode to drive the halo's per-frame tint toward the local shader hue. */
export function sampleShaderRGBAt(
  inst: MetalFxInstance,
  x: number,
  y: number,
  radius: number
): ShaderRGB {
  const buf = inst.glowSampleBuf;
  if (!buf) return FALLBACK_WHITE;
  const W = inst.glowSampleW;
  const H = inst.glowSampleH;
  const cx = Math.round(x);
  const cy = Math.round(y);
  const r = Math.max(1, radius | 0);
  const x0 = Math.max(0, cx - r);
  const x1 = Math.min(W, cx + r + 1);
  const y0 = Math.max(0, cy - r);
  const y1 = Math.min(H, cy + r + 1);
  let sR = 0, sG = 0, sB = 0, count = 0;
  for (let py = y0; py < y1; py++) {
    const rowBase = py * W;
    for (let px = x0; px < x1; px++) {
      const i = (rowBase + px) * 4;
      sR += buf[i];
      sG += buf[i + 1];
      sB += buf[i + 2];
      count++;
    }
  }
  if (count === 0) return FALLBACK_WHITE;
  return { r: sR / count, g: sG / count, b: sB / count };
}

/** Pick the most chromatic pixel in the window — preserves shader hue when
 *  averaging would collapse to neutral grey. Direct port of
 *  `_btnGlowRGBAtMostChromatic` (index.html L5286). */
export function sampleShaderRGBChromatic(
  inst: MetalFxInstance,
  x: number,
  y: number,
  radius: number
): ShaderRGB {
  const buf = inst.glowSampleBuf;
  if (!buf) return FALLBACK_WHITE;
  const W = inst.glowSampleW;
  const H = inst.glowSampleH;
  const cx = Math.round(x);
  const cy = Math.round(y);
  const r = Math.max(1, radius | 0);
  const x0 = Math.max(0, cx - r);
  const x1 = Math.min(W, cx + r + 1);
  const y0 = Math.max(0, cy - r);
  const y1 = Math.min(H, cy + r + 1);
  let bestR = 255, bestG = 255, bestB = 255, bestScore = -1;
  for (let py = y0; py < y1; py++) {
    const rowBase = py * W;
    for (let px = x0; px < x1; px++) {
      const i = (rowBase + px) * 4;
      const rr = buf[i];
      const gg = buf[i + 1];
      const bb = buf[i + 2];
      const maxC = Math.max(rr, gg, bb);
      const minC = Math.min(rr, gg, bb);
      const sat = maxC > 0 ? (maxC - minC) / maxC : 0;
      const val = maxC / 255;
      const score = sat * (0.35 + 0.65 * val);
      if (score > bestScore) {
        bestScore = score;
        bestR = rr;
        bestG = gg;
        bestB = bb;
      }
    }
  }
  return { r: bestR, g: bestG, b: bestB };
}

/** Per-instance state owned by one mounted `<MetalFx>`. */
export interface MetalFxInstance {
  /** Visible 2D canvas painted each frame. */
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Host CSS dimensions — drives both canvas size and source crop. */
  cssWidth: number;
  cssHeight: number;
  /** Border radius (CSS px) of the host. Used by the punch mask. */
  cornerRadius: number;
  /** Variant kind: pill or circle. */
  kind: 'pill' | 'circle';
  /** When true the punch mask leaves a 2-px ring (circles need it to survive
   *  sub-pixel anti-aliasing on curved silhouettes). When false (pills),
   *  it leaves a 1-px ring. */
  ringCssPx: number;
  /** Per-instance source-window divisor — see `PILL_SHADER_SCALE`. */
  shaderScale: number;
  /** Per-instance opacity multiplier (0..1). Strength prop. */
  opacityMul: number;
  /** Whether to skip the per-frame copy when offscreen. */
  visible: boolean;
  dpr: number;
  /** Optional callback fired after each per-frame paint. */
  onAfterFrame?: () => void;
  /** RGBA bitmap of the visible 2D canvas BEFORE the centre punch — populated
   *  every frame by `copyShaderToInstance` via `getImageData`. The glow
   *  brightness scan + tint sampler read from this buffer using simple
   *  linear coords (DPR-space x,y → buffer index = (y*W+x)*4), exactly
   *  mirroring `btnGlowSampleBuf` from index.html L7654. */
  glowSampleBuf: Uint8ClampedArray | null;
  glowSampleW: number;
  glowSampleH: number;
}

interface CreateInstanceOptions {
  hostCanvas: HTMLCanvasElement;
  cssWidth: number;
  cssHeight: number;
  cornerRadius: number;
  kind: 'pill' | 'circle';
  shaderScale?: number;
  ringCssPx?: number;
  opacityMul?: number;
  onAfterFrame?: () => void;
}

export function createInstance(opts: CreateInstanceOptions): MetalFxInstance {
  const renderer = ensureSharedRenderer();
  const ctx = opts.hostCanvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('metal-fx: failed to acquire 2D context');

  const inst: MetalFxInstance = {
    canvas: opts.hostCanvas,
    ctx,
    cssWidth: opts.cssWidth,
    cssHeight: opts.cssHeight,
    cornerRadius: opts.cornerRadius,
    kind: opts.kind,
    ringCssPx: opts.ringCssPx ?? (opts.kind === 'circle' ? 2 : 1),
    shaderScale:
      opts.shaderScale ??
      (opts.kind === 'circle' ? CIRCLE_SHADER_SCALE : PILL_SHADER_SCALE),
    opacityMul: opts.opacityMul ?? 1,
    visible: true,
    dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
    onAfterFrame: opts.onAfterFrame,
    glowSampleBuf: null,
    glowSampleW: 0,
    glowSampleH: 0,
  };

  resizeInstanceCanvas(inst);
  renderer.instances.add(inst);

  if (renderer.rafId === 0 && renderer.pausedAtMs === null) {
    startSharedLoop();
  }
  return inst;
}

export function destroyInstance(inst: MetalFxInstance): void {
  if (!SHARED) return;
  SHARED.instances.delete(inst);
  if (SHARED.instances.size === 0) {
    stopSharedLoop();
    teardownSharedRenderer();
  }
}

export function updateInstance(
  inst: MetalFxInstance,
  patch: Partial<{
    cssWidth: number;
    cssHeight: number;
    cornerRadius: number;
    kind: 'pill' | 'circle';
    shaderScale: number;
    ringCssPx: number;
    opacityMul: number;
  }>
): void {
  let dirty = false;
  if (patch.cssWidth !== undefined && patch.cssWidth !== inst.cssWidth) {
    inst.cssWidth = patch.cssWidth;
    dirty = true;
  }
  if (patch.cssHeight !== undefined && patch.cssHeight !== inst.cssHeight) {
    inst.cssHeight = patch.cssHeight;
    dirty = true;
  }
  if (patch.cornerRadius !== undefined) inst.cornerRadius = patch.cornerRadius;
  if (patch.kind !== undefined && patch.kind !== inst.kind) {
    inst.kind = patch.kind;
    if (patch.shaderScale === undefined) {
      inst.shaderScale =
        patch.kind === 'circle' ? CIRCLE_SHADER_SCALE : PILL_SHADER_SCALE;
    }
    if (patch.ringCssPx === undefined) {
      inst.ringCssPx = patch.kind === 'circle' ? 2 : 1;
    }
  }
  if (patch.shaderScale !== undefined) inst.shaderScale = patch.shaderScale;
  if (patch.ringCssPx !== undefined) inst.ringCssPx = patch.ringCssPx;
  if (patch.opacityMul !== undefined) inst.opacityMul = patch.opacityMul;
  if (dirty) resizeInstanceCanvas(inst);
}

export function setInstanceVisible(inst: MetalFxInstance, visible: boolean): void {
  inst.visible = visible;
}

export function setSharedPreset(name: PresetName, theme: PresetTheme): void {
  const renderer = ensureSharedRenderer();
  renderer.preset = PRESETS[name].modes[theme];
}

export function pauseShared(): void {
  if (!SHARED || SHARED.pausedAtMs !== null) return;
  SHARED.pausedAtMs = performance.now();
  stopSharedLoop();
}

export function resumeShared(): void {
  if (!SHARED || SHARED.pausedAtMs === null) return;
  const now = performance.now();
  SHARED.pausedMs += now - SHARED.pausedAtMs;
  SHARED.pausedAtMs = null;
  if (SHARED.instances.size > 0) startSharedLoop();
}

/** Resize the per-instance canvas to current CSS size × DPR. */
function resizeInstanceCanvas(inst: MetalFxInstance): void {
  inst.dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const w = Math.max(1, Math.round(inst.cssWidth * inst.dpr));
  const h = Math.max(1, Math.round(inst.cssHeight * inst.dpr));
  if (inst.canvas.width !== w) inst.canvas.width = w;
  if (inst.canvas.height !== h) inst.canvas.height = h;
}

/** Punch the inner hole on the visible canvas so only the outer ring of the
 *  shader survives. Mirrors `punchAuxInnerHole` from `index.html` exactly:
 *  ring width = `ringCssPx` × DPR; inner radius = `(cornerRadius − ringCssPx)`
 *  × DPR. */
function punchInnerHole(inst: MetalFxInstance): void {
  const ctx = inst.ctx;
  const dpr = inst.dpr;
  const stroke = inst.ringCssPx * dpr;
  const w = inst.canvas.width;
  const h = inst.canvas.height;
  const innerR = Math.max(0, (inst.cornerRadius - inst.ringCssPx) * dpr);

  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  ctx.beginPath();
  const x = stroke;
  const y = stroke;
  const iw = w - 2 * stroke;
  const ih = h - 2 * stroke;
  if (
    typeof (ctx as CanvasRenderingContext2D & { roundRect?: unknown })
      .roundRect === 'function'
  ) {
    (ctx as CanvasRenderingContext2D & {
      roundRect: (x: number, y: number, w: number, h: number, r: number) => void;
    }).roundRect(x, y, iw, ih, innerR);
  } else {
    // Manual rounded-rect fallback for older Safari.
    const r = Math.min(innerR, iw / 2, ih / 2);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + iw - r, y);
    ctx.arcTo(x + iw, y, x + iw, y + r, r);
    ctx.lineTo(x + iw, y + ih - r);
    ctx.arcTo(x + iw, y + ih, x + iw - r, y + ih, r);
    ctx.lineTo(x + r, y + ih);
    ctx.arcTo(x, y + ih, x, y + ih - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
  }
  ctx.fill();
  ctx.restore();
}

/** Per-frame copy from the shared GL canvas into an instance's 2D canvas.
 *  Source crop math reproduces `copyShaderToAux` from the canonical engine
 *  exactly: pick the same per-CSS-pixel ratio as the canonical 140×40
 *  `btnDisplay` (so 1 CSS px on this aux samples the same shader region as
 *  1 CSS px on the canonical pill), then divide by `shaderScale` to zoom
 *  features for smaller hosts (circle) or to taste (Button variant). */
function copyShaderToInstance(inst: MetalFxInstance): void {
  if (!SHARED) return;
  const renderer = SHARED;
  const dpr = inst.dpr;
  const dw = inst.canvas.width;
  const dh = inst.canvas.height;
  if (dw < 1 || dh < 1) return;

  const cw = renderer.glCanvas.width;
  const ch = renderer.glCanvas.height;
  const bdW = CANONICAL_PILL_W * dpr;
  const bdH = CANONICAL_PILL_H * dpr;
  const sxRatio = cw / bdW;
  const syRatio = ch / bdH;
  let srcW = (dw * sxRatio) / inst.shaderScale;
  let srcH = (dh * syRatio) / inst.shaderScale;
  if (srcW > cw) srcW = cw;
  if (srcH > ch) srcH = ch;
  const sx = Math.max(0, (cw - srcW) / 2);
  const sy = Math.max(0, (ch - srcH) / 2);

  inst.ctx.clearRect(0, 0, dw, dh);
  if (inst.opacityMul < 1) inst.ctx.globalAlpha = inst.opacityMul;
  inst.ctx.drawImage(renderer.glCanvas, sx, sy, srcW, srcH, 0, 0, dw, dh);
  if (inst.opacityMul < 1) inst.ctx.globalAlpha = 1;

  // Capture the unpunched bitmap for the glow's brightness scan + tint
  // sampler. Direct port of `btnGlowSampleBuf = btnDisplayCtx.getImageData(...)`
  // from index.html L7654 — the canonical engine reads from the SAME 2D
  // bitmap each frame BEFORE punching the centre hole, so the perimeter
  // sample at e.g. (cssX=18, cssY=0) on a 36×36 circle reads from buffer
  // index `(0 * 72 + 36) * 4` directly, with no GL-fb crop math involved.
  // Skipping the readback when neither glow nor reflection consumers ever
  // sample isn't worth the bookkeeping — the per-instance buffer is small
  // (≤ 268 × 80 × 4 ≈ 86 KB at default DPR) and `getImageData` reuses the
  // same backing store via the assignment.
  try {
    const img = inst.ctx.getImageData(0, 0, dw, dh);
    inst.glowSampleBuf = img.data;
    inst.glowSampleW = dw;
    inst.glowSampleH = dh;
  } catch {
    // Cross-origin canvas tainting can throw — leave the buffer as-is so
    // the glow falls back to its existing value (or stays at zero
    // luminance, which means the floor opacity path).
  }

  punchInnerHole(inst);

  inst.onAfterFrame?.();
}

/** Single GL render pass — uploads uniforms from the active preset. */
function renderSharedFrame(now: number): void {
  if (!SHARED) return;
  const { gl, uniforms, preset } = SHARED;
  const t = ((now - SHARED.startMs - SHARED.pausedMs) / 1000) * preset.speed;

  gl.viewport(0, 0, SHARED.glCanvas.width, SHARED.glCanvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  if (uniforms.u_resolution)
    gl.uniform2f(uniforms.u_resolution, SHARED.glCanvas.width, SHARED.glCanvas.height);
  if (uniforms.u_time) gl.uniform1f(uniforms.u_time, t);

  for (let i = 0; i < 7; i++) {
    const colorLoc = uniforms[`u_color${i + 1}`];
    if (colorLoc) {
      const [r, g, b] = hexToRgb(preset.colors[i]);
      gl.uniform3f(colorLoc, r, g, b);
    }
    const alphaLoc = uniforms[`u_alpha${i + 1}`];
    if (alphaLoc) gl.uniform1f(alphaLoc, preset.alphas[i]);
  }
  if (uniforms.u_intensity) gl.uniform1f(uniforms.u_intensity, preset.intensity);
  if (uniforms.u_scale) gl.uniform1f(uniforms.u_scale, preset.scale);
  if (uniforms.u_direction)
    gl.uniform1f(uniforms.u_direction, (preset.direction * Math.PI) / 180);
  if (uniforms.u_softness) gl.uniform1f(uniforms.u_softness, preset.softness);
  if (uniforms.u_distortion) gl.uniform1f(uniforms.u_distortion, preset.distortion);
  if (uniforms.u_complexity) gl.uniform1f(uniforms.u_complexity, preset.complexity);
  if (uniforms.u_shape) gl.uniform1f(uniforms.u_shape, preset.shape);
  if (uniforms.u_vignette) gl.uniform1f(uniforms.u_vignette, preset.vignette);
  if (uniforms.u_vigOpacity) gl.uniform1f(uniforms.u_vigOpacity, preset.vigOpacity);
  if (uniforms.u_blur) gl.uniform1f(uniforms.u_blur, preset.blur);
  if (uniforms.u_shaderOpacity)
    gl.uniform1f(uniforms.u_shaderOpacity, preset.shaderOpacity);

  gl.drawArrays(gl.TRIANGLES, 0, 6);

  // Glow brightness scans no longer use a shared GL framebuffer readback —
  // each instance captures its own visible 2D-canvas bitmap via
  // `getImageData` inside `copyShaderToInstance` (mirroring the canonical
  // engine's `btnGlowSampleBuf` from index.html L7654). That removes the
  // `gl.readPixels(0, 0, 300×dpr, 300×dpr, RGBA, UNSIGNED_BYTE, …)` cost
  // (~360 KB readback per frame at default DPR) AND fixes the brightness-
  // anchor / tint sampler — which were reading the wrong region of the
  // raw GL canvas because the centred sub-rect crop applied during
  // `drawImage` was never inverted in the sampler.
  SHARED.frameCount++;
}

function tick(now: number): void {
  if (!SHARED) return;
  let anyVisible = false;
  for (const inst of SHARED.instances) {
    if (inst.visible) {
      anyVisible = true;
      break;
    }
  }
  if (anyVisible) {
    renderSharedFrame(now);
    for (const inst of SHARED.instances) {
      if (inst.visible) copyShaderToInstance(inst);
    }
  }
  SHARED.rafId = requestAnimationFrame(tick);
}

function startSharedLoop(): void {
  if (!SHARED || SHARED.rafId !== 0) return;
  SHARED.rafId = requestAnimationFrame(tick);
}

function stopSharedLoop(): void {
  if (!SHARED) return;
  if (SHARED.rafId !== 0) cancelAnimationFrame(SHARED.rafId);
  SHARED.rafId = 0;
}

function teardownSharedRenderer(): void {
  if (!SHARED) return;
  const { gl, program, buffer } = SHARED;
  try {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose && typeof lose.loseContext === 'function') lose.loseContext();
  } catch {
    /* swallow */
  }
  SHARED = null;
}

/** Read accessor for the shared frame counter — glow consumers cache scans
 *  and invalidate when the counter changes. */
export function getSharedFrameCount(): number {
  return SHARED?.frameCount ?? 0;
}
