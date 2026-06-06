import { converter, modeOklab, modeRgb, useMode } from "culori/fn";

import {
  clampInteger,
  luma,
  validateImageData,
} from "./image-data.js";

useMode(modeRgb);
useMode(modeOklab);

const toOklab = converter("oklab");

const DEFAULT_PALETTE_SIZE = 16;
const MIN_PALETTE_SIZE = 1;
const MAX_PALETTE_SIZE = 256;

const ALPHA_THRESHOLD = 16;
const DEFAULT_ANCHOR_SNAP_SQ = 40 * 40;
const DETAIL_EDGE_THRESHOLD = 34;

const DARK_LIGHT_ANCHORS = Object.freeze([
  rgb(14, 14, 14),
  rgb(245, 244, 236),
  rgb(255, 255, 255),
  rgb(40, 80, 55),
]);

const GREEN_ANCHOR = Object.freeze([
  rgb(20, 56, 38),
]);

const CYBER_NEON_ANCHORS = Object.freeze([
  rgb(8, 14, 28),
  rgb(16, 28, 50),
  rgb(0, 224, 255),
  rgb(168, 238, 255),
  rgb(246, 129, 138),
  rgb(244, 246, 250),
]);

const CHANNEL_SORTERS = Object.freeze({
  r: (a, b) => a.r - b.r || a.g - b.g || a.b - b.b,
  g: (a, b) => a.g - b.g || a.r - b.r || a.b - b.b,
  b: (a, b) => a.b - b.b || a.r - b.r || a.g - b.g,
});

function rgb(r, g, b) {
  return { r, g, b };
}

function colorKey({ r, g, b }) {
  return `${r},${g},${b}`;
}

function rgbDistanceSq(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

function toLab({ r, g, b }) {
  const lab = toOklab({
    mode: "rgb",
    r: r / 255,
    g: g / 255,
    b: b / 255,
  });

  return {
    l: lab?.l ?? 0,
    a: lab?.a ?? 0,
    b: lab?.b ?? 0,
  };
}

function labDistanceSq(a, b) {
  const dl = a.l - b.l;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dl * dl + da * da + db * db;
}

function dedupeColors(colors) {
  const seen = new Set();
  const result = [];

  for (const color of colors) {
    const key = colorKey(color);
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(color);
  }

  return result;
}

function createImageDataCompat(data, width, height) {
  return typeof ImageData !== "undefined"
    ? new ImageData(data, width, height)
    : { data, width, height };
}

function getActiveAnchors(options = {}) {
  const anchors = [];

  if (
    options.preserveDarkLightAnchors ||
    options.preserveWhiteCreamOutlines ||
    options.preserveBlackDetails
  ) {
    anchors.push(...DARK_LIGHT_ANCHORS);
  }

  if (options.preserveGreenAccent) {
    anchors.push(...GREEN_ANCHOR);
  }

  if (options.preserveCyberNeonPalette) {
    anchors.push(...CYBER_NEON_ANCHORS);
  }

  return dedupeColors(anchors);
}

function maxNeighborLumaDelta(data, width, height, x, y, currentLuma) {
  let maxDelta = 0;

  const check = (nx, ny) => {
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;

    const idx = (ny * width + nx) * 4;
    if (data[idx + 3] < ALPHA_THRESHOLD) return;

    const delta = Math.abs(
      currentLuma - luma(data[idx], data[idx + 1], data[idx + 2])
    );

    if (delta > maxDelta) maxDelta = delta;
  };

  check(x - 1, y);
  check(x + 1, y);
  check(x, y - 1);
  check(x, y + 1);

  return maxDelta;
}

function collectSourceColors(imageData, options) {
  const { data, width, height } = imageData;
  const preserveEdgeDetailColors = Boolean(options.preserveEdgeDetailColors);
  const detailColorWeight = clampInteger(options.detailColorWeight, 1, 16, 4);

  const colorMap = new Map();

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;

    const color = rgb(data[i], data[i + 1], data[i + 2]);
    const key = (color.r << 16) | (color.g << 8) | color.b;

    let weight = 1;

    if (preserveEdgeDetailColors) {
      const pixel = i / 4;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const edgeDelta = maxNeighborLumaDelta(
        data,
        width,
        height,
        x,
        y,
        luma(color.r, color.g, color.b)
      );

      if (edgeDelta >= DETAIL_EDGE_THRESHOLD) {
        weight += detailColorWeight;
      }
    }

    const existing = colorMap.get(key);
    if (existing) {
      existing.count += weight;
    } else {
      colorMap.set(key, { ...color, count: weight });
    }
  }

  return Array.from(colorMap.values());
}

class Bucket {
  constructor(colors) {
    this.colors = colors;
    this.totalCount = colors.reduce((sum, color) => sum + color.count, 0);

    this.min = rgb(255, 255, 255);
    this.max = rgb(0, 0, 0);

    for (const color of colors) {
      this.min.r = Math.min(this.min.r, color.r);
      this.min.g = Math.min(this.min.g, color.g);
      this.min.b = Math.min(this.min.b, color.b);

      this.max.r = Math.max(this.max.r, color.r);
      this.max.g = Math.max(this.max.g, color.g);
      this.max.b = Math.max(this.max.b, color.b);
    }

    this.range = {
      r: this.max.r - this.min.r,
      g: this.max.g - this.min.g,
      b: this.max.b - this.min.b,
    };

    this.splitChannel = Object.entries(this.range).sort((a, b) => b[1] - a[1])[0][0];
    this.maxRange = this.range[this.splitChannel];
  }

  representative() {
    if (!this.totalCount) return rgb(0, 0, 0);

    let r = 0;
    let g = 0;
    let b = 0;

    for (const color of this.colors) {
      r += color.r * color.count;
      g += color.g * color.count;
      b += color.b * color.count;
    }

    return rgb(
      Math.round(r / this.totalCount),
      Math.round(g / this.totalCount),
      Math.round(b / this.totalCount)
    );
  }
}

function splitBucket(bucket) {
  if (bucket.colors.length <= 1) return [bucket];

  const colors = [...bucket.colors].sort(CHANNEL_SORTERS[bucket.splitChannel]);
  const half = bucket.totalCount / 2;

  let running = 0;
  let splitAt = Math.floor(colors.length / 2);

  for (let i = 0; i < colors.length - 1; i++) {
    running += colors[i].count;

    if (running >= half) {
      splitAt = i + 1;
      break;
    }
  }

  const left = colors.slice(0, splitAt);
  const right = colors.slice(splitAt);

  return left.length && right.length
    ? [new Bucket(left), new Bucket(right)]
    : [bucket];
}

function medianCut(colors, paletteSize) {
  if (!colors.length) return [];

  const buckets = [new Bucket(colors)];

  while (buckets.length < paletteSize) {
    let bestIndex = -1;
    let bestRange = -1;

    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];

      if (bucket.colors.length > 1 && bucket.maxRange > bestRange) {
        bestIndex = i;
        bestRange = bucket.maxRange;
      }
    }

    if (bestIndex === -1) break;

    const [bucket] = buckets.splice(bestIndex, 1);
    const split = splitBucket(bucket);

    buckets.push(...split);

    if (split.length === 1) break;
  }

  return buckets.map((bucket) => bucket.representative());
}

function buildPalette(sourceColors, paletteSize) {
  if (!sourceColors.length) return [];

  if (sourceColors.length <= paletteSize) {
    return sourceColors.map(({ r, g, b }) => rgb(r, g, b));
  }

  return medianCut(sourceColors, paletteSize);
}

function injectAnchors(palette, sourceColors, anchors, maxPaletteSize, anchorSnapSq) {
  const base = dedupeColors(palette);
  const baseKeys = new Set(base.map(colorKey));

  const eligibleAnchors = anchors.filter((anchor) => {
    if (baseKeys.has(colorKey(anchor))) return false;

    const existsInSource = sourceColors.some(
      (color) => rgbDistanceSq(color, anchor) < anchorSnapSq
    );

    const alreadyCovered = base.some(
      (color) => rgbDistanceSq(color, anchor) <= anchorSnapSq
    );

    return existsInSource && !alreadyCovered;
  });

  if (!eligibleAnchors.length) return base;

  const headroom = Math.max(0, maxPaletteSize - base.length);

  if (eligibleAnchors.length <= headroom) {
    return dedupeColors([...base, ...eligibleAnchors]);
  }

  const minBaseKept = Math.max(1, Math.ceil(base.length * 0.75));
  const anchorBudget = Math.min(
    eligibleAnchors.length,
    Math.max(0, maxPaletteSize - minBaseKept)
  );

  if (anchorBudget === 0) {
    return base.slice(0, maxPaletteSize);
  }

  return dedupeColors([
    ...eligibleAnchors.slice(0, anchorBudget),
    ...base.slice(0, maxPaletteSize - anchorBudget),
  ]).slice(0, maxPaletteSize);
}

function createColorMapper(palette, anchors, anchorSnapSq) {
  if (!palette.length) {
    return () => rgb(0, 0, 0);
  }

  const snapAnchors =
    anchorSnapSq > 0
      ? anchors.filter((anchor) =>
        palette.some((color) => rgbDistanceSq(color, anchor) <= anchorSnapSq)
      )
      : [];

  const labPalette = palette.map((color) => ({
    rgb: color,
    lab: toLab(color),
  }));

  return function mapColor(r, g, b) {
    const source = rgb(r, g, b);

    for (const anchor of snapAnchors) {
      if (rgbDistanceSq(source, anchor) <= anchorSnapSq) {
        return anchor;
      }
    }

    const sourceLab = toLab(source);
    let best = labPalette[0];
    let bestDistance = Infinity;

    for (const candidate of labPalette) {
      const distance = labDistanceSq(sourceLab, candidate.lab);

      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }

    return best.rgb;
  };
}

export function quantizeImageData(
  imageData,
  paletteSize = DEFAULT_PALETTE_SIZE,
  options = {}
) {
  validateImageData(imageData, "quantizeImageData");

  const { width, height, data } = imageData;

  const resolvedPaletteSize = clampInteger(
    paletteSize,
    MIN_PALETTE_SIZE,
    MAX_PALETTE_SIZE,
    DEFAULT_PALETTE_SIZE
  );

  const maxOutputPaletteSize = clampInteger(
    options.maxOutputPaletteSize ?? resolvedPaletteSize,
    resolvedPaletteSize,
    MAX_PALETTE_SIZE,
    resolvedPaletteSize
  );

  const anchorSnapSq =
    options.anchorSnapSq === undefined
      ? DEFAULT_ANCHOR_SNAP_SQ
      : Math.max(0, Number(options.anchorSnapSq));

  const anchors = getActiveAnchors(options);
  const sourceColors = collectSourceColors(imageData, options);

  let palette = dedupeColors(buildPalette(sourceColors, resolvedPaletteSize));

  if (anchors.length && anchorSnapSq > 0 && palette.length) {
    palette = injectAnchors(
      palette,
      sourceColors,
      anchors,
      maxOutputPaletteSize,
      anchorSnapSq
    );
  }

  const mapColor = createColorMapper(palette, anchors, anchorSnapSq);
  const output = new Uint8ClampedArray(data.length);
  const cache = new Map();

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < ALPHA_THRESHOLD) continue;

    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];

    let mapped = cache.get(key);
    if (!mapped) {
      mapped = mapColor(data[i], data[i + 1], data[i + 2]);
      cache.set(key, mapped);
    }

    output[i] = mapped.r;
    output[i + 1] = mapped.g;
    output[i + 2] = mapped.b;
    output[i + 3] = alpha;
  }

  return createImageDataCompat(output, width, height);
}