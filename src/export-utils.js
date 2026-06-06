import { optimize as svgoOptimize } from "svgo/browser";

const SVG_MIME_TYPE = "image/svg+xml";

const SVGO_CONFIG = {
  multipass: false,
  plugins: [
    { name: "removeComments" },
    { name: "removeEmptyAttrs" },
    { name: "removeEmptyContainers" },
    { name: "removeHiddenElems" },
    { name: "convertColors", params: { currentColor: false, shorthex: true, shortname: false } },
    {
      name: "convertPathData",
      params: { floatPrecision: 2, leadingZero: true, negativeExtraSpace: true },
    },
  ],
};

export function getSvgByteSize(svgString) {
  return new Blob([svgString || ""], { type: SVG_MIME_TYPE }).size;
}

export function formatExportBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function optimizeSvgForExport(svgString) {
  if (!svgString) return "";
  try {
    const result = svgoOptimize(svgString, SVGO_CONFIG);
    return result.data || svgString;
  } catch {
    return svgString
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/>\s+</g, "><")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+(\/?>)/g, "$1")
      .trim();
  }
}

export function createInlineDataUri(svgString) {
  const encoded = encodeURIComponent(svgString || "")
    .replace(/'/g, "%27")
    .replace(/"/g, "%22");
  return `data:${SVG_MIME_TYPE};utf8,${encoded}`;
}

export function createReactComponent(svgString, componentName = "VectorArtwork") {
  const parsed = parseSvg(svgString);
  if (!parsed) {
    return `export function ${componentName}(props) {\n  return null;\n}\n`;
  }

  const svg = parsed.documentElement.cloneNode(true);
  svg.removeAttribute("xmlns");
  svg.removeAttribute("xmlns:xlink");

  let markup = new XMLSerializer().serializeToString(svg);
  markup = markup
    .replace(/^<svg\b/, "<svg {...props}")
    .replace(/\bclass=/g, "className=")
    .replace(/\bclip-rule=/g, "clipRule=")
    .replace(/\bfill-rule=/g, "fillRule=")
    .replace(/\bstroke-linecap=/g, "strokeLinecap=")
    .replace(/\bstroke-linejoin=/g, "strokeLinejoin=")
    .replace(/\bstroke-width=/g, "strokeWidth=")
    .replace(/\bstroke-miterlimit=/g, "strokeMiterlimit=")
    .replace(/\bstop-color=/g, "stopColor=")
    .replace(/\bstop-opacity=/g, "stopOpacity=");

  return `export function ${componentName}(props) {\n  return (\n    ${markup}\n  );\n}\n`;
}

export function analyzeSvgExport(svgString, item = {}) {
  const doc = parseSvg(svgString);
  const originalSize = Number(item.originalSize || 0);
  const svgSize = getSvgByteSize(svgString);
  const optimizedSvg = optimizeSvgForExport(svgString);
  const optimizedSize = getSvgByteSize(optimizedSvg);
  const pathCount = doc ? doc.querySelectorAll("path").length : numberFromItem(item.paths);
  const palette = doc ? detectSvgPalette(doc) : [];
  const isRasterBacked = doc ? Boolean(doc.querySelector("image")) : false;
  const compressionRatio = originalSize && svgSize ? originalSize / svgSize : 0;
  const optimizedSavings = svgSize ? Math.max(0, svgSize - optimizedSize) / svgSize : 0;
  const lowContrast = hasLowContrastPalette(palette);

  const warnings = buildExportWarnings({
    item,
    svgSize,
    originalSize,
    pathCount,
    palette,
    compressionRatio,
    optimizedSavings,
    lowContrast,
    isRasterBacked,
  });

  return {
    originalSize,
    svgSize,
    optimizedSize,
    optimizedSvg,
    optimizedSavings,
    pathCount,
    palette,
    warnings,
    compressionRatio,
    isRasterBacked,
  };
}

function buildExportWarnings({
  item,
  svgSize,
  originalSize,
  pathCount,
  compressionRatio,
  optimizedSavings,
  lowContrast,
  isRasterBacked,
}) {
  const warnings = [];
  const numericPathCount = Number(pathCount);

  if (Number.isFinite(numericPathCount) && numericPathCount > 1200) {
    warnings.push({
      id: "too-many-paths",
      level: numericPathCount > 2400 ? "high" : "medium",
      title: "High path count",
      detail: `${numericPathCount.toLocaleString()} paths may make editing or rendering slower.`,
    });
  }

  if (item.textWarning || item.exportStrategy === "quantized-path-trace-needs-refinement") {
    warnings.push({
      id: "text-degradation",
      level: item.textWarning ? "high" : "medium",
      title: "Possible text degradation",
      detail: "Curved or small lettering may need a visual check before production use.",
    });
  }

  if (lowContrast) {
    warnings.push({
      id: "low-contrast-source",
      level: "medium",
      title: "Low contrast source",
      detail: "Detected colors are close in luminance, so edges may be harder to trace cleanly.",
    });
  }

  if (compressionRatio >= 35 || item.assetProfile?.downscaled) {
    warnings.push({
      id: "extreme-compression",
      level: compressionRatio >= 50 ? "high" : "medium",
      title: "Extreme compression",
      detail: "The output is much smaller than the source, which can indicate lost fine detail.",
    });
  }

  if (svgSize > 1024 * 1024 || (originalSize && svgSize > originalSize * 1.25)) {
    warnings.push({
      id: "huge-svg-output",
      level: svgSize > 2 * 1024 * 1024 ? "high" : "medium",
      title: "Huge SVG output",
      detail: "This file may be heavy for web use; try optimized export or fewer colors.",
    });
  }

  if (optimizedSavings > 0.3 && svgSize > 200 * 1024) {
    warnings.push({
      id: "optimization-recommended",
      level: "low",
      title: "Optimization recommended",
      detail: "Optimized SVG export removes extra whitespace and can reduce transfer size.",
    });
  }

  if (isRasterBacked) {
    warnings.push({
      id: "raster-backed-svg",
      level: "low",
      title: "Raster-backed SVG",
      detail: "This preserves visual fidelity, but the artwork is not editable vector paths.",
    });
  }

  return warnings;
}

function parseSvg(svgString) {
  if (!svgString) return null;
  const doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
  if (doc.querySelector("parsererror")) return null;
  if (doc.documentElement?.nodeName.toLowerCase() !== "svg") return null;
  return doc;
}

function detectSvgPalette(doc) {
  const colors = new Map();
  const nodes = doc.querySelectorAll("[fill], [stroke], stop");
  nodes.forEach((node) => {
    ["fill", "stroke", "stop-color"].forEach((attr) => {
      const raw = node.getAttribute(attr);
      const normalized = normalizeColor(raw);
      if (!normalized) return;
      colors.set(normalized, (colors.get(normalized) || 0) + 1);
    });
  });

  return [...colors.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([hex, count]) => ({ hex, count }));
}

function normalizeColor(value) {
  if (!value) return "";
  const color = value.trim().toLowerCase();
  if (!color || color === "none" || color === "transparent" || color.startsWith("url(")) return "";
  if (/^#[0-9a-f]{3}$/.test(color)) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(color)) return color;

  const rgbMatch = color.match(/^rgba?\(([^)]+)\)$/);
  if (!rgbMatch) return "";
  const parts = rgbMatch[1].split(",").map((part) => Number.parseFloat(part.trim()));
  if (parts.length < 3 || parts.some((part, index) => index < 3 && !Number.isFinite(part))) return "";
  return rgbToHex(parts[0], parts[1], parts[2]);
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b]
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function hasLowContrastPalette(palette) {
  if (!palette || palette.length < 2) return false;
  const luminances = palette.slice(0, 5).map((color) => relativeLuminance(color.hex));
  const min = Math.min(...luminances);
  const max = Math.max(...luminances);
  return max - min < 0.22;
}

function relativeLuminance(hex) {
  const rgb = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const linear = rgb.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function numberFromItem(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
