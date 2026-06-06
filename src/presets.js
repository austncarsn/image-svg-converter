import { PRESET_CONFIGS } from "./presets_config.js";

export { PRESET_CONFIGS };

const freeze = Object.freeze;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return freeze(value);
}

function mapValues(source, mapper) {
  return freeze(
    Object.fromEntries(
      Object.entries(source).map(([key, value]) => [key, deepFreeze(mapper(value, key))])
    )
  );
}

function controls(values) {
  return freeze({
    colors: 32,
    ltres: 2,
    qtres: 2,
    pathomit: 6,
    blurradius: 0,
    scale: 1,
    optimize: true,
    outline: false,
    highQuality: true,
    ...values,
  });
}

function tracer(values) {
  return freeze({
    colors: 32,
    ltres: 2,
    qtres: 2,
    pathomit: 6,
    blurradius: 0,
    blurdelta: 20,
    scale: 1,
    optimize: true,
    outline: false,
    highQuality: true,
    colorsampling: 1,
    mincolorratio: 0.01,
    ...values,
  });
}

function fidelity(values) {
  return freeze({
    mode: "spline",
    hierarchical: "stacked",
    colorPrecision: 6,
    paletteSize: 40,
    filterSpeckle: 2,
    layerDifference: 8,
    pathPrecision: 9,
    cornerThreshold: 36,
    lengthThreshold: 2,
    spliceThreshold: 18,
    fallbackMinPaths: 12,
    fallbackMinColors: 10,
    ...values,
  });
}

function vtracer(values) {
  return freeze({
    mode: "spline",
    hierarchical: "stacked",
    colorPrecision: 6,
    filterSpeckle: 2,
    layerDifference: 8,
    pathPrecision: 9,
    cornerThreshold: 45,
    lengthThreshold: 2,
    spliceThreshold: 20,
    ...values,
  });
}

function pipeline(values) {
  return deepFreeze(values);
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

const COLOR_LIMITS = {
  logo: [2, 32],
  badge: [2, 64],
  photo: [2, 32],
  drawing: [2, 32],
  lineart: [2, 2],
  complex: [2, 64],
  pixelart: [2, 64],
  sticker: [2, 96],
};

export const PRESET_CONTROL_LIMITS = mapValues(COLOR_LIMITS, ([min, max]) => ({
  colors: { min, max },
}));

export const PRESET_DEFAULT_CONTROLS = freeze({
  logo: controls({ colors: 16, pathomit: 6, outline: true }),
  badge: controls({ colors: 32, pathomit: 1 }),
  photo: controls({ colors: 32, pathomit: 10, blurradius: 2 }),
  drawing: controls({ colors: 8, pathomit: 6, blurradius: 1, outline: true }),
  lineart: controls({ colors: 2, ltres: 4, qtres: 4, pathomit: 12, outline: true }),
  complex: controls({ colors: 40, ltres: 1, qtres: 1, pathomit: 1 }),
  pixelart: controls({
    colors: 32,
    ltres: 0,
    qtres: 0,
    pathomit: 0,
    optimize: false,
  }),
  sticker: controls({ colors: 32, pathomit: 1 }),
});

export const PRESET_POSTPROCESSING = freeze({
  logo: freeze({ minPathArea: 8, pathSimplification: "aggressive", coordinateDecimals: 2 }),
  badge: freeze({ minPathArea: 1, pathSimplification: "balanced", coordinateDecimals: 3 }),
  photo: freeze({ minPathArea: 0, pathSimplification: "none", coordinateDecimals: 3 }),
  drawing: freeze({ minPathArea: 8, pathSimplification: "balanced", coordinateDecimals: 2 }),
  lineart: freeze({ minPathArea: 12, pathSimplification: "aggressive", coordinateDecimals: 2 }),
  complex: freeze({ minPathArea: 1, pathSimplification: "none", coordinateDecimals: 2 }),
  pixelart: freeze({ minPathArea: 0, pathSimplification: "none", coordinateDecimals: 1 }),
  sticker: freeze({ minPathArea: 1, pathSimplification: "balanced", coordinateDecimals: 2 }),
});

/* -------------------------------------------------------------------------- */
/* ImageTracer fallback presets                                                */
/* -------------------------------------------------------------------------- */

export const IMAGE_TRACER_PRESETS = freeze({
  default: tracer({ colors: 6, ltres: 6, qtres: 6, pathomit: 14, blurradius: 1 }),

  logo: tracer({
    colors: 16,
    pathomit: 6,
    outline: true,
    mincolorratio: 0.008,
  }),

  photo: tracer({
    colors: 32,
    pathomit: 10,
    blurradius: 2,
    blurdelta: 64,
    colorsampling: 2,
  }),

  drawing: tracer({
    colors: 8,
    pathomit: 6,
    blurradius: 1,
    outline: true,
    blurdelta: 30,
    mincolorratio: 0.018,
  }),

  lineart: tracer({
    colors: 2,
    ltres: 4,
    qtres: 4,
    pathomit: 12,
    outline: true,
  }),

  complex: tracer({
    colors: 40,
    ltres: 1,
    qtres: 1,
    pathomit: 1,
    colorsampling: 2,
    mincolorratio: 0.005,
  }),

  badge: tracer({ colors: 32, pathomit: 1 }),
  sticker: tracer({ colors: 32, pathomit: 1 }),

  pixelart: tracer({
    colors: 32,
    ltres: 0,
    qtres: 0,
    pathomit: 0,
    blurdelta: 0,
    optimize: false,
    mincolorratio: 0,
  }),
});

/* -------------------------------------------------------------------------- */
/* VTracer fidelity modes                                                      */
/* -------------------------------------------------------------------------- */

export const TRACE_FIDELITY_MODES = freeze({
  clean: fidelity({
    colorPrecision: 5,
    paletteSize: 16,
    filterSpeckle: 4,
    layerDifference: 10,
    pathPrecision: 8,
    cornerThreshold: 42,
    lengthThreshold: 3,
    spliceThreshold: 24,
    fallbackMinPaths: 6,
    fallbackMinColors: 4,
  }),

  balanced: fidelity({}),

  high: fidelity({
    paletteSize: 56,
    filterSpeckle: 1,
    layerDifference: 6,
    pathPrecision: 10,
    cornerThreshold: 32,
    lengthThreshold: 1.6,
    spliceThreshold: 14,
    fallbackMinPaths: 18,
    fallbackMinColors: 14,
  }),

  ultra: fidelity({
    paletteSize: 64,
    filterSpeckle: 0,
    layerDifference: 5,
    pathPrecision: 10,
    cornerThreshold: 28,
    lengthThreshold: 1.25,
    spliceThreshold: 11,
    fallbackMinPaths: 24,
    fallbackMinColors: 18,
  }),

  stickerClean: fidelity({
    colorPrecision: 5,
    paletteSize: 24,
    filterSpeckle: 3,
    cornerThreshold: 45,
    lengthThreshold: 3.5,
    spliceThreshold: 20,
    fallbackMinPaths: 16,
    fallbackMinColors: 8,
    preserveWhiteCreamOutlines: true,
    preserveBlackDetails: false,
  }),

  stickerHigh: fidelity({
    colorPrecision: 5,
    paletteSize: 80,
    filterSpeckle: 0,
    cornerThreshold: 55,
    lengthThreshold: 3.5,
    spliceThreshold: 40,
    fallbackMinPaths: 30,
    fallbackMinColors: 18,
    preserveWhiteCreamOutlines: true,
    preserveBlackDetails: true,
  }),

  stickerUltra: fidelity({
    paletteSize: 96,
    filterSpeckle: 0,
    layerDifference: 4,
    pathPrecision: 10,
    cornerThreshold: 24,
    lengthThreshold: 1.25,
    spliceThreshold: 10,
    fallbackMinPaths: 38,
    fallbackMinColors: 22,
    preserveWhiteCreamOutlines: true,
    preserveBlackDetails: true,
  }),

  badgeClean: fidelity({
    colorPrecision: 5,
    paletteSize: 16,
    filterSpeckle: 4,
    layerDifference: 12,
    pathPrecision: 8,
    cornerThreshold: 45,
    lengthThreshold: 3.5,
    spliceThreshold: 24,
    fallbackMinPaths: 20,
    fallbackMinColors: 6,
    preserveDarkLightAnchors: true,
    edgeBoost: false,
    textBandProtection: true,
  }),

  badgeHigh: fidelity({
    paletteSize: 64,
    filterSpeckle: 1,
    pathPrecision: 10,
    cornerThreshold: 30,
    lengthThreshold: 2,
    fallbackMinPaths: 48,
    fallbackMinColors: 18,
    preserveDarkLightAnchors: true,
    edgeBoost: true,
    textBandProtection: true,
  }),

  badgeUltra: fidelity({
    paletteSize: 64,
    filterSpeckle: 0,
    layerDifference: 5,
    pathPrecision: 10,
    cornerThreshold: 25,
    lengthThreshold: 1.5,
    spliceThreshold: 10,
    fallbackMinPaths: 56,
    fallbackMinColors: 20,
    preserveDarkLightAnchors: true,
    edgeBoost: true,
    textBandProtection: true,
  }),

  badgeMonoHigh: fidelity({
    colorPrecision: 4,
    paletteSize: 12,
    filterSpeckle: 0,
    layerDifference: 12,
    pathPrecision: 10,
    cornerThreshold: 30,
    lengthThreshold: 2,
    spliceThreshold: 14,
    fallbackMinPaths: 40,
    fallbackMinColors: 4,
    preserveDarkLightAnchors: true,
    preserveGreenAccent: true,
    edgeBoost: true,
    textBandProtection: true,
  }),

  lineartClean: fidelity({
    hierarchical: "cutout",
    colorPrecision: 3,
    paletteSize: 2,
    filterSpeckle: 5,
    layerDifference: 32,
    pathPrecision: 8,
    cornerThreshold: 85,
    lengthThreshold: 4.5,
    spliceThreshold: 65,
    fallbackMinPaths: 4,
    fallbackMinColors: 2,
  }),

  lineartBalanced: fidelity({
    hierarchical: "cutout",
    colorPrecision: 3,
    paletteSize: 2,
    filterSpeckle: 3,
    layerDifference: 32,
    cornerThreshold: 72,
    lengthThreshold: 3,
    spliceThreshold: 55,
    fallbackMinPaths: 8,
    fallbackMinColors: 2,
  }),

  lineartHigh: fidelity({
    hierarchical: "cutout",
    colorPrecision: 3,
    paletteSize: 2,
    filterSpeckle: 2,
    layerDifference: 32,
    pathPrecision: 10,
    cornerThreshold: 65,
    lengthThreshold: 2.5,
    spliceThreshold: 48,
    fallbackMinPaths: 12,
    fallbackMinColors: 2,
  }),

  lineartUltra: fidelity({
    hierarchical: "cutout",
    colorPrecision: 3,
    paletteSize: 2,
    filterSpeckle: 1,
    layerDifference: 32,
    pathPrecision: 10,
    cornerThreshold: 60,
    spliceThreshold: 40,
    fallbackMinPaths: 16,
    fallbackMinColors: 2,
  }),

  pixelartBalanced: fidelity({
    mode: "polygon",
    hierarchical: "cutout",
    paletteSize: 32,
    filterSpeckle: 0,
    layerDifference: 1,
    pathPrecision: 1,
    cornerThreshold: 0,
    lengthThreshold: 0,
    spliceThreshold: 0,
    fallbackMinPaths: 2,
    fallbackMinColors: 2,
  }),
});

/* -------------------------------------------------------------------------- */
/* Optimization modes                                                          */
/* -------------------------------------------------------------------------- */

export const OPTIMIZATION_MODES = freeze({
  none: freeze({
    removeSpeckles: false,
    pathPrecision: 10,
    coordinateDecimals: 3,
    pathCap: 0,
    filterSpeckleFloor: 0,
    lengthThresholdFloor: 0,
  }),

  balanced: freeze({
    removeSpeckles: true,
    pathPrecision: 8,
    coordinateDecimals: 2,
    pathCap: 2000,
    filterSpeckleFloor: null,
    lengthThresholdFloor: null,
  }),

  aggressive: freeze({
    removeSpeckles: true,
    pathPrecision: 6,
    coordinateDecimals: 1,
    pathCap: 800,
    filterSpeckleFloor: 2,
    lengthThresholdFloor: 6,
  }),
});

/* -------------------------------------------------------------------------- */
/* VTracer profile defaults                                                    */
/* -------------------------------------------------------------------------- */

export const VTRACER_PROFILE_OPTIONS = freeze({
  complex: vtracer({}),
  photo: vtracer({}),

  badge: vtracer({
    pathPrecision: 10,
    cornerThreshold: 35,
    lengthThreshold: 2.2,
  }),

  logo: vtracer({
    colorPrecision: 5,
    filterSpeckle: 3,
    layerDifference: 7,
    pathPrecision: 10,
    cornerThreshold: 34,
    spliceThreshold: 16,
  }),

  drawing: vtracer({
    colorPrecision: 5,
    pathPrecision: 10,
    cornerThreshold: 36,
    lengthThreshold: 2.5,
    spliceThreshold: 16,
  }),

  sticker: vtracer({
    filterSpeckle: 1,
    layerDifference: 5,
    pathPrecision: 10,
    cornerThreshold: 28,
    lengthThreshold: 1.5,
    spliceThreshold: 12,
  }),

  lineart: vtracer({
    hierarchical: "cutout",
    colorPrecision: 4,
    filterSpeckle: 4,
    layerDifference: 32,
    pathPrecision: 8,
    cornerThreshold: 80,
    lengthThreshold: 3,
    spliceThreshold: 60,
  }),

  pixelart: vtracer({
    mode: "polygon",
    hierarchical: "cutout",
    filterSpeckle: 0,
    layerDifference: 1,
    pathPrecision: 1,
    cornerThreshold: 0,
    lengthThreshold: 0,
    spliceThreshold: 0,
  }),
});

/* -------------------------------------------------------------------------- */
/* Pipeline presets                                                            */
/* -------------------------------------------------------------------------- */

export const PIPELINE_PRESETS = freeze({
  logo_bw: pipeline({
    assetType: "lineart",
    exportStrategy: "path-trace",
    imageTracerPreset: "lineart",
    vtracer: VTRACER_PROFILE_OPTIONS.lineart,
  }),

  logo_flat_color: pipeline({
    assetType: "logo",
    exportStrategy: "path-trace",
    imageTracerPreset: "logo",
    vtracer: VTRACER_PROFILE_OPTIONS.logo,
  }),

  badge_flat_color: pipeline({
    assetType: "badge",
    exportStrategy: "quantized-path-trace",
    imageTracerPreset: "badge",
    fidelityMode: "badgeHigh",
    quantize: { preserveDarkLightAnchors: true },
    vtracer: { ...VTRACER_PROFILE_OPTIONS.badge, filterSpeckle: 1 },
  }),

  badge_text_ultra: pipeline({
    assetType: "badge",
    exportStrategy: "quantized-path-trace",
    imageTracerPreset: "badge",
    fidelityMode: "badgeUltra",
    quantize: { preserveDarkLightAnchors: true },
    vtracer: { ...VTRACER_PROFILE_OPTIONS.badge, filterSpeckle: 0 },
  }),

  illustration_flat: pipeline({
    assetType: "drawing",
    exportStrategy: "path-trace",
    imageTracerPreset: "drawing",
    vtracer: VTRACER_PROFILE_OPTIONS.drawing,
  }),

  illustration_soft: pipeline({
    assetType: "complex",
    exportStrategy: "quantized-path-trace",
    imageTracerPreset: "complex",
    fidelityMode: "high",
    quantize: { preserveDarkLightAnchors: true },
    preserveBackground: true,
    preprocess: { contrastStrength: 0.12 },
    vtracer: { ...VTRACER_PROFILE_OPTIONS.complex, filterSpeckle: 2 },
  }),

  sticker_outlined_illustration: pipeline({
    assetType: "sticker",
    exportStrategy: "quantized-path-trace",
    imageTracerPreset: "sticker",
    fidelityMode: "stickerHigh",
    quantize: {
      preserveDarkLightAnchors: true,
      preserveWhiteCreamOutlines: true,
      preserveBlackDetails: true,
    },
    preserveBackground: true,
    preprocess: { contrastStrength: 0.1 },
    vtracer: { ...VTRACER_PROFILE_OPTIONS.sticker, pathPrecision: 10 },
  }),

  photo_wrapper: pipeline({
    assetType: "photo",
    exportStrategy: "image-wrapper",
    imageTracerPreset: "photo",
    vtracer: VTRACER_PROFILE_OPTIONS.photo,
  }),

  pixelart_flat: pipeline({
    assetType: "pixelart",
    exportStrategy: "quantized-path-trace",
    imageTracerPreset: "pixelart",
    fidelityMode: "pixelartBalanced",
    quantize: { anchorSnapSq: 0 },
    vtracer: VTRACER_PROFILE_OPTIONS.pixelart,
  }),

  complex_illustration_ultra: pipeline({
    assetType: "complex",
    exportStrategy: "quantized-path-trace",
    imageTracerPreset: "complex",
    fidelityMode: "ultra",
    quantize: { preserveDarkLightAnchors: true },
    preserveBackground: true,
    preprocess: { contrastStrength: 0.12 },
    vtracer: { ...VTRACER_PROFILE_OPTIONS.complex, filterSpeckle: 1 },
  }),
});

export const VTRACER_PROFILES = freeze([
  "logo",
  "drawing",
  "lineart",
  "sticker",
  "badge",
  "complex",
  "pixelart",
]);

export const BACKGROUND_REMOVAL_PROFILES = freeze(["logo", "drawing", "lineart"]);

export const EXPORT_STRATEGIES = freeze({
  photo: "image-wrapper",
  logo: "path-trace",
  drawing: "path-trace",
  lineart: "path-trace",
  complex: "quantized-path-trace",
  sticker: "quantized-path-trace",
  badge: "quantized-path-trace",
  pixelart: "quantized-path-trace",
});

const PIPELINE_KEYS_BY_TYPE = freeze({
  photo: "photo_wrapper",
  lineart: "logo_bw",
  logo: "logo_flat_color",
  complex: "illustration_soft",
  sticker: "sticker_outlined_illustration",
  badge: "badge_flat_color",
  pixelart: "pixelart_flat",
  drawing: "illustration_flat",
});

const PIPELINE_KEYS_BY_SUBTYPE = freeze({
  badge: "badge_flat_color",
  emblem: "badge_flat_color",
  sticker: "sticker_outlined_illustration",
});

/* -------------------------------------------------------------------------- */
/* Accessors                                                                   */
/* -------------------------------------------------------------------------- */

export function getExportStrategy(type) {
  return EXPORT_STRATEGIES[type] || "path-trace";
}

export function getImageTracerPreset(type) {
  return IMAGE_TRACER_PRESETS[type] || IMAGE_TRACER_PRESETS.default;
}

export function getVtracerProfileOptions(type) {
  return VTRACER_PROFILE_OPTIONS[type] || VTRACER_PROFILE_OPTIONS.drawing;
}

export function getTraceFidelityMode(mode) {
  return TRACE_FIDELITY_MODES[mode] || TRACE_FIDELITY_MODES.balanced;
}

export function getOptimizationMode(mode) {
  return OPTIMIZATION_MODES[mode] || OPTIMIZATION_MODES.balanced;
}

const resolvedPresetCache = new Map();

export function resolvePreset(presetId) {
  const id = PRESET_CONFIGS[presetId] ? presetId : "drawing";

  if (resolvedPresetCache.has(id)) {
    return resolvedPresetCache.get(id);
  }

  const merged = freeze({
    ...PRESET_CONFIGS[id],
    defaultControls: PRESET_DEFAULT_CONTROLS[id] || PRESET_DEFAULT_CONTROLS.drawing,
    controlLimits: PRESET_CONTROL_LIMITS[id] || PRESET_CONTROL_LIMITS.drawing,
    postprocessing: PRESET_POSTPROCESSING[id] || PRESET_POSTPROCESSING.drawing,
    vtracerProfile: VTRACER_PROFILE_OPTIONS[id] || VTRACER_PROFILE_OPTIONS.drawing,
  });

  resolvedPresetCache.set(id, merged);
  return merged;
}

function mergePipelinePreset(base, override) {
  return {
    ...base,
    ...override,
    vtracer: { ...(base.vtracer || {}), ...(override.vtracer || {}) },
    quantize: { ...(base.quantize || {}), ...(override.quantize || {}) },
    preprocess: { ...(base.preprocess || {}), ...(override.preprocess || {}) },
  };
}

export function resolvePipelinePreset(profileOrType = "drawing", override = {}) {
  const type =
    typeof profileOrType === "string" ? profileOrType : profileOrType?.type || "drawing";

  const subtype = typeof profileOrType === "string" ? null : profileOrType?.subtype || null;

  const key =
    override.presetKey ||
    PIPELINE_KEYS_BY_SUBTYPE[subtype] ||
    PIPELINE_KEYS_BY_TYPE[type] ||
    "illustration_flat";

  const preset = PIPELINE_PRESETS[key] || PIPELINE_PRESETS.illustration_flat;

  return {
    key,
    ...mergePipelinePreset(preset, override),
  };
}