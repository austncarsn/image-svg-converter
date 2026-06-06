const ALPHA_THRESHOLD = 16;
const SAMPLE_SIZE = 16;

function validateImageData(imageData) {
  const { data, width, height } = imageData ?? {};

  const validDimensions =
    Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0;

  const validData =
    (data instanceof Uint8ClampedArray || data instanceof Uint8Array) &&
    validDimensions &&
    data.length === width * height * 4;

  if (!validDimensions || !validData) {
    throw new Error("Invalid ImageData supplied to analyzeImageBackground.");
  }
}

function getCornerSamplePositions(width, height, size) {
  const positions = new Set();

  const regions = [
    [0, 0],
    [width - size, 0],
    [0, height - size],
    [width - size, height - size],
  ];

  for (const [startX, startY] of regions) {
    for (let y = startY; y < startY + size; y++) {
      for (let x = startX; x < startX + size; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        positions.add(y * width + x);
      }
    }
  }

  return positions;
}

export function analyzeImageBackground(imageData) {
  validateImageData(imageData);

  const { data, width, height } = imageData;
  const size = Math.max(1, Math.min(SAMPLE_SIZE, width, height));
  const positions = getCornerSamplePositions(width, height, size);

  let transparent = 0;
  let opaqueCount = 0;

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  const opaqueSamples = [];

  for (const pos of positions) {
    const idx = pos * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const a = data[idx + 3];

    if (a < ALPHA_THRESHOLD) {
      transparent++;
      continue;
    }

    opaqueCount++;
    sumR += r;
    sumG += g;
    sumB += b;
    opaqueSamples.push([r, g, b]);
  }

  const total = Math.max(1, positions.size);
  const transparentRatio = transparent / total;

  if (opaqueCount === 0) {
    return {
      hasTransparentCorners: true,
      hasUniformOpaqueBackground: false,
      transparentRatio,
      variance: 0,
      color: null,
    };
  }

  const avg = {
    r: sumR / opaqueCount,
    g: sumG / opaqueCount,
    b: sumB / opaqueCount,
  };

  const variance = Math.sqrt(
    opaqueSamples.reduce((sum, [r, g, b]) => {
      const dr = r - avg.r;
      const dg = g - avg.g;
      const db = b - avg.b;
      return sum + dr * dr + dg * dg + db * db;
    }, 0) / opaqueCount
  );

  return {
    hasTransparentCorners: transparentRatio > 0.5,
    hasUniformOpaqueBackground: transparentRatio < 0.02 && variance < 24,
    transparentRatio,
    variance,
    color: {
      r: Math.round(avg.r),
      g: Math.round(avg.g),
      b: Math.round(avg.b),
    },
  };
}
