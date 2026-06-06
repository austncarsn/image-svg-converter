/**
 * Local classifier regression harness.
 *
 * Usage:
 *   node scripts/test-classifier.mjs
 *   node scripts/test-classifier.mjs --json
 */

import process from "node:process";
import { classifyImageData } from "../src/image-classifier.js";

const CHANNELS = 4;
const DEFAULT_ALPHA = 255;

const ROUTE_TYPES = Object.freeze({
  BADGE: new Set(["badge", "emblem"]),
  NON_PHOTO_GRAPHIC: new Set(["lineart", "drawing", "logo", "badge", "complex", "sticker"]),
});

const METRIC_KEYS = Object.freeze([
  "uniqueColors",
  "edgeDensity",
  "avgSaturation",
  "transparentRatio",
  "circularity",
]);

function parseCliArgs(argv) {
  const options = { json: false };

  for (const arg of argv) {
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function assertImageDataLike(imageData, label = "imageData") {
  if (!imageData || typeof imageData !== "object") {
    throw new TypeError(`${label} must be an object.`);
  }

  const { width, height, data } = imageData;

  if (!Number.isInteger(width) || width <= 0) {
    throw new TypeError(`${label}.width must be a positive integer.`);
  }

  if (!Number.isInteger(height) || height <= 0) {
    throw new TypeError(`${label}.height must be a positive integer.`);
  }

  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) {
    throw new TypeError(`${label}.data must be a Uint8Array or Uint8ClampedArray.`);
  }

  const expectedLength = width * height * CHANNELS;
  if (data.length !== expectedLength) {
    throw new TypeError(`${label}.data length must be ${expectedLength}, got ${data.length}.`);
  }
}

function clampByte(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgba(color) {
  const [r, g, b, a = DEFAULT_ALPHA] = color;
  return [clampByte(r), clampByte(g), clampByte(b), clampByte(a)];
}

function putPixel(data, width, x, y, color) {
  const idx = (y * width + x) * CHANNELS;
  const [r, g, b, a] = rgba(color);

  data[idx] = r;
  data[idx + 1] = g;
  data[idx + 2] = b;
  data[idx + 3] = a;
}

function createImage(width, height, color = [255, 255, 255, DEFAULT_ALPHA]) {
  const data = new Uint8ClampedArray(width * height * CHANNELS);

  forEachPixel(width, height, (x, y) => {
    putPixel(data, width, x, y, color);
  });

  const imageData = { data, width, height };
  assertImageDataLike(imageData, "generated image");
  return imageData;
}

function forEachPixel(width, height, callback) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      callback(x, y);
    }
  }
}

function deterministicNoise(x, y, scale = 1) {
  const value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return (value - Math.floor(value)) * scale;
}

function makeMonochromeIcon() {
  const img = createImage(96, 96, [255, 255, 255, 0]);

  forEachPixel(img.width, img.height, (x, y) => {
    const inShape = x >= 18 && x < 78 && y >= 18 && y < 78;
    if (!inShape) return;

    const isBorder = x < 28 || x > 68 || y < 28 || y > 68;
    putPixel(img.data, img.width, x, y, isBorder ? [18, 18, 18] : [245, 245, 245]);
  });

  return img;
}

function makeDesaturatedPhoto() {
  const width = 160;
  const height = 120;
  const img = createImage(width, height);

  forEachPixel(width, height, (x, y) => {
    const gradient = 36 + (x / Math.max(1, width - 1)) * 142 + (y / Math.max(1, height - 1)) * 56;
    const waveA = Math.sin((x + y) / 13) * 8;
    const waveB = Math.cos((x * 0.7 - y) / 17) * 6;
    const grain = deterministicNoise(x, y, 10) - 5;
    const base = gradient + waveA + waveB + grain;

    // Low saturation, continuous tone, many local variations.
    putPixel(img.data, width, x, y, [base + 3, base, base - 4]);
  });

  return img;
}

function makeLineArt() {
  const size = 120;
  const img = createImage(size, size, [255, 255, 255]);

  forEachPixel(size, size, (x, y) => {
    const isDiagonal = Math.abs(x - y) < 2 || Math.abs(size - 1 - x - y) < 2;
    const isFrame = x < 4 || y < 4 || x > size - 5 || y > size - 5;

    if (isDiagonal || isFrame) {
      putPixel(img.data, img.width, x, y, [10, 10, 10]);
    }
  });

  return img;
}

function makeComplexBadge(size = 180) {
  const img = createImage(size, size, [255, 255, 255]);
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.47;
  const colors = makeBadgePalette();

  forEachPixel(size, size, (x, y) => {
    const { dx, dy, dist, angleBlock } = badgePoint(size, x, y, cx, cy);
    if (dist > outerR) return;

    const tile = Math.floor(x / 5) * 17 + Math.floor(y / 5) * 29;
    const ripple = Math.abs(tile + x * 3 + y * 5) % colors.length;

    let color;
    if (dist > outerR * 0.82) {
      color = colors[angleBlock % colors.length];
    } else if (dist > outerR * 0.6) {
      color = colors[(angleBlock + ripple) % colors.length];
    } else if (dist > outerR * 0.42 && dy > 0) {
      color = angleBlock % 2 ? [245, 244, 236] : [20, 56, 38];
    } else {
      color = colors[ripple];
    }

    putPixel(img.data, size, x, y, color);
  });

  return img;
}

function makeBadgePalette() {
  const colors = Array.from({ length: 84 }, (_, i) => [
    48 + ((i * 37) % 176),
    48 + ((i * 59) % 176),
    48 + ((i * 83) % 176),
  ]);

  colors[0] = [14, 14, 14];
  colors[1] = [245, 244, 236];
  colors[2] = [20, 56, 38];

  return colors;
}

function makeLowColorCookieBadge(size = 180) {
  const img = createImage(size, size, [238, 234, 229]);
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.47;

  const colors = {
    green: [0, 91, 60],
    cream: [250, 249, 238],
    dark: [8, 48, 34],
  };

  forEachPixel(size, size, (x, y) => {
    const { dx, dy, dist, angleBlock } = badgePoint(18, x, y, cx, cy);
    if (dist > outerR) return;

    let color;
    if (dist > outerR * 0.82) {
      color = angleBlock % 2 === 0 ? colors.cream : colors.green;
    } else if (dist > outerR * 0.74) {
      color = colors.green;
    } else if (dist > outerR * 0.52 && dy > 0.05 * outerR) {
      color = lowColorBannerColor({ x, dx, dy, cx, outerR, colors });
    } else if (dist > outerR * 0.38) {
      color = colors.cream;
    } else {
      const cell = (Math.floor(x / 9) + Math.floor(y / 7)) % 4;
      color = cell === 0 ? colors.dark : cell === 1 ? colors.cream : colors.green;
    }

    putPixel(img.data, size, x, y, color);
  });

  return img;
}

function badgePoint(blockCount, x, y, cx, cy) {
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI);

  return {
    dx,
    dy,
    dist,
    angleBlock: Math.floor(angle * blockCount),
  };
}

function lowColorBannerColor({ x, dx, dy, cx, outerR, colors }) {
  const inBanner = Math.abs(dy - outerR * 0.42) < outerR * 0.12 && Math.abs(dx) < outerR * 0.72;

  if (!inBanner) return colors.green;

  const stripe = Math.floor((x - (cx - outerR * 0.7)) / 10) % 2;
  const letterRow = Math.abs(dy - outerR * 0.42) < outerR * 0.07;

  return letterRow && stripe === 0 ? colors.cream : colors.green;
}

function makeStickerSheet(size = 180) {
  const img = createImage(size, size, [252, 250, 246]);

  const bodies = [
    [244, 170, 176],
    [236, 214, 176],
    [246, 214, 72],
    [163, 111, 72],
  ];

  const centers = [
    [56, 58],
    [124, 56],
    [56, 126],
    [124, 124],
  ];

  centers.forEach(([cx, cy], i) => {
    drawSticker(img, cx, cy, bodies[i]);
  });

  return img;
}

function drawSticker(img, cx, cy, bodyColor) {
  const white = [255, 255, 255];
  const black = [16, 16, 16];

  for (let y = cy - 24; y <= cy + 24; y++) {
    for (let x = cx - 24; x <= cx + 24; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;

      const dist = Math.hypot(x - cx, y - cy);
      if (dist <= 22) putPixel(img.data, img.width, x, y, white);
      if (dist <= 17) putPixel(img.data, img.width, x, y, bodyColor);
    }
  }

  for (const eyeDx of [-5, 5]) {
    putPixel(img.data, img.width, cx + eyeDx, cy - 2, black);
    putPixel(img.data, img.width, cx + eyeDx, cy - 1, black);
  }

  for (let x = cx - 6; x <= cx + 6; x++) {
    const y = cy + 7 + Math.round(Math.abs(x - cx) * 0.2);
    putPixel(img.data, img.width, x, y, black);
  }
}

function isBadgeRoute(result) {
  return result?.type === "badge" || (result?.type === "complex" && ROUTE_TYPES.BADGE.has(result?.subtype));
}

function isStickerRoute(result) {
  return result?.type === "sticker" || (result?.type === "complex" && result?.subtype === "sticker");
}

function isNonPhotoGraphicRoute(result) {
  return ROUTE_TYPES.NON_PHOTO_GRAPHIC.has(result?.type);
}

function getMetric(result, key) {
  const value = result?.[key];
  return Number.isFinite(value) ? value : null;
}

function summarizeResult(result) {
  return {
    type: result?.type ?? null,
    subtype: result?.subtype ?? null,
    ...Object.fromEntries(METRIC_KEYS.map((key) => [key, getMetric(result, key)])),
  };
}

function routeLabel(result) {
  return `${result?.type ?? "unknown"}${result?.subtype ? `/${result.subtype}` : ""}`;
}

function formatMetric(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function createTestCases() {
  return [
    {
      name: "monochrome icon should not be photo",
      image: makeMonochromeIcon(),
      pass: (result) => result.type !== "photo",
    },
    {
      name: "desaturated continuous-tone image should be photo",
      image: makeDesaturatedPhoto(),
      pass: (result) => result.type === "photo",
    },
    {
      name: "complex badge should route to badge family",
      image: makeComplexBadge(),
      pass: isBadgeRoute,
    },
    {
      name: "low-color badge should still route to badge family",
      image: makeLowColorCookieBadge(),
      pass: isBadgeRoute,
    },
    {
      name: "line art should be graphic, not photo",
      image: makeLineArt(),
      pass: (result) => isNonPhotoGraphicRoute(result) && result.type !== "photo",
    },
    {
      name: "outlined sticker sheet should route to sticker family",
      image: makeStickerSheet(),
      pass: isStickerRoute,
    },
  ];
}

function runCase(testCase) {
  try {
    assertImageDataLike(testCase.image, testCase.name);

    const result = classifyImageData(testCase.image);
    const pass = Boolean(testCase.pass(result));

    return {
      name: testCase.name,
      pass,
      result: summarizeResult(result),
      routed: routeLabel(result),
    };
  } catch (error) {
    return {
      name: testCase.name,
      pass: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createReport(rows) {
  const failed = rows.filter((row) => !row.pass).length;

  return {
    passed: rows.length - failed,
    failed,
    total: rows.length,
    rows: rows.map(({ routed, ...row }) => row),
  };
}

function printHumanReport(rows) {
  console.log("=== Classifier Regression Harness ===\n");

  for (const row of rows) {
    console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.name}`);

    if (row.error) {
      console.log(`      ${row.error}`);
      continue;
    }

    const { result } = row;
    console.log(
      `      routed=${row.routed} ` +
      `colors=${result.uniqueColors ?? "n/a"} ` +
      `edge=${formatMetric(result.edgeDensity)} ` +
      `sat=${formatMetric(result.avgSaturation)} ` +
      `transparent=${formatMetric(result.transparentRatio)} ` +
      `circ=${formatMetric(result.circularity)}`
    );
  }

  if (rows.some((row) => !row.pass)) {
    console.error("\nOne or more classifier gates failed.");
  } else {
    console.log("\nAll classifier gates passed.");
  }
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const rows = createTestCases().map(runCase);
  const report = createReport(rows);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(rows);
  }

  process.exitCode = report.failed > 0 ? 1 : 0;
}

await main();
