/**
 * Heuristic diagnostics for VectorStudio SVG outputs.
 * Calculates estimated quality scores and user-facing explanations.
 */

export function evaluateDiagnostics(svgString, config, profile, stats, fillColorCount) {
  if (!config) {
    return null;
  }

  const isWrapper = config.exportStrategy === "image-wrapper";
  const configuredColors =
    Number(config.defaultControls?.colors ?? config.tracing?.colors ?? config.vtracerProfile?.paletteSize) ||
    16;

  // 1. Color Preservation Score
  let colorPreservationScore = 100;
  if (!isWrapper && profile && profile.uniqueColors > 0) {
    // Percentage of original colors preserved (capped to 100)
    const original = profile.uniqueColors;
    const current = fillColorCount || 1;
    colorPreservationScore = Math.min(
      100,
      Math.round((current / Math.min(original, configuredColors)) * 100)
    );
  }

  // 2. Path Complexity Score
  let pathComplexityScore = 0;
  if (!isWrapper && stats && stats.pathCount > 0) {
    // Commands per path average. Ideal range is 4..20.
    const cpp = stats.pathCommandCount / stats.pathCount;
    if (cpp < 4) pathComplexityScore = 50; // Too simple/fragmented
    else if (cpp <= 15) pathComplexityScore = 95; // Ideal
    else pathComplexityScore = Math.max(30, Math.round(100 - (cpp - 15) * 2)); // Too heavy
  }

  // 3. Detail Retention Score
  let detailRetentionScore = 80;
  if (!isWrapper && stats && profile) {
    const edgeDensity = profile.edgeDensity || 10;
    // High edge density images expect higher path counts to retain details
    const expectedPaths = Math.max(10, Math.round(edgeDensity * 4));
    const actualPaths = stats.pathCount || 1;
    detailRetentionScore = Math.min(100, Math.max(30, Math.round((actualPaths / expectedPaths) * 100)));
  }

  // 4. Edge Preservation Score
  let edgePreservationScore = 85;
  if (config.id === "logo" || config.id === "lineart") {
    edgePreservationScore = config.id === "lineart" ? 95 : 90; // Sauvola binarization keeps edges clean
  } else if (config.id === "photo") {
    edgePreservationScore = 100; // Pixel perfect
  } else if (config.id === "drawing") {
    edgePreservationScore = 80; // Smoothed lines
  }

  // 5. Text Risk Score
  let textRiskScore = 0;
  if (config.id === "badge" || profile?.subtype === "badge") {
    if (stats && stats.pathCount < 15) {
      textRiskScore = 75; // Very high risk of losing text
    } else {
      textRiskScore = 20; // Lower risk due to text protection
    }
  } else if (config.id === "photo") {
    textRiskScore = 0; // Raster wrap preserves text perfectly
  } else if (config.id === "lineart") {
    textRiskScore = 40; // Binarization might break text loops
  }

  // 6. Editability Score
  const editabilityScore = isWrapper ? 0 : 100;

  // 7. Preset Match Score
  let presetMatchScore = 85;
  if (profile) {
    if (profile.type === config.id) {
      presetMatchScore = 98; // Direct match
    } else {
      // Manual override mismatch penalty
      presetMatchScore = 65;
    }
  }

  // 8. Export Readiness
  let exportReadiness = 90;
  if (!isWrapper && stats && stats.invalidPathCount > 0) {
    exportReadiness = Math.max(10, 90 - stats.invalidPathCount * 10);
  }

  // Generate explanations
  let explanation = "";
  let whatPreserved = "";
  let whatLost = "";
  let alternateSuggestion = "";

  if (isWrapper) {
    explanation = "This output embeds a high-quality copy of the original raster image inside an SVG container. It guarantees exact visual resemblance.";
    whatPreserved = "Every single pixel, soft gradient, and tiny detail of the original image.";
    whatLost = "The ability to edit individual vector path nodes or scale shapes independently without losing quality.";
    alternateSuggestion = "If you need an editable vector, try the Illustration or Logo preset.";
  } else {
    explanation = `Traced using the ${config.label} pipeline. A total of ${stats.pathCount || 0} vector paths were reconstructed using the vtracer WASM engine.`;
    
    if (config.id === "logo") {
      whatPreserved = "Solid colored shapes and flat silhouette boundaries.";
      whatLost = "Delicate textures, photographic noise, and fine color gradients.";
      alternateSuggestion = "If shapes are too simple, try the Illustration preset for more nested details.";
    } else if (config.id === "badge") {
      whatPreserved = "Circular layout continuity and curved text boundaries.";
      whatLost = "Tiny micro-dots or background noise removed by the circular mask.";
      alternateSuggestion = "If badge text is still blurry, try switching to 'Ultra' fidelity.";
    } else if (config.id === "drawing") {
      whatPreserved = "Organic sketch contours and natural variations in line thickness.";
      whatLost = "Flat color fills and high-contrast solid geometries.";
      alternateSuggestion = "If outlines are too rough, try the Logo or Line Art preset.";
    } else if (config.id === "lineart") {
      whatPreserved = "Crisp monochrome outlines and transparent background fields.";
      whatLost = "All interior color fills and gray midtone shades.";
      alternateSuggestion = "If lines are broken, try the Drawing preset.";
    } else if (config.id === "complex") {
      whatPreserved = "Detailed digital colors, nested shapes, and vector illustration fields.";
      whatLost = "Some micro-contrast edges simplified to reduce final file size.";
      alternateSuggestion = "If the file is too large, try the Logo preset.";
    } else if (config.id === "sticker") {
      whatPreserved = "Separated sticker outlines and sticker sheet borders.";
      whatLost = "Extraneous background specks and disconnected visual noise.";
      alternateSuggestion = "If borders merge, try raising the Detail Filter (pathomit) slider.";
    }
  }

  return {
    presetMatchScore,
    detailRetentionScore,
    pathComplexityScore,
    colorPreservationScore,
    edgePreservationScore,
    textRiskScore,
    editabilityScore,
    exportReadiness,
    explanation,
    whatPreserved,
    whatLost,
    alternateSuggestion,
  };
}
