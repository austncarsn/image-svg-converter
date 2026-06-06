export const PRESET_CONFIGS = Object.freeze({
  logo: preset({
    label: "Logo",
    description: "Flat vector shapes with sharp borders and strong simplification.",
    recommendedUse: "Logos, brand icons, geometric drawings, and flat-color graphics.",
    expectedOutput: "Clean, simplified vector paths with solid fills.",
    tradeoffs: "Reduces gradients and micro-details for lighter, sharper SVG output.",
    exportStrategy: "path-trace",
    exportLabel: "Clean Vector Logo",
    preprocessing: {
      colorMode: "flat",
      paletteHint: "cyber-neon",
      contrastStrategy: "boost-edges",
      edgeStrategy: "sobel-sharpen",
      despeckle: true,
    },
    diagnostics: {
      textRiskSensitivity: "low",
    },
  }),

  badge: preset({
    label: "Badge / Emblem",
    description: "Circular emblem tracing that preserves curved text and insignia details.",
    recommendedUse: "Circular seals, badge art, medallions, and typography-heavy emblems.",
    expectedOutput: "Circular alignments with protected high-fidelity text elements.",
    tradeoffs: "Allows higher path density to protect lettering integrity.",
    exportStrategy: "quantized-path-trace",
    exportLabel: "High-Fidelity Badge Vector",
    preprocessing: {
      colorMode: "quantized",
      thresholdStrategy: "adaptive",
      contrastStrategy: "boost-edges-high",
      edgeStrategy: "sobel-sharpen",
    },
    diagnostics: {
      textRiskSensitivity: "high",
    },
  }),

  photo: preset({
    label: "Photo",
    description: "Raster-preserving SVG container for pixel-perfect resemblance.",
    recommendedUse: "Photos, paintings, scenic backdrops, and soft gradients.",
    expectedOutput: "A high-quality embedded raster image inside clean SVG markup.",
    tradeoffs: "Not editable as vector paths, but preserves visual fidelity.",
    exportStrategy: "image-wrapper",
    exportLabel: "Image-Preserving SVG",
    fallbackStrategy: "image-wrapper",
    preprocessing: {
      colorMode: "full-color",
    },
    diagnostics: {
      textRiskSensitivity: "none",
      rasterFallbackPermission: true,
    },
  }),

  drawing: preset({
    label: "Drawing",
    description: "Organic sketch tracing that preserves hand-drawn line character.",
    recommendedUse: "Pencil sketches, ink scans, charcoal art, and organic line art.",
    expectedOutput: "Freeform vector paths with natural artistic imperfections.",
    tradeoffs: "May retain rough edge noise when detail filtering is low.",
    exportStrategy: "path-trace",
    exportLabel: "Artistic Drawing Vector",
    preprocessing: {
      colorMode: "organic",
      contrastStrategy: "boost-edges-low",
    },
    diagnostics: {
      textRiskSensitivity: "low",
    },
  }),

  lineart: preset({
    id: "lineart",
    label: "Line Art",
    description: "Clean monochrome outlines using local adaptive binarization.",
    recommendedUse: "Technical diagrams, signatures, outlines, and schematics.",
    expectedOutput: "Crisp black-and-white line paths with transparent regions.",
    tradeoffs: "Removes interior color fills, midtones, and subtle gradients.",
    exportStrategy: "path-trace",
    exportLabel: "Monochrome Outline Vector",
    preprocessing: {
      colorMode: "monochrome",
      thresholdStrategy: "sauvola",
      contrastStrategy: "sauvola",
      edgeStrategy: "sobel-sharpen",
      despeckle: true,
    },
    diagnostics: {
      textRiskSensitivity: "medium",
    },
  }),

  complex: preset({
    label: "Illustration",
    description: "Detailed multi-layer vector tracing with quantized color fields.",
    recommendedUse: "Complex illustrations, vector scenes, colorful graphics, and anime.",
    expectedOutput: "Rich multi-color vector shapes that remain editable.",
    tradeoffs: "Produces larger SVG files with higher command counts.",
    exportStrategy: "quantized-path-trace",
    exportLabel: "Multi-Color Illustration Vector",
    fallbackStrategy: "image-wrapper",
    preprocessing: {
      colorMode: "quantized",
      contrastStrategy: "boost-edges-low",
      edgeStrategy: "sobel-sharpen",
    },
    diagnostics: {
      textRiskSensitivity: "low",
      rasterFallbackPermission: true,
    },
  }),

  pixelart: preset({
    label: "Pixel Art",
    description: "Hard-edged polygon reconstruction preserving the source pixel grid.",
    recommendedUse: "Pixel sprites, low-res icons, retro game art, and grid graphics.",
    expectedOutput: "Flat polygon regions matching the source pixel palette.",
    tradeoffs: "No curve smoothing; fidelity depends on source palette size.",
    exportStrategy: "quantized-path-trace",
    exportLabel: "Pixel Art Vector",
    preprocessing: {
      colorMode: "quantized",
    },
    diagnostics: {
      textRiskSensitivity: "none",
    },
  }),

  sticker: preset({
    id: "sticker",
    label: "Sticker Sheet",
    description: "Separated-object tracing that protects white borders and silhouettes.",
    recommendedUse: "Sticker sheets, die-cut outlines, and standalone graphics.",
    expectedOutput: "Clean object islands with isolated borders and backgrounds.",
    tradeoffs: "Prunes tiny noise specks to keep print shapes continuous.",
    exportStrategy: "quantized-path-trace",
    exportLabel: "Separated Sticker Vector",
    fallbackStrategy: "image-wrapper",
    preprocessing: {
      colorMode: "quantized",
      contrastStrategy: "boost-edges-medium",
      edgeStrategy: "sobel-sharpen",
      despeckle: true,
    },
    diagnostics: {
      textRiskSensitivity: "low",
      rasterFallbackPermission: true,
    },
  }),
});

function preset(config) {
  const id = config.id ?? inferPresetId(config.label);

  return deepFreeze({
    id,
    fallbackStrategy: "none",

    ...config,

    preprocessing: {
      thresholdStrategy: "none",
      contrastStrategy: "none",
      edgeStrategy: "none",
      despeckle: false,
      ...config.preprocessing,
    },

    diagnostics: {
      textRiskSensitivity: "low",
      rasterFallbackPermission: false,
      ...config.diagnostics,
    },
  });
}

function inferPresetId(label) {
  return label
    .toLowerCase()
    .replace(/\/.*/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return Object.freeze(value);
}