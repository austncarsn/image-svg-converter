/**
 * illustration-preprocess.js — sticker-illustration detection and halo/detail
 * preprocessing applied before quantization + tracing.
 *
 * DOM-free: operates on { data, width, height } so it runs in the browser and
 * in the Node test harness. Input buffers are never mutated.
 */

import { boostContrast } from "./badge-preprocess.js";
import { cloneImageData, luma, saturation, validateImageData } from "./image-data.js";

const ALPHA_THRESHOLD = 24;

const BLACK = Object.freeze([14, 14, 14]);
const CREAM = Object.freeze([245, 244, 236]);
const PAPER = Object.freeze([248, 246, 240]);
const WHITE = Object.freeze([255, 255, 255]);

const CARDINAL_NEIGHBORS = Object.freeze([
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
]);

const EIGHT_NEIGHBORS = Object.freeze([
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
]);

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isBrightOutlinePixel(r, g, b) {
  return luma(r, g, b) >= 222 && saturation(r, g, b) <= 0.18;
}

function isDarkDetailPixel(r, g, b) {
  return luma(r, g, b) <= 72;
}

function setRgb(data, idx, color) {
  data[idx] = color[0];
  data[idx + 1] = color[1];
  data[idx + 2] = color[2];
}

function getNeighborLumaStats(data, width, x, y, pixelLuma) {
  let darkerNeighbors = 0;
  let brighterNeighbors = 0;

  for (const [dx, dy] of CARDINAL_NEIGHBORS) {
    const nIdx = ((y + dy) * width + (x + dx)) * 4;
    if (data[nIdx + 3] < ALPHA_THRESHOLD) continue;

    const nl = luma(data[nIdx], data[nIdx + 1], data[nIdx + 2]);
    if (nl <= pixelLuma - 32) darkerNeighbors++;
    if (nl >= pixelLuma + 40) brighterNeighbors++;
  }

  return { darkerNeighbors, brighterNeighbors };
}

export function detectStickerIllustration(imageData) {
  validateImageData(imageData, "detectStickerIllustration");

  const { data, width, height } = imageData;

  if (width < 3 || height < 3) {
    return {
      isSticker: false,
      brightBoundaryRatio: 0,
      darkDetailRatio: 0,
      brightBoundaryPixels: 0,
      darkDetailPixels: 0,
    };
  }

  let opaquePixels = 0;
  let brightBoundaryPixels = 0;
  let darkDetailPixels = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      if (data[idx + 3] < ALPHA_THRESHOLD) continue;

      opaquePixels++;

      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const pixelLuma = luma(r, g, b);

      const { darkerNeighbors, brighterNeighbors } = getNeighborLumaStats(
        data,
        width,
        x,
        y,
        pixelLuma
      );

      if (isBrightOutlinePixel(r, g, b) && darkerNeighbors >= 1) brightBoundaryPixels++;
      if (isDarkDetailPixel(r, g, b) && brighterNeighbors >= 2) darkDetailPixels++;
    }
  }

  const safeOpaque = Math.max(1, opaquePixels);
  const brightBoundaryRatio = brightBoundaryPixels / safeOpaque;
  const darkDetailRatio = darkDetailPixels / safeOpaque;

  const isSticker =
    brightBoundaryRatio >= 0.0045 &&
    darkDetailRatio >= 0.002 &&
    brightBoundaryPixels >= 120 &&
    darkDetailPixels >= 8;

  return {
    isSticker,
    brightBoundaryRatio,
    darkDetailRatio,
    brightBoundaryPixels,
    darkDetailPixels,
  };
}

export function preprocessStickerIllustration(imageData, options = {}) {
  validateImageData(imageData, "preprocessStickerIllustration");

  const contrastStrength = clampNumber(options.contrastStrength, 0, 1, 0.1);
  const contrasted = boostContrast(imageData, { strength: contrastStrength });

  const out = cloneImageData(contrasted, "preprocessStickerIllustration");
  const { data, width, height } = out;

  const outlineMask = new Uint8Array(width * height);

  let outlinePixels = 0;
  let darkDetailPixels = 0;

  if (width < 3 || height < 3) {
    return { ...out, outlinePixels, darkDetailPixels };
  }

  // First pass: lock detected sticker halo pixels and dark line details.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      if (data[idx + 3] < ALPHA_THRESHOLD) continue;

      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const pixelLuma = luma(r, g, b);

      const { darkerNeighbors, brighterNeighbors } = getNeighborLumaStats(
        data,
        width,
        x,
        y,
        pixelLuma
      );

      if (isBrightOutlinePixel(r, g, b) && darkerNeighbors >= 2) {
        const tone = pixelLuma >= 244 ? WHITE : CREAM;
        setRgb(data, idx, tone);
        outlineMask[y * width + x] = 1;
        outlinePixels++;
        continue;
      }

      if (isDarkDetailPixel(r, g, b) && brighterNeighbors >= 2) {
        setRgb(data, idx, BLACK);
        darkDetailPixels++;
      }
    }
  }

  // Second pass: thicken white/cream sticker halos by one pixel into adjacent
  // bright tones. Newly thickened pixels are marked so the paper/background
  // pass cannot demote them later.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const maskPos = y * width + x;
      const idx = maskPos * 4;

      if (data[idx + 3] < ALPHA_THRESHOLD) continue;
      if (outlineMask[maskPos]) continue;

      let nearOutline = false;
      for (const [dx, dy] of EIGHT_NEIGHBORS) {
        if (outlineMask[(y + dy) * width + (x + dx)]) {
          nearOutline = true;
          break;
        }
      }
      if (!nearOutline) continue;

      const pixelLuma = luma(data[idx], data[idx + 1], data[idx + 2]);
      const pixelSat = saturation(data[idx], data[idx + 1], data[idx + 2]);
      if (pixelLuma < 150 || pixelSat > 0.3) continue;

      const tone = pixelLuma >= 238 ? WHITE : CREAM;
      setRgb(data, idx, tone);
      outlineMask[maskPos] = 1;
      outlinePixels++;
    }
  }

  // Third pass: push broad flat paper/background slightly below pure white so
  // sticker halos remain the brightest light region during quantization.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const maskPos = y * width + x;
      const idx = maskPos * 4;

      if (data[idx + 3] < ALPHA_THRESHOLD) continue;
      if (outlineMask[maskPos]) continue;

      const pixelLuma = luma(data[idx], data[idx + 1], data[idx + 2]);
      const pixelSat = saturation(data[idx], data[idx + 1], data[idx + 2]);
      if (pixelLuma < 238 || pixelSat > 0.08) continue;

      let nearOutline = false;
      let darkerNeighbors = 0;

      for (const [dx, dy] of EIGHT_NEIGHBORS) {
        if (outlineMask[(y + dy) * width + (x + dx)]) {
          nearOutline = true;
          break;
        }

        const nIdx = ((y + dy) * width + (x + dx)) * 4;
        if (data[nIdx + 3] < ALPHA_THRESHOLD) continue;

        const nl = luma(data[nIdx], data[nIdx + 1], data[nIdx + 2]);
        if (nl <= pixelLuma - 28) darkerNeighbors++;
      }

      if (nearOutline || darkerNeighbors > 0) continue;

      setRgb(data, idx, PAPER);
    }
  }

  return { ...out, outlinePixels, darkDetailPixels };
}
