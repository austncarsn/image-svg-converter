import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import init, { to_svg } from "vtracer-wasm";
import { preprocessStickerIllustration } from "../src/illustration-preprocess.js";
import { quantizeImageData } from "../src/image-quantize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WASM_PATH = path.resolve(__dirname, "../node_modules/vtracer-wasm/vtracer.wasm");

const DEFAULT_SIZE = 320;

const TRACE_BASE = Object.freeze({
  binary: false,
  mode: "spline",
  hierarchical: "stacked",
  maxIterations: 10,
});

function parseCliArgs(argv) {
  const options = {
    width: DEFAULT_SIZE,
    height: DEFAULT_SIZE,
    json: false,
    wasmPath: DEFAULT_WASM_PATH,
  };

  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg.startsWith("--size=")) {
      const size = Number.parseInt(arg.slice("--size=".length), 10);
      if (!Number.isInteger(size) || size < 64 || size > 1024) {
        throw new Error("--size must be an integer between 64 and 1024.");
      }
      options.width = size;
      options.height = size;
      continue;
    }

    if (arg.startsWith("--wasm=")) {
      const wasmPath = arg.slice("--wasm=".length).trim();
      if (!wasmPath) throw new Error("--wasm requires a non-empty path.");
      options.wasmPath = path.resolve(wasmPath);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

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

function assertImageDataLike(imageData, label = "imageData") {
  if (!imageData || typeof imageData !== "object") {
    throw new TypeError(`${label} must be an object.`);
  }

  if (!Number.isInteger(imageData.width) || imageData.width <= 0) {
    throw new TypeError(`${label}.width must be a positive integer.`);
  }

  if (!Number.isInteger(imageData.height) || imageData.height <= 0) {
    throw new TypeError(`${label}.height must be a positive integer.`);
  }

  if (!(imageData.data instanceof Uint8Array || imageData.data instanceof Uint8ClampedArray)) {
    throw new TypeError(`${label}.data must be a Uint8Array or Uint8ClampedArray.`);
  }

  const expected = imageData.width * imageData.height * 4;
  if (imageData.data.length !== expected) {
    throw new TypeError(`${label}.data length must be ${expected}, got ${imageData.data.length}.`);
  }
}

function toUint8ArrayView(data) {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function put(data, width, x, y, [r, g, b, a = 255]) {
  const idx = (y * width + x) * 4;
  data[idx] = r;
  data[idx + 1] = g;
  data[idx + 2] = b;
  data[idx + 3] = a;
}

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function sat(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function inBounds(width, height, x, y) {
  return x >= 0 && y >= 0 && x < width && y < height;
}

function pixelOffset(width, x, y) {
  return (y * width + x) * 4;
}

function isOutlinePixel(data, width, height, x, y) {
  if (!inBounds(width, height, x, y)) return false;

  const idx = pixelOffset(width, x, y);
  if (data[idx + 3] < 24) return false;

  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  const here = luma(r, g, b);

  if (here < 222 || sat(r, g, b) > 0.18) return false;

  let darker = 0;

  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;

    if (!inBounds(width, height, nx, ny)) continue;

    const nIdx = pixelOffset(width, nx, ny);
    if (data[nIdx + 3] < 24) continue;

    const neighbor = luma(data[nIdx], data[nIdx + 1], data[nIdx + 2]);
    if (neighbor <= here - 32) darker++;
  }

  return darker >= 1;
}

function isDarkDetailPixel(data, width, height, x, y) {
  if (!inBounds(width, height, x, y)) return false;

  const idx = pixelOffset(width, x, y);
  if (data[idx + 3] < 24) return false;

  const here = luma(data[idx], data[idx + 1], data[idx + 2]);
  if (here > 72) return false;

  let brighter = 0;

  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;

    if (!inBounds(width, height, nx, ny)) continue;

    const nIdx = pixelOffset(width, nx, ny);
    if (data[nIdx + 3] < 24) continue;

    const neighbor = luma(data[nIdx], data[nIdx + 1], data[nIdx + 2]);
    if (neighbor >= here + 40) brighter++;
  }

  return brighter >= 1;
}

function generateStickerSheet(width = DEFAULT_SIZE, height = DEFAULT_SIZE) {
  const data = new Uint8ClampedArray(width * height * 4);

  const BG = [252, 250, 246, 255];
  const WHITE = [255, 255, 255, 255];
  const BLACK = [18, 18, 18, 255];
  const PINK = [244, 170, 176, 255];
  const TAN = [235, 214, 176, 255];
  const BROWN = [163, 111, 72, 255];
  const YELLOW = [246, 214, 72, 255];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      put(data, width, x, y, BG);
    }
  }

  const animals = [
    { cx: width * 0.3, cy: height * 0.33, body: PINK, accent: BLACK, ear: PINK },
    { cx: width * 0.7, cy: height * 0.34, body: TAN, accent: BROWN, ear: TAN },
    { cx: width * 0.33, cy: height * 0.7, body: YELLOW, accent: BLACK, ear: YELLOW },
    { cx: width * 0.72, cy: height * 0.7, body: BROWN, accent: BLACK, ear: TAN },
  ];

  const scale = Math.min(width, height) / 320;

  for (const animal of animals) {
    const cx = Math.round(animal.cx);
    const cy = Math.round(animal.cy);

    for (let y = cy - Math.round(42 * scale); y <= cy + Math.round(42 * scale); y++) {
      for (let x = cx - Math.round(40 * scale); x <= cx + Math.round(40 * scale); x++) {
        if (!inBounds(width, height, x, y)) continue;

        const dx = x - cx;
        const dy = y - cy;
        const d = Math.hypot(dx, dy);

        if (d <= 38 * scale) put(data, width, x, y, WHITE);
        if (d <= 31 * scale) put(data, width, x, y, animal.body);
      }
    }

    for (const earDxBase of [-14, 14]) {
      const earDx = Math.round(earDxBase * scale);
      for (let y = cy - Math.round(34 * scale); y <= cy - Math.round(10 * scale); y++) {
        for (
          let x = cx + earDx - Math.round(10 * scale);
          x <= cx + earDx + Math.round(10 * scale);
          x++
        ) {
          if (!inBounds(width, height, x, y)) continue;

          const dx = (x - (cx + earDx)) / (8 * scale);
          const dy = (y - (cy - 22 * scale)) / (12 * scale);

          if (dx * dx + dy * dy <= 1.15) {
            put(data, width, x, y, WHITE);
            if (dx * dx + dy * dy <= 0.72) {
              put(data, width, x, y, animal.ear);
            }
          }
        }
      }
    }

    for (const eyeDxBase of [-9, 9]) {
      const eyeDx = Math.round(eyeDxBase * scale);

      for (let y = cy - Math.round(6 * scale); y <= cy + Math.round(2 * scale); y++) {
        for (
          let x = cx + eyeDx - Math.round(3 * scale);
          x <= cx + eyeDx + Math.round(3 * scale);
          x++
        ) {
          if (!inBounds(width, height, x, y)) continue;

          const dx = x - (cx + eyeDx);
          const dy = y - (cy - 2 * scale);

          if (dx * dx + dy * dy <= 5 * scale * scale) {
            put(data, width, x, y, animal.accent);
          }
        }
      }
    }

    for (let x = cx - Math.round(10 * scale); x <= cx + Math.round(10 * scale); x++) {
      const y = cy + Math.round(10 * scale + Math.abs(x - cx) * 0.18);
      if (!inBounds(width, height, x, y)) continue;
      put(data, width, x, y, animal.accent);
    }
  }

  const imageData = { data, width, height };
  assertImageDataLike(imageData, "generated sticker sheet");
  return imageData;
}

function renderSvgToPixels(svgString, width, height) {
  if (typeof svgString !== "string" || !svgString.trim()) {
    throw new Error("Cannot render empty SVG.");
  }

  const resvg = new Resvg(svgString, {
    fitTo: {
      mode: "width",
      value: width,
    },
    background: "rgba(252,250,246,1)",
  });

  const pngData = resvg.render().asPng();
  const png = PNG.sync.read(pngData);

  if (png.width !== width || png.height !== height) {
    return resizeNearestPngPixels(
      { data: png.data, width: png.width, height: png.height },
      width,
      height
    );
  }

  return {
    data: png.data,
    width: png.width,
    height: png.height,
  };
}

function resizeNearestPngPixels(image, targetWidth, targetHeight) {
  const out = new Uint8Array(targetWidth * targetHeight * 4);

  for (let y = 0; y < targetHeight; y++) {
    const srcY = Math.min(image.height - 1, Math.floor((y / targetHeight) * image.height));

    for (let x = 0; x < targetWidth; x++) {
      const srcX = Math.min(image.width - 1, Math.floor((x / targetWidth) * image.width));

      const srcIdx = (srcY * image.width + srcX) * 4;
      const dstIdx = (y * targetWidth + x) * 4;

      out[dstIdx] = image.data[srcIdx];
      out[dstIdx + 1] = image.data[srcIdx + 1];
      out[dstIdx + 2] = image.data[srcIdx + 2];
      out[dstIdx + 3] = image.data[srcIdx + 3];
    }
  }

  return {
    data: out,
    width: targetWidth,
    height: targetHeight,
  };
}

function runVTracer(imageData, config) {
  assertImageDataLike(imageData, "trace input");

  const pixels = toUint8ArrayView(imageData.data);
  const svg = to_svg(pixels, imageData.width, imageData.height, normalizeTraceConfig(config));

  if (typeof svg !== "string" || !svg.trim()) {
    throw new Error("vtracer produced an empty SVG.");
  }

  return svg;
}

function normalizeTraceConfig(config) {
  return {
    ...config,
    colorPrecision: Math.min(6, Math.max(1, Math.round(Number(config.colorPrecision ?? 6)))),
    filterSpeckle: Math.max(0, Math.round(Number(config.filterSpeckle ?? 4))),
    layerDifference: Math.max(0, Math.round(Number(config.layerDifference ?? 8))),
    pathPrecision: Math.max(0, Math.min(16, Math.round(Number(config.pathPrecision ?? 8)))),
    cornerThreshold: Math.max(0, Math.round(Number(config.cornerThreshold ?? 60))),
    lengthThreshold: Math.max(0, Number(config.lengthThreshold ?? 4)),
    maxIterations: Math.max(1, Math.round(Number(config.maxIterations ?? 10))),
    spliceThreshold: Math.max(0, Math.round(Number(config.spliceThreshold ?? 45))),
  };
}

function traceGenericStickerBaseline(imageData) {
  const quantized = quantizeImageData(imageData, 56, {
    preserveDarkLightAnchors: true,
  });

  return runVTracer(quantized, {
    ...TRACE_BASE,
    colorPrecision: 5,
    filterSpeckle: 1,
    layerDifference: 8,
    pathPrecision: 8,
    cornerThreshold: 60,
    lengthThreshold: 4,
    spliceThreshold: 45,
  });
}

function traceStickerTuned(imageData) {
  const preprocessed = preprocessStickerIllustration(imageData, {
    contrastStrength: 0.1,
  });

  const quantized = quantizeImageData(preprocessed, 80, {
    preserveDarkLightAnchors: true,
    preserveWhiteCreamOutlines: true,
    preserveBlackDetails: true,
    maxOutputPaletteSize: 96,
  });

  return runVTracer(quantized, {
    ...TRACE_BASE,
    colorPrecision: 5,
    filterSpeckle: 0,
    layerDifference: 8,
    pathPrecision: 8,
    cornerThreshold: 55,
    lengthThreshold: 3.5,
    spliceThreshold: 40,
  });
}

function measureMaskRecall(original, rendered, matcher) {
  assertImageDataLike(original, "original");
  assertImageDataLike(rendered, "rendered");

  let target = 0;
  let hit = 0;

  for (let y = 1; y < original.height - 1; y++) {
    for (let x = 1; x < original.width - 1; x++) {
      if (!matcher(original.data, original.width, original.height, x, y)) continue;

      target++;

      let matched = false;

      for (let dy = -1; dy <= 1 && !matched; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const rx = x + dx;
          const ry = y + dy;

          if (!inBounds(rendered.width, rendered.height, rx, ry)) continue;

          if (matcher(rendered.data, rendered.width, rendered.height, rx, ry)) {
            matched = true;
            break;
          }
        }
      }

      if (matched) hit++;
    }
  }

  return {
    target,
    hit,
    ratio: target ? hit / target : 1,
  };
}

function measureEdgeRecall(original, rendered) {
  assertImageDataLike(original, "original");
  assertImageDataLike(rendered, "rendered");

  const width = Math.min(original.width, rendered.width);
  const height = Math.min(original.height, rendered.height);

  let target = 0;
  let hit = 0;

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const idx = pixelOffset(original.width, x, y);
      const rightIdx = pixelOffset(original.width, x + 1, y);
      const downIdx = pixelOffset(original.width, x, y + 1);

      const l = luma(original.data[idx], original.data[idx + 1], original.data[idx + 2]);
      const lr = luma(
        original.data[rightIdx],
        original.data[rightIdx + 1],
        original.data[rightIdx + 2]
      );
      const ld = luma(
        original.data[downIdx],
        original.data[downIdx + 1],
        original.data[downIdx + 2]
      );

      if (Math.abs(l - lr) < 32 && Math.abs(l - ld) < 32) continue;

      target++;

      const rIdx = pixelOffset(rendered.width, x, y);
      const rRightIdx = pixelOffset(rendered.width, x + 1, y);
      const rDownIdx = pixelOffset(rendered.width, x, y + 1);

      const rl = luma(rendered.data[rIdx], rendered.data[rIdx + 1], rendered.data[rIdx + 2]);
      const rlr = luma(
        rendered.data[rRightIdx],
        rendered.data[rRightIdx + 1],
        rendered.data[rRightIdx + 2]
      );
      const rld = luma(
        rendered.data[rDownIdx],
        rendered.data[rDownIdx + 1],
        rendered.data[rDownIdx + 2]
      );

      if (Math.abs(rl - rlr) >= 24 || Math.abs(rl - rld) >= 24) hit++;
    }
  }

  return {
    target,
    hit,
    ratio: target ? hit / target : 1,
  };
}

function compareRender(original, rendered) {
  assertImageDataLike(original, "original");
  assertImageDataLike(rendered, "rendered");

  if (original.width !== rendered.width || original.height !== rendered.height) {
    throw new Error(
      `Image size mismatch: original ${original.width}×${original.height}, rendered ${rendered.width}×${rendered.height}.`
    );
  }

  const diff = new PNG({
    width: original.width,
    height: original.height,
  });

  const mismatchPixels = pixelmatch(
    original.data,
    rendered.data,
    diff.data,
    original.width,
    original.height,
    {
      threshold: 0.16,
      includeAA: true,
    }
  );

  const outline = measureMaskRecall(original, rendered, isOutlinePixel);
  const darkDetail = measureMaskRecall(original, rendered, isDarkDetailPixel);
  const edge = measureEdgeRecall(original, rendered);

  return {
    mismatchRatio: mismatchPixels / (original.width * original.height),
    outlineRecall: outline.ratio,
    outlineTargetPixels: outline.target,
    darkDetailRecall: darkDetail.ratio,
    darkDetailTargetPixels: darkDetail.target,
    edgeRecall: edge.ratio,
    edgeTargetPixels: edge.target,
  };
}

function printMetrics(label, metrics) {
  console.log(`--- ${label} ---`);
  console.log(`  mismatch:       ${(metrics.mismatchRatio * 100).toFixed(2)}%`);
  console.log(
    `  outline recall: ${(metrics.outlineRecall * 100).toFixed(1)}% (${metrics.outlineTargetPixels} px target)`
  );
  console.log(
    `  dark recall:    ${(metrics.darkDetailRecall * 100).toFixed(1)}% (${metrics.darkDetailTargetPixels} px target)`
  );
  console.log(
    `  edge recall:    ${(metrics.edgeRecall * 100).toFixed(1)}% (${metrics.edgeTargetPixels} px target)`
  );
}

function buildChecks(baselineMetrics, tunedMetrics) {
  return [
    {
      label: "outline recall not worse",
      pass: tunedMetrics.outlineRecall + 0.005 >= baselineMetrics.outlineRecall,
      baseline: baselineMetrics.outlineRecall,
      tuned: tunedMetrics.outlineRecall,
    },
    {
      label: "dark-detail recall improved or preserved",
      pass:
        tunedMetrics.darkDetailRecall >= Math.min(0.96, baselineMetrics.darkDetailRecall + 0.02) ||
        tunedMetrics.darkDetailRecall + 0.005 >= baselineMetrics.darkDetailRecall,
      baseline: baselineMetrics.darkDetailRecall,
      tuned: tunedMetrics.darkDetailRecall,
    },
    {
      label: "edge recall improved or preserved",
      pass:
        tunedMetrics.edgeRecall >= Math.min(0.96, baselineMetrics.edgeRecall + 0.03) ||
        tunedMetrics.edgeRecall + 0.005 >= baselineMetrics.edgeRecall,
      baseline: baselineMetrics.edgeRecall,
      tuned: tunedMetrics.edgeRecall,
    },
    {
      label: "overall mismatch not materially worse",
      pass: tunedMetrics.mismatchRatio <= baselineMetrics.mismatchRatio + 0.015,
      baseline: baselineMetrics.mismatchRatio,
      tuned: tunedMetrics.mismatchRatio,
    },
  ];
}

function printChecks(checks) {
  console.log("\n=== Acceptance gates ===");

  let failed = 0;

  for (const check of checks) {
    console.log(
      `  ${check.pass ? "PASS" : "FAIL"}  ${check.label} ` +
        `(baseline=${formatMetric(check.baseline)}, tuned=${formatMetric(check.tuned)})`
    );

    if (!check.pass) failed++;
  }

  return failed;
}

function formatMetric(value) {
  return Number.isFinite(value) ? value.toFixed(4) : "n/a";
}

async function run(options) {
  await initializeVTracer(options.wasmPath);

  const original = generateStickerSheet(options.width, options.height);

  const baselineSvg = traceGenericStickerBaseline(original);
  const tunedSvg = traceStickerTuned(original);

  const baselineRender = renderSvgToPixels(baselineSvg, original.width, original.height);
  const tunedRender = renderSvgToPixels(tunedSvg, original.width, original.height);

  const baselineMetrics = compareRender(original, baselineRender);
  const tunedMetrics = compareRender(original, tunedRender);
  const checks = buildChecks(baselineMetrics, tunedMetrics);

  return {
    image: {
      width: original.width,
      height: original.height,
    },
    baseline: {
      svgBytes: Buffer.byteLength(baselineSvg, "utf8"),
      metrics: baselineMetrics,
    },
    tuned: {
      svgBytes: Buffer.byteLength(tunedSvg, "utf8"),
      metrics: tunedMetrics,
    },
    checks,
    passed: checks.every((check) => check.pass),
  };
}

async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const result = await run(options);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("=== Sticker Visual Regression Harness ===\n");
      console.log(`Synthetic sticker sheet: ${result.image.width}×${result.image.height}px`);
      console.log(`Baseline SVG bytes: ${result.baseline.svgBytes}`);
      console.log(`Tuned SVG bytes:    ${result.tuned.svgBytes}\n`);

      printMetrics("Generic Quantized Trace", result.baseline.metrics);
      printMetrics("Sticker Profile Trace", result.tuned.metrics);

      const failed = printChecks(result.checks);

      if (failed) {
        throw new Error(`Sticker visual regression gates failed: ${failed} check(s).`);
      }

      console.log(
        "\n✅ Sticker profile preserved or improved visual fidelity on the synthetic outlined sheet."
      );
    }

    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error("Sticker visual regression failed:");
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  }
}

await main();
