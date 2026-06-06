/**
 * pipeline-preprocess.js — STUB IMPLEMENTATIONS.
 *
 * Referenced by trace-pipeline.js but not part of the audited fileset. The
 * three exports below are real, working, DOM-free reference implementations so
 * the pipeline runs standalone. They match the call signatures used by the
 * pipeline: boxBlur(imageData, radius), edgeAwareSharpen(imageData, {strength}),
 * localAdaptiveBinarize(imageData, {k}). Swap for the production versions as
 * needed — behaviour is intentionally conservative.
 */

import { cloneImageData, luma } from "./image-data.js";

/** Separable box blur. radius in pixels. */
export function boxBlur(imageData, radius = 1) {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return cloneImageData(imageData, "boxBlur");

  const src = cloneImageData(imageData, "boxBlur");
  const { width, height } = src;
  const tmp = new Uint8ClampedArray(src.data.length);
  const out = new Uint8ClampedArray(src.data.length);

  const blurPass = (input, output, horizontal) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const nx = horizontal ? x + k : x;
          const ny = horizontal ? y : y + k;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const idx = (ny * width + nx) * 4;
          sr += input[idx]; sg += input[idx + 1]; sb += input[idx + 2]; sa += input[idx + 3];
          n++;
        }
        const o = (y * width + x) * 4;
        output[o] = sr / n; output[o + 1] = sg / n; output[o + 2] = sb / n; output[o + 3] = sa / n;
      }
    }
  };

  blurPass(src.data, tmp, true);
  blurPass(tmp, out, false);
  return { data: out, width, height };
}

/** Unsharp-mask-style edge-aware sharpen. strength in 0..1. */
export function edgeAwareSharpen(imageData, options = {}) {
  const strength = Math.max(0, Math.min(1, options.strength ?? 0.3));
  const out = cloneImageData(imageData, "edgeAwareSharpen");
  if (strength === 0) return out;

  const { width, height, data } = out;
  const blurred = boxBlur(imageData, 1).data;
  const amount = strength * 1.5;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) {
      const orig = imageData.data[i + c];
      const diff = orig - blurred[i + c];
      data[i + c] = Math.max(0, Math.min(255, orig + diff * amount));
    }
  }
  return out;
}

/**
 * Sauvola-style local adaptive binarization to pure black/white.
 * k controls threshold sensitivity. Conservative window of 15px.
 */
export function localAdaptiveBinarize(imageData, options = {}) {
  const k = options.k ?? 0.15;
  const R = 128; // dynamic range of standard deviation
  const win = options.window ?? 15;
  const half = Math.floor(win / 2);

  const out = cloneImageData(imageData, "localAdaptiveBinarize");
  const { width, height, data } = out;

  // Precompute luma.
  const L = new Float64Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    L[p] = luma(data[i], data[i + 1], data[i + 2]);
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, sumSq = 0, n = 0;
      for (let wy = -half; wy <= half; wy++) {
        for (let wx = -half; wx <= half; wx++) {
          const nx = x + wx;
          const ny = y + wy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const v = L[ny * width + nx];
          sum += v; sumSq += v * v; n++;
        }
      }
      const mean = sum / n;
      const variance = Math.max(0, sumSq / n - mean * mean);
      const std = Math.sqrt(variance);
      const threshold = mean * (1 + k * (std / R - 1));

      const idx = (y * width + x) * 4;
      const value = L[y * width + x] >= threshold ? 255 : 0;
      data[idx] = value; data[idx + 1] = value; data[idx + 2] = value;
    }
  }

  return out;
}
