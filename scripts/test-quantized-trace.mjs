/**
 * Senior-grade test harness for quantized vs. direct vtracer tracing, plus the
 * badge refinement pass.
 *
 * Usage:
 *   node scripts/test-quantized-trace.mjs
 *   node scripts/test-quantized-trace.mjs --size=320
 *   node scripts/test-quantized-trace.mjs --json
 *
 * This script intentionally avoids browser-only APIs. It uses raw Uint8Array /
 * Uint8ClampedArray pixel buffers throughout so it can run in Node and CI.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import init, { to_svg } from "vtracer-wasm";
import { detectBadge } from "../src/badge-detect.js";
import { preprocessBadge } from "../src/badge-preprocess.js";
import { quantizeImageData } from "../src/image-quantize.js";
import { isLightFill } from "../src/svg-sanitize.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WASM_PATH = path.resolve(SCRIPT_DIR, "../node_modules/vtracer-wasm/vtracer.wasm");

const DEFAULT_IMAGE_SIZE = 240;

const BASE_TRACE_CONFIG = Object.freeze({
  binary: false,
  mode: "spline",
  hierarchical: "stacked",
  layerDifference: 8,
  cornerThreshold: 60,
  lengthThreshold: 4,
  maxIterations: 10,
  spliceThreshold: 45,
  pathPrecision: 8,
});

const TRACE_MODES = Object.freeze({
  direct: Object.freeze({
    name: "direct",
    config: Object.freeze({
      ...BASE_TRACE_CONFIG,
      filterSpeckle: 4,
      colorPrecision: 6,
    }),
  }),

  quantizedHigh: Object.freeze({
    name: "quantizedHigh",
    paletteSize: 40,
    quantizeOptions: Object.freeze({}),
    config: Object.freeze({
      ...BASE_TRACE_CONFIG,
      filterSpeckle: 2,
      colorPrecision: 5,
    }),
  }),

  badgeRefined: Object.freeze({
    name: "badgeRefined",
    paletteSize: 64,
    quantizeOptions: Object.freeze({
      preserveDarkLightAnchors: true,
      preserveGreenAccent: true,
    }),
    preprocessOptions: Object.freeze({
      contrastStrength: 0.25,
      textBandProtection: true,
    }),
    config: Object.freeze({
      ...BASE_TRACE_CONFIG,
      filterSpeckle: 1,
      colorPrecision: 4,
      cornerThreshold: 40,
    }),
  }),
});

const BADGE_ACCEPTANCE = Object.freeze({
  minColors: 18,
  preferredMinColors: 20,
  minPaths: 48,
  minTextBandCreamPaths: 4,
  minSelectedCandidatePaths: 40,
});

const BADGE_CANDIDATES = Object.freeze([
  Object.freeze({
    name: "badgeMonoHigh-8",
    paletteSize: 8,
    filterSpeckle: 0,
    colorPrecision: 6,
  }),
  Object.freeze({
    name: "badgeMonoHigh-12",
    paletteSize: 12,
    filterSpeckle: 0,
    colorPrecision: 6,
  }),
  Object.freeze({
    name: "badgeMonoHigh-16",
    paletteSize: 16,
    filterSpeckle: 0,
    colorPrecision: 6,
  }),
  Object.freeze({
    name: "badgeHigh-48",
    paletteSize: 48,
    filterSpeckle: 1,
    colorPrecision: 5,
  }),
  Object.freeze({
    name: "badgeUltra-64",
    paletteSize: 64,
    filterSpeckle: 0,
    colorPrecision: 4,
  }),
]);

const CANDIDATE_SCORING = Object.freeze({
  pathWeight: 2,
  fillColorWeight: 5,
  textBandCreamPathWeight: 35,
  bytePenaltyDivisor: 60_000,
  overFragmentationSoftLimit: 2_500,
  overFragmentationPenalty: 0.06,
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const options = {
    imageSize: DEFAULT_IMAGE_SIZE,
    json: false,
    wasmPath: DEFAULT_WASM_PATH,
  };

  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg.startsWith("--size=")) {
      const value = Number.parseInt(arg.slice("--size=".length), 10);
      if (!Number.isInteger(value) || value < 32 || value > 2048) {
        throw new Error("--size must be an integer between 32 and 2048.");
      }
      options.imageSize = value;
      continue;
    }

    if (arg.startsWith("--wasm=")) {
      const value = arg.slice("--wasm=".length).trim();
      if (!value) throw new Error("--wasm requires a non-empty path.");
      options.wasmPath = path.resolve(value);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function initializeVTracer(wasmPath) {
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`vtracer wasm file not found: ${wasmPath}`);
  }

  const wasmBuffer = fs.readFileSync(wasmPath);

  try {
    await init({ module_or_path: wasmBuffer });
  } catch (firstError) {
    try {
      await init(wasmBuffer);
    } catch {
      throw firstError;
    }
  }
}

// ---------------------------------------------------------------------------
// Image validation and synthetic fixture generation
// ---------------------------------------------------------------------------

function isPixelArray(value) {
  return value instanceof Uint8Array || value instanceof Uint8ClampedArray;
}

function assertImageDataLike(imgData, label = "imgData") {
  if (!imgData || typeof imgData !== "object") {
    throw new TypeError(`${label} must be an object.`);
  }

  if (!Number.isInteger(imgData.width) || imgData.width <= 0) {
    throw new TypeError(`${label}.width must be a positive integer.`);
  }

  if (!Number.isInteger(imgData.height) || imgData.height <= 0) {
    throw new TypeError(`${label}.height must be a positive integer.`);
  }

  if (!isPixelArray(imgData.data)) {
    throw new TypeError(`${label}.data must be a Uint8Array or Uint8ClampedArray.`);
  }

  const expectedLength = imgData.width * imgData.height * 4;
  if (imgData.data.length !== expectedLength) {
    throw new TypeError(
      `${label}.data length must be width * height * 4. Expected ${expectedLength}, got ${imgData.data.length}.`
    );
  }
}

function toUint8ArrayView(data) {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function writeRgb(pixels, offset, rgb, alpha = 255) {
  pixels[offset] = rgb[0];
  pixels[offset + 1] = rgb[1];
  pixels[offset + 2] = rgb[2];
  pixels[offset + 3] = alpha;
}

/**
 * Generate a synthetic circular badge that exercises:
 * - circular mask removal
 * - dark/light anchors
 * - rim alternation
 * - lower-arc text-like details
 * - many distinct mid-tone accents
 */
function generateCircularBadge(size = DEFAULT_IMAGE_SIZE) {
  if (!Number.isInteger(size) || size < 32) {
    throw new TypeError("size must be an integer >= 32.");
  }

  const width = size;
  const height = size;
  const pixels = new Uint8Array(width * height * 4);

  const cx = width / 2;
  const cy = height / 2;
  const outerR = (size / 2) * 0.96;

  const BG = [255, 255, 255];
  const BLACK = [14, 14, 14];
  const CREAM = [245, 244, 236];
  const GREEN = [20, 56, 38];

  const ACCENTS = [
    [176, 64, 64],
    [64, 104, 176],
    [192, 144, 64],
    [128, 64, 152],
    [72, 152, 152],
    [152, 104, 64],
    [104, 152, 72],
    [192, 104, 128],
    [88, 88, 136],
    [152, 176, 80],
    [72, 128, 104],
    [176, 128, 176],
    [192, 80, 72],
    [80, 168, 192],
    [152, 72, 104],
    [104, 104, 176],
    [184, 184, 96],
    [72, 168, 128],
    [128, 80, 64],
    [168, 168, 144],
    [120, 72, 152],
    [64, 144, 80],
    [176, 96, 160],
    [96, 120, 64],
    [144, 96, 96],
    [80, 152, 168],
    [160, 144, 72],
    [112, 128, 144],
    [208, 88, 88],
    [88, 192, 88],
    [88, 88, 208],
    [208, 168, 88],
    [168, 88, 208],
    [88, 208, 168],
    [208, 88, 168],
    [136, 208, 88],
    [88, 136, 208],
    [208, 136, 136],
    [136, 208, 208],
    [208, 208, 136],
  ];

  const rimBlocks = 16;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      const angle01 = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI);

      if (dist > outerR) {
        writeRgb(pixels, offset, BG);
        continue;
      }

      if (dist > outerR * 0.82) {
        const block = Math.floor(angle01 * rimBlocks);
        if (block % 3 === 2) {
          writeRgb(pixels, offset, ACCENTS[block % ACCENTS.length]);
        } else {
          writeRgb(pixels, offset, block % 2 === 0 ? CREAM : BLACK);
        }
        continue;
      }

      if (dist > outerR * 0.78) {
        writeRgb(pixels, offset, BLACK);
        continue;
      }

      if (dist > outerR * 0.6) {
        const wedge = Math.floor(angle01 * ACCENTS.length) % ACCENTS.length;
        writeRgb(pixels, offset, ACCENTS[wedge]);
        continue;
      }

      if (dist > outerR * 0.42 && dy > 0) {
        const dash = Math.floor(angle01 * 40) % 2;
        writeRgb(pixels, offset, dash === 0 ? CREAM : GREEN);
        continue;
      }

      if (dist > outerR * 0.42) {
        writeRgb(pixels, offset, GREEN);
        continue;
      }

      const gx = Math.floor((x - (cx - outerR * 0.42)) / (outerR * 0.075));
      const gy = Math.floor((y - (cy - outerR * 0.42)) / (outerR * 0.075));
      const cell = (gx * 3 + gy * 5) % 8;

      if (cell === 0) writeRgb(pixels, offset, BLACK);
      else if (cell === 1) writeRgb(pixels, offset, CREAM);
      else if (cell === 2) writeRgb(pixels, offset, GREEN);
      else writeRgb(pixels, offset, ACCENTS[Math.abs(gx * 7 + gy * 11) % ACCENTS.length]);
    }
  }

  const imgData = { data: pixels, width, height };
  assertImageDataLike(imgData, "generatedCircularBadge");
  return imgData;
}

function uniqueOpaqueColors(imgData) {
  assertImageDataLike(imgData);

  const colors = new Set();
  for (let i = 0; i < imgData.data.length; i += 4) {
    if (imgData.data[i + 3] >= 16) {
      colors.add(`${imgData.data[i]},${imgData.data[i + 1]},${imgData.data[i + 2]}`);
    }
  }
  return colors.size;
}

// ---------------------------------------------------------------------------
// SVG parsing helpers
// ---------------------------------------------------------------------------

function countSvgElements(svgString, tagName) {
  if (typeof svgString !== "string" || !tagName) return 0;
  const re = new RegExp(`<${escapeRegExp(tagName)}\\b`, "gi");
  return (svgString.match(re) || []).length;
}

function countPaths(svgString) {
  return countSvgElements(svgString, "path");
}

function isRasterBackedSvg(svgString) {
  return (
    /<image\b/i.test(svgString || "") ||
    /\b(?:href|xlink:href)=["']data:image/i.test(svgString || "")
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSvgAttributes(attributeSource) {
  const attrs = {};
  if (!attributeSource) return attrs;

  const attrRegex = /([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

  let match;
  while ((match = attrRegex.exec(attributeSource)) !== null) {
    const [, key, doubleQuoted, singleQuoted, unquoted] = match;
    attrs[key] = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
  }

  return attrs;
}

function getSvgElements(svgString, tagName) {
  if (typeof svgString !== "string" || !tagName) return [];

  const re = new RegExp(`<${escapeRegExp(tagName)}\\b([^>]*)>`, "gi");
  const elements = [];

  let match;
  while ((match = re.exec(svgString)) !== null) {
    elements.push({
      raw: match[0],
      attrs: parseSvgAttributes(match[1]),
    });
  }

  return elements;
}

function normalizeFill(fill) {
  if (typeof fill !== "string") return null;

  const raw = fill.trim().toLowerCase();
  if (!raw || raw === "none" || raw === "transparent") return null;

  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (hexMatch) {
    let hex = hexMatch[1].toLowerCase();
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((ch) => ch + ch)
        .join("");
    }
    return `#${hex}`;
  }

  const rgbMatch =
    /^rgba?\(\s*(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*[,/]\s*(\d*\.?\d+%?))?\s*\)$/i.exec(
      raw
    );

  if (rgbMatch) {
    const r = clampByte(Number.parseInt(rgbMatch[1], 10));
    const g = clampByte(Number.parseInt(rgbMatch[2], 10));
    const b = clampByte(Number.parseInt(rgbMatch[3], 10));
    const alphaRaw = rgbMatch[4];

    if (alphaRaw != null) {
      const alpha = alphaRaw.endsWith("%")
        ? Number.parseFloat(alphaRaw) / 100
        : Number.parseFloat(alphaRaw);

      if (Number.isFinite(alpha) && alpha <= 0) return null;
    }

    return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`;
  }

  if (raw === "white") return "#ffffff";
  if (raw === "black") return "#000000";

  return raw;
}

function clampByte(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, value));
}

function byteToHex(value) {
  return clampByte(value).toString(16).padStart(2, "0");
}

function countDistinctFills(svgString) {
  const fills = new Set();

  for (const pathElement of getSvgElements(svgString, "path")) {
    const fill = normalizeFill(pathElement.attrs.fill);
    if (fill) fills.add(fill);
  }

  return fills.size;
}



// ---------------------------------------------------------------------------
// SVG path and transform helpers
// ---------------------------------------------------------------------------

function tokenizePathData(d) {
  if (typeof d !== "string") return [];

  const tokenRegex = /[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
  return d.match(tokenRegex) || [];
}

function isPathCommand(token) {
  return /^[AaCcHhLlMmQqSsTtVvZz]$/.test(token);
}

function readNumber(tokens, index) {
  if (index >= tokens.length || isPathCommand(tokens[index])) return null;
  const value = Number.parseFloat(tokens[index]);
  if (!Number.isFinite(value)) return null;
  return value;
}

function readPathNumbers(tokens, start, count) {
  const values = [];

  for (let j = 0; j < count; j++) {
    const value = readNumber(tokens, start + j);
    if (value == null) return null;
    values.push(value);
  }

  return values;
}

/**
 * Command-aware extraction of representative points from SVG path data.
 * This is not exact geometric integration. It is stable enough for text-band
 * centroid classification.
 */
function extractRepresentativePathPoints(d) {
  const tokens = tokenizePathData(d);
  const points = [];

  let i = 0;
  let command = null;
  let current = { x: 0, y: 0 };
  let subpathStart = { x: 0, y: 0 };

  const pushPoint = (x, y) => {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      current = { x, y };
      points.push(current);
    }
  };

  while (i < tokens.length) {
    if (isPathCommand(tokens[i])) {
      command = tokens[i++];
    }

    if (!command) break;

    const absolute = command === command.toUpperCase();
    const lower = command.toLowerCase();

    if (lower === "z") {
      pushPoint(subpathStart.x, subpathStart.y);
      command = null;
      continue;
    }

    if (lower === "m") {
      const x = readNumber(tokens, i);
      const y = readNumber(tokens, i + 1);
      if (x == null || y == null) break;

      i += 2;

      const px = absolute ? x : current.x + x;
      const py = absolute ? y : current.y + y;

      pushPoint(px, py);
      subpathStart = { x: px, y: py };

      command = absolute ? "L" : "l";
      continue;
    }

    if (lower === "l") {
      const x = readNumber(tokens, i);
      const y = readNumber(tokens, i + 1);
      if (x == null || y == null) {
        command = null;
        continue;
      }

      i += 2;
      pushPoint(absolute ? x : current.x + x, absolute ? y : current.y + y);
      continue;
    }

    if (lower === "h") {
      const x = readNumber(tokens, i);
      if (x == null) {
        command = null;
        continue;
      }

      i += 1;
      pushPoint(absolute ? x : current.x + x, current.y);
      continue;
    }

    if (lower === "v") {
      const y = readNumber(tokens, i);
      if (y == null) {
        command = null;
        continue;
      }

      i += 1;
      pushPoint(current.x, absolute ? y : current.y + y);
      continue;
    }

    if (lower === "c") {
      const values = readPathNumbers(tokens, i, 6);
      if (!values) {
        command = null;
        continue;
      }

      i += 6;

      const p1 = {
        x: absolute ? values[0] : current.x + values[0],
        y: absolute ? values[1] : current.y + values[1],
      };
      const p2 = {
        x: absolute ? values[2] : current.x + values[2],
        y: absolute ? values[3] : current.y + values[3],
      };
      const p3 = {
        x: absolute ? values[4] : current.x + values[4],
        y: absolute ? values[5] : current.y + values[5],
      };

      points.push(p1, p2);
      pushPoint(p3.x, p3.y);
      continue;
    }

    if (lower === "s" || lower === "q") {
      const values = readPathNumbers(tokens, i, 4);
      if (!values) {
        command = null;
        continue;
      }

      i += 4;

      const control = {
        x: absolute ? values[0] : current.x + values[0],
        y: absolute ? values[1] : current.y + values[1],
      };
      const end = {
        x: absolute ? values[2] : current.x + values[2],
        y: absolute ? values[3] : current.y + values[3],
      };

      points.push(control);
      pushPoint(end.x, end.y);
      continue;
    }

    if (lower === "t") {
      const values = readPathNumbers(tokens, i, 2);
      if (!values) {
        command = null;
        continue;
      }

      i += 2;

      pushPoint(
        absolute ? values[0] : current.x + values[0],
        absolute ? values[1] : current.y + values[1]
      );
      continue;
    }

    if (lower === "a") {
      const values = readPathNumbers(tokens, i, 7);
      if (!values) {
        command = null;
        continue;
      }

      i += 7;

      pushPoint(
        absolute ? values[5] : current.x + values[5],
        absolute ? values[6] : current.y + values[6]
      );
      continue;
    }

    command = null;
  }

  return points;
}

function parseSvgTransform(transform) {
  const identity = {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: 0,
    f: 0,
  };

  if (typeof transform !== "string" || !transform.trim()) {
    return identity;
  }

  let matrix = identity;
  const transformRegex = /(\w+)\(([^)]*)\)/g;
  let match;

  while ((match = transformRegex.exec(transform)) !== null) {
    const kind = match[1].toLowerCase();
    const args = match[2]
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((value) => Number.parseFloat(value));

    if (args.some((value) => !Number.isFinite(value))) continue;

    let next = identity;

    if (kind === "translate") {
      next = {
        ...identity,
        e: args[0] ?? 0,
        f: args[1] ?? 0,
      };
    } else if (kind === "scale") {
      const sx = args[0] ?? 1;
      const sy = args[1] ?? sx;
      next = {
        a: sx,
        b: 0,
        c: 0,
        d: sy,
        e: 0,
        f: 0,
      };
    } else if (kind === "matrix" && args.length >= 6) {
      next = {
        a: args[0],
        b: args[1],
        c: args[2],
        d: args[3],
        e: args[4],
        f: args[5],
      };
    } else {
      continue;
    }

    matrix = multiplyAffine(matrix, next);
  }

  return matrix;
}

function multiplyAffine(m1, m2) {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

function applyAffine(point, matrix) {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

function centroid(points) {
  if (!Array.isArray(points) || points.length === 0) return null;

  let sx = 0;
  let sy = 0;
  let n = 0;

  for (const point of points) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    sx += point.x;
    sy += point.y;
    n++;
  }

  if (n === 0) return null;
  return { x: sx / n, y: sy / n };
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function scoreBadge(svgString, minPaths, minColors) {
  const pathCount = countPaths(svgString);
  const fills = new Set();
  let lightPathCount = 0;

  for (const pathElement of getSvgElements(svgString, "path")) {
    const fill = normalizeFill(pathElement.attrs.fill);
    if (!fill) continue;

    fills.add(fill);
    if (isLightFill(fill)) lightPathCount++;
  }

  const fillColorCount = fills.size;
  const rasterBacked = isRasterBackedSvg(svgString);

  const acceptable =
    pathCount >= minPaths && fillColorCount >= minColors && lightPathCount >= 1 && !rasterBacked;

  return {
    acceptable,
    pathCount,
    fillColorCount,
    lightPathCount,
    rasterBacked,
  };
}

/**
 * Count light-filled paths whose representative centroid lands in the lower
 * text band returned by badge detection.
 */
function countTextBandLightPaths(svgString, zones, imgWidth, imgHeight) {
  if (!zones || !zones.textBand) return -1;

  const radius = zones.radiusRatio * Math.max(imgWidth, imgHeight);
  const cx = zones.cxRatio * imgWidth;
  const cy = zones.cyRatio * imgHeight;
  const band = zones.textBand;

  let count = 0;

  for (const pathElement of getSvgElements(svgString, "path")) {
    const fill = pathElement.attrs.fill;
    if (!isLightFill(fill)) continue;

    const d = pathElement.attrs.d;
    if (!d) continue;

    const transform = parseSvgTransform(pathElement.attrs.transform);
    const points = extractRepresentativePathPoints(d).map((point) => applyAffine(point, transform));

    const c = centroid(points);
    if (!c) continue;

    const dx = c.x - cx;
    const dy = c.y - cy;

    if (dy <= radius * band.minYRatio) continue;

    const dist = Math.hypot(dx, dy);
    if (dist >= radius * band.innerR && dist <= radius * band.outerR) {
      count++;
    }
  }

  return count;
}

function scoreCandidate(candidate) {
  if (!candidate || !candidate.svg || candidate.rasterBacked) {
    return Number.NEGATIVE_INFINITY;
  }

  const pathCount = candidate.paths ?? candidate.pathCount ?? 0;
  const fillColorCount = candidate.colors ?? candidate.fillColorCount ?? 0;
  const svgBytes = candidate.bytes ?? candidate.svgBytes ?? 0;
  const textBandCreamPaths = Math.max(0, candidate.textBandCreamPaths ?? 0);

  const overFragmentationPenalty =
    Math.max(0, pathCount - CANDIDATE_SCORING.overFragmentationSoftLimit) *
    CANDIDATE_SCORING.overFragmentationPenalty;

  const acceptanceBonus =
    pathCount >= BADGE_ACCEPTANCE.minPaths &&
    fillColorCount >= BADGE_ACCEPTANCE.minColors &&
    textBandCreamPaths >= BADGE_ACCEPTANCE.minTextBandCreamPaths
      ? 250
      : 0;

  return (
    acceptanceBonus +
    pathCount * CANDIDATE_SCORING.pathWeight +
    fillColorCount * CANDIDATE_SCORING.fillColorWeight +
    textBandCreamPaths * CANDIDATE_SCORING.textBandCreamPathWeight -
    svgBytes / CANDIDATE_SCORING.bytePenaltyDivisor -
    overFragmentationPenalty
  );
}

// ---------------------------------------------------------------------------
// Tracing helpers
// ---------------------------------------------------------------------------

function normalizeTraceConfig(config) {
  return {
    ...config,
    colorPrecision: Math.min(6, Math.max(1, Math.round(Number(config.colorPrecision ?? 6)))),
    filterSpeckle: Math.max(0, Math.round(Number(config.filterSpeckle ?? 4))),
    layerDifference: Math.max(0, Math.round(Number(config.layerDifference ?? 8))),
    cornerThreshold: Math.max(0, Math.round(Number(config.cornerThreshold ?? 60))),
    lengthThreshold: Math.max(0, Number(config.lengthThreshold ?? 4)),
    maxIterations: Math.max(1, Math.round(Number(config.maxIterations ?? 10))),
    spliceThreshold: Math.max(0, Math.round(Number(config.spliceThreshold ?? 45))),
    pathPrecision: Math.max(0, Math.min(16, Math.round(Number(config.pathPrecision ?? 8)))),
  };
}

function runVTracer(imgData, config) {
  assertImageDataLike(imgData, "trace input");

  if (!config || typeof config !== "object") {
    throw new TypeError("trace config must be an object.");
  }

  const pixels = toUint8ArrayView(imgData.data);
  const svg = to_svg(pixels, imgData.width, imgData.height, normalizeTraceConfig(config));

  if (typeof svg !== "string" || svg.trim().length === 0) {
    throw new Error("vtracer returned an empty SVG string.");
  }

  return svg;
}

function summarizeSvg(svg, zones, width, height) {
  return {
    colors: countDistinctFills(svg),
    paths: countPaths(svg),
    bytes: Buffer.byteLength(svg, "utf8"),
    rasterBacked: isRasterBackedSvg(svg),
    textBandCreamPaths: countTextBandLightPaths(svg, zones, width, height),
  };
}

function traceDirect(imgData, zones) {
  const svg = runVTracer(imgData, TRACE_MODES.direct.config);
  return {
    name: TRACE_MODES.direct.name,
    svg,
    ...summarizeSvg(svg, zones, imgData.width, imgData.height),
  };
}

function traceQuantized(imgData, zones) {
  const mode = TRACE_MODES.quantizedHigh;
  const quantized = quantizeImageData(imgData, mode.paletteSize, mode.quantizeOptions);

  assertImageDataLike(quantized, "quantized image");

  const svg = runVTracer(quantized, mode.config);

  return {
    name: mode.name,
    svg,
    quantized,
    ...summarizeSvg(svg, zones, quantized.width, quantized.height),
  };
}

function traceBadgeRefined(imgData, signals) {
  const mode = TRACE_MODES.badgeRefined;
  const shouldMask = Boolean(signals?.isBadge) || Number(signals?.circularity) >= 0.72;

  const preprocessed = preprocessBadge(imgData, signals, {
    ...mode.preprocessOptions,
    mask: shouldMask,
  });

  assertImageDataLike(preprocessed, "preprocessed badge image");

  const quantized = quantizeImageData(preprocessed, mode.paletteSize, mode.quantizeOptions);
  assertImageDataLike(quantized, "badge quantized image");

  const svg = runVTracer(quantized, mode.config);
  const badgeScore = scoreBadge(svg, BADGE_ACCEPTANCE.minPaths, BADGE_ACCEPTANCE.minColors);
  const summary = summarizeSvg(svg, signals?.zones, quantized.width, quantized.height);

  return {
    name: mode.name,
    svg,
    preprocessed,
    quantized,
    score: badgeScore,
    ...summary,
  };
}

function traceBadgeCandidates(preprocessed, signals) {
  assertImageDataLike(preprocessed, "candidate preprocessed image");

  const rows = BADGE_CANDIDATES.map((candidate) => {
    const quantized = quantizeImageData(preprocessed, candidate.paletteSize, {
      preserveDarkLightAnchors: true,
      preserveGreenAccent: true,
    });

    assertImageDataLike(quantized, `candidate ${candidate.name} quantized image`);

    const config = {
      ...BASE_TRACE_CONFIG,
      filterSpeckle: candidate.filterSpeckle,
      colorPrecision: candidate.colorPrecision,
      cornerThreshold: 40,
    };

    const svg = runVTracer(quantized, config);
    const summary = summarizeSvg(svg, signals?.zones, quantized.width, quantized.height);

    const row = {
      ...candidate,
      svg,
      ...summary,
    };

    return {
      ...row,
      selectionScore: scoreCandidate(row),
    };
  });

  const selected = rows
    .filter((row) => !row.rasterBacked && row.paths > 0)
    .sort((a, b) => b.selectionScore - a.selectionScore)[0];

  return { rows, selected };
}

// ---------------------------------------------------------------------------
// Acceptance gates
// ---------------------------------------------------------------------------

function buildAcceptanceGates({ signals, direct, quantized, badge, candidates }) {
  const selected = candidates.selected;
  const badgePathCount = badge.score.pathCount;
  const badgeFillColorCount = badge.score.fillColorCount;

  return [
    {
      label: "badge detected",
      pass: Boolean(signals?.isBadge),
    },
    {
      label: `badge colors >= ${BADGE_ACCEPTANCE.minColors}`,
      pass: badgeFillColorCount >= BADGE_ACCEPTANCE.minColors,
    },
    {
      label: `badge paths >= ${BADGE_ACCEPTANCE.minPaths}`,
      pass: badgePathCount >= BADGE_ACCEPTANCE.minPaths,
    },
    {
      label: `badge colors >= ${BADGE_ACCEPTANCE.preferredMinColors}`,
      pass: badgeFillColorCount >= BADGE_ACCEPTANCE.preferredMinColors,
    },
    {
      label: "badge paths > direct",
      pass: badgePathCount > direct.paths,
    },
    {
      label: "badge keeps at least one light text path",
      pass: badge.score.lightPathCount >= 1,
    },
    {
      label: "badge protected lower text band",
      pass: Number(badge.preprocessed?.textBandPixels) > 0,
    },
    {
      label: `badge text-band cream paths >= ${BADGE_ACCEPTANCE.minTextBandCreamPaths}`,
      pass: badge.textBandCreamPaths >= BADGE_ACCEPTANCE.minTextBandCreamPaths,
    },
    {
      label: "badge text band >= plain quant",
      pass: badge.textBandCreamPaths >= quantized.textBandCreamPaths,
    },
    {
      label: "badge not fallen back",
      pass: badge.score.acceptable,
    },
    {
      label: "selected badge vector candidate exists",
      pass: Boolean(selected),
    },
    {
      label: "selected badge vector has no <image>",
      pass: Boolean(selected && !/<image\b/i.test(selected.svg)),
    },
    {
      label: "selected badge vector has no data:image",
      pass: Boolean(selected && !/\b(?:href|xlink:href)=["']data:image/i.test(selected.svg)),
    },
    {
      label: `selected badge vector path count numeric > ${BADGE_ACCEPTANCE.minSelectedCandidatePaths}`,
      pass: Boolean(selected && selected.paths > BADGE_ACCEPTANCE.minSelectedCandidatePaths),
    },
  ];
}

function hasFailedGates(gates) {
  return gates.some((gate) => !gate.pass);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatNumber(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function printHumanReport(result) {
  const { imgData, inputUniqueColors, signals, direct, quantized, badge, candidates, gates } =
    result;

  console.log("=== High-Fidelity Quantized-Trace + Badge Refinement Harness ===\n");

  console.log(`Synthetic circular badge: ${imgData.width}×${imgData.height}px`);
  console.log(`Input unique colors: ${inputUniqueColors}\n`);

  console.log("--- Badge detection ---");
  console.log(`  subtype:        ${signals?.subtype ?? "n/a"}`);
  console.log(`  isBadge:        ${Boolean(signals?.isBadge)}`);
  console.log(`  circularity:    ${formatNumber(signals?.circularity)}`);
  console.log(`  rimEdgeDensity: ${formatNumber(signals?.rimEdgeDensity)}`);
  console.log(`  rimAlternation: ${formatNumber(signals?.rimAlternation)}`);
  console.log(`  lowerArcText:   ${formatNumber(signals?.lowerArcText)}\n`);

  console.log("--- Direct trace ---");
  console.log(`  Colors: ${direct.colors}`);
  console.log(`  Paths:  ${direct.paths}`);
  console.log(`  Bytes:  ${direct.bytes}`);
  console.log(`  Raster: ${direct.rasterBacked ? "yes" : "no"}\n`);

  console.log("--- Quantized trace (no badge refinement) ---");
  console.log(`  Colors:          ${quantized.colors}`);
  console.log(`  Paths:           ${quantized.paths}`);
  console.log(`  Text-band cream: ${quantized.textBandCreamPaths}`);
  console.log(`  Bytes:           ${quantized.bytes}`);
  console.log(`  Raster:          ${quantized.rasterBacked ? "yes" : "no"}\n`);

  console.log("--- Badge-refined quantized trace ---");
  console.log(`  masked:          ${Boolean(badge.preprocessed?.masked)}`);
  console.log(`  Text-band px:    ${badge.preprocessed?.textBandPixels ?? 0}`);
  console.log(`  Colors:          ${badge.score.fillColorCount}`);
  console.log(`  Paths:           ${badge.score.pathCount}`);
  console.log(`  Light paths:     ${badge.score.lightPathCount}`);
  console.log(`  Text-band cream: ${badge.textBandCreamPaths}`);
  console.log(`  Bytes:           ${badge.bytes}`);
  console.log(`  Raster:          ${badge.rasterBacked ? "yes" : "no"}`);
  console.log(`  Fallback:        ${badge.score.acceptable ? "NOT triggered" : "TRIGGERED"}\n`);

  console.log("--- Badge vector candidates ---");
  for (const row of candidates.rows) {
    console.log(
      [
        `  ${row.name.padEnd(16)}`,
        `palette=${String(row.paletteSize).padStart(2)}`,
        `paths=${String(row.paths).padStart(4)}`,
        `fills=${String(row.colors).padStart(3)}`,
        `textCream=${String(row.textBandCreamPaths).padStart(3)}`,
        `bytes=${String(row.bytes).padStart(7)}`,
        `raster=${row.rasterBacked ? "yes" : "no"}`,
        `score=${formatNumber(row.selectionScore, 2).padStart(8)}`,
      ].join(" ")
    );
  }
  console.log(`  Selected: ${candidates.selected?.name || "none"}\n`);

  console.log("=== Comparison ===");
  console.log(
    `  Colors:          direct ${direct.colors} → quant ${quantized.colors} → badge ${badge.score.fillColorCount}`
  );
  console.log(
    `  Paths:           direct ${direct.paths} → quant ${quantized.paths} → badge ${badge.score.pathCount}`
  );
  console.log(
    `  Text-band cream: quant ${quantized.textBandCreamPaths} → badge ${badge.textBandCreamPaths}\n`
  );

  console.log("=== Acceptance gates ===");
  for (const gate of gates) {
    console.log(`  ${gate.pass ? "PASS" : "FAIL"}  ${gate.label}`);
  }
  console.log("");

  if (hasFailedGates(gates)) {
    console.error("❌ One or more badge acceptance gates failed.");
  } else {
    console.log("✅ All badge acceptance targets met.");
  }
}

function toJsonReport(result) {
  return {
    image: {
      width: result.imgData.width,
      height: result.imgData.height,
      uniqueOpaqueColors: result.inputUniqueColors,
    },
    badgeDetection: {
      subtype: result.signals?.subtype ?? null,
      isBadge: Boolean(result.signals?.isBadge),
      circularity: result.signals?.circularity ?? null,
      rimEdgeDensity: result.signals?.rimEdgeDensity ?? null,
      rimAlternation: result.signals?.rimAlternation ?? null,
      lowerArcText: result.signals?.lowerArcText ?? null,
    },
    traces: {
      direct: omitSvg(result.direct),
      quantized: omitSvg(result.quantized),
      badge: {
        ...omitSvg(result.badge),
        score: result.badge.score,
        masked: Boolean(result.badge.preprocessed?.masked),
        textBandPixels: result.badge.preprocessed?.textBandPixels ?? 0,
      },
    },
    candidates: {
      selected: result.candidates.selected ? omitSvg(result.candidates.selected) : null,
      rows: result.candidates.rows.map(omitSvg),
    },
    gates: result.gates,
    passed: !hasFailedGates(result.gates),
  };
}

function omitSvg(value) {
  const {
    svg,
    quantized,
    preprocessed,
    score,
    name,
    colors,
    paths,
    bytes,
    rasterBacked,
    textBandCreamPaths,
    selectionScore,
    paletteSize,
    filterSpeckle,
    colorPrecision,
  } = value;

  return {
    ...(name != null ? { name } : {}),
    ...(paletteSize != null ? { paletteSize } : {}),
    ...(filterSpeckle != null ? { filterSpeckle } : {}),
    ...(colorPrecision != null ? { colorPrecision } : {}),
    ...(colors != null ? { colors } : {}),
    ...(paths != null ? { paths } : {}),
    ...(bytes != null ? { bytes } : {}),
    ...(rasterBacked != null ? { rasterBacked } : {}),
    ...(textBandCreamPaths != null ? { textBandCreamPaths } : {}),
    ...(selectionScore != null ? { selectionScore } : {}),
    ...(score != null ? { score } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main test flow
// ---------------------------------------------------------------------------

async function runHarness(options) {
  await initializeVTracer(options.wasmPath);

  const imgData = generateCircularBadge(options.imageSize);
  const inputUniqueColors = uniqueOpaqueColors(imgData);

  const signals = detectBadge(imgData);
  if (!signals || typeof signals !== "object") {
    throw new Error("detectBadge() returned an invalid result.");
  }

  const direct = traceDirect(imgData, signals.zones);
  const quantized = traceQuantized(imgData, signals.zones);
  const badge = traceBadgeRefined(imgData, signals);
  const candidates = traceBadgeCandidates(badge.preprocessed, signals);

  const gates = buildAcceptanceGates({
    signals,
    direct,
    quantized,
    badge,
    candidates,
  });

  return {
    imgData,
    inputUniqueColors,
    signals,
    direct,
    quantized,
    badge,
    candidates,
    gates,
  };
}

async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const result = await runHarness(options);

    if (options.json) {
      console.log(JSON.stringify(toJsonReport(result), null, 2));
    } else {
      printHumanReport(result);
    }

    process.exitCode = hasFailedGates(result.gates) ? 1 : 0;
  } catch (error) {
    console.error("Test execution failed:");
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  }
}

await main();
