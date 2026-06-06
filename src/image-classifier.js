import { detectBadge } from "./badge-detect.js";
import { detectStickerIllustration } from "./illustration-preprocess.js";

export function classifyImageData(imageData) {
  const { data, width, height } = imageData;
  const colors = new Set();
  let transparentPixels = 0;
  let edgeHits = 0;
  let sampledPixels = 0;
  let totalSaturation = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const a = data[idx + 3];
      if (a < 20) {
        transparentPixels++;
        continue;
      }

      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);

      colors.add(`${r >> 4}-${g >> 4}-${b >> 4}`);
      totalSaturation += max === 0 ? 0 : (max - min) / max;
      sampledPixels++;

      if (x > 0 && y > 0) {
        const leftIdx = idx - 4;
        const topIdx = idx - width * 4;
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        const leftLuma =
          0.299 * data[leftIdx] + 0.587 * data[leftIdx + 1] + 0.114 * data[leftIdx + 2];
        const topLuma =
          0.299 * data[topIdx] + 0.587 * data[topIdx + 1] + 0.114 * data[topIdx + 2];
        if (Math.abs(luma - leftLuma) > 38 || Math.abs(luma - topLuma) > 38) edgeHits++;
      }
    }
  }

  const totalPixels = width * height;
  const uniqueColors = colors.size;
  const transparentRatio = transparentPixels / totalPixels;
  const edgeDensity = sampledPixels ? edgeHits / sampledPixels : 0;
  const avgSaturation = sampledPixels ? totalSaturation / sampledPixels : 0;
  const badgeSignals = detectBadge(imageData);
  const stickerSignals = detectStickerIllustration(imageData);
  const isMonochromeLinework = uniqueColors <= 2 && avgSaturation < 0.04;

  if ((badgeSignals.isBadge || badgeSignals.isEmblem) && !isMonochromeLinework) {
    return {
      type: "complex",
      subtype: badgeSignals.subtype,
      badgeSignals,
      uniqueColors,
      edgeDensity,
      avgSaturation,
      transparentRatio,
      circularity: badgeSignals.circularity,
    };
  }

  // Require meaningful saturation to avoid mistaking dense B&W typography
  // (whose letter edges look like sticker outlines) for a sticker sheet.
  if (stickerSignals.isSticker && uniqueColors > 4 && avgSaturation > 0.05) {
    return {
      type: "sticker",
      subtype: null,
      badgeSignals: null,
      uniqueColors,
      edgeDensity,
      avgSaturation,
      transparentRatio,
    };
  }

  let type = "drawing";
  // Near-monochrome JPEG content (e.g. dense B&W typography) has many apparent
  // colors from compression artifacts but near-zero saturation. Treat it as
  // lineart so the monochrome pipeline is used instead of gray-band quantization.
  if ((uniqueColors <= 10 || (avgSaturation < 0.065 && edgeDensity > 0.18)) && edgeDensity > 0.1)
    type = "lineart";
  else if (uniqueColors <= 34 && (transparentRatio > 0.08 || edgeDensity > 0.16)) type = "logo";
  else if (
    (uniqueColors > 70 || (avgSaturation < 0.18 && uniqueColors >= 40)) &&
    edgeDensity < 0.13
  ) {
    type = "photo";
  }

  if (type !== "photo" && uniqueColors > 60 && edgeDensity > 0.1) type = "complex";
  if (type === "drawing" && uniqueColors > 120) type = "complex";

  return {
    type,
    subtype: null,
    badgeSignals: null,
    uniqueColors,
    edgeDensity,
    avgSaturation,
    transparentRatio,
    circularity: badgeSignals.circularity,
  };
}
