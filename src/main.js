import ImageTracer from "imagetracerjs";
import { createZipBlob } from "./zip-helper.js";

(() => {
  "use strict";

  const tracer = ImageTracer || window.ImageTracer;

  const CONFIG = Object.freeze({
    storageKey: "svg_converter_presets_v2",
    workingImageMaxDim: 1600,
    previewTraceMaxDim: 720,
    backgroundSampleSize: 16,
    backgroundThreshold: 64,
    maxFileSize: 8 * 1024 * 1024,
    minZoom: 0.5,
    maxZoom: 4,
    zoomStepButton: 0.25,
    zoomStepWheel: 0.1,
  });

  const PRESETS = Object.freeze({
    default: {
      colors: 6,
      ltres: 6,
      qtres: 6,
      pathomit: 14,
      blurradius: 1,
      blurdelta: 20,
      scale: 1,
      optimize: true,
      outline: true,
      highQuality: true,
      colorsampling: 1,
      mincolorratio: 0.01,
    },
    logo: {
      colors: 16,
      ltres: 3,
      qtres: 3,
      pathomit: 8,
      blurradius: 0,
      blurdelta: 20,
      scale: 1,
      optimize: true,
      outline: true,
      highQuality: true,
      colorsampling: 1,
      mincolorratio: 0.01,
    },
    photo: {
      colors: 32,
      ltres: 2,
      qtres: 2,
      pathomit: 10,
      blurradius: 2,
      blurdelta: 64,
      scale: 1,
      optimize: true,
      outline: false,
      highQuality: true,
      colorsampling: 2,
      mincolorratio: 0.01,
    },
    drawing: {
      colors: 8,
      ltres: 3,
      qtres: 3,
      pathomit: 8,
      blurradius: 2,
      blurdelta: 40,
      scale: 1,
      optimize: true,
      outline: true,
      highQuality: true,
      colorsampling: 1,
      mincolorratio: 0.025,
    },
    lineart: {
      colors: 4,
      ltres: 4,
      qtres: 4,
      pathomit: 12,
      blurradius: 0,
      blurdelta: 20,
      scale: 1,
      optimize: true,
      outline: true,
      highQuality: true,
      colorsampling: 1,
      mincolorratio: 0.01,
    },
  });

  const ASSET_LABELS = Object.freeze({
    logo: "Logo or flat graphic",
    photo: "Photo or gradient-heavy image",
    drawing: "Illustration or drawing",
    lineart: "Line art",
  });

  const state = {
    queue: [],
    currentFileIndex: -1,
    currentSvgString: "",
    currentImgElement: null,
    activePresetName: "logo",
    activeJobToken: 0,
    suppressRetrace: false,
    zoom: 1,
    panX: 0,
    panY: 0,
    isPanning: false,
    pointerId: null,
    pointerStartX: 0,
    pointerStartY: 0,
    panStartX: 0,
    panStartY: 0,
    theme: "light",
    memoryStore: new Map(),
    conversionDebounceId: 0,
  };

  const dom = {
    dropZone: document.querySelector("#drop-zone"),
    fileInput: document.querySelector("#file-input"),
    welcomeScreen: document.querySelector("#welcome-screen"),
    workspaceIntake: document.querySelector("#workspace-intake"),
    enterAppBtn: document.querySelector("#enter-app-btn"),
    appGrid: document.querySelector("#app-grid"),

    comparisonBox: document.querySelector("#comparison-box"),
    originalPane: document.querySelector("#pane-original"),
    vectorPane: document.querySelector("#pane-vector"),

    zoomInBtn: document.querySelector("#zoom-in-btn"),
    zoomOutBtn: document.querySelector("#zoom-out-btn"),
    zoomResetBtn: document.querySelector("#zoom-reset-btn"),
    zoomVal: document.querySelector("#zoom-val"),

    colorsInput: document.querySelector("#numberofcolors"),
    ltresInput: document.querySelector("#ltres"),
    qtresInput: document.querySelector("#qtres"),
    pathomitInput: document.querySelector("#pathomit"),
    blurInput: document.querySelector("#blurradius"),
    scaleInput: document.querySelector("#scale"),
    optimizeInput: document.querySelector("#path-optimize"),
    outlineInput: document.querySelector("#outline-mode"),
    highQualityInput: document.querySelector("#high-quality"),

    presetsContainer: document.querySelector("#presets-container"),
    presetSelect: document.querySelector("#preset-select"),
    customPresetActions: document.querySelector("#custom-preset-actions"),
    assetSummary: document.querySelector("#asset-summary"),

    batchQueueSection: document.querySelector("#batch-queue"),
    queueList: document.querySelector("#queue-list"),
    downloadOptions: document.querySelector("#download-options"),
    downloadVectorBtn: document.querySelector("#download-vector-btn"),
    downloadZipBtn: document.querySelector("#download-zip-btn"),

    metricOriginalSize: document.querySelector("#metric-original-size"),
    metricSvgSize: document.querySelector("#metric-svg-size"),
    metricCompression: document.querySelector("#metric-compression"),
    metricTime: document.querySelector("#metric-time"),
    metricColors: document.querySelector("#metric-colors"),
    metricPaths: document.querySelector("#metric-paths"),

    themeToggleBtn: document.querySelector("#theme-toggle"),
    announcer: document.querySelector("#a11y-announcer"),
  };

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function createEl(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
      if (key === "className") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key === "html") el.innerHTML = value;
      else if (value !== undefined && value !== null) el.setAttribute(key, String(value));
    });
    children.forEach((child) => child && el.appendChild(child));
    return el;
  }

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return state.memoryStore.get(key) ?? null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      state.memoryStore.set(key, value);
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function sanitizeFileName(name) {
    const cleaned = String(name || "vectorized-file")
      .replace(/[\\/:*?"<>|]/g, "_")
      .trim();
    return cleaned || "vectorized-file";
  }

  function announce(message) {
    if (!dom.announcer) return;
    dom.announcer.textContent = "";
    requestAnimationFrame(() => {
      dom.announcer.textContent = message;
    });
  }

  function showWorkspace() {
    dom.welcomeScreen?.classList.add("hidden");
    dom.workspaceIntake?.classList.remove("hidden");
    dom.appGrid?.classList.remove("hidden");
    dom.dropZone?.focus({ preventScroll: true });
  }

  function setTheme(theme, save = true) {
    const resolved =
      theme === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;

    state.theme = resolved;
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.style.colorScheme = resolved;

    if (save) safeStorageSet("theme-color-scheme", theme);
    updateThemeIcon(resolved);
  }

  function updateThemeIcon(theme) {
    if (!dom.themeToggleBtn) return;
    dom.themeToggleBtn.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
    );
    dom.themeToggleBtn.innerHTML =
      theme === "dark"
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }

  function initTheme() {
    const saved = safeStorageGet("theme-color-scheme") || "system";
    setTheme(saved, false);
    dom.themeToggleBtn?.addEventListener("click", () => {
      setTheme(state.theme === "dark" ? "light" : "dark", true);
    });
  }

  function getContainedSize(width, height, maxDim) {
    if (width <= maxDim && height <= maxDim) return { width, height };
    if (width >= height) {
      return {
        width: maxDim,
        height: Math.max(1, Math.round((height * maxDim) / width)),
      };
    }
    return {
      width: Math.max(1, Math.round((width * maxDim) / height)),
      height: maxDim,
    };
  }

  function cleanupCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  }

  function cleanupImage(img) {
    if (!img) return;
    img.onload = null;
    img.onerror = null;
    if (img.src?.startsWith("blob:")) URL.revokeObjectURL(img.src);
    img.src = "";
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Unable to decode the selected image."));
      img.src = src;
    });
  }

  async function readFileIfTiff(file) {
    const lower = file.name.toLowerCase();
    const isTiff = file.type === "image/tiff" || lower.endsWith(".tif") || lower.endsWith(".tiff");
    if (!isTiff) return null;

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  async function validateImageFile(file) {
    if (!file) throw new Error("No file selected.");
    if (file.size === 0) throw new Error(`File "${file.name}" is empty.`);
    if (file.size > CONFIG.maxFileSize) {
      throw new Error(`File "${file.name}" exceeds the 8MB browser-safe limit.`);
    }

    const header = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => resolve(new Uint8Array(event.target.result));
      reader.onerror = () => reject(new Error("Unable to read file header."));
      reader.readAsArrayBuffer(file.slice(0, 4));
    });

    const hex = Array.from(header)
      .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ");

    const isPNG = hex.startsWith("89 50 4E 47");
    const isJPG = hex.startsWith("FF D8 FF");
    const isBMP = hex.startsWith("42 4D");
    const isTIFF =
      hex.startsWith("49 49 2A 00") ||
      hex.startsWith("4D 4D 00 2A") ||
      file.name.toLowerCase().endsWith(".tiff") ||
      file.name.toLowerCase().endsWith(".tif");

    if (!isPNG && !isJPG && !isBMP && !isTIFF) {
      throw new Error(`File "${file.name}" is not a supported format or is corrupt.`);
    }
  }

  function getTracingImageData(img, maxDim) {
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    const target = getContainedSize(width, height, maxDim);

    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, target.width, target.height);

    const imageData = ctx.getImageData(0, 0, target.width, target.height);
    cleanupCanvas(canvas);
    return imageData;
  }

  function colorDistanceSq(data, idx, color) {
    const dr = data[idx] - color.r;
    const dg = data[idx + 1] - color.g;
    const db = data[idx + 2] - color.b;
    return dr * dr + dg * dg + db * db;
  }

  function estimateBackgroundColor(data, width, height) {
    const samples = [];
    const size = Math.min(CONFIG.backgroundSampleSize, width, height);
    const regions = [
      [0, 0],
      [width - size, 0],
      [0, height - size],
      [width - size, height - size],
    ];

    for (const [startX, startY] of regions) {
      for (let y = startY; y < startY + size; y++) {
        for (let x = startX; x < startX + size; x++) {
          const idx = (y * width + x) * 4;
          samples.push([data[idx], data[idx + 1], data[idx + 2]]);
        }
      }
    }

    const avg = samples.reduce(
      (acc, [r, g, b]) => {
        acc.r += r;
        acc.g += g;
        acc.b += b;
        return acc;
      },
      { r: 0, g: 0, b: 0 }
    );

    avg.r = Math.round(avg.r / samples.length);
    avg.g = Math.round(avg.g / samples.length);
    avg.b = Math.round(avg.b / samples.length);

    const variance = Math.sqrt(
      samples.reduce((sum, [r, g, b]) => {
        const dr = r - avg.r;
        const dg = g - avg.g;
        const db = b - avg.b;
        return sum + dr * dr + dg * dg + db * db;
      }, 0) / samples.length
    );

    return { ...avg, variance };
  }

  function removeConnectedBackground(canvas, ctx) {
    const width = canvas.width;
    const height = canvas.height;
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const bg = estimateBackgroundColor(data, width, height);
    const threshold = Math.min(
      96,
      Math.max(
        CONFIG.backgroundThreshold,
        Math.round(bg.variance * 1.4 + CONFIG.backgroundThreshold)
      )
    );
    const thresholdSq = threshold * threshold;

    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;

    const enqueue = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const pos = y * width + x;
      if (visited[pos]) return;
      const idx = pos * 4;
      if (data[idx + 3] < 8 || colorDistanceSq(data, idx, bg) <= thresholdSq) {
        visited[pos] = 1;
        queue[tail++] = pos;
      }
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

    if (tail < width * height * 0.01) {
      return { removedBackground: false, width, height };
    }

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
      if (data[idx + 3] > 8) {
        const x = pos % width;
        const y = Math.floor(pos / width);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    ctx.putImageData(imageData, 0, 0);

    if (maxX < minX || maxY < minY) {
      return { removedBackground: false, width, height };
    }

    const padding = 8;
    const cropX = Math.max(0, minX - padding);
    const cropY = Math.max(0, minY - padding);
    const cropW = Math.min(width - cropX, maxX - minX + 1 + padding * 2);
    const cropH = Math.min(height - cropY, maxY - minY + 1 + padding * 2);

    if (cropW < width || cropH < height) {
      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = cropW;
      cropCanvas.height = cropH;
      const cropCtx = cropCanvas.getContext("2d");
      cropCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      canvas.width = cropW;
      canvas.height = cropH;
      ctx = canvas.getContext("2d");
      ctx.drawImage(cropCanvas, 0, 0);
      cleanupCanvas(cropCanvas);
    }

    return { removedBackground: true, width: canvas.width, height: canvas.height };
  }

  function canvasToWorkingDataURL(source, width, height) {
    const target = getContainedSize(width, height, CONFIG.workingImageMaxDim);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;

    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, target.width, target.height);

    const backgroundResult = removeConnectedBackground(canvas, ctx);

    try {
      return {
        dataUrl: canvas.toDataURL("image/png"),
        width: backgroundResult.width,
        height: backgroundResult.height,
        downscaled: target.width !== width || target.height !== height,
        removedBackground: backgroundResult.removedBackground,
      };
    } finally {
      cleanupCanvas(canvas);
    }
  }

  async function loadWorkingImage(file, fileData) {
    const lowerName = file.name.toLowerCase();
    const isTIFF = lowerName.endsWith(".tif") || lowerName.endsWith(".tiff");
    let source = null;
    let sourceUrl = null;

    try {
      if (isTIFF && typeof window.Tiff === "function") {
        const tiff = new window.Tiff({ buffer: fileData });
        source = tiff.toCanvas();
      } else {
        sourceUrl = URL.createObjectURL(file);
        source = await loadImage(sourceUrl);
      }

      const originalWidth = source.naturalWidth || source.width;
      const originalHeight = source.naturalHeight || source.height;

      const working = canvasToWorkingDataURL(source, originalWidth, originalHeight);
      const img = await loadImage(working.dataUrl);

      return {
        img,
        originalWidth,
        originalHeight,
        workingWidth: working.width,
        workingHeight: working.height,
        downscaled: working.downscaled,
        removedBackground: working.removedBackground,
      };
    } finally {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      if (source instanceof HTMLImageElement) cleanupImage(source);
      if (source instanceof HTMLCanvasElement) cleanupCanvas(source);
    }
  }

  function detectAssetProfile(imgEl) {
    const w = imgEl.naturalWidth || imgEl.width || 1;
    const h = imgEl.naturalHeight || imgEl.height || 1;
    const sampleW = Math.min(180, w);
    const sampleH = Math.max(1, Math.min(180, Math.round((h / w) * sampleW)));
    const canvas = document.createElement("canvas");
    canvas.width = sampleW;
    canvas.height = sampleH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    try {
      ctx.drawImage(imgEl, 0, 0, sampleW, sampleH);
      const data = ctx.getImageData(0, 0, sampleW, sampleH).data;

      const colors = new Set();
      let transparentPixels = 0;
      let edgeHits = 0;
      let sampledPixels = 0;
      let totalSaturation = 0;

      for (let y = 0; y < sampleH; y++) {
        for (let x = 0; x < sampleW; x++) {
          const idx = (y * sampleW + x) * 4;
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
            const topIdx = idx - sampleW * 4;
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            const leftLuma =
              0.299 * data[leftIdx] + 0.587 * data[leftIdx + 1] + 0.114 * data[leftIdx + 2];
            const topLuma =
              0.299 * data[topIdx] + 0.587 * data[topIdx + 1] + 0.114 * data[topIdx + 2];
            if (Math.abs(luma - leftLuma) > 38 || Math.abs(luma - topLuma) > 38) edgeHits++;
          }
        }
      }

      const totalPixels = sampleW * sampleH;
      const uniqueColors = colors.size;
      const transparentRatio = transparentPixels / totalPixels;
      const edgeDensity = sampledPixels ? edgeHits / sampledPixels : 0;
      const avgSaturation = sampledPixels ? totalSaturation / sampledPixels : 0;

      let type = "drawing";
      if (uniqueColors <= 10 && edgeDensity > 0.1) type = "lineart";
      else if (uniqueColors <= 34 && (transparentRatio > 0.08 || edgeDensity > 0.16)) type = "logo";
      else if ((uniqueColors > 70 || avgSaturation < 0.18) && edgeDensity < 0.13) type = "photo";

      return {
        type,
        width: w,
        height: h,
        uniqueColors,
        edgeDensity: Math.round(edgeDensity * 100),
        transparentRatio: Math.round(transparentRatio * 100),
      };
    } finally {
      cleanupCanvas(canvas);
    }
  }

  function normalizeTraceConfig(input) {
    const merged = { ...PRESETS.default, ...input };
    return {
      colors: Number(merged.colors),
      ltres: Number(merged.ltres),
      qtres: Number(merged.qtres),
      pathomit: Number(merged.pathomit),
      blurradius: Number(merged.blurradius),
      blurdelta: Number(merged.blurdelta),
      scale: Number(merged.scale),
      optimize: Boolean(merged.optimize),
      outline: Boolean(merged.outline),
      highQuality: Boolean(merged.highQuality),
      colorsampling: Number(merged.colorsampling),
      mincolorratio: Number(merged.mincolorratio),
    };
  }

  function createTraceOptions(config) {
    const normalized = normalizeTraceConfig(config);
    return {
      numberofcolors: normalized.colors,
      ltres: normalized.ltres,
      qtres: normalized.qtres,
      pathomit: normalized.pathomit,
      blurradius: normalized.blurradius,
      blurdelta: normalized.blurdelta,
      scale: normalized.scale,
      optimize: normalized.optimize,
      outline: normalized.outline,
      colorsampling: normalized.colorsampling,
      colorquantcycles: normalized.highQuality ? 3 : 2,
      mincolorratio: normalized.mincolorratio,
      layering: 0,
      linefilter: true,
      rightangleenhance: true,
      roundcoords: normalized.highQuality ? 2 : 1,
      desc: false,
      viewbox: true,
      strokewidth: 0,
      lcpr: 0,
      qcpr: 0,
    };
  }

  function ensureSvgViewBox(svg) {
    if (!svg || svg.getAttribute("viewBox")) return;
    const parseLength = (value) => {
      const parsed = parseFloat(String(value || "").replace(/[^\d.-]/g, ""));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const width = parseLength(svg.getAttribute("width"));
    const height = parseLength(svg.getAttribute("height"));
    if (width > 0 && height > 0) svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }

  function collectReferencedIds(svg) {
    const referenced = new Set();
    const walker = svg.querySelectorAll("*");
    const refPattern = /url\(#([^)]+)\)|#([A-Za-z][\w:.-]*)/g;

    walker.forEach((node) => {
      for (const attr of node.getAttributeNames()) {
        const value = node.getAttribute(attr);
        if (!value) continue;
        let match;
        while ((match = refPattern.exec(value))) {
          referenced.add(match[1] || match[2]);
        }
      }
    });

    return referenced;
  }

  function sanitizeAndOptimizeSvg(svgString, { title = "", description = "" } = {}) {
    if (!svgString) return "";

    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, "image/svg+xml");
    const svg = doc.documentElement;
    const parseError = doc.querySelector("parsererror");

    if (parseError || !svg || svg.nodeName.toLowerCase() !== "svg") {
      return String(svgString).replace(/>\s+</g, "><").trim();
    }

    doc.querySelectorAll("script, foreignObject, iframe, object, embed").forEach((n) => n.remove());

    doc.querySelectorAll("*").forEach((node) => {
      for (const attr of [...node.getAttributeNames()]) {
        const value = node.getAttribute(attr) || "";
        if (/^on/i.test(attr)) node.removeAttribute(attr);
        if (
          (attr === "href" || attr === "xlink:href") &&
          /^\s*(https?:|data:|javascript:)/i.test(value)
        ) {
          node.removeAttribute(attr);
        }
      }
    });

    doc.querySelectorAll("metadata").forEach((n) => n.remove());
    ensureSvgViewBox(svg);

    const referencedIds = collectReferencedIds(svg);

    doc.querySelectorAll("[id]").forEach((node) => {
      const id = node.getAttribute("id");
      if (!referencedIds.has(id) && !/^svg-(title|desc)$/.test(id)) {
        if (
          ![
            "linearGradient",
            "radialGradient",
            "pattern",
            "clipPath",
            "mask",
            "filter",
            "symbol",
          ].includes(node.tagName)
        ) {
          node.removeAttribute("id");
        }
      }
    });

    doc.querySelectorAll("path").forEach((path) => {
      const d = (path.getAttribute("d") || "").trim();
      const fill = path.getAttribute("fill");
      const stroke = path.getAttribute("stroke");
      const display = path.getAttribute("display");
      const visibility = path.getAttribute("visibility");
      const opacity = Number(path.getAttribute("opacity") ?? 1);

      if (!d || d === "M0 0") {
        path.remove();
        return;
      }

      const effectivelyInvisible =
        display === "none" ||
        visibility === "hidden" ||
        opacity === 0 ||
        (fill === "none" && (!stroke || stroke === "none"));

      if (effectivelyInvisible) path.remove();
    });

    // --- Canonical SVG structure rebuild ---
    // Strip any existing title/desc/metadata before we insert controlled versions.
    doc.querySelectorAll("title, desc, metadata").forEach((n) => n.remove());

    // Collect existing <defs> (may be undefined) and prune unreferenced children.
    const existingDefs = svg.querySelector(":scope > defs");
    if (existingDefs) {
      [...existingDefs.children].forEach((child) => {
        const id = child.getAttribute("id");
        if (id && !referencedIds.has(id)) child.remove();
      });
    }

    // Wrap every remaining artwork child (everything that isn't <defs>) in a
    // named layer group so downstream tools can target the artwork cleanly.
    const artworkNodes = [...svg.children].filter(
      (n) => n.tagName.toLowerCase() !== "defs"
    );
    const artworkGroup = doc.createElementNS("http://www.w3.org/2000/svg", "g");
    artworkGroup.setAttribute("data-layer", "artwork");
    artworkGroup.setAttribute("fill", "none");
    artworkNodes.forEach((n) => artworkGroup.appendChild(n));

    // Build the <defs> element (empty when ImageTracer produces no gradients/clips).
    const defsEl =
      existingDefs || doc.createElementNS("http://www.w3.org/2000/svg", "defs");

    // Clear svg and re-insert children in canonical order:
    //   <title> → <desc> → <defs> → <g data-layer="artwork">
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const titleEl = doc.createElementNS("http://www.w3.org/2000/svg", "title");
    titleEl.setAttribute("id", "svg-title");
    titleEl.textContent = title || "Vectorized image";
    svg.appendChild(titleEl);

    const descEl = doc.createElementNS("http://www.w3.org/2000/svg", "desc");
    descEl.setAttribute("id", "svg-desc");
    descEl.textContent = description || "Auto-generated SVG output from the uploaded source image.";
    svg.appendChild(descEl);

    svg.appendChild(defsEl);
    svg.appendChild(artworkGroup);

    // Accessibility + aspect-ratio attributes on the root <svg>.
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-labelledby", "svg-title svg-desc");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    return new XMLSerializer()
      .serializeToString(svg)
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/>\s+</g, "><")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function createSafeSvg(img, profile) {
    if (!tracer || typeof tracer.imagedataToSVG !== "function") {
      throw new Error("Vector tracer is unavailable.");
    }

    const preset = PRESETS[profile.type] || PRESETS.default;
    const imgData = getTracingImageData(img, CONFIG.previewTraceMaxDim);
    const rawSvg = tracer.imagedataToSVG(imgData, createTraceOptions(preset));

    return sanitizeAndOptimizeSvg(rawSvg, {
      title: "Vectorized image",
      description: "Auto-generated SVG output from the uploaded source image.",
    });
  }

  function renderOriginal(img) {
    dom.originalPane.innerHTML = "";
    const wrapper = createEl("div", { className: "zoom-wrapper" });
    wrapper.appendChild(img);
    dom.originalPane.appendChild(wrapper);
  }

  function renderSvg(svgString) {
    dom.vectorPane.innerHTML = "";

    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, "image/svg+xml");
    const svg = doc.documentElement;
    ensureSvgViewBox(svg);

    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    const wrapper = createEl("div", { className: "zoom-wrapper" });
    wrapper.appendChild(svg);
    dom.vectorPane.appendChild(wrapper);
    applyZoomPan();
  }

  function applyZoomPan() {
    document.querySelectorAll(".zoom-wrapper").forEach((el) => {
      el.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
      el.style.transformOrigin = "center center";
      el.style.willChange = state.isPanning || state.zoom !== 1 ? "transform" : "auto";
    });

    if (dom.zoomVal) dom.zoomVal.textContent = `${Math.round(state.zoom * 100)}%`;
  }

  function resetZoomPan() {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    applyZoomPan();
  }

  function attachPanHandlers(pane) {
    pane.addEventListener("pointerdown", (event) => {
      state.isPanning = true;
      state.pointerId = event.pointerId;
      state.pointerStartX = event.clientX;
      state.pointerStartY = event.clientY;
      state.panStartX = state.panX;
      state.panStartY = state.panY;
      pane.setPointerCapture(event.pointerId);
      pane.style.cursor = "grabbing";
    });

    pane.addEventListener("pointermove", (event) => {
      if (!state.isPanning || event.pointerId !== state.pointerId) return;
      state.panX = state.panStartX + (event.clientX - state.pointerStartX);
      state.panY = state.panStartY + (event.clientY - state.pointerStartY);
      requestAnimationFrame(applyZoomPan);
    });

    const endPan = (event) => {
      if (event.pointerId !== state.pointerId) return;
      state.isPanning = false;
      state.pointerId = null;
      pane.style.cursor = "";
      try {
        pane.releasePointerCapture(event.pointerId);
      } catch {}
      applyZoomPan();
    };

    pane.addEventListener("pointerup", endPan);
    pane.addEventListener("pointercancel", endPan);

    pane.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const delta = event.deltaY < 0 ? CONFIG.zoomStepWheel : -CONFIG.zoomStepWheel;
        state.zoom = Math.min(CONFIG.maxZoom, Math.max(CONFIG.minZoom, state.zoom + delta));
        requestAnimationFrame(applyZoomPan);
      },
      { passive: false }
    );
  }

  function setupZoomPan() {
    document.querySelectorAll(".comparison-pane").forEach(attachPanHandlers);

    dom.zoomInBtn?.addEventListener("click", () => {
      state.zoom = Math.min(CONFIG.maxZoom, state.zoom + CONFIG.zoomStepButton);
      applyZoomPan();
    });

    dom.zoomOutBtn?.addEventListener("click", () => {
      state.zoom = Math.max(CONFIG.minZoom, state.zoom - CONFIG.zoomStepButton);
      applyZoomPan();
    });

    dom.zoomResetBtn?.addEventListener("click", resetZoomPan);
  }

  function getUiOptions() {
    return normalizeTraceConfig({
      colors: dom.colorsInput?.value,
      ltres: dom.ltresInput?.value,
      qtres: dom.qtresInput?.value,
      pathomit: dom.pathomitInput?.value,
      blurradius: dom.blurInput?.value,
      scale: dom.scaleInput?.value,
      optimize: dom.optimizeInput?.checked,
      outline: dom.outlineInput?.checked,
      highQuality: dom.highQualityInput?.checked,
    });
  }

  function updateSliderFill(input) {
    if (!input || input.type !== "range") return;
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const value = Number(input.value);
    const percent = ((value - min) / (max - min)) * 100;
    input.style.setProperty("--value", `${percent}%`);
  }

  function updateControlBadge(input) {
    const output = document.getElementById(`${input.id}-value`);
    if (!output) return;
    output.textContent = input.type === "checkbox" ? (input.checked ? "On" : "Off") : input.value;
  }

  function scheduleRetrace() {
    if (state.suppressRetrace || !state.currentImgElement) return;
    clearTimeout(state.conversionDebounceId);
    state.conversionDebounceId = window.setTimeout(() => {
      retraceCurrent();
    }, 180);
  }

  function setupSettings() {
    const controls = [
      dom.colorsInput,
      dom.ltresInput,
      dom.qtresInput,
      dom.pathomitInput,
      dom.blurInput,
      dom.scaleInput,
      dom.optimizeInput,
      dom.outlineInput,
      dom.highQualityInput,
    ].filter(Boolean);

    controls.forEach((input) => {
      const handler = () => {
        updateControlBadge(input);
        updateSliderFill(input);
        scheduleRetrace();
      };

      input.addEventListener("input", handler);
      input.addEventListener("change", handler);
      handler();
    });
  }

  function getCustomPresets() {
    try {
      const raw = safeStorageGet(CONFIG.storageKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};

      const valid = {};
      for (const [key, preset] of Object.entries(parsed)) {
        const normalized = normalizeTraceConfig(preset);
        if (normalized.colors >= 2 && normalized.colors <= 32) valid[key] = normalized;
      }
      return valid;
    } catch {
      return {};
    }
  }

  function saveCustomPreset(name, values) {
    const presets = getCustomPresets();
    presets[name] = normalizeTraceConfig(values);
    safeStorageSet(CONFIG.storageKey, JSON.stringify(presets));
    renderCustomPresets();
  }

  function deleteCustomPreset(name) {
    const presets = getCustomPresets();
    delete presets[name];
    safeStorageSet(CONFIG.storageKey, JSON.stringify(presets));
    renderCustomPresets();
  }

  function applyPreset(name, { silent = false } = {}) {
    const allCustom = getCustomPresets();
    const config = PRESETS[name] || allCustom[name];
    if (!config) return;

    state.activePresetName = name;
    state.suppressRetrace = silent;

    dom.colorsInput.value = config.colors;
    dom.ltresInput.value = config.ltres;
    dom.qtresInput.value = config.qtres;
    dom.pathomitInput.value = config.pathomit;
    dom.blurInput.value = config.blurradius;
    dom.scaleInput.value = config.scale;
    dom.optimizeInput.checked = config.optimize;
    dom.outlineInput.checked = config.outline;
    dom.highQualityInput.checked = config.highQuality;

    [
      dom.colorsInput,
      dom.ltresInput,
      dom.qtresInput,
      dom.pathomitInput,
      dom.blurInput,
      dom.scaleInput,
      dom.optimizeInput,
      dom.outlineInput,
      dom.highQualityInput,
    ].forEach((input) => {
      if (!input) return;
      updateControlBadge(input);
      updateSliderFill(input);
    });

    dom.presetsContainer?.querySelectorAll(".preset-btn[data-preset]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-preset") === name);
    });

    state.suppressRetrace = false;
  }

  function renderCustomPresets() {
    const custom = getCustomPresets();
    if (dom.presetSelect) {
      dom.presetSelect.innerHTML = "";
      dom.presetSelect.appendChild(createEl("option", { value: "", text: "Load saved..." }));
      Object.keys(custom)
        .sort()
        .forEach((name) =>
          dom.presetSelect.appendChild(createEl("option", { value: name, text: name }))
        );
    }

    if (dom.customPresetActions) {
      dom.customPresetActions.innerHTML = "";
      Object.keys(custom)
        .sort()
        .forEach((name) => {
          const chip = createEl("div", { className: "preset-btn", "data-custom-preset": name });
          chip.appendChild(createEl("span", { text: `★ ${name}` }));
          chip.appendChild(
            createEl("button", {
              type: "button",
              className: "preset-delete",
              "data-delete-preset": name,
              "aria-label": `Delete preset ${name}`,
              text: "×",
            })
          );
          dom.customPresetActions.appendChild(chip);
        });
    }
  }

  function setupPresets() {
    dom.presetsContainer?.addEventListener("click", (event) => {
      const btn = event.target.closest(".preset-btn[data-preset]");
      if (!btn) return;
      applyPreset(btn.getAttribute("data-preset"));
      scheduleRetrace();
    });

    dom.presetSelect?.addEventListener("change", (event) => {
      const name = event.target.value;
      if (!name) return;
      applyPreset(name);
      scheduleRetrace();
    });

    dom.customPresetActions?.addEventListener("click", (event) => {
      const deleteBtn = event.target.closest("[data-delete-preset]");
      if (deleteBtn) {
        const name = deleteBtn.getAttribute("data-delete-preset");
        if (window.confirm(`Delete custom preset "${name}"?`)) deleteCustomPreset(name);
        return;
      }

      const chip = event.target.closest("[data-custom-preset]");
      if (chip) {
        applyPreset(chip.getAttribute("data-custom-preset"));
        scheduleRetrace();
      }
    });

    document.querySelector("#preset-save")?.addEventListener("click", () => {
      const name = window.prompt("Enter a name for your custom preset:", "My Custom Preset");
      const cleanName = String(name || "")
        .trim()
        .replace(/[:\"']/g, "");
      if (!cleanName) return;
      saveCustomPreset(cleanName, getUiOptions());
      applyPreset(cleanName, { silent: true });
    });

    document.querySelector("#preset-reset")?.addEventListener("click", () => {
      applyPreset("default");
      scheduleRetrace();
    });

    renderCustomPresets();
  }

  function setAssetSummary(profile) {
    if (!dom.assetSummary) return;
    const typeEl = $(".asset-type", dom.assetSummary);
    const detailEl = $(".asset-detail", dom.assetSummary);
    if (!typeEl || !detailEl) return;

    if (!profile) {
      typeEl.textContent = "No asset loaded";
      detailEl.textContent = "Upload an image to apply an automatic profile.";
      return;
    }

    typeEl.textContent = ASSET_LABELS[profile.type] || "Detected asset";
    const backgroundNote = profile.removedBackground ? " Background removed." : "";
    detailEl.textContent =
      profile.downscaled || profile.removedBackground
        ? `${profile.originalWidth} × ${profile.originalHeight}px prepared as ${profile.workingWidth} × ${profile.workingHeight}px before vectorizing.${backgroundNote}`
        : `${profile.width} × ${profile.height}px. Applied the ${profile.type} profile automatically.`;
  }

  function updateMetrics(item) {
    if (!item) return;
    dom.metricOriginalSize.textContent = formatBytes(item.originalSize);
    dom.metricSvgSize.textContent = formatBytes(item.svgSize);
    dom.metricCompression.textContent = item.compressionRatio ? `${item.compressionRatio}x` : "—";
    dom.metricTime.textContent = Number.isFinite(item.processingTime)
      ? `${item.processingTime.toFixed(2)}s`
      : "—";
    dom.metricColors.textContent = item.colors || "—";
    dom.metricPaths.textContent = item.paths || "—";
  }

  function getCurrentItem() {
    return state.queue[state.currentFileIndex] || null;
  }

  function updateQueueUi() {
    if (!dom.queueList) return;
    dom.batchQueueSection?.classList.toggle("hidden", state.queue.length === 0);

    dom.queueList.innerHTML = "";
    state.queue.forEach((item, index) => {
      const row = createEl("div", {
        className: `queue-item ${item.status} ${index === state.currentFileIndex ? "processing" : ""}`,
        "data-index": index,
      });

      const info = createEl("div", { className: "queue-info" });
      info.appendChild(createEl("span", { className: "queue-filename", text: item.file.name }));

      const status =
        item.status === "completed"
          ? `Done (${item.compressionRatio || "—"}x)`
          : item.status === "processing"
            ? "Converting..."
            : item.status === "error"
              ? "Failed"
              : "Waiting...";

      const statusEl = createEl("span", { className: "queue-status", text: status });
      if (item.status === "error" && item.errorMessage) {
        statusEl.title = item.errorMessage;
      }
      info.appendChild(statusEl);

      const actions = createEl("div", { className: "queue-actions" });
      actions.appendChild(
        createEl("button", {
          type: "button",
          className: "btn btn-accent btn-small",
          "data-action": "view",
          "data-index": index,
          text: "View",
        })
      );
      actions.appendChild(
        createEl("button", {
          type: "button",
          className: "btn btn-small btn-secondary",
          "data-action": "delete",
          "data-index": index,
          text: "×",
          "aria-label": `Delete ${item.file.name}`,
        })
      );

      row.append(info, actions);
      dom.queueList.appendChild(row);
    });
  }

  function showErrorInPanes(message) {
    dom.originalPane.innerHTML = "";
    dom.vectorPane.innerHTML = "";

    const originalError = createEl("div", {
      className: "preview-placeholder error-message",
      role: "alert",
    });
    originalError.append(
      createEl("h4", { text: "Image Load Error" }),
      createEl("p", { text: message })
    );

    const vectorError = createEl("div", { className: "preview-placeholder error-message" });
    vectorError.append(
      createEl("h4", { text: "Conversion Halted" }),
      createEl("p", { text: "Please resolve the loading error to proceed." })
    );

    dom.originalPane.appendChild(originalError);
    dom.vectorPane.appendChild(vectorError);
    dom.downloadOptions?.classList.add("hidden");
  }

  async function computeColors(imgEl) {
    try {
      const maxSample = 120;
      const w = imgEl.naturalWidth || imgEl.width;
      const h = imgEl.naturalHeight || imgEl.height;
      const sw = Math.min(maxSample, w);
      const sh = Math.min(Math.max(1, Math.round((h / w) * sw)), maxSample);

      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(imgEl, 0, 0, sw, sh);

      const data = ctx.getImageData(0, 0, sw, sh).data;
      const set = new Set();

      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        const key =
          (((data[i] >> 3) & 31) << 10) |
          (((data[i + 1] >> 3) & 31) << 5) |
          ((data[i + 2] >> 3) & 31);
        set.add(key);
      }

      cleanupCanvas(canvas);
      return set.size;
    } catch {
      return 0;
    }
  }

  async function processQueueItem(index) {
    if (index < 0 || index >= state.queue.length) return;

    state.activeJobToken += 1;
    const jobToken = state.activeJobToken;
    state.currentFileIndex = index;

    const item = getCurrentItem();
    updateQueueUi();

    dom.originalPane.innerHTML = '<div class="preview-placeholder">Loading original...</div>';
    dom.vectorPane.innerHTML = '<div class="preview-placeholder">Vectorizing...</div>';
    dom.downloadOptions?.classList.add("hidden");

    try {
      await validateImageFile(item.file);
      if (jobToken !== state.activeJobToken) return;

      const fileData = await readFileIfTiff(item.file);
      if (jobToken !== state.activeJobToken) return;

      const workingImage = await loadWorkingImage(item.file, fileData);
      if (jobToken !== state.activeJobToken) {
        cleanupImage(workingImage.img);
        return;
      }

      if (state.currentImgElement) cleanupImage(state.currentImgElement);
      state.currentImgElement = workingImage.img;

      renderOriginal(workingImage.img);

      if (!item.assetProfile) {
        item.assetProfile = detectAssetProfile(workingImage.img);
        Object.assign(item.assetProfile, {
          originalWidth: workingImage.originalWidth,
          originalHeight: workingImage.originalHeight,
          workingWidth: workingImage.workingWidth,
          workingHeight: workingImage.workingHeight,
          downscaled: workingImage.downscaled,
          removedBackground: workingImage.removedBackground,
        });
      }

      setAssetSummary(item.assetProfile);
      applyPreset(item.assetProfile.type, { silent: true });

      if (item.status === "completed" && item.svgString) {
        state.currentSvgString = item.svgString;
        renderSvg(item.svgString);
        updateMetrics(item);
        dom.downloadOptions?.classList.remove("hidden");
        resetZoomPan();
        return;
      }

      item.status = "processing";
      updateQueueUi();

      await new Promise((resolve) => requestAnimationFrame(resolve));
      const start = performance.now();

      const svgString = createSafeSvg(workingImage.img, item.assetProfile);
      if (jobToken !== state.activeJobToken) return;

      state.currentSvgString = svgString;
      renderSvg(svgString);

      const svgDoc = new DOMParser().parseFromString(svgString, "image/svg+xml");
      const svgSize = new Blob([svgString], { type: "image/svg+xml" }).size;

      item.svgString = svgString;
      item.svgSize = svgSize;
      item.status = "completed";
      item.processingTime = (performance.now() - start) / 1000;
      item.paths = svgDoc.querySelectorAll("path").length;
      item.colors = await computeColors(workingImage.img);
      item.compressionRatio = svgSize > 0 ? (item.originalSize / svgSize).toFixed(1) : null;

      if (jobToken !== state.activeJobToken) return;

      updateMetrics(item);
      updateQueueUi();
      dom.downloadOptions?.classList.remove("hidden");
      resetZoomPan();
      announce(`Finished vectorizing ${item.file.name}.`);
    } catch (error) {
      if (jobToken !== state.activeJobToken) return;
      item.status = "error";
      item.errorMessage = error.message || "Unknown error.";
      updateQueueUi();
      showErrorInPanes(item.errorMessage);
      announce(`Failed to process ${item.file.name}.`);
    }
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    showWorkspace();

    state.queue = files.slice(0, 1).map((file) => ({
      file,
      status: "pending",
      svgString: "",
      originalSize: file.size,
      svgSize: 0,
      paths: 0,
      colors: 0,
      compressionRatio: null,
      assetProfile: null,
      processingTime: null,
      errorMessage: "",
    }));

    state.currentFileIndex = -1;
    state.currentSvgString = "";
    updateQueueUi();

    await processQueueItem(0);
  }

  function removeQueueItem(index) {
    const removed = state.queue.splice(index, 1)[0];
    if (removed && index === state.currentFileIndex) {
      if (state.currentImgElement) {
        cleanupImage(state.currentImgElement);
        state.currentImgElement = null;
      }
      state.currentSvgString = "";
      state.currentFileIndex = state.queue.length ? 0 : -1;
      dom.originalPane.innerHTML =
        '<div class="preview-placeholder">Upload an image to begin</div>';
      dom.vectorPane.innerHTML = '<div class="preview-placeholder">SVG will appear here</div>';
      dom.downloadOptions?.classList.add("hidden");
      setAssetSummary(null);
    } else if (state.currentFileIndex > index) {
      state.currentFileIndex -= 1;
    }

    updateQueueUi();
    if (state.currentFileIndex >= 0) processQueueItem(state.currentFileIndex);
  }

  async function retraceCurrent() {
    const item = getCurrentItem();
    if (!item || !state.currentImgElement) return;

    state.activeJobToken += 1;
    const jobToken = state.activeJobToken;

    dom.vectorPane.style.opacity = "0.6";
    await new Promise((resolve) => requestAnimationFrame(resolve));

    try {
      const start = performance.now();
      const imgData = getTracingImageData(state.currentImgElement, CONFIG.previewTraceMaxDim);
      const svgString = sanitizeAndOptimizeSvg(
        tracer.imagedataToSVG(imgData, createTraceOptions(getUiOptions())),
        {
          title: "Vectorized image",
          description: "Auto-generated SVG output from the uploaded source image.",
        }
      );

      if (jobToken !== state.activeJobToken) return;

      state.currentSvgString = svgString;
      item.svgString = svgString;
      item.svgSize = new Blob([svgString], { type: "image/svg+xml" }).size;
      item.processingTime = (performance.now() - start) / 1000;
      item.paths = new DOMParser()
        .parseFromString(svgString, "image/svg+xml")
        .querySelectorAll("path").length;
      item.compressionRatio =
        item.svgSize > 0 ? (item.originalSize / item.svgSize).toFixed(1) : null;

      renderSvg(svgString);
      updateMetrics(item);
      applyZoomPan();
    } catch (error) {
      console.warn("Retrace failed:", error);
    } finally {
      dom.vectorPane.style.opacity = "1";
    }
  }

  function getFullResolutionSvg() {
    if (!state.currentImgElement || !tracer || typeof tracer.imagedataToSVG !== "function") {
      return state.currentSvgString;
    }

    const item = getCurrentItem();
    const profileType = item?.assetProfile?.type || "default";
    const preset = PRESETS[profileType] || PRESETS.default;

    try {
      const imgData = getTracingImageData(state.currentImgElement, CONFIG.workingImageMaxDim);
      return sanitizeAndOptimizeSvg(tracer.imagedataToSVG(imgData, createTraceOptions(preset)), {
        title: "Vectorized image",
        description: "Auto-generated SVG output from the uploaded source image.",
      });
    } catch {
      return state.currentSvgString;
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = createEl("a", { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 100);
  }

  function setupDownloads() {
    dom.downloadVectorBtn?.addEventListener("click", () => {
      const item = getCurrentItem();
      if (!item) return;
      const svgString = getFullResolutionSvg();
      triggerDownload(
        new Blob([svgString], { type: "image/svg+xml" }),
        `${sanitizeFileName(item.file.name.replace(/\.[^/.]+$/, ""))}.svg`
      );
    });

    dom.downloadZipBtn?.addEventListener("click", () => {
      const complete = state.queue.filter((item) => item.status === "completed" && item.svgString);
      if (!complete.length) return;

      const files = complete.map((item, index) => ({
        name: `${sanitizeFileName(item.file.name.replace(/\.[^/.]+$/, "") || `vector-${index}`)}.svg`,
        content: item.svgString,
      }));

      const zipBlob = createZipBlob(files);
      triggerDownload(zipBlob, "vectorized-images.zip");
    });
  }

  function setupFileInputs() {
    if (!dom.dropZone || !dom.fileInput) return;

    const highlight = () => dom.dropZone.classList.add("highlight");
    const unhighlight = () => dom.dropZone.classList.remove("highlight");

    ["dragenter", "dragover"].forEach((type) => {
      dom.dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        highlight();
      });
    });

    ["dragleave", "dragend", "drop"].forEach((type) => {
      dom.dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        unhighlight();
      });
    });

    dom.dropZone.setAttribute("tabindex", "0");
    dom.dropZone.setAttribute("role", "button");
    dom.dropZone.setAttribute("aria-label", "Upload images. Drag and drop or click to browse.");

    dom.dropZone.addEventListener("click", () => dom.fileInput.click());
    dom.dropZone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        dom.fileInput.click();
      }
    });

    dom.dropZone.addEventListener("drop", (event) => {
      const files = event.dataTransfer?.files;
      if (files?.length) handleFiles(files);
    });

    dom.fileInput.addEventListener("change", (event) => {
      const files = event.target.files;
      if (files?.length) handleFiles(files);
    });

    window.addEventListener("paste", (event) => {
      const items = Array.from(event.clipboardData?.items || []);
      const imageFiles = items
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter(Boolean);

      if (imageFiles.length) handleFiles(imageFiles);
    });

    window.addEventListener("dragover", (event) => event.preventDefault());
    window.addEventListener("drop", (event) => event.preventDefault());
  }

  function setupQueueActions() {
    dom.queueList?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-action]");
      if (!btn) return;
      const index = Number(btn.getAttribute("data-index"));
      const action = btn.getAttribute("data-action");

      if (action === "view") processQueueItem(index);
      if (action === "delete") removeQueueItem(index);
    });
  }

  function setupAppFlow() {
    dom.enterAppBtn?.addEventListener("click", () => {
      showWorkspace();
      announce("Workspace ready. Upload an image to begin.");
    });
  }

  function init() {
    if (!tracer) {
      console.error("ImageTracer is unavailable.");
      return;
    }

    initTheme();
    setupAppFlow();
    setupZoomPan();
    setupFileInputs();
    setupSettings();
    setupPresets();
    setupQueueActions();
    setupDownloads();
    applyPreset("logo", { silent: true });
  }

  document.addEventListener("DOMContentLoaded", init, { once: true });
})();
