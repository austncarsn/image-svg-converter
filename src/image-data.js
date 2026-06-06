/**
 * image-data.js — shared, DOM-free ImageData utilities.
 *
 * Centralizes the {data, width, height} contract so every stage of the pipeline
 * (quantizer, badge/sticker preprocessing) agrees on what a valid buffer is.
 * Previously each module rolled its own validator with divergent accepted types
 * (one allowed Uint8Array, another only Uint8ClampedArray), so a buffer that
 * passed quantization could throw in preprocessing. This is the single source.
 */

/** Both typed-array kinds the pipeline produces/consumes are valid. */
export function isPixelBuffer(data) {
  return data instanceof Uint8ClampedArray || data instanceof Uint8Array;
}

/**
 * Validate an ImageData-like object. Throws a contextual error on failure.
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} imageData
 * @param {string} [context] Used in the error message.
 */
export function validateImageData(imageData, context = "quantizeImageData") {
  const { data, width, height } = imageData ?? {};

  const validDimensions =
    Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0;

  const validData = isPixelBuffer(data) && validDimensions && data.length === width * height * 4;

  if (!validDimensions || !validData) {
    throw new Error(`Invalid ImageData supplied to ${context}.`);
  }
}

/**
 * Deep-clone an ImageData-like object into a fresh Uint8ClampedArray-backed
 * buffer. Input is never mutated.
 */
export function cloneImageData(imageData, context = "cloneImageData") {
  validateImageData(imageData, context);
  const data = new Uint8ClampedArray(imageData.data.length);
  data.set(imageData.data);
  return { data, width: imageData.width, height: imageData.height };
}

/** Rec. 601 luma. */
export function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** HSV-style saturation in [0,1]. */
export function saturation(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function clampInteger(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
