const ALPHA_THRESHOLD = 20;
const BACKGROUND_DISTANCE_THRESHOLD = 28;

const EMPTY_BADGE_RESULT = Object.freeze({
  isBadge: false,
  isEmblem: false,
  subtype: null,
  circularity: 0,
  bbox: null,
  zones: null,
});

const DEFAULT_CENTERED_ZONES = Object.freeze({
  cxRatio: 0.5,
  cyRatio: 0.5,
  radiusRatio: 0.46,
  textBand: {
    minYRatio: 0.35,
    innerRatio: 0.62,
    outerRatio: 0.98,
    innerR: 0.62,
    outerR: 0.98,
  },
});

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function pixelIndex(width, x, y) {
  return (y * width + x) * 4;
}

function isOpaquePixel(data, idx) {
  return data[idx + 3] >= ALPHA_THRESHOLD;
}

function colorDistance(data, idx, color) {
  const dr = data[idx] - color[0];
  const dg = data[idx + 1] - color[1];
  const db = data[idx + 2] - color[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function isBackgroundPixel(data, idx, backgroundColor) {
  return colorDistance(data, idx, backgroundColor) < BACKGROUND_DISTANCE_THRESHOLD;
}

function isForegroundPixel(data, idx, backgroundColor) {
  return isOpaquePixel(data, idx) && !isBackgroundPixel(data, idx, backgroundColor);
}

function createFallbackResult(width, height) {
  const minSide = Math.min(width, height);
  const maxSide = Math.max(width, height);
  const radiusRatio = maxSide > 0 ? (0.46 * minSide) / maxSide : 0;

  return {
    ...EMPTY_BADGE_RESULT,
    bbox: {
      cxRatio: 0.5,
      cyRatio: 0.5,
      radiusRatioW: 0.46,
      radiusRatioH: 0.46,
    },
    zones: {
      ...DEFAULT_CENTERED_ZONES,
      radiusRatio,
    },
  };
}

function estimateBackgroundColor(data, width, height) {
  const sampleSize = Math.max(3, Math.floor(Math.min(width, height) * 0.08));
  const corners = [
    [0, 0],
    [Math.max(0, width - sampleSize), 0],
    [0, Math.max(0, height - sampleSize)],
    [Math.max(0, width - sampleSize), Math.max(0, height - sampleSize)],
  ];

  let count = 0;
  const total = [0, 0, 0];

  for (const [startX, startY] of corners) {
    const endX = Math.min(width, startX + sampleSize);
    const endY = Math.min(height, startY + sampleSize);

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const idx = pixelIndex(width, x, y);
        if (!isOpaquePixel(data, idx)) continue;

        total[0] += data[idx];
        total[1] += data[idx + 1];
        total[2] += data[idx + 2];
        count++;
      }
    }
  }

  return count > 0 ? total.map((value) => value / count) : [255, 255, 255];
}

function collectForegroundStats(data, width, height, backgroundColor) {
  const stats = {
    minX: width,
    minY: height,
    maxX: -1,
    maxY: -1,
    count: 0,
    sumX: 0,
    sumY: 0,
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = pixelIndex(width, x, y);
      if (!isForegroundPixel(data, idx, backgroundColor)) continue;

      stats.count++;
      stats.sumX += x;
      stats.sumY += y;
      stats.minX = Math.min(stats.minX, x);
      stats.minY = Math.min(stats.minY, y);
      stats.maxX = Math.max(stats.maxX, x);
      stats.maxY = Math.max(stats.maxY, y);
    }
  }

  return stats;
}

function hasUsableForeground(stats, width, height) {
  return stats.count >= width * height * 0.04 && stats.maxX >= stats.minX && stats.maxY >= stats.minY;
}

function getCenteredness(cx, cy, width, height) {
  const minSide = Math.min(width, height);
  const maxSide = Math.max(width, height);
  const normalizedOffset = Math.hypot(cx / width - 0.5, cy / height - 0.5);
  const tolerance = Math.max(0.01, (0.28 * minSide) / maxSide);

  return 1 - Math.min(1, normalizedOffset / tolerance);
}

function analyzeCircularForeground(data, width, height, backgroundColor, geometry) {
  const angleBins = new Uint16Array(36);
  let insideCircle = 0;
  let outsideCircle = 0;
  let annulusCount = 0;

  for (let y = geometry.minY; y <= geometry.maxY; y++) {
    for (let x = geometry.minX; x <= geometry.maxX; x++) {
      const idx = pixelIndex(width, x, y);
      if (!isForegroundPixel(data, idx, backgroundColor)) continue;

      const dx = x - geometry.cx;
      const dy = y - geometry.cy;
      const dist = Math.hypot(dx, dy);

      if (dist <= geometry.radius * 1.05) {
        insideCircle++;
      } else {
        outsideCircle++;
      }

      if (dist >= geometry.radius * 0.58 && dist <= geometry.radius * 1.04) {
        annulusCount++;
        const angle = (Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2);
        const bin = Math.min(angleBins.length - 1, Math.floor(angle * angleBins.length));
        angleBins[bin]++;
      }
    }
  }

  const activeThreshold = Math.max(2, annulusCount / 220);
  const activeBins = Array.from(angleBins).filter((count) => count >= activeThreshold).length;

  return {
    insideCircle,
    outsideCircle,
    annulusCount,
    angularCoverage: activeBins / angleBins.length,
  };
}

function calculateCircularity({ insideCircle, outsideCircle }, geometry) {
  const circleContainment = insideCircle / Math.max(1, insideCircle + outsideCircle);
  const fillScore = Math.min(1, geometry.foreground / Math.max(1, geometry.circleArea * 0.42));
  const areaScore = Math.min(1, geometry.circleArea / Math.max(1, geometry.bboxArea * 0.72));
  const aspectScore = Math.min(1, Math.min(geometry.aspect, 1 / geometry.aspect));
  const centerScore = Math.max(0.2, geometry.centeredness);

  return clamp01(circleContainment * fillScore * areaScore * aspectScore * centerScore);
}

function createBadgeZones(cxRatio, cyRatio, radiusRatio) {
  return {
    cxRatio,
    cyRatio,
    radiusRatio,
    textBand: {
      minYRatio: 0.32,
      innerRatio: 0.52,
      outerRatio: 0.98,
      innerR: 0.52,
      outerR: 0.98,
    },
  };
}

/**
 * Detect centered circular emblems so badge assets route through the detail
 * preserving pipeline instead of being treated as stickers or generic drawings.
 *
 * @typedef {{cxRatio:number, cyRatio:number, radiusRatio:number, textBand:object}} BadgeZones
 * @typedef {{isBadge:boolean,isEmblem:boolean,subtype:string|null,circularity:number,bbox:object|null,zones:BadgeZones|null}} BadgeSignals
 */
export function detectBadge(imageData) {
  const { data, width = 0, height = 0 } = imageData ?? {};

  if (!data || width <= 0 || height <= 0) {
    return { ...EMPTY_BADGE_RESULT };
  }

  const backgroundColor = estimateBackgroundColor(data, width, height);
  const foregroundStats = collectForegroundStats(data, width, height, backgroundColor);

  if (!hasUsableForeground(foregroundStats, width, height)) {
    return createFallbackResult(width, height);
  }

  const bboxW = foregroundStats.maxX - foregroundStats.minX + 1;
  const bboxH = foregroundStats.maxY - foregroundStats.minY + 1;
  const cx = foregroundStats.sumX / foregroundStats.count;
  const cy = foregroundStats.sumY / foregroundStats.count;
  const radius = Math.max(bboxW, bboxH) / 2;
  const radiusRatioW = radius / width;
  const radiusRatioH = radius / height;
  const aspect = bboxW / Math.max(1, bboxH);

  const geometry = {
    minX: foregroundStats.minX,
    minY: foregroundStats.minY,
    maxX: foregroundStats.maxX,
    maxY: foregroundStats.maxY,
    cx,
    cy,
    radius,
    foreground: foregroundStats.count,
    bboxArea: bboxW * bboxH,
    circleArea: Math.PI * radius * radius,
    aspect,
    centeredness: getCenteredness(cx, cy, width, height),
  };

  const circleStats = analyzeCircularForeground(data, width, height, backgroundColor, geometry);
  const circularity = calculateCircularity(circleStats, geometry);

  const largeCenteredDisc =
    radiusRatioW >= 0.32 &&
    radiusRatioH >= 0.32 &&
    aspect >= 0.78 &&
    aspect <= 1.28 &&
    geometry.centeredness >= 0.42;

  const isBadge = largeCenteredDisc && circularity >= 0.44 && circleStats.angularCoverage >= 0.66;
  const cxRatio = cx / width;
  const cyRatio = cy / height;

  return {
    isBadge,
    isEmblem: isBadge,
    subtype: isBadge ? "badge" : null,
    circularity,
    angularCoverage: circleStats.angularCoverage,
    bbox: {
      x: foregroundStats.minX,
      y: foregroundStats.minY,
      width: bboxW,
      height: bboxH,
      cxRatio,
      cyRatio,
      radiusRatioW,
      radiusRatioH,
    },
    zones: createBadgeZones(cxRatio, cyRatio, Math.min(radiusRatioW, radiusRatioH)),
  };
}

/**
 * Whether a pixel offset (dx, dy) from the badge centre falls inside the
 * annular lower text band.
 */
export function isInTextBand(dx, dy, radius, band) {
  if (!band || radius <= 0) return false;

  const dist = Math.sqrt(dx * dx + dy * dy);
  const inner = (band.innerRatio ?? 0.6) * radius;
  const outer = (band.outerRatio ?? 1.0) * radius;
  const minY = (band.minYRatio ?? 0.35) * radius;

  return dist >= inner && dist <= outer && dy > minY;
}
