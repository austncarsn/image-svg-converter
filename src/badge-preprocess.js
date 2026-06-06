import { isInTextBand } from "./badge-detect.js";
import { cloneImageData, luma } from "./image-data.js";

const ALPHA_OPAQUE = 24;
const INK = Object.freeze([14, 14, 14]);
const CREAM = Object.freeze([245, 244, 236]);

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function setRgb(data, idx, [r, g, b]) {
  data[idx] = r;
  data[idx + 1] = g;
  data[idx + 2] = b;
}

function pixelIndex(width, x, y) {
  return (y * width + x) * 4;
}

function getBadgeGeometry(width, height, bboxOrZones) {
  const cx = bboxOrZones.cxRatio * width;
  const cy = bboxOrZones.cyRatio * height;

  const radius =
    bboxOrZones.radiusRatio != null
      ? bboxOrZones.radiusRatio * Math.max(width, height)
      : Math.max(bboxOrZones.radiusRatioW * width, bboxOrZones.radiusRatioH * height);

  return { cx, cy, radius };
}

/**
 * Keep only the circular badge disc and feather the outside edge.
 */
export function applyCircularMask(imageData, bbox, options = {}) {
  const out = cloneImageData(imageData, "applyCircularMask");
  if (!bbox) return out;

  const { width, height, data } = out;
  const { cx, cy, radius } = getBadgeGeometry(width, height, bbox);

  const radiusScale = options.radiusScale ?? 1.04;
  const feather = Math.max(0, options.feather ?? 2);
  const maskRadius = radius * radiusScale;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = pixelIndex(width, x, y);
      const dist = Math.hypot(x - cx, y - cy);

      if (dist <= maskRadius) continue;

      if (feather === 0 || dist >= maskRadius + feather) {
        data[idx + 3] = 0;
      } else {
        const alphaScale = 1 - (dist - maskRadius) / feather;
        data[idx + 3] = Math.round(data[idx + 3] * alphaScale);
      }
    }
  }

  return out;
}

/**
 * Push near-neutral opaque pixels away from mid-grey.
 * Saturated colored regions are preserved.
 */
export function boostContrast(imageData, options = {}) {
  const out = cloneImageData(imageData, "boostContrast");
  const { data } = out;

  const strength = Math.max(0, Math.min(1, options.strength ?? 0.35));
  if (strength === 0) return out;

  let lumaSum = 0;
  let opaqueCount = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < ALPHA_OPAQUE) continue;
    lumaSum += luma(data[i], data[i + 1], data[i + 2]);
    opaqueCount++;
  }

  const pivot = opaqueCount ? lumaSum / opaqueCount : 128;
  const factor = 1 + strength * 2;

  const lut = new Uint8ClampedArray(256);
  for (let value = 0; value < 256; value++) {
    lut[value] = clampByte((value - pivot) * factor + pivot);
  }

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < ALPHA_OPAQUE) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Leave colorful badge fills alone.
    if (Math.max(r, g, b) - Math.min(r, g, b) >= 18) continue;

    data[i] = lut[r];
    data[i + 1] = lut[g];
    data[i + 2] = lut[b];
  }

  return out;
}

function collectTextBandPixels(out, zones) {
  const { width, height, data } = out;
  const { cx, cy, radius } = getBadgeGeometry(width, height, zones);
  const band = zones.textBand;
  const minY = radius * (Number.isFinite(band.minYRatio) ? band.minYRatio : 0);

  const pixels = [];

  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    if (dy <= minY) continue;

    for (let x = 0; x < width; x++) {
      const idx = pixelIndex(width, x, y);
      if (data[idx + 3] < ALPHA_OPAQUE) continue;
      if (!isInTextBand(x - cx, dy, radius, band)) continue;

      pixels.push({
        idx,
        x,
        y,
        value: luma(data[idx], data[idx + 1], data[idx + 2]),
      });
    }
  }

  return pixels;
}

function adaptiveThreshold(values) {
  if (!values.length) return 128;

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => {
      const delta = value - mean;
      return sum + delta * delta;
    }, 0) / values.length;

  return mean + Math.sqrt(variance) * 0.4;
}

function cleanBandSpeckles(data, width, height, pixels, mask) {
  const neighbors = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  for (const { idx, x, y } of pixels) {
    const p = idx >> 2;
    const tone = mask[p];

    let same = 0;
    let different = 0;

    for (const [dx, dy] of neighbors) {
      const nx = x + dx;
      const ny = y + dy;

      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

      const n = ny * width + nx;
      if (data[n * 4 + 3] < ALPHA_OPAQUE) continue;

      if (mask[n] === tone) same++;
      else different++;
    }

    if (different >= 3 && same <= 1) {
      const flipped = tone ? INK : CREAM;
      setRgb(data, idx, flipped);
      mask[p] = tone ? 0 : 1;
    }
  }
}

/**
 * Convert lower badge text band to pure cream / pure ink so thin letters
 * survive tracing as clean flat shapes.
 */
export function protectTextBand(imageData, zones) {
  const out = cloneImageData(imageData, "protectTextBand");

  if (!zones?.textBand) {
    return { result: out, bandPixels: 0 };
  }

  const { width, height, data } = out;
  const pixels = collectTextBandPixels(out, zones);

  if (!pixels.length) {
    return { result: out, bandPixels: 0 };
  }

  const threshold = adaptiveThreshold(pixels.map((pixel) => pixel.value));
  const mask = new Uint8Array(width * height);

  for (const pixel of pixels) {
    const isCream = pixel.value >= threshold;
    setRgb(data, pixel.idx, isCream ? CREAM : INK);
    mask[pixel.idx >> 2] = isCream ? 1 : 0;
  }

  cleanBandSpeckles(data, width, height, pixels, mask);

  return {
    result: out,
    bandPixels: pixels.length,
  };
}

/**
 * Run badge preprocessing:
 * 1. moderate contrast boost
 * 2. optional text-band protection
 * 3. optional circular mask for strong badge detections
 */
export function preprocessBadge(imageData, signals, options = {}) {
  const {
    mask = true,
    contrastStrength = 0.35,
    textBandProtection = false,
  } = options;

  let result = boostContrast(imageData, { strength: contrastStrength });
  let textBandPixels = 0;

  if (textBandProtection && signals?.zones) {
    const protectedBand = protectTextBand(result, signals.zones);
    result = protectedBand.result;
    textBandPixels = protectedBand.bandPixels;
  }

  const shouldMask = mask && signals?.bbox && signals.circularity >= 0.72;
  if (shouldMask) {
    result = applyCircularMask(result, signals.bbox);
  }

  return {
    ...result,
    masked: Boolean(shouldMask),
    textBandPixels,
  };
}