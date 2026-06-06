import initVtracer, { to_svg } from "vtracer-wasm";

let readyPromise = null;
let ready = false;

function isPixelArray(value) {
  return value instanceof Uint8Array || value instanceof Uint8ClampedArray;
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function normalizeTraceConfig(options = {}) {
  return {
    binary: Boolean(options.binary ?? false),
    hierarchical: options.hierarchical || "stacked",
    mode: options.mode || "spline",
    filterSpeckle: Math.max(0, Math.round(Number(options.filterSpeckle ?? 4))),
    colorPrecision: Math.max(1, Math.min(6, Math.round(Number(options.colorPrecision ?? 6)))),
    layerDifference: Math.max(0, Math.round(Number(options.layerDifference ?? 16))),
    cornerThreshold: Math.max(0, Math.round(Number(options.cornerThreshold ?? 60))),
    lengthThreshold: Math.max(0, Number(options.lengthThreshold ?? 4)),
    maxIterations: Math.max(1, Math.round(Number(options.maxIterations ?? 10))),
    spliceThreshold: Math.max(0, Math.round(Number(options.spliceThreshold ?? 45))),
    pathPrecision: Math.max(0, Math.min(16, Math.round(Number(options.pathPrecision ?? 8)))),
  };
}

export async function ensureVtracerReady() {
  if (ready) return true;
  if (typeof window === "undefined") return true;

  if (!readyPromise) {
    readyPromise = import("vtracer-wasm/vtracer.wasm?url")
      .then((mod) => initVtracer({ module_or_path: mod.default }))
      .then(() => {
        ready = true;
        return true;
      })
      .catch((error) => {
        readyPromise = null;
        throw error;
      });
  }

  return readyPromise;
}

export async function traceImageDataToSvg(imageData, options = {}) {
  const { data, width, height } = imageData ?? {};
  if (!isPixelArray(data) || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new TypeError("traceImageDataToSvg requires ImageData-like { data, width, height }.");
  }

  if (data.length !== width * height * 4) {
    throw new TypeError(`Invalid pixel buffer length: expected ${width * height * 4}, got ${data.length}.`);
  }

  try {
    await ensureVtracerReady();
  } catch (error) {
    // Node regression tests often initialize vtracer-wasm before calling the
    // pipeline. In that case to_svg is already usable even if the Vite URL
    // initializer is not meaningful in Node.
    if (typeof window !== "undefined") throw error;
  }

  const svg = to_svg(toUint8Array(data), width, height, normalizeTraceConfig(options));
  if (typeof svg !== "string" || !svg.trim()) {
    throw new Error("vtracer returned an empty SVG string.");
  }

  return svg;
}
