import { SVGPathData } from "svg-pathdata";

import { OPTIMIZATION_MODES } from "./presets.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/* -------------------------------------------------------------------------- */
/* Geometry + color helpers.                                                   */
/* -------------------------------------------------------------------------- */

export function getPathBBoxFromD(d) {
  if (!d) return null;
  try {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    const commands = new SVGPathData(d).commands;
    for (const cmd of commands) {
      for (const key of ["x", "x1", "x2"]) {
        const v = cmd[key];
        if (v !== undefined) {
          if (v < minX) minX = v;
          if (v > maxX) maxX = v;
        }
      }
      for (const key of ["y", "y1", "y2"]) {
        const v = cmd[key];
        if (v !== undefined) {
          if (v < minY) minY = v;
          if (v > maxY) maxY = v;
        }
      }
    }

    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  } catch {
    return null;
  }
}

export function parseColorToRgb(colorStr) {
  if (!colorStr || colorStr === "none") return null;
  const str = colorStr.trim().toLowerCase();

  if (str === "white") return { r: 255, g: 255, b: 255 };
  if (str === "black") return { r: 0, g: 0, b: 0 };

  const hexM = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str);
  if (hexM) {
    let hex = hexM[1];
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  const rgbM = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(str);
  if (rgbM) {
    return { r: parseInt(rgbM[1], 10), g: parseInt(rgbM[2], 10), b: parseInt(rgbM[3], 10) };
  }

  return null;
}

export function isPaleColor(rgb) {
  if (!rgb) return false;
  return rgb.r > 215 && rgb.g > 215 && rgb.b > 215;
}

export function isLightFill(fill) {
  if (!fill || fill === "none") return false;
  const rgb = parseColorToRgb(fill);
  if (!rgb) return false;
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b > 190;
}

export function isNearWhiteFill(fill) {
  if (!fill || fill === "none") return false;
  const rgb = parseColorToRgb(fill);
  if (!rgb) return false;
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b > 240;
}

export function isShadowColor(rgb, bgRgb) {
  if (!rgb) return false;
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  const sat = max === 0 ? 0 : (max - min) / max;
  const lightness = (max + min) / 510;

  if (lightness > 0.65 && sat < 0.15) return true;

  if (bgRgb) {
    const dSq = (rgb.r - bgRgb.r) ** 2 + (rgb.g - bgRgb.g) ** 2 + (rgb.b - bgRgb.b) ** 2;
    if (dSq < 40 * 40) return true;
  }

  return false;
}

function roundNumbersInString(str, decimals) {
  return str.replace(/[-+]?[0-9]*\.?[0-9]+/g, (match) => {
    const num = parseFloat(match);
    if (Number.isNaN(num)) return match;
    return String(Number(num.toFixed(decimals)));
  });
}

/* -------------------------------------------------------------------------- */
/* Shared background-artifact analysis (single source for detect + removal).   */
/* -------------------------------------------------------------------------- */

function parseViewBox(svg) {
  const vb = (svg.getAttribute("viewBox") || "").trim().split(/[ ,]+/).map(Number);
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n)) || vb[2] <= 0 || vb[3] <= 0) {
    return null;
  }
  return { x: vb[0], y: vb[1], width: vb[2], height: vb[3], area: vb[2] * vb[3] };
}

/**
 * Analyze the leading paths of an SVG for large pale/shadow background polygons.
 * This is the SINGLE implementation shared by detectBackgroundArtifacts() (which
 * reports) and the sanitizer (which removes). Previously these were two
 * near-duplicate blocks that drifted apart.
 *
 * @returns {{
 *   viewBoxArea: number,
 *   stickerBackingPath: Element|null,
 *   candidates: Array<{path: Element, area: number, rgb: object|null, isBackground: boolean}>
 * } | null}
 */
function analyzeBackgroundPaths(svg, { profileType = "", backgroundColor = null } = {}) {
  const viewBox = parseViewBox(svg);
  if (!viewBox) return null;

  const paths = [...svg.querySelectorAll("path")];
  if (paths.length === 0) return null;

  const checkCount = Math.max(8, Math.min(paths.length, Math.ceil(paths.length * 0.2)));
  const earlyPaths = paths.slice(0, checkCount);

  const isSticker = profileType === "sticker";
  const areaThreshold = isSticker ? viewBox.area * 0.12 : viewBox.area * 0.35;

  // Identify the sticker backing sheet (a large near-white region we keep).
  let stickerBackingPath = null;
  if (isSticker) {
    let largestWhiteArea = 0;
    for (const p of earlyPaths) {
      const fill = (p.getAttribute("fill") || "").trim().toLowerCase();
      if (!isNearWhiteFill(fill)) continue;
      const bbox = getPathBBoxFromD((p.getAttribute("d") || "").trim());
      const area = bbox ? bbox.width * bbox.height : 0;
      if (area > viewBox.area * 0.25 && area > largestWhiteArea) {
        largestWhiteArea = area;
        stickerBackingPath = p;
      }
    }
  }

  const candidates = earlyPaths.map((path) => {
    const bbox = getPathBBoxFromD((path.getAttribute("d") || "").trim());
    const area = bbox ? bbox.width * bbox.height : 0;
    const rgb = parseColorToRgb((path.getAttribute("fill") || "").trim().toLowerCase());
    const isBackground =
      area > areaThreshold && (isPaleColor(rgb) || isShadowColor(rgb, backgroundColor));
    return { path, area, rgb, isBackground };
  });

  return { viewBoxArea: viewBox.area, stickerBackingPath, candidates };
}

function capPathsByArea(root, pathCap) {
  if (!root || pathCap <= 0) return;

  const allPaths = [...root.querySelectorAll("path")];
  if (allPaths.length <= pathCap) return;

  const pathsWithInfo = allPaths.map((path) => {
    const d = path.getAttribute("d") || "";
    const bbox = getPathBBoxFromD(d);
    const area = bbox ? bbox.width * bbox.height : 0;
    return { path, area, len: d.length };
  });

  pathsWithInfo.sort((a, b) => a.area - b.area || a.len - b.len);

  const toRemoveCount = allPaths.length - pathCap;
  for (let i = 0; i < toRemoveCount; i++) {
    pathsWithInfo[i].path.remove();
  }
}

const PATH_MERGE_ATTRS = Object.freeze([
  "fill",
  "fill-rule",
  "clip-rule",
  "opacity",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
]);

function getPathMergeKey(path) {
  if (!path || path.tagName.toLowerCase() !== "path" || path.hasAttribute("transform")) {
    return "";
  }
  return PATH_MERGE_ATTRS.map((attr) => `${attr}:${path.getAttribute(attr) || ""}`).join("|");
}

/* -------------------------------------------------------------------------- */
/* Public: background-artifact detection (reporting only).                     */
/* -------------------------------------------------------------------------- */

export function detectBackgroundArtifacts(svgString, profileType = "") {
  if (!svgString) return { detected: false };
  try {
    const doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
    if (doc.querySelector("parsererror")) return { detected: false };

    const analysis = analyzeBackgroundPaths(doc.documentElement, { profileType });
    if (!analysis) return { detected: false };

    for (const candidate of analysis.candidates) {
      if (!candidate.isBackground) continue;
      if (profileType === "sticker" && candidate.path === analysis.stickerBackingPath) continue;
      return {
        detected: true,
        reason: "Large pale background polygon detected behind artwork.",
      };
    }
  } catch (e) {
    console.warn("Artifact detection failed", e);
  }
  return { detected: false };
}

/* -------------------------------------------------------------------------- */
/* Public: full sanitize + optimize pass.                                      */
/* -------------------------------------------------------------------------- */

export function sanitizeAndOptimizeSvg(
  svgString,
  {
    title = "",
    description = "",
    removeSpeckles = false,
    profileType = "",
    preserveBackground = false,
    backgroundColor = null,
    optimizationMode = "balanced",
  } = {}
) {
  if (!svgString) return "";

  const doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
  const svg = doc.documentElement;
  const parseError = doc.querySelector("parsererror");

  if (parseError || !svg || svg.nodeName.toLowerCase() !== "svg") return "";

  // Optimization intensity is owned entirely by OPTIMIZATION_MODES (presets.js).
  const opt = OPTIMIZATION_MODES[optimizationMode] || OPTIMIZATION_MODES.balanced;
  const optNone = optimizationMode === "none";

  const isBadgeProfile = profileType === "complex" || profileType === "badge";
  // Badge/complex profiles keep more decimals to protect fine lettering.
  const coordinateDecimals = optNone ? 3 : isBadgeProfile ? 3 : opt.coordinateDecimals;
  const pathCap = opt.pathCap;
  const shouldRemoveSpeckles = removeSpeckles || opt.removeSpeckles;

  const idPrefix = createSvgIdPrefix();
  const titleId = `${idPrefix}-title`;
  const descId = `${idPrefix}-desc`;

  doc.querySelectorAll("script, foreignObject, iframe, object, embed").forEach((n) => n.remove());

  // Strip event handlers and unsafe href schemes.
  doc.querySelectorAll("*").forEach((node) => {
    for (const attr of [...node.getAttributeNames()]) {
      const value = node.getAttribute(attr) || "";
      if (/^on/i.test(attr)) node.removeAttribute(attr);
      if (
        (attr === "href" || attr === "xlink:href") &&
        /^\s*(https?:|data:|javascript:|vbscript:|\/\/)/i.test(value)
      ) {
        node.removeAttribute(attr);
      }
    }
  });

  doc.querySelectorAll("metadata").forEach((n) => n.remove());
  doc.querySelectorAll("feImage").forEach((n) => {
    n.removeAttribute("href");
    n.removeAttribute("xlink:href");
    n.removeAttribute("externalResourcesRequired");
  });

  ensureSvgViewBox(svg);

  // Background and shadow polygon removal — uses the shared analyzer.
  if (!optNone) {
    const analysis = analyzeBackgroundPaths(svg, { profileType, backgroundColor });
    if (analysis) {
      for (const candidate of analysis.candidates) {
        if (!candidate.isBackground) continue;
        if (
          profileType === "sticker" &&
          candidate.path === analysis.stickerBackingPath &&
          preserveBackground !== false
        ) {
          continue;
        }
        candidate.path.remove();
      }
    }
  }

  const referencedIds = collectReferencedIds(svg);

  const KEEP_ID_TAGS = ["linearGradient", "radialGradient", "pattern", "clipPath", "mask", "filter", "symbol"];
  doc.querySelectorAll("[id]").forEach((node) => {
    const id = node.getAttribute("id");
    if (referencedIds.has(id)) return;
    if (!KEEP_ID_TAGS.includes(node.tagName)) node.removeAttribute("id");
  });

  doc.querySelectorAll("path").forEach((path) => {
    let d = (path.getAttribute("d") || "").trim();
    const fill = path.getAttribute("fill");
    const stroke = path.getAttribute("stroke");
    const display = path.getAttribute("display");
    const visibility = path.getAttribute("visibility");
    const opacity = Number(path.getAttribute("opacity") ?? 1);

    if (!d || d === "M0 0") {
      path.remove();
      return;
    }

    if (coordinateDecimals !== undefined) {
      d = roundNumbersInString(d, coordinateDecimals);
      path.setAttribute("d", d);
    }

    if (shouldRemoveSpeckles) {
      const commandCount = (d.match(/[MLHVCSQTAZmlhvcsqtaz]/g) || []).length;
      const hasCurves = /[CSQTAcsqta]/.test(d);
      // Badge text glyphs produce small paths with 4-6 commands; a tighter
      // threshold for badge/complex profiles keeps letter fragments alive.
      const speckleThreshold = isBadgeProfile ? 3 : 5;

      // A low command count alone is NOT enough to call something a speckle:
      // large flat-color polygons (logo blocks, pixel-art cells, flat UI fills)
      // are also few-command and curve-free, and must be preserved. Only prune
      // when the path is ALSO physically tiny. Speckle area scales with the
      // optimization mode's coordinate precision so aggressive prunes a bit more.
      const speckleArea = optimizationMode === "aggressive" ? 9 : 4;
      const bbox = getPathBBoxFromD(d);
      const area = bbox ? bbox.width * bbox.height : Infinity;

      if (commandCount <= speckleThreshold && !hasCurves && area <= speckleArea) {
        path.remove();
        return;
      }
    }

    const effectivelyInvisible =
      display === "none" ||
      visibility === "hidden" ||
      opacity === 0 ||
      (fill === "none" && (!stroke || stroke === "none"));

    if (effectivelyInvisible) path.remove();
  });

  doc.querySelectorAll("title, desc, metadata").forEach((n) => n.remove());

  const existingDefs = svg.querySelector(":scope > defs");
  if (existingDefs) {
    [...existingDefs.children].forEach((child) => {
      const id = child.getAttribute("id");
      if (id && !referencedIds.has(id)) child.remove();
    });
  }

  const artworkNodes = [...svg.children].filter((n) => n.tagName.toLowerCase() !== "defs");
  const artworkGroup = doc.createElementNS(SVG_NS, "g");
  artworkGroup.setAttribute("data-layer", "artwork");
  artworkGroup.setAttribute("fill", "none");
  artworkNodes.forEach((n) => artworkGroup.appendChild(n));

  // Merge consecutive same-style paths to reduce path count.
  let mergeKey = "";
  let mergeTarget = null;
  for (const child of [...artworkGroup.children]) {
    const childKey = getPathMergeKey(child);
    if (!childKey) {
      mergeTarget = null;
      mergeKey = "";
      continue;
    }

    if (childKey === mergeKey && mergeTarget) {
      const addedD = (child.getAttribute("d") || "").trim();
      if (addedD) {
        mergeTarget.setAttribute("d", `${mergeTarget.getAttribute("d") || ""} ${addedD}`.trim());
      }
      child.remove();
    } else {
      mergeTarget = child;
      mergeKey = childKey;
    }
  }

  capPathsByArea(artworkGroup, pathCap);

  const defsEl = existingDefs || doc.createElementNS(SVG_NS, "defs");

  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const titleEl = doc.createElementNS(SVG_NS, "title");
  titleEl.setAttribute("id", titleId);
  titleEl.textContent = title || "Vectorized image";
  svg.appendChild(titleEl);

  const descEl = doc.createElementNS(SVG_NS, "desc");
  descEl.setAttribute("id", descId);
  descEl.textContent = description || "Auto-generated SVG output from the uploaded source image.";
  svg.appendChild(descEl);

  svg.appendChild(defsEl);
  svg.appendChild(artworkGroup);

  svg.setAttribute("role", "img");
  svg.setAttribute("aria-labelledby", `${titleId} ${descId}`);
  svg.setAttribute("focusable", "false");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  // Coordinates were already rounded structurally per-path above; only strip
  // comments and collapse whitespace here. The previous fragile trailing
  // number-munging regex (which could corrupt viewBox/id numbers) is removed.
  return new XMLSerializer()
    .serializeToString(svg)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* -------------------------------------------------------------------------- */
/* White-background stripping + background stabilization.                      */
/* -------------------------------------------------------------------------- */

export function stripWhiteBackgroundFromSvg(svgString) {
  if (!svgString) return svgString;
  try {
    const svgDoc = new DOMParser().parseFromString(svgString, "image/svg+xml");
    if (svgDoc.querySelector("parsererror")) return svgString;

    const svg = svgDoc.documentElement;
    ensureSvgViewBox(svg);
    const viewBox = parseViewBox(svg);
    if (!viewBox) return svgString;

    const areaThreshold = viewBox.area * 0.15;

    let removed = false;
    for (const path of [...svgDoc.querySelectorAll("path")]) {
      const fill = (path.getAttribute("fill") || "").trim().toLowerCase();
      if (isNearWhiteFill(fill)) {
        const bbox = getPathBBoxFromD((path.getAttribute("d") || "").trim());
        const area = bbox ? bbox.width * bbox.height : 0;
        if (area >= areaThreshold) {
          path.remove();
          removed = true;
        }
      } else {
        break;
      }
    }

    return removed ? new XMLSerializer().serializeToString(svgDoc) : svgString;
  } catch (e) {
    console.warn("Failed to strip white background from SVG", e);
  }
  return svgString;
}

export function validateSvgString(svgString, context = "SVG output") {
  if (!svgString || typeof svgString !== "string") {
    throw new Error(`${context} was empty.`);
  }
  const doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
  const svg = doc.documentElement;
  if (doc.querySelector("parsererror") || !svg || svg.nodeName.toLowerCase() !== "svg") {
    throw new Error(`${context} was not valid SVG.`);
  }
  return svgString;
}

function colorToHex(color) {
  const toHex = (value) =>
    Math.max(0, Math.min(255, Math.round(value || 0)))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(color?.r)}${toHex(color?.g)}${toHex(color?.b)}`;
}

export function stabilizeSvgBackground(svgString, background, options = {}) {
  if (!svgString || !background?.hasUniformOpaqueBackground) return svgString;
  try {
    const doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
    if (doc.querySelector("parsererror")) return svgString;

    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== "svg") return svgString;
    ensureSvgViewBox(svg);

    const viewBox = parseViewBox(svg);
    if (!viewBox) return svgString;

    const artwork = svg.querySelector('[data-layer="artwork"]') || svg;
    if (options.removeLeadingWhitePaths !== false) {
      const areaThreshold = viewBox.area * 0.15;
      for (const path of [...artwork.querySelectorAll("path")]) {
        const fill = (path.getAttribute("fill") || "").trim().toLowerCase();
        if (isNearWhiteFill(fill)) {
          const bbox = getPathBBoxFromD((path.getAttribute("d") || "").trim());
          const area = bbox ? bbox.width * bbox.height : 0;
          if (area >= areaThreshold) path.remove();
        } else {
          break;
        }
      }
    }

    const rect = doc.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(viewBox.x));
    rect.setAttribute("y", String(viewBox.y));
    rect.setAttribute("width", String(viewBox.width));
    rect.setAttribute("height", String(viewBox.height));
    rect.setAttribute("fill", colorToHex(background.color));
    rect.setAttribute("data-layer", "background");

    const firstArtworkChild = artwork.firstChild;
    if (artwork === svg) svg.insertBefore(rect, firstArtworkChild);
    else artwork.insertBefore(rect, firstArtworkChild);

    return new XMLSerializer().serializeToString(svg);
  } catch (error) {
    console.warn("Stable SVG background skipped:", error);
    return svgString;
  }
}

/* -------------------------------------------------------------------------- */
/* Image-wrapper SVG + raster detection.                                       */
/* -------------------------------------------------------------------------- */

export function createImagePreservingSvg(dataUrl, width, height, options = {}) {
  const { title = "Image preserved as SVG", description = "" } = options;
  const safeWidth = Math.max(1, Math.round(Number(width) || 0));
  const safeHeight = Math.max(1, Math.round(Number(height) || 0));
  const href =
    typeof dataUrl === "string" && /^data:image\/(png|jpeg|webp);/i.test(dataUrl) ? dataUrl : "";
  if (!href) return "";

  const idPrefix = createSvgIdPrefix();
  const titleId = `${idPrefix}-title`;
  const descId = `${idPrefix}-desc`;

  const doc = document.implementation.createDocument(SVG_NS, "svg", null);
  const svg = doc.documentElement;
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", `0 0 ${safeWidth} ${safeHeight}`);
  svg.setAttribute("width", String(safeWidth));
  svg.setAttribute("height", String(safeHeight));
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-labelledby", `${titleId} ${descId}`);
  svg.setAttribute("focusable", "false");

  const titleEl = doc.createElementNS(SVG_NS, "title");
  titleEl.setAttribute("id", titleId);
  titleEl.textContent = title;
  svg.appendChild(titleEl);

  const descEl = doc.createElementNS(SVG_NS, "desc");
  descEl.setAttribute("id", descId);
  descEl.textContent =
    description ||
    "Photo or gradient-heavy image preserved as an embedded SVG for visual fidelity.";
  svg.appendChild(descEl);

  const imageEl = doc.createElementNS(SVG_NS, "image");
  imageEl.setAttribute("x", "0");
  imageEl.setAttribute("y", "0");
  imageEl.setAttribute("width", String(safeWidth));
  imageEl.setAttribute("height", String(safeHeight));
  imageEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
  imageEl.setAttribute("href", href);
  imageEl.setAttributeNS(XLINK_NS, "xlink:href", href);
  svg.appendChild(imageEl);

  return new XMLSerializer().serializeToString(svg);
}

export function isRasterBackedSvg(svgString) {
  return /<image\b/i.test(svgString || "") || /href=["']data:image/i.test(svgString || "");
}

export function assertRealVectorSvg(svgString) {
  if (isRasterBackedSvg(svgString)) {
    throw new Error("Vector-only export produced raster-backed SVG.");
  }
}

export function ensureSvgViewBox(svg) {
  if (!svg || svg.getAttribute("viewBox")) return;
  const parseLength = (value) => {
    const parsed = parseFloat(String(value || "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const width = parseLength(svg.getAttribute("width"));
  const height = parseLength(svg.getAttribute("height"));
  if (width > 0 && height > 0) svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
}

export function createSvgIdPrefix() {
  return "svg-" + Math.random().toString(36).substring(2, 9);
}

export function collectReferencedIds(svg) {
  const ids = new Set();
  const urlRegex = /url\s*\(\s*#([^)]+)\)/g;
  const hashRegex = /^#(.+)$/;

  const walk = (node) => {
    if (node.nodeType === 1) {
      for (let i = 0; i < node.attributes.length; i++) {
        const attr = node.attributes[i];
        const val = attr.value || "";
        urlRegex.lastIndex = 0;
        let match;
        while ((match = urlRegex.exec(val)) !== null) {
          ids.add(match[1].trim());
        }
        if (attr.name === "href" || attr.name === "xlink:href") {
          const hashMatch = hashRegex.exec(val.trim());
          if (hashMatch) ids.add(hashMatch[1]);
        }
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
  };

  walk(svg);
  return ids;
}
