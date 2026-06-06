/**
 * Preset regression test suite for VectorStudio.
 *
 * Usage:
 *   node scripts/test-presets-regression.mjs
 *   node scripts/test-presets-regression.mjs --size=160
 *   node scripts/test-presets-regression.mjs --json
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import init from "vtracer-wasm";
import { PRESET_CONFIGS } from "../src/presets_config.js";
import { traceImageDataPipeline } from "../src/trace-pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WASM_PATH = path.resolve(__dirname, "../node_modules/vtracer-wasm/vtracer.wasm");

const DEFAULT_SIZE = 128;

function parseCliArgs(argv) {
  const options = {
    size: DEFAULT_SIZE,
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
      if (!Number.isInteger(size) || size < 32 || size > 512) {
        throw new Error("--size must be an integer between 32 and 512.");
      }
      options.size = size;
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

/**
 * Minimal Node DOM shim for this pipeline.
 *
 * Important:
 * - serializeToString() returns the current SVG string, not "".
 * - removed paths are actually omitted.
 * - enough path/fill/d parsing exists for postProcessSvg(), countSvgFills(),
 *   and getSvgPathStats().
 */
function installMinimalSvgDomShim() {
  if (
    typeof globalThis.DOMParser !== "undefined" &&
    typeof globalThis.XMLSerializer !== "undefined"
  ) {
    return;
  }

  class MinimalPathElement {
    constructor(raw) {
      this.raw = raw;
      this.removed = false;
      this.attrs = parseAttributes(raw);
    }

    getAttribute(attr) {
      return this.attrs[attr] ?? null;
    }

    setAttribute(attr, value) {
      this.attrs[attr] = String(value);
    }

    remove() {
      this.removed = true;
    }

    toString() {
      if (this.removed) return "";

      const attrs = Object.entries(this.attrs)
        .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
        .join(" ");

      return `<path${attrs ? ` ${attrs}` : ""}/>`;
    }
  }

  class MinimalSvgDocument {
    constructor(svgString) {
      this.original = String(svgString || "");
      this.paths = [];
      this.hasParserError = false;

      const pathRegex = /<path\b[^>]*\/?>/gi;
      let match;

      while ((match = pathRegex.exec(this.original)) !== null) {
        this.paths.push(new MinimalPathElement(match[0]));
      }
    }

    querySelector(selector) {
      if (selector === "parsererror") return this.hasParserError ? {} : null;
      if (selector === "path") return this.paths.find((path) => !path.removed) ?? null;
      return null;
    }

    querySelectorAll(selector) {
      if (selector === "path") return this.paths.filter((path) => !path.removed);
      return [];
    }

    serialize() {
      let i = 0;
      return this.original.replace(/<path\b[^>]*\/?>/gi, () => {
        const pathElement = this.paths[i++];
        return pathElement ? pathElement.toString() : "";
      });
    }
  }

  globalThis.DOMParser = class {
    parseFromString(svgString) {
      return new MinimalSvgDocument(svgString);
    }
  };

  globalThis.XMLSerializer = class {
    serializeToString(doc) {
      if (doc && typeof doc.serialize === "function") return doc.serialize();
      return "";
    }
  };
}

function parseAttributes(rawTag) {
  const attrs = {};
  const attrRegex = /([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

  let match;
  while ((match = attrRegex.exec(rawTag)) !== null) {
    const [, key, doubleQuoted, singleQuoted, unquoted] = match;
    attrs[key] = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
  }

  return attrs;
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function writeRgb(pixels, idx, r, g, b, a = 255) {
  pixels[idx] = r;
  pixels[idx + 1] = g;
  pixels[idx + 2] = b;
  pixels[idx + 3] = a;
}

function createFlatLogo(size = DEFAULT_SIZE) {
  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      const inside = x > size * 0.25 && x < size * 0.75 && y > size * 0.25 && y < size * 0.75;

      if (inside) writeRgb(pixels, idx, 0, 0, 255);
      else writeRgb(pixels, idx, 255, 255, 255);
    }
  }

  return { data: pixels, width: size, height: size };
}

function createCircularBadge(size = DEFAULT_SIZE) {
  const pixels = new Uint8Array(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const outerR = (size / 2) * 0.9;
  const innerR = outerR * 0.58;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const band = Math.floor(((angle + Math.PI) / (Math.PI * 2)) * 24);

      if (dist > outerR) {
        writeRgb(pixels, idx, 255, 255, 255);
      } else if (dist > outerR * 0.82) {
        if (band % 2 === 0) writeRgb(pixels, idx, 245, 244, 236);
        else writeRgb(pixels, idx, 14, 14, 14);
      } else if (dist > outerR * 0.74) {
        writeRgb(pixels, idx, 14, 14, 14);
      } else if (dist > innerR && dy > 0) {
        if (band % 2 === 0) writeRgb(pixels, idx, 245, 244, 236);
        else writeRgb(pixels, idx, 20, 56, 38);
      } else {
        writeRgb(pixels, idx, 20, 56, 38);
      }
    }
  }

  return { data: pixels, width: size, height: size };
}

function createPhotoLike(size = DEFAULT_SIZE) {
  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      writeRgb(
        pixels,
        idx,
        Math.round((x / Math.max(1, size - 1)) * 255),
        Math.round((y / Math.max(1, size - 1)) * 255),
        Math.round(((x + y) / Math.max(1, 2 * (size - 1))) * 255)
      );
    }
  }

  return { data: pixels, width: size, height: size };
}

function createPencilDrawing(size = DEFAULT_SIZE) {
  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      const isLine =
        Math.abs(y - x) < 3 ||
        Math.abs(y - (size - x)) < 3 ||
        Math.abs(Math.sin(x * 0.15) * size * 0.12 + size * 0.5 - y) < 2;

      const noise = deterministicNoise(x, y) * 40;

      if (isLine) {
        const value = Math.round(50 + noise);
        writeRgb(pixels, idx, value, value, value);
      } else {
        const value = Math.round(226 + noise * 0.35);
        writeRgb(pixels, idx, value, value, value);
      }
    }
  }

  return { data: pixels, width: size, height: size };
}

function createLineArt(size = DEFAULT_SIZE) {
  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const isLine = Math.abs(y - size / 2) < 2 || Math.abs(x - size / 2) < 2;

      if (isLine) writeRgb(pixels, idx, 0, 0, 0);
      else writeRgb(pixels, idx, 255, 255, 255);
    }
  }

  return { data: pixels, width: size, height: size };
}

function createStickerSheet(size = DEFAULT_SIZE) {
  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      const leftDist = Math.hypot(x - size * 0.3, y - size * 0.5);
      const rightDist = Math.hypot(x - size * 0.7, y - size * 0.5);

      const insideLeft = leftDist < size * 0.15;
      const insideRight = rightDist < size * 0.15;
      const haloLeft = leftDist < size * 0.2;
      const haloRight = rightDist < size * 0.2;

      if (insideLeft || insideRight) {
        writeRgb(pixels, idx, 255, 0, 0);
      } else if (haloLeft || haloRight) {
        writeRgb(pixels, idx, 245, 244, 236);
      } else {
        writeRgb(pixels, idx, 255, 255, 255);
      }
    }
  }

  return { data: pixels, width: size, height: size };
}

function deterministicNoise(x, y) {
  const value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function normalizeTestResult(result) {
  return {
    strategy: result.strategy,
    engine: result.engine,
    presetId: result.preset?.id,
    exportLabel: result.preset?.exportLabel,
    paletteSize: result.paletteSize,
    pathCount: result.pathCount,
    pathCommandCount: result.pathCommandCount,
    fillColorCount: result.fillColorCount,
    isBadge: result.isBadge,
    textWarning: result.textWarning,
    modeName: result.modeName,
    svgBytes: Buffer.byteLength(result.svgString || "", "utf8"),
  };
}

function makeTestCases(size) {
  return [
    {
      presetId: "logo",
      imageGen: () => createFlatLogo(size),
      expectedStrategy: "path-trace",
      validate(result) {
        if (result.paletteSize > 32) {
          throw new Error(`Logo colors not simplified enough: ${result.paletteSize}`);
        }

        if (result.pathCount <= 0) {
          throw new Error("Logo should produce at least one path.");
        }
      },
    },
    {
      presetId: "badge",
      imageGen: () => createCircularBadge(size),
      expectedStrategy: "quantized-path-trace",
      validate(result) {
        if (result.isBadge !== true) {
          throw new Error("Badge preset did not mark result as badge.");
        }

        if (result.pathCount <= 0) {
          throw new Error("Badge should produce vector paths.");
        }
      },
    },
    {
      presetId: "photo",
      imageGen: () => createPhotoLike(size),
      expectedStrategy: "image-wrapper",
      validate(result) {
        if (result.svgString !== "") {
          throw new Error("Photo strategy should bypass path tracing.");
        }

        if (result.engine !== "image-wrapper") {
          throw new Error(`Photo engine should be image-wrapper, got ${result.engine}.`);
        }
      },
    },
    {
      presetId: "drawing",
      imageGen: () => createPencilDrawing(size),
      expectedStrategy: "path-trace",
      validate(result) {
        if (result.preset.preprocessing.colorMode !== "organic") {
          throw new Error("Drawing preset should use organic color mode.");
        }

        if (result.pathCount <= 0) {
          throw new Error("Drawing should produce vector paths.");
        }
      },
    },
    {
      presetId: "lineart",
      imageGen: () => createLineArt(size),
      expectedStrategy: "path-trace",
      validate(result) {
        if (result.paletteSize !== 2) {
          throw new Error(
            `LineArt must force monochrome palette size 2, got ${result.paletteSize}.`
          );
        }

        if (result.pathCount <= 0) {
          throw new Error("LineArt should produce vector paths.");
        }
      },
    },
    {
      presetId: "complex",
      imageGen: () => createPhotoLike(size),
      expectedStrategy: "quantized-path-trace",
      validate(result) {
        if (result.preset.defaultControls.colors < 32) {
          throw new Error("Illustration preset should retain a high default color count.");
        }

        if (result.paletteSize < 32) {
          throw new Error(`Complex preset palette unexpectedly low: ${result.paletteSize}.`);
        }
      },
    },
    {
      presetId: "sticker",
      imageGen: () => createStickerSheet(size),
      expectedStrategy: "quantized-path-trace",
      validate(result) {
        if (result.preset.id !== "sticker") {
          throw new Error(`Incorrect sticker preset mapping: ${result.preset.id}`);
        }

        if (result.pathCount <= 0) {
          throw new Error("Sticker should produce vector paths.");
        }
      },
    },
  ];
}

async function runTests(options) {
  const rows = [];
  let passCount = 0;
  let failCount = 0;

  const testCases = makeTestCases(options.size);

  if (!options.json) {
    console.log("=== Running VectorStudio Presets Regression Tests ===\n");
  }

  for (const tc of testCases) {
    const config = PRESET_CONFIGS[tc.presetId];

    if (!config) {
      rows.push({
        presetId: tc.presetId,
        pass: false,
        error: "Preset config not found.",
      });
      failCount++;
      continue;
    }

    if (!options.json) {
      console.log(`Testing Preset: [${config.label}] (${tc.presetId})`);
    }

    try {
      const imageData = tc.imageGen();

      const result = await traceImageDataPipeline(imageData, {
        presetId: tc.presetId,
        profile: { type: tc.presetId },
        allowImageTracerFallback: false,
      });

      if (result.strategy !== tc.expectedStrategy) {
        throw new Error(
          `Strategy mismatch. Expected ${tc.expectedStrategy}, got ${result.strategy}.`
        );
      }

      if (config.exportLabel !== result.preset.exportLabel) {
        throw new Error(
          `Export label mismatch. Expected "${config.exportLabel}", got "${result.preset.exportLabel}".`
        );
      }

      tc.validate(result);

      const normalized = normalizeTestResult(result);

      rows.push({
        presetId: tc.presetId,
        label: config.label,
        pass: true,
        ...normalized,
      });

      passCount++;

      if (!options.json) {
        console.log(
          `  -> PASS: strategy=${result.strategy}, engine=${result.engine}, paths=${result.pathCount}, palette=${result.paletteSize}`
        );
      }
    } catch (error) {
      rows.push({
        presetId: tc.presetId,
        label: config.label,
        pass: false,
        error: error instanceof Error ? error.message : String(error),
      });

      failCount++;

      if (!options.json) {
        console.error(`  -> FAIL: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const summary = {
    passed: passCount,
    failed: failCount,
    total: passCount + failCount,
    rows,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("\n=== Test Results ===");
    console.log(`Passed: ${passCount}`);
    console.log(`Failed: ${failCount}`);

    if (failCount === 0) {
      console.log("\n✅ All preset regression tests passed successfully!");
    }
  }

  return summary;
}

async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));

    installMinimalSvgDomShim();
    await initializeVTracer(options.wasmPath);

    const summary = await runTests(options);
    process.exitCode = summary.failed > 0 ? 1 : 0;
  } catch (error) {
    console.error("Preset regression test execution failed:");
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  }
}

await main();
