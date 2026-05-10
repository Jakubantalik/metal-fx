export { MetalFx } from './MetalFx';

export type {
  MetalFxProps,
  MetalFxVariant,
  MetalFxTheme,
  MetalFxPreset,
} from './types';

// Power-user surface: expose the engine primitives so consumers building
// non-React integrations can drive the same renderer.
export {
  PRESETS,
  hexToRgb,
  type Preset,
  type PresetMode,
  type PresetName,
  type PresetTheme,
} from './engine/presets';

export {
  createInstance,
  destroyInstance,
  updateInstance,
  setSharedPreset,
  pauseShared,
  resumeShared,
} from './engine/renderer/loop';

export type { MetalFxInstance } from './engine/renderer/core';
