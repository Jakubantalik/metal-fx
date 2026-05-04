/** Public engine surface. */
export {
  createInstance,
  destroyInstance,
  updateInstance,
  setInstanceVisible,
  setSharedPreset,
  pauseShared,
  resumeShared,
  sampleShaderLumAt,
  sampleShaderRGBAt,
  sampleShaderRGBChromatic,
  getSharedFrameCount,
  type ShaderRGB,
  CANONICAL_PILL_W,
  CANONICAL_PILL_H,
  PILL_SHADER_SCALE,
  BOLD_SHADER_SCALE,
  type MetalFxInstance,
} from './renderer';

export { injectGlow, updateGlow, resizeGlow } from './glow';

export {
  addReflectionTarget,
  removeReflectionTarget,
  paintReflections,
  type ReflectionTarget,
} from './reflection';

export { scheduleReflectionPaint } from './animationLoop';

export {
  PRESETS,
  hexToRgb,
  type Preset,
  type PresetMode,
  type PresetName,
  type PresetTheme,
} from './presets';
