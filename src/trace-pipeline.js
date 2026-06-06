import { SVGPathData } from "svg-pathdata";

import { detectBadge } from "./badge-detect.js";
import { boostContrast, preprocessBadge } from "./badge-preprocess.js";
import { clampInteger, clampNumber } from "./image-data.js";
import {
  detectStickerIllustration,
  preprocessStickerIllustration,
} from "./illustration-preprocess.js";
import { quantizeImageData } from "./image-quantize.js";
import { boxBlur, edgeAwareSharpen, localAdaptiveBinarize } from "./pipeline-preprocess.js";
import {
  getOptimizationMode,
  resolvePipelinePreset,
  resolvePreset,
  TRACE_FIDELITY_MODES,
  VTRACER_PROFILE_OPTIONS,
} from "./presets.js";
import { traceImageDataToSvg } from "./vtracer-trace.js";

/* -------------------------------------------------------------------------- */
/* Small utilities.                                                            */
/* -------------------------------------------------------------------------- */

function identity(value) {
  return value;
}

function normalizeSvgString(value) {
  return typeof value === "string" ? value : "";
}

function canParseSvg() {
  return typeof DOMParser !== "undefined" && typeof XMLSerializer !== "undefined";
}

function parseSvg(svgString) {
  if (!svgString || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
  if (doc.querySelector("parsererror")) return null;
  return doc;
}

function countSvgFills(svgString) {
  const doc = parseSvg(svgString);
  if (!doc) return 0;

  const fills = new Set();
  doc.querySelectorAll("path").forEach((path) => {
    const fill = path.getAttribute("fill");
    if (fill && fill !== "none") fills.add(fill.trim().toLowerCase());
  });

  return fills.size;
}

function getSvgPathStats(svgString) {
  const stats = { pathCount: 0, pathCommandCount: 0, invalidPathCount: 0 };

  const doc = parseSvg(svgString);
  if (!doc) return stats;

  const paths = [...doc.querySelectorAll("path")];
  stats.pathCount = paths.length;

  for (const path of paths) {
    const d = path.getAttribute("d") || "";
    if (!d.trim()) {
      stats.invalidPathCount++;
      continue;
    }
    try {
      stats.pathCommandCount += new SVGPathData(d).commands.length;
    } catch {
      stats.invalidPathCount++;
    }
  }

  return stats;
}

/* -------------------------------------------------------------------------- */
/* SVG post-processing: prune micro-paths, round coordinates.                  */
/* -------------------------------------------------------------------------- */

export function postProcessSvg(svgString, options = {}) {
  if (!svgString || !canParseSvg()) return svgString;

  const doc = parseSvg(svgString);
  if (!doc) return svgString;

  const minArea = clampNumber(options.minArea, 0, 1_000_000, 0);
  const despeckle = Boolean(options.despeckle);
  const coordinateDecimals =
    options.coordinateDecimals === undefined
      ? undefined
      : clampInteger(options.coordinateDecimals, 0, 6, 3);

  const paths = [...doc.querySelectorAll("path")];

  paths.forEach((path) => {
    const d = path.getAttribute("d") || "";
    if (!d.trim()) {
      path.remove();
      return;
    }

    let commands;
    try {
      commands = new SVGPathData(d).commands;
    } catch {
      path.remove();
      return;
    }

    if (despeckle && commands.length <= 3) {
      const hasCurves = commands.some(
        (cmd) =>
          cmd.type === SVGPathData.CURVE_TO ||
          cmd.type === SVGPathData.QUAD_CURVE_TO ||
          cmd.type === SVGPathData.SMOOTH_CURVE_TO ||
          cmd.type === SVGPathData.SMOOTH_QUAD_CURVE_TO
      );
      if (!hasCurves) {
        path.remove();
        return;
      }
    }

    if (minArea > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const cmd of commands) {
        for (const key of ["x", "x1", "x2"]) {
          if (cmd[key] !== undefined) {
            minX = Math.min(minX, cmd[key]);
            maxX = Math.max(maxX, cmd[key]);
          }
        }
        for (const key of ["y", "y1", "y2"]) {
          if (cmd[key] !== undefined) {
            minY = Math.min(minY, cmd[key]);
            maxY = Math.max(maxY, cmd[key]);
          }
        }
      }

      const hasBounds =
        Number.isFinite(minX) && Number.isFinite(minY) &&
        Number.isFinite(maxX) && Number.isFinite(maxY);

      const width = hasBounds ? maxX - minX : 0;
      const height = hasBounds ? maxY - minY : 0;
      const area = width > 0 && height > 0 ? width * height : 0;

      if (area < minArea) {
        path.remove();
        return;
      }
    }

    if (coordinateDecimals !== undefined) {
      try {
        const factor = 10 ** coordinateDecimals;
        const round = (v) => Math.round(v * factor) / factor;

        const simplified = commands.map((cmd) => {
          const next = { ...cmd };
          for (const key of ["x", "y", "x1", "y1", "x2", "y2"]) {
            if (next[key] !== undefined) next[key] = round(next[key]);
          }
          return next;
        });

        path.setAttribute("d", new SVGPathData(simplified).encode());
      } catch {
        // Keep original path data if simplification fails.
      }
    }
  });

  return new XMLSerializer().serializeToString(doc);
}

/* -------------------------------------------------------------------------- */
/* Fidelity-mode resolution.                                                   */
/* -------------------------------------------------------------------------- */

const BADGE_FIDELITY_MAP = Object.freeze({
  clean: "badgeClean",
  balanced: "badgeHigh",
  high: "badgeHigh",
  ultra: "badgeUltra",
});

const STICKER_FIDELITY_MAP = Object.freeze({
  clean: "stickerClean",
  balanced: "stickerHigh",
  high: "stickerHigh",
  ultra: "stickerUltra",
});

const LINEART_FIDELITY_MAP = Object.freeze({
  clean: "lineartClean",
  balanced: "lineartBalanced",
  high: "lineartHigh",
  ultra: "lineartUltra",
});

// Pixel art has exactly one fidelity mode; map any request straight to it
// rather than maintaining an all-identical lookup table.
const PIXELART_FIDELITY = "pixelartBalanced";

const GENERIC_VTRACER_DEFAULTS = Object.freeze({
  mode: "spline",
  hierarchical: "stacked",
  colorPrecision: 6,
  filterSpeckle: 2,
  layerDifference: 8,
  pathPrecision: 9,
  cornerThreshold: 48,
  lengthThreshold: 2,
  spliceThreshold: 18,
});

function classifyPresetFamily(profile, preset) {
  const isBadge =
    profile?.subtype === "badge" || profile?.subtype === "emblem" || profile?.type === "badge";
  const isSticker = profile?.subtype === "sticker" || profile?.type === "sticker";
  // Preset id wins so a user-selected preset overrides classifier type.
  const isLineart = preset?.id === "lineart" || profile?.type === "lineart";
  const isPixelart = preset?.id === "pixelart" || profile?.type === "pixelart";
  return { isBadge, isSticker, isLineart, isPixelart };
}

function normalizeFidelityMode(profile, preset, requestedMode) {
  const { isBadge, isSticker, isLineart, isPixelart } = classifyPresetFamily(profile, preset);

  if (isPixelart) return PIXELART_FIDELITY;

  if (isBadge && requestedMode) {
    const mapped = BADGE_FIDELITY_MAP[requestedMode];
    if (mapped && TRACE_FIDELITY_MODES[mapped]) return mapped;
  }
  if (isSticker && requestedMode) {
    const mapped = STICKER_FIDELITY_MAP[requestedMode];
    if (mapped && TRACE_FIDELITY_MODES[mapped]) return mapped;
  }
  if (isLineart && requestedMode) {
    const mapped = LINEART_FIDELITY_MAP[requestedMode];
    if (mapped && TRACE_FIDELITY_MODES[mapped]) return mapped;
  }

  if (requestedMode && TRACE_FIDELITY_MODES[requestedMode]) return requestedMode;
  if (preset?.fidelityMode && TRACE_FIDELITY_MODES[preset.fidelityMode]) return preset.fidelityMode;

  if (isBadge) return "badgeHigh";
  if (isSticker) return "stickerHigh";
  if (isLineart) return "lineartBalanced";
  if (profile?.type === "complex") return "high";

  return "balanced";
}

function ensureResolvedPreset(presetId) {
  const config = resolvePreset(presetId);
  if (config?.defaultControls?.colors !== undefined && config?.controlLimits?.colors) {
    return config;
  }

  const fallback = resolvePreset("drawing");
  return {
    ...fallback,
    ...config,
    defaultControls: config?.defaultControls || fallback.defaultControls,
    controlLimits: config?.controlLimits || fallback.controlLimits,
    postprocessing: config?.postprocessing || fallback.postprocessing,
    preprocessing: config?.preprocessing || fallback.preprocessing,
    vtracerProfile: config?.vtracerProfile || fallback.vtracerProfile,
  };
}

/* -------------------------------------------------------------------------- */
/* Quantize-options builder — SINGLE source for every color mode.              */
/* Previously quantized vs flat/organic branches built divergent option        */
/* objects; this unifies them so anchor/edge logic is consistent.              */
/* -------------------------------------------------------------------------- */

function shouldPreserveEdgeDetails(config, profile) {
  return (
    config?.id === "badge" ||
    config?.id === "sticker" ||
    config?.id === "complex" ||
    profile?.type === "complex"
  );
}

function buildQuantizeOptions({ config, profile, fidelityCfg, useCyberNeonPalette }) {
  const isPixelart = config.id === "pixelart";
  const isBadge =
    config.id === "badge" || profile?.type === "badge" || profile?.subtype === "badge";
  const isNearMonochrome = (profile?.avgSaturation ?? 1) < 0.07;

  // For flat/organic near-monochrome content (e.g. B&W drawings with JPEG
  // artifacts), anchor to true black/white so median-cut doesn't band to gray.
  const colorMode = config.preprocessing.colorMode;
  const flatOrOrganic = colorMode === "flat" || colorMode === "organic";

  return {
    preserveDarkLightAnchors: isPixelart ? false : flatOrOrganic ? isNearMonochrome : true,
    preserveWhiteCreamOutlines: config.id === "sticker",
    preserveBlackDetails: config.id === "sticker",
    preserveGreenAccent: isBadge,
    preserveCyberNeonPalette: useCyberNeonPalette,
    // Pixel Art: disable anchor snapping so the source palette is exact.
    anchorSnapSq: isPixelart ? 0 : undefined,
    preserveEdgeDetailColors: shouldPreserveEdgeDetails(config, profile),
    detailColorWeight: fidelityCfg.edgeBoost ? 6 : 4,
  };
}

/* -------------------------------------------------------------------------- */
/* VTracer option resolution.                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a single numeric vtracer field across the precedence chain. Treats
 * `undefined` as "not set" but accepts a meaningful 0 (e.g. pixel-art corner
 * thresholds), which `??` alone preserves correctly.
 */
function pick(...candidates) {
  for (const c of candidates) {
    if (c !== undefined && c !== null) return c;
  }
  return undefined;
}

export function resolveVtracerOptions({
  fidelityCfg = {},
  profileOpts = {},
  pipelineVtracerOpts = {},
  tracingConfig = {},
  optimizationMode = "balanced",
}) {
  const traceOpts = {
    mode: pick(fidelityCfg.mode, pipelineVtracerOpts.mode, profileOpts.mode, GENERIC_VTRACER_DEFAULTS.mode),
    hierarchical: pick(
      fidelityCfg.hierarchical, pipelineVtracerOpts.hierarchical,
      profileOpts.hierarchical, GENERIC_VTRACER_DEFAULTS.hierarchical
    ),
    colorPrecision: pick(
      fidelityCfg.colorPrecision, pipelineVtracerOpts.colorPrecision,
      profileOpts.colorPrecision, GENERIC_VTRACER_DEFAULTS.colorPrecision
    ),
    filterSpeckle: pick(
      fidelityCfg.filterSpeckle, pipelineVtracerOpts.filterSpeckle,
      profileOpts.filterSpeckle, GENERIC_VTRACER_DEFAULTS.filterSpeckle
    ),
    layerDifference: pick(
      fidelityCfg.layerDifference, pipelineVtracerOpts.layerDifference,
      profileOpts.layerDifference, GENERIC_VTRACER_DEFAULTS.layerDifference
    ),
    pathPrecision: pick(
      fidelityCfg.pathPrecision, pipelineVtracerOpts.pathPrecision,
      profileOpts.pathPrecision, GENERIC_VTRACER_DEFAULTS.pathPrecision
    ),
    cornerThreshold: pick(
      fidelityCfg.cornerThreshold, pipelineVtracerOpts.cornerThreshold,
      profileOpts.cornerThreshold, tracingConfig.cornerPreservation,
      GENERIC_VTRACER_DEFAULTS.cornerThreshold
    ),
    lengthThreshold: pick(
      fidelityCfg.lengthThreshold, pipelineVtracerOpts.lengthThreshold,
      profileOpts.lengthThreshold, GENERIC_VTRACER_DEFAULTS.lengthThreshold
    ),
    spliceThreshold: pick(
      fidelityCfg.spliceThreshold, pipelineVtracerOpts.spliceThreshold,
      profileOpts.spliceThreshold, GENERIC_VTRACER_DEFAULTS.spliceThreshold
    ),
  };

  // Optimization floors are owned by OPTIMIZATION_MODES (presets.js), not
  // hard-coded here, so the vtracer pass and the sanitizer agree.
  const opt = getOptimizationMode(optimizationMode);

  if (optimizationMode === "none") {
    traceOpts.filterSpeckle = 0;
    traceOpts.lengthThreshold = 0;
  } else if (optimizationMode === "aggressive") {
    if (opt.filterSpeckleFloor != null) {
      traceOpts.filterSpeckle = Math.max(opt.filterSpeckleFloor, Number(traceOpts.filterSpeckle) + 1);
    }
    if (opt.lengthThresholdFloor != null) {
      traceOpts.lengthThreshold = Math.max(opt.lengthThresholdFloor, Number(traceOpts.lengthThreshold) + 2);
    }
  }

  return traceOpts;
}

/* -------------------------------------------------------------------------- */
/* Preprocessing dispatch — produces the buffer handed to the quantizer.       */
/* -------------------------------------------------------------------------- */

function applyPreprocessing(imageData, { config, profile }) {
  let traceInput = imageData;
  let badgeSignals = null;
  let masked = false;
  let textBandPixels = 0;

  if (config.preprocessing.blurRadius > 0) {
    // blurRadius now lives on default controls, not preprocessing metadata;
    // kept defensive in case a caller injects it.
    traceInput = boxBlur(traceInput, config.preprocessing.blurRadius);
  }

  const strategy = config.preprocessing.contrastStrategy;

  if (strategy === "sauvola") {
    traceInput = localAdaptiveBinarize(traceInput, { k: 0.15 });
  } else if (config.id === "badge") {
    badgeSignals = profile.badgeSignals || detectBadge(traceInput);
    const sharpened = edgeAwareSharpen(traceInput, { strength: 0.45 });
    const preprocessed = preprocessBadge(sharpened, badgeSignals, {
      mask: badgeSignals.isBadge || badgeSignals.circularity >= 0.72,
      contrastStrength: 0.35,
      textBandProtection: true,
    });
    traceInput = preprocessed;
    masked = Boolean(preprocessed.masked);
    textBandPixels = preprocessed.textBandPixels || 0;
  } else if (config.id === "sticker") {
    const sharpened = edgeAwareSharpen(traceInput, { strength: 0.3 });
    const hasTransparent = (profile?.transparentRatio ?? 0) > 0.02;
    if (hasTransparent) {
      // Transparent-background die-cut art: always safe to run the full
      // halo + dark-detail preprocessing pass.
      traceInput = preprocessStickerIllustration(sharpened, { contrastStrength: 0.1 });
    } else {
      // Opaque background: run halo preprocessing only if the image actually
      // shows the bright-boundary + dark-detail signature of a sticker sheet.
      const stickerSignals = detectStickerIllustration(sharpened);
      traceInput = stickerSignals.isSticker
        ? preprocessStickerIllustration(sharpened, { contrastStrength: 0.12 })
        : boostContrast(sharpened, { strength: 0.12 });
    }
  } else if (strategy === "boost-edges-high") {
    traceInput = boostContrast(edgeAwareSharpen(traceInput, { strength: 0.45 }), { strength: 0.25 });
  } else if (strategy === "boost-edges-medium") {
    traceInput = boostContrast(edgeAwareSharpen(traceInput, { strength: 0.35 }), { strength: 0.15 });
  } else if (strategy === "boost-edges-low") {
    traceInput = edgeAwareSharpen(traceInput, { strength: 0.2 });
  } else if (strategy === "boost-edges") {
    traceInput = edgeAwareSharpen(traceInput, { strength: 0.35 });
  }

  return { traceInput, badgeSignals, masked, textBandPixels };
}

function applyQuantization(traceInput, { config, profile, fidelityCfg, targetColors }) {
  const useCyberNeonPalette = config.preprocessing.paletteHint === "cyber-neon";
  const colorMode = config.preprocessing.colorMode;

  if (colorMode === "monochrome") {
    return quantizeImageData(traceInput, 2, { preserveDarkLightAnchors: false });
  }

  if (colorMode === "quantized" || colorMode === "flat" || colorMode === "organic") {
    return quantizeImageData(
      traceInput,
      targetColors,
      buildQuantizeOptions({ config, profile, fidelityCfg, useCyberNeonPalette })
    );
  }

  // full-color (photo) modes never reach here (image-wrapper short-circuits).
  return traceInput;
}

/* -------------------------------------------------------------------------- */
/* Main pipeline.                                                              */
/* -------------------------------------------------------------------------- */

export async function traceImageDataPipeline(imageData, options = {}) {
  const profile = options.profile || { type: "drawing" };
  const presetId = options.presetId || profile.type || "drawing";
  const config = ensureResolvedPreset(presetId);

  const hooks = {
    sanitizeSvg: typeof options.sanitizeSvg === "function" ? options.sanitizeSvg : identity,
    traceWithImageTracer:
      typeof options.traceWithImageTracer === "function" ? options.traceWithImageTracer : null,
    stripWhiteBackground:
      typeof options.stripWhiteBackground === "function" ? options.stripWhiteBackground : null,
    tightenSvgViewBoxToContent:
      typeof options.tightenSvgViewBoxToContent === "function"
        ? options.tightenSvgViewBoxToContent
        : null,
  };

  if (config.exportStrategy === "image-wrapper") {
    return {
      svgString: "",
      engine: "image-wrapper",
      strategy: "image-wrapper",
      preset: config,
      textWarning: false,
      textWarningReason: "",
      pathCount: 0,
      pathCommandCount: 0,
      invalidPathCount: 0,
      fillColorCount: 0,
    };
  }

  const fidelityMode = normalizeFidelityMode(profile, config, options.fidelityMode || "balanced");
  const fidelityCfg = TRACE_FIDELITY_MODES[fidelityMode] || TRACE_FIDELITY_MODES.balanced;

  const userSettings = options.preset || {};
  const mergedColors =
    userSettings.colors !== undefined ? Number(userSettings.colors) : config.defaultControls.colors;
  const userPathOmit =
    userSettings.pathomit !== undefined ? Number(userSettings.pathomit) : config.defaultControls.pathomit;
  const userOptimize =
    userSettings.optimize !== undefined ? Boolean(userSettings.optimize) : config.defaultControls.optimize;

  let targetColors = Number.isFinite(mergedColors) ? mergedColors : config.defaultControls.colors;

  if (config.controlLimits?.colors) {
    const { min, max } = config.controlLimits.colors;
    targetColors = Math.max(min, Math.min(max, targetColors));
  }

  const usesQuantizedMode =
    config.preprocessing.colorMode === "quantized" ||
    config.preprocessing.colorMode === "flat" ||
    config.preprocessing.colorMode === "organic";

  if (usesQuantizedMode && fidelityCfg.paletteSize) {
    const maxAllowed = config.controlLimits?.colors?.max ?? 64;
    targetColors = Math.min(maxAllowed, Math.max(targetColors, fidelityCfg.paletteSize));
  }

  targetColors = clampInteger(targetColors, 2, 256, 16);

  // 1. Preprocess.
  const { traceInput, badgeSignals, masked, textBandPixels } = applyPreprocessing(imageData, {
    config,
    profile,
  });

  // 2. Quantize.
  const quantizedData = applyQuantization(traceInput, {
    config,
    profile,
    fidelityCfg,
    targetColors,
  });

  // 3. Resolve vtracer options. The pipeline preset is consulted only for its
  //    vtracer block; we no longer re-merge the whole recipe redundantly.
  const profileOpts = VTRACER_PROFILE_OPTIONS[presetId] || {};
  const pipelinePreset = resolvePipelinePreset({ type: presetId, subtype: profile?.subtype });
  const traceOpts = resolveVtracerOptions({
    fidelityCfg,
    profileOpts,
    pipelineVtracerOpts: pipelinePreset?.vtracer || {},
    tracingConfig: config.vtracerProfile || {},
    optimizationMode: options.optimizationMode || "balanced",
  });

  // 4. Trace (with optional ImageTracer fallback).
  let svgString = "";
  let engine = "vtracer";

  try {
    const rawSvg = await traceImageDataToSvg(quantizedData, traceOpts);
    svgString = normalizeSvgString(hooks.sanitizeSvg(rawSvg));
  } catch (error) {
    if (!options.allowImageTracerFallback || !hooks.traceWithImageTracer) throw error;

    console.warn("vtracer failed, falling back to ImageTracer:", error);
    svgString = normalizeSvgString(
      hooks.traceWithImageTracer(quantizedData, {
        colors: targetColors,
        ltres: config.defaultControls.ltres,
        qtres: config.defaultControls.qtres,
        pathomit: clampNumber(userPathOmit, 0, 1_000_000, 0),
        blurradius: config.defaultControls.blurradius,
      })
    );
    engine = "imagetracer";
  }

  // 5. Background handling.
  if (svgString && config.id !== "badge" && config.id !== "sticker" && hooks.stripWhiteBackground) {
    svgString = normalizeSvgString(hooks.stripWhiteBackground(svgString));
  }

  if (svgString && config.id === "badge" && masked && hooks.tightenSvgViewBoxToContent) {
    svgString = normalizeSvgString(hooks.tightenSvgViewBoxToContent(svgString));
  }

  // 6. Post-process. minArea floor = max(user slider, preset minimum).
  svgString = postProcessSvg(svgString, {
    minArea: Math.max(
      clampNumber(userPathOmit, 0, 1_000_000, 0),
      config.postprocessing.minPathArea ?? 0
    ),
    despeckle: userOptimize,
    coordinateDecimals: config.postprocessing.coordinateDecimals,
  });

  const pathStats = getSvgPathStats(svgString);

  // 7. Text-loss diagnostics for badges.
  let textWarning = false;
  let textWarningReason = "";

  if (config.id === "badge" && textBandPixels > 0) {
    const commandsPerPath = pathStats.pathCount
      ? pathStats.pathCommandCount / pathStats.pathCount
      : 0;

    if (pathStats.pathCount < 8) {
      textWarning = true;
      textWarningReason =
        "Badge text elements may be missing. Try selecting 'Ultra' fidelity or lowering the 'Detail Filter' slider to recover details.";
    } else if (commandsPerPath < 5 && pathStats.pathCount > 40) {
      textWarning = true;
      textWarningReason =
        "Text outline paths appear fragmented. Try raising 'Line Smoothness' or selecting 'High'/'Ultra' fidelity mode.";
    }
  }

  return {
    svgString,
    engine,
    strategy: config.exportStrategy,
    ...pathStats,
    fillColorCount: countSvgFills(svgString),
    paletteSize: targetColors,
    masked,
    isBadge: config.id === "badge",
    textBandPixels,
    badgeSignals,
    textWarning,
    textWarningReason,
    preset: config,
    modeName: fidelityMode,
  };
}
