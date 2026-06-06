const DEFAULT_IMAGE_PREP_CONFIG = Object.freeze({
  workingImageMaxDim: 1600,
  backgroundSampleSize: 16,
  backgroundThreshold: 64,
  maxFileSize: 8 * 1024 * 1024,
});

const SUPPORTED_SIGNATURES = Object.freeze({
  png: "89 50 4E 47",
  jpg: "FF D8 FF",
  bmp: "42 4D",
  tiffLE: "49 49 2A 00",
  tiffBE: "4D 4D 00 2A",
});

function withDefaults(config = {}) {
  return { ...DEFAULT_IMAGE_PREP_CONFIG, ...config };
}

function assertBrowserImageApis() {
  if (
    typeof document === "undefined" ||
    typeof Image === "undefined" ||
    typeof FileReader === "undefined" ||
    typeof URL === "undefined"
  ) {
    throw new Error("Image preparation requires browser image APIs.");
  }
}

function getCanvasContext(canvas, type = "2d", options) {
  const ctx = canvas.getContext(type, options);
  if (!ctx) throw new Error("Unable to create canvas rendering context.");
  return ctx;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown size";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 10 ? 0 : 1)}MB`;
}

function isPositiveDimension(value) {
  return Number.isFinite(value) && value > 0;
}

function isTiffFile(file) {
  const lowerName = file?.name?.toLowerCase?.() || "";
  return file?.type === "image/tiff" || lowerName.endsWith(".tif") || lowerName.endsWith(".tiff");
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}

function readFileHeader(file, byteCount = 4) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      const result = event.target?.result;

      if (!(result instanceof ArrayBuffer)) {
        reject(new Error("Unable to read file header."));
        return;
      }

      resolve(new Uint8Array(result));
    };

    reader.onerror = () => reject(new Error("Unable to read file header."));
    reader.readAsArrayBuffer(file.slice(0, byteCount));
  });
}

export function getContainedSize(width, height, maxDim) {
  if (!isPositiveDimension(width) || !isPositiveDimension(height)) {
    throw new Error(`Invalid image dimensions: ${width}×${height}.`);
  }

  if (!Number.isFinite(maxDim) || maxDim < 1) {
    throw new Error(`Invalid maximum image dimension: ${maxDim}.`);
  }

  if (width <= maxDim && height <= maxDim) {
    return {
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  const scale = maxDim / Math.max(width, height);

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function cleanupCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

export function cleanupImage(img) {
  if (!img) return;

  img.onload = null;
  img.onerror = null;

  if (typeof img.src === "string" && img.src.startsWith("blob:")) {
    URL.revokeObjectURL(img.src);
  }

  img.removeAttribute?.("src");
  img.src = "";
}

export function loadImage(src) {
  assertBrowserImageApis();

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";

    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;

      if (!isPositiveDimension(width) || !isPositiveDimension(height)) {
        cleanupImage(img);
        reject(new Error("Decoded image has invalid dimensions."));
        return;
      }

      resolve(img);
    };

    img.onerror = () => {
      cleanupImage(img);
      reject(new Error("Unable to decode the selected image."));
    };

    img.src = src;
  });
}

export async function readFileIfTiff(file) {
  if (!file || !isTiffFile(file)) return null;

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Unable to read "${file.name}".`));

    reader.readAsArrayBuffer(file);
  });
}

export async function validateImageFile(file, config = {}) {
  assertBrowserImageApis();

  const resolved = withDefaults(config);

  if (!file) throw new Error("No file selected.");
  if (file.size === 0) throw new Error(`File "${file.name}" is empty.`);

  if (file.size > resolved.maxFileSize) {
    throw new Error(
      `File "${file.name}" exceeds the ${formatBytes(resolved.maxFileSize)} browser-safe limit.`
    );
  }

  const header = await readFileHeader(file, 4);
  const hex = bytesToHex(header);
  const lowerName = file.name.toLowerCase();

  const isPNG = hex.startsWith(SUPPORTED_SIGNATURES.png);
  const isJPG = hex.startsWith(SUPPORTED_SIGNATURES.jpg);
  const isBMP = hex.startsWith(SUPPORTED_SIGNATURES.bmp);
  const isTIFF =
    hex.startsWith(SUPPORTED_SIGNATURES.tiffLE) ||
    hex.startsWith(SUPPORTED_SIGNATURES.tiffBE) ||
    lowerName.endsWith(".tiff") ||
    lowerName.endsWith(".tif");

  if (!isPNG && !isJPG && !isBMP && !isTIFF) {
    throw new Error(`File "${file.name}" is not a supported format or is corrupt.`);
  }

  return {
    type: isPNG ? "png" : isJPG ? "jpg" : isBMP ? "bmp" : "tiff",
    size: file.size,
  };
}

export function getTracingImageData(img, maxDim, fillWhite = false) {
  assertBrowserImageApis();

  const sourceWidth = img.naturalWidth || img.width;
  const sourceHeight = img.naturalHeight || img.height;
  const target = getContainedSize(sourceWidth, sourceHeight, maxDim);

  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;

  try {
    const ctx = getCanvasContext(canvas, "2d", { willReadFrequently: true });

    if (fillWhite) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, target.width, target.height);
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, target.width, target.height);

    return ctx.getImageData(0, 0, target.width, target.height);
  } finally {
    cleanupCanvas(canvas);
  }
}

function colorDistanceSq(data, idx, color) {
  const dr = data[idx] - color.r;
  const dg = data[idx + 1] - color.g;
  const db = data[idx + 2] - color.b;
  return dr * dr + dg * dg + db * db;
}

function estimateBackgroundColor(data, width, height, config) {
  const sampleSize = Math.max(1, Math.min(config.backgroundSampleSize, width, height));
  const corners = [
    [0, 0],
    [width - sampleSize, 0],
    [0, height - sampleSize],
    [width - sampleSize, height - sampleSize],
  ];

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const samples = [];

  for (const [startX, startY] of corners) {
    for (let y = startY; y < startY + sampleSize; y++) {
      for (let x = startX; x < startX + sampleSize; x++) {
        const idx = (y * width + x) * 4;
        const sample = [data[idx], data[idx + 1], data[idx + 2]];

        samples.push(sample);
        r += sample[0];
        g += sample[1];
        b += sample[2];
        count++;
      }
    }
  }

  if (!count) {
    return { r: 255, g: 255, b: 255, variance: 0 };
  }

  const avg = {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
  };

  const variance = Math.sqrt(
    samples.reduce((sum, [sr, sg, sb]) => {
      const dr = sr - avg.r;
      const dg = sg - avg.g;
      const db = sb - avg.b;
      return sum + dr * dr + dg * dg + db * db;
    }, 0) / samples.length
  );

  return { ...avg, variance };
}

function floodFillConnectedBackground(data, width, height, background, thresholdSq) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;

    const pos = y * width + x;
    if (visited[pos]) return;

    const idx = pos * 4;
    const isTransparent = data[idx + 3] < 8;
    const isBackground = colorDistanceSq(data, idx, background) <= thresholdSq;

    if (!isTransparent && !isBackground) return;

    visited[pos] = 1;
    queue[tail++] = pos;
  };

  for (let x = 0; x < width; x++) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }

  for (let y = 0; y < height; y++) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  while (head < tail) {
    const pos = queue[head++];
    const x = pos % width;
    const y = Math.floor(pos / width);

    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
  }

  return {
    visited,
    removedCount: tail,
  };
}

function clearVisitedAndMeasureBounds(data, width, height, visited) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let pos = 0; pos < visited.length; pos++) {
    const idx = pos * 4;

    if (visited[pos]) {
      data[idx + 3] = 0;
      continue;
    }

    if (data[idx + 3] <= 8) continue;

    const x = pos % width;
    const y = Math.floor(pos / width);

    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  if (maxX < minX || maxY < minY) return null;

  return { minX, minY, maxX, maxY };
}

function cropCanvasToBounds(canvas, bounds, padding = 8) {
  const cropX = Math.max(0, bounds.minX - padding);
  const cropY = Math.max(0, bounds.minY - padding);
  const cropW = Math.min(canvas.width - cropX, bounds.maxX - bounds.minX + 1 + padding * 2);
  const cropH = Math.min(canvas.height - cropY, bounds.maxY - bounds.minY + 1 + padding * 2);

  if (cropW >= canvas.width && cropH >= canvas.height) return;

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = cropW;
  cropCanvas.height = cropH;

  try {
    const cropCtx = getCanvasContext(cropCanvas);
    cropCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    canvas.width = cropW;
    canvas.height = cropH;

    const freshCtx = getCanvasContext(canvas);
    freshCtx.drawImage(cropCanvas, 0, 0);
  } finally {
    cleanupCanvas(cropCanvas);
  }
}

function removeConnectedBackground(canvas, ctx, config) {
  const width = canvas.width;
  const height = canvas.height;

  if (!width || !height) {
    return { removedBackground: false, width, height };
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const bg = estimateBackgroundColor(data, width, height, config);

  const baseThreshold = Number.isFinite(config.backgroundThreshold)
    ? config.backgroundThreshold
    : DEFAULT_IMAGE_PREP_CONFIG.backgroundThreshold;

  const threshold = Math.min(
    96,
    Math.max(baseThreshold, Math.round(bg.variance * 1.4 + baseThreshold))
  );

  const { visited, removedCount } = floodFillConnectedBackground(
    data,
    width,
    height,
    bg,
    threshold * threshold
  );

  if (removedCount < width * height * 0.01) {
    return { removedBackground: false, width, height };
  }

  const bounds = clearVisitedAndMeasureBounds(data, width, height, visited);

  if (!bounds) {
    return { removedBackground: false, width, height };
  }

  ctx.putImageData(imageData, 0, 0);
  cropCanvasToBounds(canvas, bounds);

  return {
    removedBackground: true,
    width: canvas.width,
    height: canvas.height,
  };
}

function canvasToWorkingDataURL(source, width, height, { removeBackground = true, config } = {}) {
  assertBrowserImageApis();

  const resolvedConfig = withDefaults(config);
  const target = getContainedSize(width, height, resolvedConfig.workingImageMaxDim);

  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;

  try {
    const ctx = getCanvasContext(canvas);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, target.width, target.height);

    const backgroundResult = removeBackground
      ? removeConnectedBackground(canvas, ctx, resolvedConfig)
      : { removedBackground: false, width: canvas.width, height: canvas.height };

    return {
      dataUrl: canvas.toDataURL("image/png"),
      width: backgroundResult.width,
      height: backgroundResult.height,
      downscaled: target.width !== Math.round(width) || target.height !== Math.round(height),
      removedBackground: backgroundResult.removedBackground,
    };
  } finally {
    cleanupCanvas(canvas);
  }
}

async function loadSourceFromFile(file, fileData) {
  if (isTiffFile(file) && typeof window.Tiff === "function" && fileData) {
    return {
      source: new window.Tiff({ buffer: fileData }).toCanvas(),
      sourceUrl: null,
    };
  }

  const sourceUrl = URL.createObjectURL(file);

  try {
    const source = await loadImage(sourceUrl);
    return { source, sourceUrl };
  } catch (error) {
    URL.revokeObjectURL(sourceUrl);
    throw error;
  }
}

function cleanupSource(source, sourceUrl) {
  if (sourceUrl) {
    URL.revokeObjectURL(sourceUrl);
  }

  if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) {
    source.onload = null;
    source.onerror = null;
    source.removeAttribute?.("src");
    source.src = "";
  }

  if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement) {
    cleanupCanvas(source);
  }
}

export async function loadWorkingImage(file, fileData, options = {}) {
  assertBrowserImageApis();

  if (!file) throw new Error("No file selected.");

  const { removeBackground = true } = options;
  const config = withDefaults(options.config);

  let source = null;
  let sourceUrl = null;

  try {
    const loaded = await loadSourceFromFile(file, fileData);
    source = loaded.source;
    sourceUrl = loaded.sourceUrl;

    const originalWidth = source.naturalWidth || source.width;
    const originalHeight = source.naturalHeight || source.height;

    if (!isPositiveDimension(originalWidth) || !isPositiveDimension(originalHeight)) {
      throw new Error("Loaded image has invalid dimensions.");
    }

    const working = canvasToWorkingDataURL(source, originalWidth, originalHeight, {
      removeBackground,
      config,
    });

    const img = await loadImage(working.dataUrl);

    return {
      img,
      dataUrl: working.dataUrl,
      originalWidth,
      originalHeight,
      workingWidth: working.width,
      workingHeight: working.height,
      downscaled: working.downscaled,
      removedBackground: working.removedBackground,
    };
  } finally {
    cleanupSource(source, sourceUrl);
  }
}