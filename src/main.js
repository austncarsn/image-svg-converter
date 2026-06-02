import ImageTracer from "imagetracerjs";
import { createZipBlob } from "./zip-helper.js";

(function () {
  "use strict";

  // --- Selectors ---
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // --- Security Helpers ---
  const escapeHTML = (str) => {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  const safeGet = (obj, key) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
    if (obj && Object.prototype.hasOwnProperty.call(obj, key)) {
      return obj[key];
    }
    return undefined;
  };

  const safeSet = (obj, key, val) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") return;
    obj[key] = val;
  };

  const safeDelete = (obj, key) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") return;
    delete obj[key];
  };

  // Helper to extract ImageData, optionally downscaling to prevent main-thread hangs
  const getTracingImageData = (img, maxDim = 1000) => {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    let traceW = w;
    let traceH = h;
    if (maxDim && (traceW > maxDim || traceH > maxDim)) {
      if (traceW > traceH) {
        traceH = Math.round((traceH * maxDim) / traceW);
        traceW = maxDim;
      } else {
        traceW = Math.round((traceW * maxDim) / traceH);
        traceH = maxDim;
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = traceW;
    canvas.height = traceH;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, traceW, traceH);
    return ctx.getImageData(0, 0, traceW, traceH);
  };

  const dropZone = $("#drop-zone");
  const fileInput = $("#file-input");
  const welcomeScreen = $("#welcome-screen");
  const workspaceIntake = $("#workspace-intake");
  const enterAppBtn = $("#enter-app-btn");
  const appGrid = $("#app-grid");

  // Results view elements
  const comparisonBox = $("#comparison-box");
  const originalPane = $("#pane-original");
  const vectorPane = $("#pane-vector");
  // Toolbar controls
  const zoomInBtn = $("#zoom-in-btn");
  const zoomOutBtn = $("#zoom-out-btn");
  const zoomResetBtn = $("#zoom-reset-btn");
  const zoomValDisplay = $("#zoom-val");

  // Settings controls
  const colorsInput = $("#numberofcolors");
  const ltresInput = $("#ltres");
  const qtresInput = $("#qtres");
  const pathomitInput = $("#pathomit");
  const blurInput = $("#blurradius");
  const scaleInput = $("#scale");
  const optimizeInput = $("#path-optimize");
  const outlineInput = $("#outline-mode");
  const hqInput = $("#high-quality");

  // Presets
  const presetsContainer = $("#presets-container");
  const customPresetsSelect = $("#preset-select");
  const assetSummary = $("#asset-summary");

  // Queue & download elements
  const batchQueueSection = $("#batch-queue");
  const queueList = $("#queue-list");
  const downloadOptions = $("#download-options");
  const downloadVectorBtn = $("#download-vector-btn");
  const downloadZipBtn = $("#download-zip-btn");

  // Metrics elements
  const metricOriginalSize = $("#metric-original-size");
  const metricSvgSize = $("#metric-svg-size");
  const metricCompression = $("#metric-compression");
  const metricTime = $("#metric-time");
  const metricColors = $("#metric-colors");
  const metricPaths = $("#metric-paths");

  // Theme Toggle
  const themeToggleBtn = $("#theme-toggle");

  // --- App State ---
  let queue = []; // Array of processed file objects
  let currentFileIndex = -1;
  let currentSvgString = null;
  let currentImgElement = null;
  let activePresetName = "logo";
  let activeJobToken = 0;
  let activeQualityToken = 0;
  let suppressRetrace = false;

  // Zoom/Pan State
  let zoom = 1.0;
  let panX = 0;
  let panY = 0;
  let isPanning = false;
  let startX = 0;
  let startY = 0;

  // Debouncing for settings changes
  let conversionDebounceTimeout = null;

  // Standard preset values
  const DEFAULTS = {
    colors: 6,
    ltres: 6,
    qtres: 6,
    pathomit: 14,
    blurradius: 1,
    scale: 1.0,
    optimize: true,
    outline: true,
    highQuality: true,
  };

  const PRESETS = {
    logo: {
      colors: 16,
      ltres: 3,
      qtres: 3,
      pathomit: 8,
      blurradius: 0,
      scale: 1.0,
      optimize: true,
      outline: true,
      highQuality: true,
    },
    photo: {
      colors: 32,
      ltres: 2,
      qtres: 2,
      pathomit: 10,
      blurradius: 2,
      blurdelta: 64,
      scale: 1.0,
      optimize: true,
      outline: false,
      highQuality: true,
      colorsampling: 2,
    },
    drawing: {
      colors: 12,
      ltres: 3,
      qtres: 3,
      pathomit: 14,
      blurradius: 2,
      scale: 1.0,
      optimize: true,
      outline: true,
      highQuality: true,
    },
    lineart: {
      colors: 4,
      ltres: 4,
      qtres: 4,
      pathomit: 12,
      blurradius: 0,
      scale: 1.0,
      optimize: true,
      outline: true,
      highQuality: true,
    },
  };

  const STORAGE_KEY = "svg_converter_presets_v2";
  const WORKING_IMAGE_MAX_DIM = 1600;
  const PREVIEW_TRACE_MAX_DIM = 720;
  const BACKGROUND_SAMPLE_SIZE = 16;
  const BACKGROUND_THRESHOLD = 64;
  const tracer = ImageTracer || window.ImageTracer;
  const ASSET_LABELS = {
    logo: "Logo or flat graphic",
    photo: "Photo or gradient-heavy image",
    drawing: "Illustration or drawing",
    lineart: "Line art",
  };

  // --- Helper: Format Bytes ---
  function formatBytes(bytes) {
    if (bytes === undefined || bytes === null || isNaN(bytes)) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  // --- File System Access Helper ---
  async function readFile(file) {
    const isTIFF =
      file.type === "image/tiff" ||
      file.name.toLowerCase().endsWith(".tif") ||
      file.name.toLowerCase().endsWith(".tiff");
    if (!isTIFF) return null;

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  function loadImageFromSource(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Unable to decode the selected image."));
      img.src = src;
    });
  }

  function getContainedSize(width, height, maxDim) {
    if (width <= maxDim && height <= maxDim) {
      return { width, height };
    }

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

  function colorDistanceSq(data, idx, color) {
    const dr = data[idx] - color.r;
    const dg = data[idx + 1] - color.g;
    const db = data[idx + 2] - color.b;
    return dr * dr + dg * dg + db * db;
  }

  function estimateBackgroundColor(data, width, height) {
    const samples = [];
    const size = Math.min(BACKGROUND_SAMPLE_SIZE, width, height);
    const regions = [
      [0, 0],
      [width - size, 0],
      [0, height - size],
      [width - size, height - size],
    ];

    regions.forEach(([startX, startY]) => {
      for (let y = startY; y < startY + size; y++) {
        for (let x = startX; x < startX + size; x++) {
          const idx = (y * width + x) * 4;
          samples.push([data[idx], data[idx + 1], data[idx + 2]]);
        }
      }
    });

    const color = samples.reduce(
      (acc, sample) => {
        acc.r += sample[0];
        acc.g += sample[1];
        acc.b += sample[2];
        return acc;
      },
      { r: 0, g: 0, b: 0 }
    );

    color.r = Math.round(color.r / samples.length);
    color.g = Math.round(color.g / samples.length);
    color.b = Math.round(color.b / samples.length);

    const variance = Math.sqrt(
      samples.reduce((sum, sample) => {
        const dr = sample[0] - color.r;
        const dg = sample[1] - color.g;
        const db = sample[2] - color.b;
        return sum + dr * dr + dg * dg + db * db;
      }, 0) / samples.length
    );

    return { ...color, variance };
  }

  function removeConnectedBackground(canvas, ctx) {
    const width = canvas.width;
    const height = canvas.height;
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const bg = estimateBackgroundColor(data, width, height);
    const threshold = Math.min(
      96,
      Math.max(BACKGROUND_THRESHOLD, Math.round(bg.variance * 1.4 + BACKGROUND_THRESHOLD))
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
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
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

    return {
      removedBackground: true,
      width: canvas.width,
      height: canvas.height,
    };
  }

  function canvasToWorkingDataURL(source, width, height) {
    const target = getContainedSize(width, height, WORKING_IMAGE_MAX_DIM);
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
        source = await loadImageFromSource(sourceUrl);
      }

      const originalWidth = source.naturalWidth || source.width;
      const originalHeight = source.naturalHeight || source.height;
      const working = canvasToWorkingDataURL(source, originalWidth, originalHeight);
      const img = await loadImageFromSource(working.dataUrl);

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
      if (source && source instanceof HTMLImageElement) cleanupImage(source);
      if (source && source instanceof HTMLCanvasElement) cleanupCanvas(source);
    }
  }

  // --- Memory and Element Cleanups ---
  function cleanupImage(img) {
    if (!img) return;
    img.onload = null;
    img.onerror = null;
    if (img.src && img.src.startsWith("blob:")) {
      URL.revokeObjectURL(img.src);
    }
    img.src = "";
  }

  function cleanupCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  }

  // --- File Validation (Signatures, limits) ---
  async function validateImageFile(file) {
    if (!file) {
      throw new Error("No file selected.");
    }
    if (file.size === 0) {
      throw new Error(`File "${file.name}" is empty (0 bytes). Please upload a valid image file.`);
    }
    const MAX_SIZE = 8 * 1024 * 1024; // Browser-safe local processing limit
    if (file.size > MAX_SIZE) {
      throw new Error(
        `File "${file.name}" exceeds the 8MB browser-safe limit. Please use a smaller image.`
      );
    }

    try {
      const headerBytes = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(new Uint8Array(e.target.result));
        reader.onerror = () => reject(new Error("Unable to read file header signature."));
        reader.readAsArrayBuffer(file.slice(0, 4));
      });

      if (headerBytes.length < 2) {
        throw new Error("File content is too small to identify format.");
      }

      const hex = Array.from(headerBytes)
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
        throw new Error(
          `File "${file.name}" is not a supported format or is corrupt. Please upload PNG, JPG, BMP, or TIFF.`
        );
      }
    } catch (err) {
      throw new Error(`Validation failed for "${file.name}": ${err.message}`);
    }
  }

  // --- UI Helpers for State / Process Overlays ---
  function showProcessing(pane, message) {
    // Remove existing processing overlay if any
    const existing = pane.querySelector(".processing-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "processing-overlay";
    overlay.innerHTML = `
      <div class="spinner"></div>
      <div class="processing-text">${escapeHTML(message)}</div>
    `;
    pane.appendChild(overlay);
    return overlay;
  }

  function showErrorInPanes(message) {
    originalPane.innerHTML = `<div class="preview-placeholder error-message" role="alert">
      <h4>Image Load Error</h4>
      <p>${escapeHTML(message)}</p>
    </div>`;
    vectorPane.innerHTML = `<div class="preview-placeholder error-message">
      <h4>Conversion Halted</h4>
      <p>Please resolve the loading error to proceed.</p>
    </div>`;
    if (downloadOptions) downloadOptions.classList.add("hidden");
  }

  function announceA11y(msg) {
    let announcer = $("#a11y-announcer");
    if (!announcer) {
      announcer = document.createElement("div");
      announcer.id = "a11y-announcer";
      announcer.className = "sr-only";
      announcer.setAttribute("aria-live", "polite");
      announcer.setAttribute("aria-atomic", "true");
      document.body.appendChild(announcer);
    }
    announcer.textContent = msg;
  }

  function showWorkspace() {
    if (welcomeScreen) welcomeScreen.classList.add("hidden");
    if (workspaceIntake) workspaceIntake.classList.remove("hidden");
    if (dropZone) dropZone.focus({ preventScroll: true });
  }

  function setupAppFlow() {
    if (!enterAppBtn) return;
    enterAppBtn.addEventListener("click", () => {
      showWorkspace();
      announceA11y("Workspace ready. Upload an image to begin.");
    });
  }

  function setAssetSummary(profile) {
    if (!assetSummary) return;

    const typeEl = assetSummary.querySelector(".asset-type");
    const detailEl = assetSummary.querySelector(".asset-detail");
    if (!typeEl || !detailEl) return;

    if (!profile) {
      typeEl.textContent = "No asset loaded";
      detailEl.textContent = "Upload an image to apply an automatic profile.";
      return;
    }

    typeEl.textContent = ASSET_LABELS[profile.type] || "Detected asset";
    const backgroundNote = profile.removedBackground ? " Background removed." : "";
    if (profile.downscaled || profile.removedBackground) {
      detailEl.textContent = `${profile.originalWidth} x ${profile.originalHeight}px prepared as ${profile.workingWidth} x ${profile.workingHeight}px before vectorizing.${backgroundNote}`;
    } else {
      detailEl.textContent = `${profile.width} x ${profile.height}px. Applied the ${profile.type} profile automatically.`;
    }
  }

  function createSafeSVG(img, profile) {
    if (!tracer || typeof tracer.imagedataToSVG !== "function") {
      throw new Error("Vector tracer is unavailable. Please reload the app and try again.");
    }

    const presetConfig = safeGet(PRESETS, profile.type) || DEFAULTS;
    const imgData = getTracingImageData(img, PREVIEW_TRACE_MAX_DIM);
    const rawSvg = tracer.imagedataToSVG(imgData, createTraceOptions(presetConfig));
    return {
      svgString: optimizeSvgString(rawSvg),
      mode: "vector",
    };
  }

  function optimizeSvgString(svgString) {
    if (!svgString) return "";

    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(svgString, "image/svg+xml");
    const svgElement = svgDoc.documentElement;
    const parseError = svgDoc.querySelector("parsererror");
    if (parseError || !svgElement || svgElement.nodeName.toLowerCase() !== "svg") {
      return svgString.replace(/>\s+</g, "><").trim();
    }

    svgDoc.querySelectorAll("title, desc, metadata").forEach((node) => node.remove());
    ensureSvgViewBox(svgElement);
    svgDoc.querySelectorAll("*").forEach((node) => {
      node.removeAttribute("id");
      node.removeAttribute("class");
      node.removeAttribute("data-name");
    });

    svgDoc.querySelectorAll("path").forEach((path) => {
      const d = path.getAttribute("d") || "";
      // Count distinct path commands; fewer than 8 means the path has no meaningful shape
      const commandCount = (d.match(/[MLHVCSQTAZ]/gi) || []).length;
      if (commandCount < 8 || d === "M0 0") {
        path.remove();
      }
    });

    const serialized = new XMLSerializer().serializeToString(svgElement);
    return serialized
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/>\s+</g, "><")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function ensureSvgViewBox(svgElement) {
    if (!svgElement || svgElement.getAttribute("viewBox")) return;

    const parseLength = (value) => {
      if (!value) return 0;
      const parsed = parseFloat(String(value).replace(/[^\d.-]/g, ""));
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const width = parseLength(svgElement.getAttribute("width"));
    const height = parseLength(svgElement.getAttribute("height"));
    if (width > 0 && height > 0) {
      svgElement.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }
  }

  // --- Theme Management with View Transitions ---
  function initTheme() {
    const savedTheme = localStorage.getItem("theme-color-scheme") || "system";
    applyTheme(savedTheme, false);

    if (themeToggleBtn) {
      themeToggleBtn.addEventListener("click", () => {
        const currentTheme = document.documentElement.getAttribute("data-theme") || "light";
        const nextTheme = currentTheme === "dark" ? "light" : "dark";

        // Use modern View Transitions API if supported
        if (document.startViewTransition) {
          document.startViewTransition(() => {
            applyTheme(nextTheme, true);
          });
        } else {
          applyTheme(nextTheme, true);
        }
      });
    }
  }

  function applyTheme(theme, save = true) {
    let resolvedTheme = theme;
    if (theme === "system") {
      resolvedTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }

    document.documentElement.setAttribute("data-theme", resolvedTheme);
    document.documentElement.style.colorScheme = resolvedTheme;

    if (save) {
      localStorage.setItem("theme-color-scheme", theme);
    }

    updateThemeIcon(resolvedTheme);
  }

  function updateThemeIcon(resolvedTheme) {
    if (!themeToggleBtn) return;
    if (resolvedTheme === "dark") {
      themeToggleBtn.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`;
      themeToggleBtn.title = "Switch to Light Mode";
    } else {
      themeToggleBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
      themeToggleBtn.title = "Switch to Dark Mode";
    }
  }

  // --- Zoom & Pan Management ---
  function applyZoomPan() {
    const zoomWrappers = $$(".zoom-wrapper");
    zoomWrappers.forEach((el) => {
      el.style.transform = `scale(${zoom}) translate(${panX}px, ${panY}px)`;
    });
    if (zoomValDisplay) zoomValDisplay.textContent = Math.round(zoom * 100) + "%";
  }

  function setupZoomPanEvents() {
    const panes = $$(".comparison-pane");
    if (!panes.length) return;

    panes.forEach((pane) => {
      pane.addEventListener("mousedown", (e) => {
        isPanning = true;
        pane.style.cursor = "grabbing";
        startX = e.clientX - panX * zoom;
        startY = e.clientY - panY * zoom;
      });

      pane.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          const delta = e.deltaY < 0 ? 0.1 : -0.1;
          zoom = Math.min(Math.max(zoom + delta, 0.5), 4.0);
          applyZoomPan();
        },
        { passive: false }
      );
    });

    window.addEventListener("mousemove", (e) => {
      if (!isPanning) return;
      panX = (e.clientX - startX) / zoom;
      panY = (e.clientY - startY) / zoom;
      applyZoomPan();
    });

    window.addEventListener("mouseup", () => {
      if (isPanning) {
        isPanning = false;
        panes.forEach((pane) => {
          pane.style.cursor = "";
        });
      }
    });

    // Zoom buttons
    if (zoomInBtn)
      zoomInBtn.addEventListener("click", () => {
        zoom = Math.min(zoom + 0.25, 4.0);
        applyZoomPan();
      });
    if (zoomOutBtn)
      zoomOutBtn.addEventListener("click", () => {
        zoom = Math.max(zoom - 0.25, 0.5);
        applyZoomPan();
      });
    if (zoomResetBtn)
      zoomResetBtn.addEventListener("click", () => {
        zoom = 1.0;
        panX = 0;
        panY = 0;
        applyZoomPan();
      });
  }

  // --- File Inputs, Drag and Drop, and Clipboard Paste ---
  function setupFileInputs() {
    if (!dropZone || !fileInput) return;

    const highlight = () => dropZone.classList.add("highlight");
    const unhighlight = () => dropZone.classList.remove("highlight");

    // Drag events
    ["dragenter", "dragover"].forEach((name) => {
      dropZone.addEventListener(name, (e) => {
        e.preventDefault();
        highlight();
      });
    });

    ["dragleave", "dragend", "drop"].forEach((name) => {
      dropZone.addEventListener(name, (e) => {
        e.preventDefault();
        unhighlight();
      });
    });

    dropZone.addEventListener("drop", (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) handleFiles(files);
    });

    dropZone.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files.length) handleFiles(e.target.files);
    });

    // Clipboard Paste
    window.addEventListener("paste", (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const imageFiles = [];
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length) handleFiles(imageFiles);
    });

    // Keyboard accessibility for dropzone
    dropZone.setAttribute("tabindex", "0");
    dropZone.setAttribute("role", "button");
    dropZone.setAttribute("aria-label", "Upload images. Drag and drop or click to browse");
    dropZone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });
  }

  // --- Queue State Management ---
  async function handleFiles(fileList) {
    const files = Array.from(fileList);
    if (!files.length) return;

    showWorkspace();

    // Toggle grid view
    if (appGrid) appGrid.classList.remove("hidden");

    activeJobToken++;
    activeQualityToken++;
    queue = [
      {
        file: files[0],
        status: "pending",
        svgString: null,
        originalSize: files[0].size,
        svgSize: null,
        paths: 0,
        colors: 0,
        compressionRatio: null,
        ssim: null,
        deltaE: null,
        assetProfile: null,
        processingTime: null,
        errorMessage: null,
        outputMode: null,
      },
    ];
    currentFileIndex = -1;

    updateQueueUI();
    await loadQueueItem(0);
  }

  function updateQueueUI() {
    if (batchQueueSection) batchQueueSection.classList.add("hidden");
    if (!queue.length) {
      return;
    }

    if (!queueList) return;

    queueList.innerHTML = "";

    queue.forEach((item, index) => {
      const itemEl = document.createElement("div");
      itemEl.className = `queue-item ${item.status} ${index === currentFileIndex ? "processing" : ""}`;

      const compVal = item.compressionRatio ? `${item.compressionRatio}x` : "—";
      let statusText = "Waiting...";
      if (item.status === "completed") statusText = `Done (${compVal})`;
      else if (item.status === "processing") statusText = "Converting...";
      else if (item.status === "error") statusText = "Failed";

      itemEl.innerHTML = `
        <div class="queue-info">
          <span class="queue-filename">${escapeHTML(item.file.name)}</span>
          <span class="queue-status" ${item.status === "error" ? `title="${escapeHTML(item.errorMessage || "")}" style="color: var(--error-color, #ff4d4d);"` : ""}>${escapeHTML(statusText)}</span>
        </div>
        <div class="queue-actions">
          <button class="btn btn-accent btn-small load-item-btn" type="button" data-index="${index}">View</button>
          <button class="btn btn-small btn-secondary delete-item-btn" type="button" data-index="${index}">×</button>
        </div>
      `;

      // Handle item loading
      itemEl.querySelector(".load-item-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        loadQueueItem(index);
      });

      // Handle item deletion
      itemEl.querySelector(".delete-item-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        removeQueueItem(index);
      });

      queueList.appendChild(itemEl);
    });
  }

  async function loadQueueItem(index) {
    if (index < 0 || index >= queue.length) return;

    activeJobToken++;
    const jobToken = activeJobToken;

    currentFileIndex = index;
    updateQueueUI();

    const item = queue.at(index);

    // Reset view panes to loading states
    originalPane.innerHTML = '<div class="preview-placeholder">Loading original...</div>';
    vectorPane.innerHTML = '<div class="preview-placeholder">Vectorizing...</div>';
    if (downloadOptions) downloadOptions.classList.add("hidden");

    try {
      await validateImageFile(item.file);
      if (jobToken !== activeJobToken) return;

      const fileData = await readFile(item.file);
      if (jobToken !== activeJobToken) return;

      const workingImage = await loadWorkingImage(item.file, fileData);
      if (jobToken !== activeJobToken) {
        cleanupImage(workingImage.img);
        return;
      }

      const img = workingImage.img;

      await new Promise((resolve) => {
        window.requestAnimationFrame(resolve);
      });

      {
        if (jobToken !== activeJobToken) {
          cleanupImage(img);
          return;
        }

        if (currentImgElement) {
          cleanupImage(currentImgElement);
        }
        currentImgElement = img;

        originalPane.innerHTML = "";
        const originalZoomWrapper = document.createElement("div");
        originalZoomWrapper.className = "zoom-wrapper";
        originalZoomWrapper.appendChild(img);
        originalPane.appendChild(originalZoomWrapper);

        if (!item.assetProfile) {
          item.assetProfile = detectAssetProfile(img);
          item.assetProfile.originalWidth = workingImage.originalWidth;
          item.assetProfile.originalHeight = workingImage.originalHeight;
          item.assetProfile.workingWidth = workingImage.workingWidth;
          item.assetProfile.workingHeight = workingImage.workingHeight;
          item.assetProfile.downscaled = workingImage.downscaled;
          item.assetProfile.removedBackground = workingImage.removedBackground;
        }
        setAssetSummary(item.assetProfile);

        // Check if item has already been successfully vectorized
        if (item.status === "completed" && item.svgString) {
          applyPresetValues(item.assetProfile.type, { silent: true });
          currentSvgString = item.svgString;
          renderSVGString(item.svgString);
          updateMetricsUI(item);
          if (downloadOptions) downloadOptions.classList.remove("hidden");

          zoom = 1.0;
          panX = 0;
          panY = 0;
          applyZoomPan();

          return;
        }

        item.status = "processing";
        updateQueueUI();

        const startTime = performance.now();
        applyPresetValues(item.assetProfile.type, { silent: true });
        let result;
        try {
          result = createSafeSVG(img, item.assetProfile);
        } catch (err) {
          console.error("Vector tracing failed:", err);
          item.status = "error";
          item.errorMessage = err.message || "Vector conversion failed.";
          updateQueueUI();
          showErrorInPanes(item.errorMessage);
          return;
        }
        const { svgString, mode } = result;

        if (jobToken !== activeJobToken) {
          cleanupImage(img);
          return;
        }

        currentSvgString = svgString;
        renderSVGString(svgString);

        const svgBlob = new Blob([svgString], { type: "image/svg+xml" });
        const svgSize = svgBlob.size;

        item.svgString = svgString;
        item.svgSize = svgSize;
        item.status = "completed";
        item.outputMode = mode;
        item.processingTime = (performance.now() - startTime) / 1000;

        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(svgString, "image/svg+xml");
        item.paths = svgDoc.querySelectorAll("path").length;
        item.colors = await computeColors(img);
        item.compressionRatio = (item.originalSize / svgSize).toFixed(1);

        if (jobToken !== activeJobToken) return;

        updateMetricsUI(item);
        updateQueueUI();
        if (downloadOptions) downloadOptions.classList.remove("hidden");

        zoom = 1.0;
        panX = 0;
        panY = 0;
        applyZoomPan();
      }
    } catch (err) {
      if (jobToken !== activeJobToken) return;
      item.status = "error";
      item.errorMessage = err.message;
      updateQueueUI();
      showErrorInPanes(err.message);
    }
  }

  function removeQueueItem(index) {
    const deleted = queue.splice(index, 1)[0];
    if (deleted && deleted.svgString) {
      // Clean up cached SVG URL representation if any
    }

    if (currentFileIndex === index) {
      if (currentImgElement) {
        cleanupImage(currentImgElement);
        currentImgElement = null;
      }
      currentFileIndex = queue.length ? 0 : -1;
      currentSvgString = null;
      originalPane.innerHTML = '<div class="preview-placeholder">Upload an image to begin</div>';
      vectorPane.innerHTML = '<div class="preview-placeholder">SVG will appear here</div>';
      if (downloadOptions) downloadOptions.classList.add("hidden");
      setAssetSummary(null);
    } else if (currentFileIndex > index) {
      currentFileIndex--;
    }

    updateQueueUI();
    if (currentFileIndex !== -1) loadQueueItem(currentFileIndex);
  }

  // --- Render SVG Document to preview pane ---
  function renderSVGString(svgString) {
    vectorPane.innerHTML = "";
    const vectorZoomWrapper = document.createElement("div");
    vectorZoomWrapper.className = "zoom-wrapper";

    let sanitizedSvg = svgString || "";
    if (sanitizedSvg.indexOf("xmlns=") === -1) {
      sanitizedSvg = sanitizedSvg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(sanitizedSvg, "image/svg+xml");
    const svgElement = svgDoc.documentElement;
    ensureSvgViewBox(svgElement);
    svgElement.setAttribute("width", "100%");
    svgElement.setAttribute("height", "100%");
    svgElement.setAttribute("preserveAspectRatio", "xMidYMid meet");

    vectorZoomWrapper.appendChild(svgElement);
    vectorPane.appendChild(vectorZoomWrapper);
    vectorPane.style.opacity = "1";
  }

  // --- Retrace current image with settings change ---
  function retraceCurrent() {
    if (!currentImgElement || !tracer || typeof tracer.imagedataToSVG !== "function") return;

    activeJobToken++;
    const jobToken = activeJobToken;

    if (vectorPane) vectorPane.style.opacity = "0.6";

    setTimeout(() => {
      if (jobToken !== activeJobToken) return;

      try {
        const options = createTraceOptions(getOptionsFromUI());
        const startTime = performance.now();

        const imgData = getTracingImageData(currentImgElement, PREVIEW_TRACE_MAX_DIM);
        const svgString = optimizeSvgString(tracer.imagedataToSVG(imgData, options));

        if (jobToken !== activeJobToken) return;

        currentSvgString = svgString;
        renderSVGString(svgString);

        const endTime = performance.now();
        const elapsed = (endTime - startTime) / 1000;
        const svgBlob = new Blob([svgString], { type: "image/svg+xml" });
        const svgSize = svgBlob.size;

        const item = queue.at(currentFileIndex);
        if (item) {
          item.svgString = svgString;
          item.svgSize = svgSize;
          item.processingTime = elapsed;

          const parser = new DOMParser();
          const svgDoc = parser.parseFromString(svgString, "image/svg+xml");
          item.paths = svgDoc.querySelectorAll("path").length;
          item.compressionRatio = (item.originalSize / svgSize).toFixed(1);

          updateMetricsUI(item);
        }

        applyZoomPan();
      } catch (err) {
        console.warn("Retrace failed:", err);
        if (vectorPane) vectorPane.style.opacity = "1";
      }
    }, 10);
  }

  // --- Canvas Color Sampling ---
  async function computeColors(imgEl) {
    try {
      const maxSample = 120;
      const w = imgEl.naturalWidth || imgEl.width;
      const h = imgEl.naturalHeight || imgEl.height;
      const sw = Math.min(maxSample, w);
      const sh = Math.min(Math.round((h / w) * sw) || sw, maxSample);

      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(imgEl, 0, 0, sw, sh);

      const data = ctx.getImageData(0, 0, sw, sh).data;
      const set = new Set();
      for (let i = 0; i < data.length; i += 4) {
        const a = data.at(i + 3);
        if (a === 0) continue;
        const r = data.at(i);
        const g = data.at(i + 1);
        const b = data.at(i + 2);
        const key = (((r >> 3) & 31) << 10) | (((g >> 3) & 31) << 5) | ((b >> 3) & 31);
        set.add(key);
      }
      return set.size;
    } catch (err) {
      return 0;
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
    const ctx = canvas.getContext("2d");

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
      if (uniqueColors <= 10 && edgeDensity > 0.1) {
        type = "lineart";
      } else if (uniqueColors <= 34 && (transparentRatio > 0.08 || edgeDensity > 0.16)) {
        type = "logo";
      } else if ((uniqueColors > 70 || avgSaturation < 0.18) && edgeDensity < 0.13) {
        // Classify as photo only if it also has low edge density (smooth photographic gradients).
        // Illustrated or engraved assets with many JPEG-compression colors but crisp ink edges
        // have high edgeDensity and should route to "drawing" instead.
        type = "photo";
      }

      return {
        type,
        width: w,
        height: h,
        uniqueColors,
        edgeDensity: Math.round(edgeDensity * 100),
        transparentRatio: Math.round(transparentRatio * 100),
      };
    } catch (err) {
      return {
        type: "logo",
        width: w,
        height: h,
        uniqueColors: 0,
        edgeDensity: 0,
        transparentRatio: 0,
      };
    } finally {
      cleanupCanvas(canvas);
    }
  }

  // --- Settings Control Handling ---
  function createTraceOptions(config) {
    const hq = !!config.highQuality;
    return {
      numberofcolors: Number(config.colors),
      ltres: Number(config.ltres),
      qtres: Number(config.qtres),
      pathomit: Number(config.pathomit),
      blurradius: Number(config.blurradius),
      blurdelta: config.blurdelta !== undefined ? Number(config.blurdelta) : 20,
      scale: Number(config.scale),
      optimize: !!config.optimize,
      outline: !!config.outline,
      // Use image-based color sampling by default (fewer spurious color clusters).
      // Photo preset overrides this to stochastic (2) via config.colorsampling.
      colorsampling: config.colorsampling !== undefined ? Number(config.colorsampling) : 1,
      colorquantcycles: hq ? 3 : 2,
      mincolorratio: hq ? 0.01 : 0.02,
      layering: 0,
      linefilter: true,
      rightangleenhance: true,
      roundcoords: hq ? 2 : 1,
      desc: false,
      viewbox: true,
      strokewidth: 0,
      lcpr: 0,
      qcpr: 0,
    };
  }

  function getOptionsFromUI() {
    return {
      numberofcolors: Number(colorsInput.value),
      ltres: Number(ltresInput.value),
      qtres: Number(qtresInput.value),
      pathomit: Number(pathomitInput.value),
      blurradius: Number(blurInput.value),
      scale: Number(scaleInput.value),
      optimize: optimizeInput.checked,
      outline: outlineInput.checked,
      highQuality: hqInput.checked,
    };
  }

  function setupSettingsEvents() {
    const controls = [
      colorsInput,
      ltresInput,
      qtresInput,
      pathomitInput,
      blurInput,
      scaleInput,
      optimizeInput,
      outlineInput,
      hqInput,
    ];

    controls.forEach((input) => {
      if (!input) return;

      const triggerChange = () => {
        // Update display text bubble
        const displayVal = document.getElementById(input.id + "-value");
        if (displayVal) {
          if (input.type === "checkbox") {
            displayVal.textContent = input.checked ? "On" : "Off";
          } else {
            displayVal.textContent = input.value;
          }
        }

        // Apply gradient background fill to range sliders
        if (input.type === "range") {
          const val = Number(input.value);
          const min = Number(input.min || 0);
          const max = Number(input.max || 100);
          const percent = ((val - min) / (max - min)) * 100;
          input.style.setProperty("--value", `${percent}%`);
        }

        clearTimeout(conversionDebounceTimeout);
      };

      input.addEventListener("input", triggerChange);
      input.addEventListener("change", triggerChange);

      // Initial trigger for slider fills
      triggerChange();
    });
  }

  // --- Metrics Display Updates ---
  function updateMetricsUI(item) {
    if (!item) return;
    metricOriginalSize.textContent = formatBytes(item.originalSize);
    metricSvgSize.textContent = formatBytes(item.svgSize);
    metricCompression.textContent = `${item.compressionRatio}x`;
    metricTime.textContent = item.processingTime ? `${item.processingTime.toFixed(2)}s` : "—";
    metricColors.textContent = item.colors || "—";
    metricPaths.textContent = item.paths || "—";
  }

  // --- Presets Wiring ---
  function setupPresets() {
    if (!presetsContainer) return;

    // Default Presets click delegate
    presetsContainer.addEventListener("click", (e) => {
      const btn = e.target.closest(".preset-btn[data-preset]");
      if (!btn) return;

      const name = btn.getAttribute("data-preset");
      applyPresetValues(name);
    });

    // Reset settings
    const resetBtn = $("#preset-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => applyPresetValues("default"));
    }

    // Save Custom Preset
    const saveBtn = $("#preset-save");
    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        const name = prompt("Enter a name for your custom preset:", "My Custom Preset");
        if (!name) return;

        const cleanName = name.trim().replace(/[:"']/g, "");
        if (!cleanName) return;

        const options = getOptionsFromUI();
        saveCustomPreset(cleanName, options);
      });
    }

    if (customPresetsSelect) {
      customPresetsSelect.addEventListener("change", (e) => {
        const val = e.target.value;
        if (val) applyPresetValues(val);
      });
    }

    renderCustomPresetsList();
  }

  function applyPresetValues(name, options = {}) {
    const wasSuppressed = suppressRetrace;
    suppressRetrace = wasSuppressed || !!options.silent;
    activePresetName = name;

    // Highlight buttons
    $$(".preset-btn[data-preset]").forEach((btn) => {
      if (btn.getAttribute("data-preset") === name) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });

    let config = safeGet(PRESETS, name);
    if (!config && name === "default") {
      config = DEFAULTS;
    }

    // Look up custom preset in localStorage
    if (!config) {
      const custom = getCustomPresets();
      config = safeGet(custom, name);
    }

    if (!config) {
      suppressRetrace = wasSuppressed;
      return;
    }

    // Apply values to DOM controls
    updateSlider(colorsInput, config.colors);
    updateSlider(ltresInput, config.ltres);
    updateSlider(qtresInput, config.qtres);
    updateSlider(pathomitInput, config.pathomit);
    updateSlider(blurInput, config.blurradius);
    updateSlider(scaleInput, config.scale);

    optimizeInput.checked = config.optimize;
    optimizeInput.dispatchEvent(new Event("change"));

    outlineInput.checked = config.outline;
    outlineInput.dispatchEvent(new Event("change"));

    if (config.highQuality !== undefined) {
      hqInput.checked = config.highQuality;
      hqInput.dispatchEvent(new Event("change"));
    }

    suppressRetrace = wasSuppressed;
  }

  function updateSlider(element, val) {
    if (!element) return;
    element.value = val;
    element.dispatchEvent(new Event("input"));
  }

  // Local Storage Custom Presets
  function getCustomPresets() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) return {};
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== "object") return {};

      const validated = {};
      for (const [key, preset] of Object.entries(parsed)) {
        if (!preset || typeof preset !== "object") continue;
        const colors = Number(preset.colors);
        if (isNaN(colors) || colors < 2 || colors > 32) continue;

        validated[key] = {
          colors: colors,
          ltres: isNaN(Number(preset.ltres)) ? 8 : Number(preset.ltres),
          qtres: isNaN(Number(preset.qtres)) ? 8 : Number(preset.qtres),
          pathomit: isNaN(Number(preset.pathomit)) ? 15 : Number(preset.pathomit),
          blurradius: isNaN(Number(preset.blurradius)) ? 0 : Number(preset.blurradius),
          scale: isNaN(Number(preset.scale)) ? 1.0 : Number(preset.scale),
          optimize: preset.optimize === undefined ? true : !!preset.optimize,
          outline: preset.outline === undefined ? true : !!preset.outline,
          highQuality: preset.highQuality === undefined ? true : !!preset.highQuality,
        };
      }
      return validated;
    } catch {
      return {};
    }
  }

  function saveCustomPreset(name, values) {
    const custom = getCustomPresets();
    safeSet(custom, name, values);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));

    renderCustomPresetsList();
    if (customPresetsSelect) customPresetsSelect.value = name;
    applyPresetValues(name);
  }

  // Delete Custom Preset from localStorage safely
  function deleteCustomPreset(name) {
    const custom = getCustomPresets();
    safeDelete(custom, name);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));

    renderCustomPresetsList();
    applyPresetValues("default");
  }

  function renderCustomPresetsList() {
    if (!customPresetsSelect) return;

    const custom = getCustomPresets();
    const keys = Object.keys(custom);

    customPresetsSelect.innerHTML = '<option value="">Load saved...</option>';

    keys.sort().forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      customPresetsSelect.appendChild(opt);
    });

    // Render deletion chips / buttons alongside standard ones if needed
    // In this premium UI, we allow choosing custom options directly in the select element.
    // If they choose a custom preset, we display a delete chip in the preset bar.
    const container = $("#custom-preset-actions");
    if (container) {
      container.innerHTML = "";
      keys.forEach((name) => {
        const chip = document.createElement("div");
        chip.className = "preset-btn";
        chip.innerHTML = `
          <span>★ ${escapeHTML(name)}</span>
          <button class="preset-delete" type="button" aria-label="Delete preset ${escapeHTML(name)}">×</button>
        `;

        chip.querySelector(".preset-delete").addEventListener("click", (e) => {
          e.stopPropagation();
          if (confirm(`Delete custom preset "${name}"?`)) {
            deleteCustomPreset(name);
          }
        });

        chip.addEventListener("click", () => {
          applyPresetValues(name);
        });

        container.appendChild(chip);
      });
    }
  }

  // --- Utility: Re-run trace at full working-image resolution for final download ---
  function getFullResolutionSVG() {
    if (!currentImgElement || !tracer || typeof tracer.imagedataToSVG !== "function") {
      return currentSvgString;
    }
    try {
      const item = queue.at(currentFileIndex);
      const config =
        item && item.assetProfile ? safeGet(PRESETS, item.assetProfile.type) || DEFAULTS : DEFAULTS;
      const imgData = getTracingImageData(currentImgElement, WORKING_IMAGE_MAX_DIM);
      return optimizeSvgString(tracer.imagedataToSVG(imgData, createTraceOptions(config)));
    } catch {
      return currentSvgString;
    }
  }

  // --- Downloads and ZIP Exporter ---
  function setupDownloads() {
    if (downloadVectorBtn) {
      downloadVectorBtn.addEventListener("click", () => {
        if (!currentImgElement) return;

        // Show processing overlay on the vector pane
        const overlay = showProcessing(vectorPane, "Preparing SVG export...");

        // Use setTimeout to yield execution so browser renders the loading indicator
        setTimeout(() => {
          try {
            const svgString = getFullResolutionSVG();
            const blob = new Blob([svgString], { type: "image/svg+xml" });
            triggerDownload(blob, `${getCurrentFileName()}.svg`);
          } catch (err) {
            console.error("SVG download failed:", err);
            alert("Failed to generate the SVG download.");
            if (currentSvgString) {
              const blob = new Blob([currentSvgString], { type: "image/svg+xml" });
              triggerDownload(blob, `${getCurrentFileName()}.svg`);
            }
          } finally {
            if (overlay) overlay.remove();
          }
        }, 50);
      });
    }

    if (downloadZipBtn) {
      downloadZipBtn.addEventListener("click", () => {
        const completedItems = queue.filter(
          (item) => item.status === "completed" && item.svgString
        );
        if (!completedItems.length) {
          alert("No completed SVGs to package.");
          return;
        }

        const files = completedItems.map((item, idx) => {
          const base = item.file.name.replace(/\.[^/.]+$/, "") || `vector-${idx}`;
          return {
            name: `${sanitizeFileName(base)}.svg`,
            content: item.svgString,
          };
        });

        try {
          const zipBlob = createZipBlob(files);
          triggerDownload(zipBlob, "vectorized-images.zip");
        } catch (err) {
          console.error("ZIP generation failed:", err);
          alert("Failed to generate ZIP archive: " + err.message);
        }
      });
    }
  }

  function sanitizeFileName(name) {
    if (!name) return "vectorized-file";
    let cleaned = name.replace(/[\\/:*?"<>|]/g, "_").trim();
    return cleaned || "vectorized-file";
  }

  function getCurrentFileName() {
    const activeItem = queue.at(currentFileIndex);
    if (currentFileIndex !== -1 && activeItem) {
      const base = activeItem.file.name.replace(/\.[^/.]+$/, "");
      return sanitizeFileName(base);
    }
    return "vectorized-image";
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    // Clean up
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  // --- Initial Bindings ---
  function init() {
    initTheme();
    setupAppFlow();
    setupZoomPanEvents();
    setupFileInputs();
    setupSettingsEvents();
    setupPresets();
    setupDownloads();

    // Prevent default drag window freezes
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());

    // Preload defaults
    applyPresetValues("logo");
  }

  // Kick off application logic
  document.addEventListener("DOMContentLoaded", init);
})();
