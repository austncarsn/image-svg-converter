import ImageTracer from "imagetracerjs";
import { analyzeImageBackground } from "./background-policy.js";
import { detectBadge, isInTextBand } from "./badge-detect.js";
import { evaluateDiagnostics } from "./diagnostics.js";
import {
  analyzeSvgExport,
  createInlineDataUri,
  createReactComponent,
  formatExportBytes,
  optimizeSvgForExport,
} from "./export-utils.js";
import { classifyImageData } from "./image-classifier.js";
import {
  cleanupCanvas,
  cleanupImage,
  getTracingImageData,
  loadImage,
  loadWorkingImage,
  readFileIfTiff,
  validateImageFile,
} from "./image-prepare.js";
import {
  BACKGROUND_REMOVAL_PROFILES,
  TRACE_FIDELITY_MODES as FIDELITY_MODES,
  getExportStrategy,
  PRESET_CONFIGS,
  IMAGE_TRACER_PRESETS as PRESETS,
  resolvePreset,
} from "./presets.js";
import {
  assertRealVectorSvg,
  createImagePreservingSvg,
  detectBackgroundArtifacts,
  ensureSvgViewBox,
  isRasterBackedSvg,
  isLightFill,
  sanitizeAndOptimizeSvg,
  stripWhiteBackgroundFromSvg,
  validateSvgString,
} from "./svg-sanitize.js";
import { traceImageDataPipeline } from "./trace-pipeline.js";
import { ensureVtracerReady } from "./vtracer-trace.js";
import { createZipBlob } from "./zip-helper.js";

(() => {
  "use strict";

  const tracer = ImageTracer || window.ImageTracer;

  const CONFIG = Object.freeze({
    storageKey: "svg_converter_presets_v2",
    themeStorageKey: "theme-color-scheme",
    workingImageMaxDim: 2048,
    previewTraceMaxDim: 960,
    backgroundSampleSize: 16,
    backgroundThreshold: 64,
    maxFileSize: 8 * 1024 * 1024,
    maxBatchFiles: 12,
    minZoom: 0.5,
    maxZoom: 4,
    zoomStepButton: 0.25,
    zoomStepWheel: 0.1,
  });

  const ASSET_LABELS = Object.freeze({
    logo: "Logo or flat graphic",
    photo: "Photo or gradient-heavy image",
    drawing: "Illustration or drawing",
    lineart: "Line art",
    complex: "Detailed illustration",
    sticker: "Sticker or outlined illustration",
    badge: "Badge or circular emblem",
  });

  const COMFORT_COPY = Object.freeze({
    logo: "Flat graphic detected. Using clean path tracing.",
    drawing: "Illustration detected. Preserving drawn edges and simplified color regions.",
    lineart: "Line art detected. Prioritizing crisp strokes and clean contours.",
    photo: "Photo or gradient-heavy image. Using image-preserving SVG for visual fidelity.",
    complex: "Complex artwork detected. Using local high-fidelity quantized tracing.",
    sticker:
      "Sticker sheet detected. Using local high-fidelity quantized tracing with background-component filtering.",
    badge:
      "Detailed badge detected. Using local high-fidelity quantized path tracing with text preservation.",
  });

  const MOBILE_LAYOUT_QUERY = "(max-width: 680px)";

  const state = {
    queue: [],
    currentFileIndex: -1,
    currentSvgString: "",
    currentImgElement: null,
    activePresetName: "logo",
    recommendedPresetName: null,
    activeJobToken: 0,
    activeBatchToken: 0,
    suppressRetrace: false,
    isBatchRunning: false,
    zoom: 1,
    panX: 0,
    panY: 0,
    isPanning: false,
    pointerId: null,
    pointerStartX: 0,
    pointerStartY: 0,
    panStartX: 0,
    panStartY: 0,
    zoomPanRafId: 0,
    theme: "light",
    themePreference: "system",
    memoryStore: new Map(),
    conversionDebounceId: 0,
    dropZoneState: "idle", // idle, dragover, loading, preparing, analyzing, tracing, rendering, complete
    detectedAssetType: null,
    // User-chosen tracing fidelity for complex/badge assets (Balanced/High/
    // Ultra). Defaults to High; only surfaced in the UI for complex assets.
    badgeFidelity: "high",
    optimizationMode: "balanced",
    previewCheckerboard: false,
    // Badge/vector development mode. In vector-only mode, badge/emblem assets
    // keep the best real path trace even if quality gates say it needs work.
    badgeVectorMode: "vector-only", // auto, vector-only, wrapper-only
    activeControlPresetName: "logo",
    pendingPresetName: "",
    activeNavId: "upload",
    activePanelId: "source",
  };

  function getRequiredElement(selector, label) {
    const el = document.querySelector(selector);
    if (!el) {
      throw new Error(`Required element missing: ${label} (${selector}).`);
    }
    return el;
  }

  const dom = {
    // Critical elements (resolved up-front in resolveCriticalRefs)
    dropZone: null,
    fileInput: null,
    originalPane: null,
    vectorPane: null,
    downloadVectorBtn: null,
    themeToggleBtn: null,

    // Scattered elements cached at startup
    controlSafetyNote: document.querySelector("#control-safety-note"),
    exportReadyState: document.querySelector("#export-ready-state"),
    formatLabel: document.querySelector(".export-format-label"),
    readyBadge: document.querySelector(".export-ready-badge"),
    readyNote: document.querySelector(".export-ready-note"),
    presetGuidanceBox: document.querySelector("#preset-guidance-box"),
    sourceRail: document.querySelector(".source-rail"),
    editorCanvas: document.querySelector(".editor-canvas"),
    inspectorRail: document.querySelector(".inspector-rail"),
    exportBar: document.querySelector(".export-bar"),
    assetSummaryType: document.querySelector("#asset-summary .asset-type"),
    assetSummaryDetail: document.querySelector("#asset-summary .asset-detail"),
    assetSummaryComfort: document.querySelector("#asset-summary .comfort-note"),
    assetSummaryStrategy: document.querySelector("#asset-summary .strategy-badge"),

    // Optional elements remain nullable; the app degrades gracefully if absent.
    landingScreen: document.querySelector("#welcome-screen"),
    landingDropZone: document.querySelector("#landing-drop-zone"),
    landingBrowseBtn: document.querySelector("#landing-browse-btn"),
    enterAppBtn: document.querySelector("#enter-app-btn"),
    appGrid: document.querySelector("#app-grid"),
    topFileStatus: document.querySelector("#top-file-status"),

    comparisonBox: document.querySelector("#comparison-box"),

    zoomInBtn: document.querySelector("#zoom-in-btn"),
    zoomOutBtn: document.querySelector("#zoom-out-btn"),
    zoomResetBtn: document.querySelector("#zoom-reset-btn"),
    previewBgToggle: document.querySelector("#preview-bg-toggle"),
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
    fidelityToggle: document.querySelector("#fidelity-toggle"),
    optimizationToggle: document.querySelector("#optimization-toggle"),

    batchQueueSection: document.querySelector("#batch-queue"),
    queueList: document.querySelector("#queue-list"),
    downloadOptions: document.querySelector("#download-options"),
    downloadZipBtn: document.querySelector("#download-zip-btn"),
    downloadOptimizedSvgBtn: document.querySelector("#download-optimized-svg-btn"),
    copySvgMarkupBtn: document.querySelector("#copy-svg-markup-btn"),
    copyReactComponentBtn: document.querySelector("#copy-react-component-btn"),
    copyDataUriBtn: document.querySelector("#copy-data-uri-btn"),
    exportStatePill: document.querySelector("#export-state-pill"),
    exportMetaFormat: document.querySelector("#export-meta-format"),
    exportMetaPaths: document.querySelector("#export-meta-paths"),
    exportMetaColors: document.querySelector("#export-meta-colors"),
    exportMetaEngine: document.querySelector("#export-meta-engine"),
    exportSizeOriginal: document.querySelector("#export-size-original"),
    exportSizeSvg: document.querySelector("#export-size-svg"),
    exportSizeOptimized: document.querySelector("#export-size-optimized"),
    exportSizeMeterFill: document.querySelector("#export-size-meter-fill"),
    exportPalette: document.querySelector("#export-palette"),
    exportWarnings: document.querySelector("#export-warnings"),
    toastRegion: document.querySelector("#toast-region"),

    metricOriginalSize: document.querySelector("#metric-original-size"),
    metricSvgSize: document.querySelector("#metric-svg-size"),
    metricCompression: document.querySelector("#metric-compression"),
    metricTime: document.querySelector("#metric-time"),
    metricColors: document.querySelector("#metric-colors"),
    metricPaths: document.querySelector("#metric-paths"),
    metricStrategy: document.querySelector("#metric-strategy"),
    metricStrategyWrapper: document.querySelector("#metric-strategy-wrapper"),

    announcer: document.querySelector("#a11y-announcer"),
  };

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  // createEl deliberately does NOT support raw HTML injection. Only text,
  // class names, attributes, and pre-built child nodes are allowed so untrusted
  // strings can never become live markup. Sanitized SVG parsing happens only in
  // renderSvg() via DOMParser.
  function createEl(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
      if (key === "className") el.className = value;
      else if (key === "text") el.textContent = value;
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

  function sanitizeComponentName(name) {
    const base = String(name || "VectorArtwork")
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");
    const safe = base || "VectorArtwork";
    return /^[A-Za-z]/.test(safe) ? safe : `Vector${safe}`;
  }

  function announce(message) {
    if (!dom.announcer) return;
    dom.announcer.textContent = "";
    requestAnimationFrame(() => {
      dom.announcer.textContent = message;
    });
  }

  function updateDropZoneState(newState) {
    state.dropZoneState = newState;
    const zone = dom.dropZone;
    if (!zone) return;

    zone.setAttribute("data-state", newState);
    const statusEl = zone.querySelector(".drop-status");
    if (!statusEl) return;

    const messages = {
      idle: "",
      dragover: "Release to prepare your image",
      loading: "Reading image…",
      preparing: "Preparing preview…",
      analyzing: "Detecting image type…",
      tracing: "Building SVG…",
      rendering: "Rendering result…",
      complete: "SVG ready",
    };

    statusEl.textContent = messages[newState] || "";
    if (dom.topFileStatus && newState !== "idle" && newState !== "dragover") {
      dom.topFileStatus.textContent = messages[newState] || "Working";
    }
  }

  function updateExportReadyState(isReady) {
    const readyState = dom.exportReadyState;
    if (!readyState) return;
    if (isReady) {
      readyState.classList.remove("hidden");
      setText(dom.topFileStatus, "SVG ready");
    } else {
      readyState.classList.add("hidden");
      setText(dom.topFileStatus, "Awaiting source");
    }
  }

  function updateExportFormatState(item = null) {
    const formatLabel = dom.formatLabel;
    const readyBadge = dom.readyBadge;
    const readyNote = dom.readyNote;
    const isWrapper =
      item?.exportStrategy === "image-wrapper" || item?.exportStrategy === "image-wrapper-fallback";
    const needsRefinement = item?.exportStrategy === "quantized-path-trace-needs-refinement";
    const isOversized =
      item && item.svgSize && item.originalSize && item.svgSize > item.originalSize;
    const hasArtifacts = item && item.backgroundArtifactsDetected;
    const visualFailed = item && item.visualValidationFailed;

    const needsReview = isOversized || hasArtifacts || visualFailed;

    if (formatLabel) {
      formatLabel.textContent = isWrapper
        ? "Raster image embedded in SVG"
        : "Real Vector SVG (.svg)";
    }
    if (readyBadge) {
      if (needsReview) {
        readyBadge.textContent = "Needs review";
        readyBadge.classList.add("needs-review");
      } else {
        readyBadge.textContent = needsRefinement
          ? "Ready to export, needs refinement"
          : "Ready to export";
        readyBadge.classList.remove("needs-review");
      }
    }
    if (readyNote) {
      if (isWrapper) {
        readyNote.textContent = "This preserves pixels but is not editable vector paths.";
      } else {
        const warnings = [];
        if (isOversized) {
          warnings.push(
            `SVG size exceeds original raster size (compression is ${item.compressionRatio || "0.0"}x).`
          );
        }
        if (hasArtifacts) {
          warnings.push("Background artifacts or large pale polygons detected behind artwork.");
        }
        if (visualFailed) {
          warnings.push(
            "Visual validation detected significant differences from the original image."
          );
        }

        if (warnings.length > 0) {
          readyNote.textContent =
            "Warning: " +
            warnings.join(" ") +
            " Adjust vector settings or optimization modes to refine output.";
        } else if (needsRefinement) {
          readyNote.textContent =
            "Real vector output generated. Some lettering may need refinement.";
        } else {
          readyNote.textContent = "This SVG was generated locally as editable vector paths.";
        }
      }
    }
  }

  function setExportActionsEnabled(enabled) {
    [
      dom.downloadVectorBtn,
      dom.downloadOptimizedSvgBtn,
      dom.copySvgMarkupBtn,
      dom.copyReactComponentBtn,
      dom.copyDataUriBtn,
    ].forEach((button) => {
      if (button) button.disabled = !enabled;
    });

    if (dom.downloadZipBtn) {
      dom.downloadZipBtn.disabled = countCompletedItems() < 2;
    }
  }

  function updateExportConsole(item = null) {
    const ready = Boolean(item?.status === "completed" && item.svgString);
    setExportActionsEnabled(ready);

    if (!ready) {
      if (dom.exportStatePill) {
        dom.exportStatePill.textContent = "Locked";
        dom.exportStatePill.dataset.state = "locked";
      }
      setText(dom.topFileStatus, "Awaiting source");
      setText(dom.exportMetaFormat, "-");
      setText(dom.exportMetaPaths, "-");
      setText(dom.exportMetaColors, "-");
      setText(dom.exportMetaEngine, "-");
      setText(dom.exportSizeOriginal, "-");
      setText(dom.exportSizeSvg, "-");
      setText(dom.exportSizeOptimized, "-");
      if (dom.exportSizeMeterFill) dom.exportSizeMeterFill.style.width = "0%";
      renderExportPalette([]);
      if (dom.exportWarnings) {
        dom.exportWarnings.textContent = "";
        dom.exportWarnings.appendChild(
          createEl("div", {
            className: "export-warning export-warning-muted",
            text: "Run conversion",
          })
        );
      }
      return;
    }

    const analysis = analyzeSvgExport(item.svgString, item);
    const isWrapper =
      item.exportStrategy === "image-wrapper" || item.exportStrategy === "image-wrapper-fallback";

    if (dom.exportStatePill) {
      dom.exportStatePill.textContent = analysis.warnings.length ? "Review" : "Ready";
      dom.exportStatePill.dataset.state = analysis.warnings.length ? "review" : "ready";
    }
    setText(dom.topFileStatus, analysis.warnings.length ? "SVG needs review" : "SVG ready");

    setText(dom.exportMetaFormat, isWrapper ? "SVG wrapper" : "Vector SVG");
    setText(
      dom.exportMetaPaths,
      Number.isFinite(analysis.pathCount) && analysis.pathCount > 0
        ? analysis.pathCount.toLocaleString()
        : isWrapper
          ? "N/A"
          : "0"
    );
    setText(dom.exportMetaColors, analysis.palette.length ? String(analysis.palette.length) : "—");
    setText(dom.exportMetaEngine, item.traceEngine ? getStrategyLabel(item.traceEngine) : "Local");
    setText(dom.exportSizeOriginal, formatExportBytes(analysis.originalSize));
    setText(dom.exportSizeSvg, formatExportBytes(analysis.svgSize));
    setText(dom.exportSizeOptimized, formatExportBytes(analysis.optimizedSize));

    if (dom.exportSizeMeterFill) {
      const ratio = analysis.originalSize
        ? Math.min(100, (analysis.svgSize / analysis.originalSize) * 100)
        : 0;
      dom.exportSizeMeterFill.style.width = `${Math.max(4, ratio).toFixed(0)}%`;
    }

    renderExportPalette(analysis.palette);
    renderExportWarnings(analysis.warnings);
  }

  function setText(el, value) {
    if (el) el.textContent = value;
  }

  function renderExportPalette(palette) {
    if (!dom.exportPalette) return;
    dom.exportPalette.textContent = "";
    if (!palette.length) {
      dom.exportPalette.appendChild(
        createEl("span", { className: "palette-empty", text: "No colors detected yet" })
      );
      return;
    }

    palette.forEach((color) => {
      const swatch = createEl("span", {
        className: "palette-swatch",
        title: color.hex,
        "aria-label": color.hex,
      });
      swatch.style.background = color.hex;
      dom.exportPalette.appendChild(swatch);
    });
  }

  function renderExportWarnings(warnings) {
    if (!dom.exportWarnings) return;
    dom.exportWarnings.textContent = "";
    if (!warnings.length) {
      dom.exportWarnings.appendChild(
        createEl("div", {
          className: "export-warning export-warning-ok",
          text: "No export warnings detected.",
        })
      );
      return;
    }

    warnings.slice(0, 5).forEach((warning) => {
      const row = createEl("div", {
        className: `export-warning export-warning-${warning.level}`,
      });
      row.append(
        createEl("strong", { text: warning.title }),
        createEl("span", { text: warning.detail })
      );
      dom.exportWarnings.appendChild(row);
    });
  }

  function showToast(message, tone = "success") {
    if (!dom.toastRegion) return;
    const toast = createEl("div", {
      className: `toast toast-${tone}`,
      role: "status",
      text: message,
    });
    dom.toastRegion.appendChild(toast);
    setTimeout(() => toast.classList.add("is-leaving"), 2600);
    setTimeout(() => toast.remove(), 3100);
  }

  async function copyTextToClipboard(text, successMessage) {
    if (!text) return;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
        showToast(successMessage);
        announce(successMessage);
        return;
      }
    } catch (err) {
      console.warn("navigator.clipboard failed, falling back", err);
    }

    // Fallback for insecure contexts or unsupported navigator.clipboard
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.top = "0";
      textArea.style.left = "0";
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const successful = document.execCommand("copy");
      document.body.removeChild(textArea);
      if (successful) {
        showToast(successMessage);
        announce(successMessage);
      } else {
        throw new Error("execCommand copy returned false");
      }
    } catch (err) {
      console.error("Clipboard copy failed completely", err);
      showToast("Failed to copy to clipboard. Please select and copy manually.", "error");
    }
  }

  function updateControlSafetyNote(profile) {
    const noteEl = dom.controlSafetyNote;
    if (!noteEl) return;

    if (!profile || profile.type !== "photo") {
      noteEl.hidden = true;
      noteEl.textContent = "";
      return;
    }

    noteEl.hidden = false;
    noteEl.textContent =
      "Note: Trace controls apply to path-based SVG output. This image is using visual fidelity SVG export, so sliders won't affect the result.";
  }

  function showWorkspace() {
    dom.landingScreen?.classList.add("hidden");
    dom.appGrid?.classList.remove("hidden");
    document.body.setAttribute("data-app-state", "workspace");
    dom.dropZone?.focus({ preventScroll: true });
  }

  function setTheme(preference, save = true) {
    const resolved =
      preference === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : preference;

    state.themePreference = preference;
    state.theme = resolved;
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.style.colorScheme = resolved;

    if (save) safeStorageSet(CONFIG.themeStorageKey, preference);
    updateThemeIcon(resolved);
  }

  function updateThemeIcon(theme) {
    if (!dom.themeToggleBtn) return;
    dom.themeToggleBtn.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
    );

    // Built-in static icon markup (no untrusted input). Rebuild via DOM nodes
    // rather than innerHTML to keep a single sanitized-injection boundary.
    dom.themeToggleBtn.textContent = "";
    dom.themeToggleBtn.appendChild(theme === "dark" ? buildSunIcon() : buildMoonIcon());
  }

  function svgNode(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  }

  function buildSunIcon() {
    const svg = svgNode("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    svg.appendChild(svgNode("circle", { cx: "12", cy: "12", r: "4" }));
    svg.appendChild(
      svgNode("path", {
        d: "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41",
      })
    );
    return svg;
  }

  function buildMoonIcon() {
    const svg = svgNode("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    svg.appendChild(svgNode("path", { d: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" }));
    return svg;
  }

  function initTheme() {
    const saved = safeStorageGet(CONFIG.themeStorageKey) || "system";
    setTheme(saved, false);

    // Toggling flips the resolved appearance and persists a concrete
    // light/dark preference, so a resolved "dark" is never mistaken for the
    // stored "system" value on reload.
    dom.themeToggleBtn.addEventListener("click", () => {
      setTheme(state.theme === "dark" ? "light" : "dark", true);
    });
  }

  function setActiveHeaderNav(navId) {
    state.activeNavId = navId;
    document.querySelectorAll(".header-nav-btn[data-nav-id]").forEach((button) => {
      const isActive = button.getAttribute("data-nav-id") === navId;
      button.classList.toggle("active", isActive);
      if (isActive) {
        button.setAttribute("aria-current", "true");
      } else {
        button.removeAttribute("aria-current");
      }
    });
  }

  function setActiveMobilePanel(panelId) {
    state.activePanelId = panelId;
    dom.appGrid?.setAttribute("data-active-panel", panelId);
    syncMobilePanelState(panelId);
    document.querySelectorAll(".mobile-panel-tab[data-panel-target]").forEach((button) => {
      const isActive = button.getAttribute("data-panel-target") === panelId;
      button.classList.toggle("active", isActive);
      if (isActive) {
        button.setAttribute("aria-current", "true");
      } else {
        button.removeAttribute("aria-current");
      }
    });
  }

  function getPanelIdForNav(navId) {
    if (navId === "upload") return "source";
    if (navId === "preview") return "preview";
    if (navId === "export") return "export";
    return "source";
  }

  function getNavIdForPanel(panelId) {
    if (panelId === "source") return "upload";
    if (panelId === "preview") return "preview";
    if (panelId === "export") return "export";
    return "upload";
  }

  function isMobilePanelLayout() {
    return window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
  }

  function getPanelElement(panelId) {
    if (panelId === "source") return dom.sourceRail;
    if (panelId === "preview") return dom.editorCanvas;
    if (panelId === "presets") return dom.inspectorRail;
    if (panelId === "export") return dom.exportBar;
    return null;
  }

  function syncMobilePanelState(activePanelId) {
    if (!isMobilePanelLayout()) {
      ["source", "preview", "presets", "export"].forEach((panelId) => {
        const panel = getPanelElement(panelId);
        if (!panel) return;
        panel.classList.remove("is-panel-active", "is-panel-inactive");
        panel.removeAttribute("aria-hidden");
      });
      return;
    }

    ["source", "preview", "presets", "export"].forEach((panelId) => {
      const panel = getPanelElement(panelId);
      if (!panel) return;
      const isActive = panelId === activePanelId;
      panel.classList.toggle("is-panel-active", isActive);
      panel.classList.toggle("is-panel-inactive", !isActive);
      panel.setAttribute("aria-hidden", isActive ? "false" : "true");
    });
  }

  function revealActiveMobilePanel(panelId) {
    if (!isMobilePanelLayout()) return;
    const panel = getPanelElement(panelId);
    if (!panel) return;
    requestAnimationFrame(() => {
      panel.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
    });
  }

  function setupHeaderNavigation() {
    const navButtons = Array.from(document.querySelectorAll(".header-nav-btn[data-nav-target]"));
    const navTargets = navButtons
      .map((button) => {
        const selector = button.getAttribute("data-nav-target");
        const target = selector ? document.querySelector(selector) : null;
        return target ? { button, target } : null;
      })
      .filter(Boolean);

    navButtons.forEach((button) => {
      button.addEventListener("click", () => {
        if (dom.appGrid?.classList.contains("hidden")) {
          showWorkspace();
        }

        const navTarget = navTargets.find((nt) => nt.button === button);
        const target = navTarget?.target;
        if (!target) return;
        const navId = button.getAttribute("data-nav-id") || "upload";
        setActiveHeaderNav(navId);
        const panelId = getPanelIdForNav(navId);
        setActiveMobilePanel(panelId);

        if (isMobilePanelLayout()) {
          revealActiveMobilePanel(panelId);
          return;
        }

        target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    if (!navTargets.length || !("IntersectionObserver" in window)) {
      setActiveHeaderNav(state.activeNavId);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;

        const match = navTargets.find(({ target }) => target === visible.target);
        if (match) {
          const navId = match.button.getAttribute("data-nav-id") || "upload";
          setActiveHeaderNav(navId);
          setActiveMobilePanel(getPanelIdForNav(navId));
        }
      },
      {
        root: null,
        threshold: [0.15, 0.35, 0.55, 0.75],
        rootMargin: "-20% 0px -55% 0px",
      }
    );

    navTargets.forEach(({ target }) => observer.observe(target));
    state.headerNavObserver = observer;
    setActiveHeaderNav(state.activeNavId);
    setActiveMobilePanel(state.activePanelId);
  }

  function setupMobilePanelTabs() {
    document.querySelectorAll(".mobile-panel-tab[data-panel-target]").forEach((button) => {
      button.addEventListener("click", () => {
        const panelId = button.getAttribute("data-panel-target") || "source";
        setActiveMobilePanel(panelId);
        setActiveHeaderNav(getNavIdForPanel(panelId));
        revealActiveMobilePanel(panelId);
      });
    });
  }

  function setupScrollReactiveHeader() {
    let ticking = false;
    const threshold = 20;

    const applyScrollState = () => {
      const compact = window.scrollY > threshold;
      document.body.setAttribute("data-scroll-state", compact ? "compact" : "expanded");
      ticking = false;
    };

    window.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(applyScrollState);
      },
      { passive: true }
    );

    applyScrollState();
  }

  // Cheap pre-pass classifier to pick a tracing profile. Run on the original
  // source before background removal so the decision is not biased by it.
  function detectAssetProfileFromImage(imgEl) {
    const w = imgEl.naturalWidth || imgEl.width || 1;
    const h = imgEl.naturalHeight || imgEl.height || 1;
    const sampleW = Math.min(180, w);
    const sampleH = Math.max(1, Math.min(180, Math.round((h / w) * sampleW)));
    const canvas = document.createElement("canvas");
    canvas.width = sampleW;
    canvas.height = sampleH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      return {
        type: "drawing",
        subtype: null,
        badgeSignals: null,
        width: w,
        height: h,
        uniqueColors: 0,
        edgeDensity: 0,
        transparentRatio: 0,
      };
    }

    try {
      ctx.drawImage(imgEl, 0, 0, sampleW, sampleH);
      const imageData = ctx.getImageData(0, 0, sampleW, sampleH);
      const result = classifyImageData(imageData);

      let type = result.type;
      if (result.subtype === "badge" || result.subtype === "emblem") {
        type = "badge";
      }

      return {
        type,
        subtype: result.subtype,
        badgeSignals: result.badgeSignals,
        width: w,
        height: h,
        uniqueColors: result.uniqueColors,
        edgeDensity: Math.round(result.edgeDensity * 100),
        transparentRatio: Math.round(result.transparentRatio * 100),
      };
    } finally {
      cleanupCanvas(canvas);
    }
  }

  // Classify the raw source before any preprocessing so background removal can
  // be skipped for photo-like content (see BACKGROUND_REMOVAL_PROFILES).
  async function detectSourceProfile(file, fileData) {
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
      return detectAssetProfileFromImage(source);
    } finally {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      if (source instanceof HTMLImageElement) cleanupImage(source);
      if (source instanceof HTMLCanvasElement) cleanupCanvas(source);
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
      roundcoords: normalized.highQuality ? 1 : 0,
      desc: false,
      viewbox: true,
      strokewidth: 0,
      lcpr: 0,
      qcpr: 0,
    };
  }

  const SVG_META = Object.freeze({
    title: "Vectorized image",
    description: "Auto-generated SVG output from the uploaded source image.",
  });

  function traceWithImageTracer(imageData, preset) {
    if (!tracer || typeof tracer.imagedataToSVG !== "function") {
      throw new Error("Vector tracer is unavailable.");
    }
    const rawSvg = tracer.imagedataToSVG(imageData, createTraceOptions(preset));
    return sanitizeAndOptimizeSvg(rawSvg, SVG_META);
  }

  // Trace using the highest-fidelity engine available for the profile. vtracer
  // (WASM) is preferred for detailed/flat-graphic profiles; if its module fails
  // to load or trace, we transparently fall back to imagetracerjs so the app
  // never hard-fails on an engine problem. Both outputs pass through the same
  // sanitizer before they can reach the DOM.
  async function performVectorConversion(img, profile, options = {}) {
    const context = options.context || resolveConversionContext(getCurrentItem(), options);
    const { presetId, config, controls } = context;

    // Get ImageData from working image
    const isBadgeMode =
      config.id === "badge" || profile?.type === "badge" || profile?.subtype === "badge";
    const maxDim = options.maxDim || (isBadgeMode ? 1024 : CONFIG.previewTraceMaxDim);

    // Fill white background for non-photo elements
    const sourceData = getTracingImageData(img, maxDim, false);
    const background = analyzeImageBackground(sourceData);
    const shouldPreserveSourceBackground =
      options.preserveBackground ?? background.hasUniformOpaqueBackground;

    const imgData =
      isBadgeMode || background.hasTransparentCorners || shouldPreserveSourceBackground
        ? sourceData
        : getTracingImageData(img, maxDim, true);

    // Run the unified trace pipeline
    const traced = await traceImageDataPipeline(imgData, {
      profile,
      presetId,
      fidelityMode: state.badgeFidelity,
      optimizationMode: state.optimizationMode,
      allowImageTracerFallback: true,
      sanitizeSvg: (svg) =>
        sanitizeAndOptimizeSvg(svg, {
          ...SVG_META,
          profileType: config.id,
          optimizationMode: state.optimizationMode,
          preserveBackground: Boolean(options.preserveBackground),
        }),
      stripWhiteBackground: stripWhiteBackgroundFromSvg,
      tightenSvgViewBoxToContent: tightenSvgViewBoxToContent,
      traceWithImageTracer,
      preset: controls,
    });

    // Handle photo / image-wrapper case
    if (traced.strategy === "image-wrapper") {
      const svgString = createImagePreservingSvg(
        options.dataUrl || img.src,
        options.width || img.naturalWidth || img.width,
        options.height || img.naturalHeight || img.height,
        {
          title: "Image preserved as SVG",
          description:
            "Photo or gradient-heavy image preserved as an embedded SVG for visual fidelity.",
        }
      );

      const stats = { pathCount: 0, pathCommandCount: 0, invalidPathCount: 0 };
      const diag = evaluateDiagnostics(svgString, config, profile, stats, 0);

      return {
        svgString,
        strategy: "image-wrapper",
        engine: "image-wrapper",
        pathCount: 0,
        fillColorCount: 0,
        textWarning: false,
        textWarningReason: "",
        diagnostics: diag,
      };
    }

    if (shouldUseImageWrapperFallback(traced, config, profile) && options.dataUrl) {
      const svgString = createImagePreservingSvg(
        options.dataUrl || img.src,
        options.width || img.naturalWidth || img.width,
        options.height || img.naturalHeight || img.height,
        {
          title: "Image preserved as SVG",
          description:
            "Path tracing produced an incomplete result, so the source image was preserved inside an SVG for visual fidelity.",
        }
      );

      const stats = { pathCount: 0, pathCommandCount: 0, invalidPathCount: 0 };
      const wrapperConfig = resolvePreset("photo") || config;
      const diag = evaluateDiagnostics(svgString, wrapperConfig, profile, stats, 0);

      return {
        svgString,
        strategy: "image-wrapper-fallback",
        engine: "image-wrapper",
        pathCount: 0,
        fillColorCount: 0,
        textWarning: false,
        textWarningReason: "",
        diagnostics: diag,
        fallbackReason: "collapsed-vector-trace",
      };
    }

    // Run diagnostics
    const stats = {
      pathCount: traced.pathCount,
      pathCommandCount: traced.pathCommandCount,
      invalidPathCount: traced.invalidPathCount,
    };
    const diag = evaluateDiagnostics(
      traced.svgString,
      config,
      profile,
      stats,
      traced.fillColorCount
    );

    return {
      svgString: traced.svgString,
      strategy: traced.strategy,
      engine: traced.engine,
      pathCount: traced.pathCount,
      fillColorCount: traced.fillColorCount,
      textWarning: traced.textWarning,
      textWarningReason: traced.textWarningReason,
      diagnostics: diag,
      masked: traced.masked,
      transparentSource: traced.transparentSource,
      fallbackReason: "",
    };
  }

  function shouldUseImageWrapperFallback(traced, config, profile) {
    if (!traced || !config?.diagnostics?.rasterFallbackPermission) return false;
    if (isRasterBackedSvg(traced.svgString)) return false;

    const pathCount = Number(traced.pathCount || 0);
    const fillColorCount = Number(traced.fillColorCount || 0);
    const sourceComplexity = Math.max(
      Number(profile?.edgeDensity || 0),
      Number(profile?.uniqueColors || 0) / 12
    );

    const expectedMinPaths =
      config.id === "sticker" ? 18 : config.id === "complex" ? 24 : 12;
    const expectedMinColors =
      config.id === "sticker" ? 6 : config.id === "complex" ? 10 : 4;

    const collapsedShapeField = pathCount > 0 && pathCount < expectedMinPaths;
    const collapsedPalette = fillColorCount > 0 && fillColorCount < expectedMinColors;
    const detailedSource = sourceComplexity >= 8 || profile?.type === "complex";

    return detailedSource && (collapsedShapeField || collapsedPalette);
  }

  // Tighten an SVG's viewBox to the bounding box of its rendered geometry. For
  // a masked badge the traced disc sits inside a transparent square; cropping
  // the viewBox to the artwork removes the empty margin so the badge fills the
  // preview/export instead of floating in a beige square. Uses getBBox on a
  // temporarily-attached (off-screen) clone, falling back to the original SVG
  // string if measurement is unavailable (e.g. no layout engine).
  function tightenSvgViewBoxToContent(svgString, padRatio = 0.02) {
    if (!svgString) return svgString;
    if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined" || typeof document === "undefined") {
      return svgString;
    }
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(svgString, "image/svg+xml");
      if (doc.querySelector("parsererror")) return svgString;
      const svg = doc.documentElement;
      if (!svg || svg.nodeName.toLowerCase() !== "svg") return svgString;

      const measured = document.importNode(svg, true);
      measured.setAttribute("width", "0");
      measured.setAttribute("height", "0");
      measured.style.position = "absolute";
      measured.style.left = "-99999px";
      measured.style.top = "-99999px";
      measured.style.visibility = "hidden";
      document.body.appendChild(measured);

      let bbox;
      try {
        bbox = measured.getBBox();
      } finally {
        measured.remove();
      }

      if (!bbox || bbox.width <= 0 || bbox.height <= 0) return svgString;

      const padX = bbox.width * padRatio;
      const padY = bbox.height * padRatio;
      const vbX = bbox.x - padX;
      const vbY = bbox.y - padY;
      const vbW = bbox.width + padX * 2;
      const vbH = bbox.height + padY * 2;

      svg.setAttribute(
        "viewBox",
        `${trimNum(vbX)} ${trimNum(vbY)} ${trimNum(vbW)} ${trimNum(vbH)}`
      );
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      return new XMLSerializer().serializeToString(svg);
    } catch (error) {
      console.warn("viewBox tightening skipped:", error);
      return svgString;
    }
  }

  function trimNum(n) {
    return Number(n.toFixed(2));
  }

  // Quality score for a traced badge. Returns the metrics plus a boolean
  // verdict on whether the trace is good enough to ship. A bad badge trace
  // collapses to a blob (few paths/colors), loses its cream/white text paths,
  // or is dominated by one giant background-like path.
  //
  // Crucially this also measures the LOWER TEXT BAND specifically: a badge can
  // have a high overall path count and still have collapsed lettering, so the
  // global counts alone are not proof of text quality. When zones are supplied
  // and getBBox is available, count the light (cream/white) paths whose bounding
  // box centre lands in the lower text band — that is the real text signal.
  function badgeErrorResult(reason) {
    return {
      acceptable: false,
      reason,
      pathCount: 0,
      fillColorCount: 0,
      lightPathCount: 0,
      textBandLightPaths: 0,
      textWarning: true,
      vectorUsable: false,
      qualityGateResults: {
        minPaths: false,
        minFillColors: false,
        hasLightPaths: false,
        backgroundOk: false,
        textBandOk: false,
        vectorMinimum: false,
        noRaster: false,
      },
    };
  }

  // and getBBox is available, count the light (cream/white) paths whose bounding
  // box centre lands in the lower text band — that is the real text signal.
  function scoreBadgeOutput(svgString, modeCfg, zones = null) {
    if (typeof DOMParser === "undefined") {
      return badgeErrorResult("parse-error");
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, "image/svg+xml");
    if (doc.querySelector("parsererror")) {
      return badgeErrorResult("parse-error");
    }
    const paths = [...doc.querySelectorAll("path")];
    const pathCount = paths.length;

    const fills = new Set();
    let lightPathCount = 0;
    let largeBackgroundPaths = 0;
    paths.forEach((p) => {
      const fill = (p.getAttribute("fill") || "").trim().toLowerCase();
      if (fill && fill !== "none") {
        fills.add(fill);
        if (isLightFill(fill)) lightPathCount++;
      }
      // A path whose command string is very long AND fill is light is likely a
      // big background slab rather than artwork detail.
      const d = p.getAttribute("d") || "";
      if (d.length > 4000 && isLightFill(fill)) largeBackgroundPaths++;
    });
    const fillColorCount = fills.size;

    const textBandLightPaths = countTextBandLightPaths(doc, paths, zones);

    // A real "COOKIE MIKE" arc is many small cream glyph paths. If the band is
    // present (zones known) but yields too few light paths, the type collapsed.
    const textWarning = zones != null && textBandLightPaths >= 0 && textBandLightPaths < 4;
    const noRaster = !isRasterBackedSvg(svgString);
    const qualityGateResults = {
      minPaths: pathCount >= modeCfg.fallbackMinPaths,
      minFillColors: fillColorCount >= modeCfg.fallbackMinColors,
      hasLightPaths: lightPathCount >= 1,
      backgroundOk: largeBackgroundPaths <= 2,
      textBandOk: zones == null || textBandLightPaths < 0 || textBandLightPaths >= 4,
      // Low-colour black/cream/green badges can be valid vectors with only a
      // few fills. This is the hard floor for keeping an imperfect real vector.
      vectorMinimum: pathCount > 40 && fillColorCount > 4,
      noRaster,
    };

    const acceptable =
      qualityGateResults.minPaths &&
      qualityGateResults.minFillColors &&
      qualityGateResults.hasLightPaths &&
      qualityGateResults.backgroundOk &&
      qualityGateResults.noRaster;
    const vectorUsable =
      qualityGateResults.vectorMinimum &&
      qualityGateResults.hasLightPaths &&
      qualityGateResults.backgroundOk &&
      qualityGateResults.noRaster;

    let reason = "ok";
    if (!qualityGateResults.noRaster) reason = "raster-backed-svg";
    else if (pathCount < modeCfg.fallbackMinPaths) reason = "too-few-paths";
    else if (fillColorCount < modeCfg.fallbackMinColors) reason = "too-few-fill-colors";
    else if (lightPathCount < 1) reason = "lost-light-text";
    else if (largeBackgroundPaths > 2) reason = "background-dominated";
    else if (textWarning) reason = "text-band-quality-failed";

    return {
      acceptable,
      reason,
      pathCount,
      fillColorCount,
      lightPathCount,
      textBandLightPaths,
      textWarning,
      vectorUsable,
      qualityGateResults,
    };
  }

  function getBadgeVectorCandidates() {
    // Text-preserving candidates: minimal speckle, tight corner/splice/length
    // thresholds so curved glyph contours survive the trace. Spread mode defaults
    // first so per-candidate values always win (correct override order).
    const textCandidates = [
      {
        name: "badgeTextA",
        paletteSize: 8,
        filterSpeckle: 0,
        colorPrecision: 6,
        cornerThreshold: 45,
        lengthThreshold: 2,
        spliceThreshold: 30,
        pathPrecision: 8,
      },
      {
        name: "badgeTextB",
        paletteSize: 12,
        filterSpeckle: 0,
        colorPrecision: 6,
        cornerThreshold: 50,
        lengthThreshold: 2,
        spliceThreshold: 35,
        pathPrecision: 8,
      },
      {
        name: "badgeTextC",
        paletteSize: 16,
        filterSpeckle: 0,
        colorPrecision: 6,
        cornerThreshold: 60,
        lengthThreshold: 2.5,
        spliceThreshold: 40,
        pathPrecision: 8,
      },
    ].map((c) => ({
      ...FIDELITY_MODES.badgeMonoHigh,
      // Per-candidate values spread last — they must win over mode defaults.
      ...c,
      fallbackMinPaths: FIDELITY_MODES.badgeMonoHigh.fallbackMinPaths,
      fallbackMinColors: FIDELITY_MODES.badgeMonoHigh.fallbackMinColors,
      preserveDarkLightAnchors: true,
      preserveGreenAccent: true,
      textBandProtection: true,
    }));

    // General-fidelity candidates (existing set). Same merge order: mode defaults
    // first, then per-candidate overrides win.
    const generalCandidates = [
      { name: "badgeMonoHigh-8", paletteSize: 8, filterSpeckle: 0, colorPrecision: 6 },
      { name: "badgeMonoHigh-12", paletteSize: 12, filterSpeckle: 0, colorPrecision: 6 },
      { name: "badgeMonoHigh-16", paletteSize: 16, filterSpeckle: 0, colorPrecision: 6 },
      { name: "badgeHigh-48", paletteSize: 48, filterSpeckle: 1, colorPrecision: 5 },
      { name: "badgeUltra-64", paletteSize: 64, filterSpeckle: 0, colorPrecision: 4 },
    ].map((candidate) => ({
      ...FIDELITY_MODES.badgeMonoHigh,
      // Per-candidate values spread last so they win over mode defaults.
      ...candidate,
      fallbackMinPaths:
        candidate.paletteSize <= 16
          ? FIDELITY_MODES.badgeMonoHigh.fallbackMinPaths
          : candidate.paletteSize === 48
            ? FIDELITY_MODES.badgeHigh.fallbackMinPaths
            : FIDELITY_MODES.badgeUltra.fallbackMinPaths,
      fallbackMinColors:
        candidate.paletteSize <= 16
          ? FIDELITY_MODES.badgeMonoHigh.fallbackMinColors
          : candidate.paletteSize === 48
            ? FIDELITY_MODES.badgeHigh.fallbackMinColors
            : FIDELITY_MODES.badgeUltra.fallbackMinColors,
      preserveDarkLightAnchors: true,
      preserveGreenAccent: true,
      textBandProtection: true,
    }));

    return [...textCandidates, ...generalCandidates];
  }

  function scoreCandidateForSelection(candidate) {
    if (!candidate.svgString || candidate.parserError || candidate.rasterBacked) return -Infinity;
    const textBand = Math.max(0, candidate.textBandLightPaths || 0);
    const paths = Math.max(0, candidate.pathCount || 0);
    const fills = Math.max(0, candidate.fillColorCount || 0);
    const sizePenalty = Math.max(0, candidate.svgSize || 0) / 60000;
    // Text-band score is the dominant term. A trace with readable lettering wins
    // over one with more total paths but collapsed text. Path count is a tiebreaker
    // only — a 983-path SVG must not outrank an 80-path SVG with legible glyphs.
    return (
      textBand * 200 +
      (candidate.acceptable ? 1000 : 0) +
      (candidate.vectorUsable ? 500 : 0) +
      fills * 5 +
      paths * 0.5 -
      sizePenalty
    );
  }

  function getBestRealVectorCandidate(candidates) {
    return (
      candidates
        .filter(
          (candidate) => candidate.svgString && !candidate.rasterBacked && candidate.pathCount > 0
        )
        .sort((a, b) => b.selectionScore - a.selectionScore)[0] || null
    );
  }

  function getFallbackRealVectorCandidate(candidates) {
    return (
      candidates
        .filter(
          (candidate) => candidate.svgString && !candidate.rasterBacked && candidate.pathCount > 0
        )
        .sort((a, b) => {
          const aPaths = Number(a.pathCount || 0);
          const bPaths = Number(b.pathCount || 0);
          const aSize = Number(a.svgSize || 0);
          const bSize = Number(b.svgSize || 0);
          return bPaths - aPaths || bSize - aSize;
        })[0] || null
    );
  }

  // Count light-filled paths whose bounding-box centre lands in the badge's
  // lower text band. Returns -1 when measurement is unavailable (no zones, no
  // getBBox, or no viewBox) so callers can treat it as "unknown" rather than 0.
  function countTextBandLightPaths(doc, paths, zones) {
    if (!zones) return -1;
    const svg = doc.documentElement;
    const vb = (svg.getAttribute("viewBox") || "").split(/[ ,]+/).map(Number);
    if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) return -1;
    const [vx, vy, vw, vh] = vb;
    if (vw <= 0 || vh <= 0) return -1;

    // The viewBox is tightened to the badge disc, so the badge centre is the
    // viewBox centre and the radius is half the smaller dimension.
    const cx = vx + vw / 2;
    const cy = vy + vh / 2;
    const radius = Math.min(vw, vh) / 2;
    const band = zones.textBand;

    let measured = false;
    let count = 0;
    const probe = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    probe.setAttribute("width", "0");
    probe.setAttribute("height", "0");
    probe.style.position = "absolute";
    probe.style.left = "-99999px";
    probe.style.visibility = "hidden";
    probe.setAttribute("viewBox", `${vx} ${vy} ${vw} ${vh}`);
    document.body.appendChild(probe);
    try {
      for (const p of paths) {
        const fill = (p.getAttribute("fill") || "").trim().toLowerCase();
        if (!isLightFill(fill)) continue;
        const clone = document.importNode(p, true);
        probe.appendChild(clone);
        let bb;
        try {
          bb = clone.getBBox();
        } catch {
          probe.removeChild(clone);
          continue;
        }
        probe.removeChild(clone);
        measured = true;
        const pcx = bb.x + bb.width / 2;
        const pcy = bb.y + bb.height / 2;
        if (isInTextBand(pcx - cx, pcy - cy, radius, band)) count++;
      }
    } finally {
      probe.remove();
    }
    return measured ? count : -1;
  }



  function getActiveFidelityMode(profile = null) {
    // Badge/emblem complex assets use dedicated badge modes regardless of the
    // ImageTracer-oriented sliders: badges follow the dedicated fidelity toggle
    // (Clean/Balanced/Detailed/Ultra), defaulting to Detailed (high).
    if (profile?.subtype === "badge" || profile?.subtype === "emblem") {
      if (state.badgeFidelity === "clean") return "badgeClean";
      return state.badgeFidelity === "ultra" ? "badgeUltra" : "badgeHigh";
    }
    if (profile?.subtype === "sticker" || profile?.type === "sticker") {
      if (state.badgeFidelity === "clean") return "stickerClean";
      return state.badgeFidelity === "ultra" ? "stickerUltra" : "stickerHigh";
    }

    if (profile?.type === "complex" || profile?.type === "badge" || profile?.type === "sticker") {
      if (state.badgeFidelity === "clean") return "clean";
      if (state.badgeFidelity === "balanced") return "balanced";
      if (state.badgeFidelity === "ultra") return "ultra";
      return "high";
    }

    if (!dom.highQualityInput?.checked) {
      return "balanced";
    }
    const colorsVal = Number(dom.colorsInput?.value || 40);
    // Thresholds align with spec palette sizes: balanced<=28, high<=40, ultra>40
    if (colorsVal <= 28) return "balanced";
    if (colorsVal <= 40) return "high"; // 40 colors (complex preset default) = high mode
    return "ultra";
  }

  function renderOriginal(img) {
    dom.originalPane.textContent = "";
    const wrapper = createEl("div", { className: "zoom-wrapper" });
    wrapper.appendChild(img);
    dom.originalPane.appendChild(wrapper);
  }

  // renderSvg is the only place sanitized SVG markup is parsed back into live
  // DOM. The string has already passed through sanitizeAndOptimizeSvg().
  function renderSvg(svgString) {
    dom.vectorPane.textContent = "";
    dom.vectorPane.classList.add("preview-updating");

    // Show the transparent-canvas treatment (checkerboard + indicator) only for
    // outputs that genuinely have transparent regions: masked badges and
    // image-wrapper PNGs keep their backdrop, so they stay on the neutral pane.
    const transparent = Boolean(getCurrentItem()?.transparentBackground);
    dom.vectorPane.classList.toggle("pane-transparent", transparent);
    dom.vectorPane.classList.toggle("pane-checker-forced", state.previewCheckerboard);
    updateTransparentIndicator(transparent);

    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, "image/svg+xml");
    const parserError = doc.querySelector("parsererror");
    const svg = doc.documentElement;
    if (parserError || !svg || svg.nodeName.toLowerCase() !== "svg") {
      setPlaceholder(dom.vectorPane, "Error: Invalid SVG output generated.");
      dom.vectorPane.classList.remove("preview-updating");
      return;
    }

    ensureSvgViewBox(svg);

    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    const wrapper = createEl("div", { className: "zoom-wrapper" });
    wrapper.appendChild(svg);
    dom.vectorPane.appendChild(wrapper);

    requestAnimationFrame(() => {
      dom.vectorPane.classList.remove("preview-updating");
    });

    applyZoomPan();
  }

  // Toggle a small "Transparent background" chip on the vector preview card.
  // Built with DOM nodes; never injects markup.
  function updateTransparentIndicator(show) {
    const card = dom.vectorPane.closest(".preview-card");
    if (!card) return;
    const existing = card.querySelector(".transparent-indicator");
    if (!show) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const titleEl = card.querySelector(".preview-title");
    const chip = createEl("span", {
      className: "transparent-indicator",
      title: "Output has a transparent background",
      text: "Transparent background",
    });
    if (titleEl) titleEl.appendChild(chip);
    else card.appendChild(chip);
  }

  function setPlaceholder(pane, text) {
    pane.textContent = "";
    const placeholder = createEl("div", { className: "preview-placeholder", text });
    pane.appendChild(placeholder);
    pane.classList.add("preview-updating");
    requestAnimationFrame(() => {
      pane.classList.remove("preview-updating");
    });
  }

  function applyZoomPan() {
    // DEV smoke assertion — .zoom-wrapper nodes only appear after the workspace
    // is rendered (i.e. after resolveCriticalRefs + init). A non-empty list while
    // dom.vectorPane is still null means a caller site snuck in before init() ran.
    if (dom.vectorPane === null && document.querySelectorAll(".zoom-wrapper").length > 0) {
      throw new Error(
        "[VectorStudio DEV] applyZoomPan() called before resolveCriticalRefs(). " +
        "Move the call site into init() after resolveCriticalRefs()."
      );
    }
    document.querySelectorAll(".zoom-wrapper").forEach((el) => {
      el.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
      el.style.transformOrigin = "center center";
      el.style.willChange = state.isPanning || state.zoom !== 1 ? "transform" : "auto";
    });

    if (dom.zoomVal) dom.zoomVal.textContent = `${Math.round(state.zoom * 100)}%`;
  }

  // RAF-locked scheduler: high-frequency pointermove/wheel events coalesce into
  // a single transform write per frame instead of queueing one RAF callback per
  // event, which would otherwise pile up and jank the pan/zoom.
  function scheduleZoomPanRender() {
    if (state.zoomPanRafId) return;
    state.zoomPanRafId = requestAnimationFrame(() => {
      state.zoomPanRafId = 0;
      applyZoomPan();
    });
  }

  function resetZoomPan() {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    applyZoomPan();
  }

  // After a successful conversion, fit the vector so it fills roughly 83% of the
  // pane rather than defaulting to 1× (which often shows the badge at ~30%).
  // Falls back to resetZoomPan() if the pane has no dimensions yet.
  function fitZoomToContent() {
    const wrapper = dom.vectorPane.querySelector(".zoom-wrapper");
    const svgEl = wrapper?.querySelector("svg");
    if (!svgEl) {
      resetZoomPan();
      return;
    }

    const paneRect = dom.vectorPane.getBoundingClientRect();
    if (!paneRect.width || !paneRect.height) {
      resetZoomPan();
      return;
    }

    const vbParts = (svgEl.getAttribute("viewBox") || "").split(/[ ,]+/).map(Number);
    const svgW = vbParts.length === 4 && vbParts[2] > 0 ? vbParts[2] : paneRect.width;
    const svgH = vbParts.length === 4 && vbParts[3] > 0 ? vbParts[3] : paneRect.height;

    const TARGET_COVERAGE = 0.83;
    const fitZoom = Math.min(
      (paneRect.width * TARGET_COVERAGE) / svgW,
      (paneRect.height * TARGET_COVERAGE) / svgH
    );

    state.zoom = Math.min(CONFIG.maxZoom, Math.max(CONFIG.minZoom, fitZoom));
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
      scheduleZoomPanRender();
    });

    const endPan = (event) => {
      if (event.pointerId !== state.pointerId) return;
      state.isPanning = false;
      state.pointerId = null;
      pane.style.cursor = "";
      try {
        pane.releasePointerCapture(event.pointerId);
      } catch (err) {
        console.warn("releasePointerCapture failed", err);
      }
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
        scheduleZoomPanRender();
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

    dom.previewBgToggle?.addEventListener("click", () => {
      state.previewCheckerboard = !state.previewCheckerboard;
      dom.previewBgToggle.setAttribute("aria-pressed", String(state.previewCheckerboard));
      dom.vectorPane.classList.toggle("pane-checker-forced", state.previewCheckerboard);
    });
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
        if (normalized.colors >= 2 && normalized.colors <= 64) valid[key] = normalized;
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

  // Safe checks for custom presets
  function isBuiltInPresetName(name) {
    return Boolean(name && PRESET_CONFIGS[name] && PRESETS[name]);
  }

  function getResolvedPresetConfig(name, fallback = "drawing") {
    return resolvePreset(isBuiltInPresetName(name) ? name : fallback);
  }

  function getCurrentBasePresetName(fallback = "logo") {
    return getItemConversionPresetName(getCurrentItem(), fallback);
  }

  function getItemConversionPresetName(item, fallback = "drawing") {
    if (isBuiltInPresetName(item?.selectedPresetName)) return item.selectedPresetName;
    if (isBuiltInPresetName(item?.assetProfile?.type)) return item.assetProfile.type;
    if (isBuiltInPresetName(state.activePresetName)) return state.activePresetName;
    return fallback;
  }

  function getUiTraceControls(config) {
    const defaults = config?.defaultControls || PRESETS.default;

    return {
      colors: Number(dom.colorsInput?.value || defaults.colors),
      pathomit: Number(dom.pathomitInput?.value || defaults.pathomit),
      optimize: dom.optimizeInput?.checked ?? defaults.optimize,
    };
  }

  function resolveConversionContext(item = getCurrentItem(), overrides = {}) {
    const presetId = overrides.presetId || getItemConversionPresetName(item);
    const config = getResolvedPresetConfig(presetId);

    return {
      presetId,
      config,
      controls: overrides.preset || getUiTraceControls(config),
    };
  }

  function getPresetControls(name) {
    const custom = getCustomPresets();
    return PRESETS[name] || custom[name] || null;
  }

  function applyControlLimits(basePresetName, controls) {
    const config = getResolvedPresetConfig(basePresetName);
    const colorLimits = config?.controlLimits?.colors || { min: 2, max: 32 };
    if (dom.colorsInput) {
      dom.colorsInput.min = String(colorLimits.min);
      dom.colorsInput.max = String(colorLimits.max);
      const clamped = Math.max(
        colorLimits.min,
        Math.min(
          colorLimits.max,
          Number(controls?.colors ?? dom.colorsInput.value ?? colorLimits.min)
        )
      );
      dom.colorsInput.value = String(clamped);
    }
  }

  function updateItemProfileForPreset(item, presetName) {
    if (!item?.assetProfile || !isBuiltInPresetName(presetName)) return;
    item.assetProfile.type = presetName;
    item.assetProfile.subtype = null;
    item.assetProfile.badgeSignals = null;

    if (presetName === "sticker") {
      item.assetProfile.subtype = "sticker";
    } else if (presetName === "badge") {
      item.assetProfile.subtype = "badge";
    }
  }

  function resetItemForPresetRun(item, presetName) {
    if (!item) return;
    item.selectedPresetName = presetName;
    item.traceEngine = "";
    item.svgString = "";
    item.svgSize = 0;
    item.status = "pending";
    item.traceDiagnostics = null;
    item.fallbackReason = "";
    item.visualValidationFailed = false;
    item.backgroundArtifactsDetected = false;
    item.textWarning = false;
    item.textWarningReason = "";
    updateItemProfileForPreset(item, presetName);
  }

  function getActiveConversionConfig() {
    return resolveConversionContext().config;
  }

  function updateDisabledControls(basePresetName) {
    const isPhoto = basePresetName === "photo";
    const isLineArt = basePresetName === "lineart";

    if (dom.colorsInput) {
      if (isPhoto) {
        dom.colorsInput.disabled = true;
        dom.colorsInput.closest(".setting-item")?.classList.add("disabled");
      } else if (isLineArt) {
        dom.colorsInput.value = "2";
        dom.colorsInput.disabled = true;
        dom.colorsInput.closest(".setting-item")?.classList.add("disabled");
        updateControlBadge(dom.colorsInput);
        updateSliderFill(dom.colorsInput);
      } else {
        dom.colorsInput.disabled = false;
        dom.colorsInput.closest(".setting-item")?.classList.remove("disabled");
      }
    }

    const otherSliders = [
      dom.ltresInput,
      dom.qtresInput,
      dom.pathomitInput,
      dom.blurInput,
      dom.scaleInput,
    ];
    otherSliders.forEach((input) => {
      if (input) {
        input.disabled = isPhoto;
        input.closest(".setting-item")?.classList.toggle("disabled", isPhoto);
      }
    });

    const checkboxes = [dom.optimizeInput, dom.outlineInput, dom.highQualityInput];
    checkboxes.forEach((input) => {
      if (input) {
        input.disabled = isPhoto;
        input.closest(".switch-container")?.classList.toggle("disabled", isPhoto);
        input.closest(".high-quality-toggle")?.classList.toggle("disabled", isPhoto);
      }
    });
  }

  function updatePresetGuidance(name, basePresetName = name) {
    const box = dom.presetGuidanceBox;
    if (!box) return;

    const item = getCurrentItem();
    if (!item || !item.assetProfile || !name) {
      box.classList.add("hidden");
      box.style.display = "none";
      return;
    }

    const config = getResolvedPresetConfig(basePresetName);
    if (!config) {
      box.classList.add("hidden");
      box.style.display = "none";
      return;
    }

    // Retrieve diagnostics from the completed item, or run evaluateDiagnostics on the fly
    let diag = item.traceDiagnostics;
    if (!diag && item.svgString) {
      const stats = {
        pathCount: item.paths || 0,
        pathCommandCount: 0,
        invalidPathCount: 0,
      };
      diag = evaluateDiagnostics(
        item.svgString,
        config,
        item.assetProfile,
        stats,
        item.colors || 0
      );
    }

    // Fallback default diagnostics if not traced yet
    if (!diag) {
      diag = {
        presetMatchScore: item.assetProfile.type === basePresetName ? 98 : 65,
        detailRetentionScore: 80,
        pathComplexityScore: 90,
        colorPreservationScore: 90,
        edgePreservationScore: 85,
        textRiskScore: basePresetName === "badge" ? 20 : 0,
        editabilityScore: basePresetName === "photo" ? 0 : 100,
        exportReadiness: 90,
        explanation: config.description,
        whatPreserved: config.expectedOutput,
        whatLost: "N/A",
        alternateSuggestion: "N/A",
      };
    }

    box.classList.remove("hidden");
    box.style.display = "block";
    box.textContent = "";

    const header = createEl("div", { className: "guidance-header" }, [
      createEl("span", { className: "guidance-badge", text: PRESET_CONFIGS[name]?.label || name }),
      createEl("span", { className: "guidance-confidence", text: `${diag.presetMatchScore}% match` })
    ]);

    const explanation = createEl("p", { className: "guidance-text", text: diag.explanation });

    box.appendChild(header);
    box.appendChild(explanation);

    if (item.textWarning && item.textWarningReason) {
      const warningBox = createEl("div", { className: "guidance-warning-box" }, [
        createEl("span", { className: "warning-icon", text: "⚠" }),
        createEl("span", { className: "warning-text", text: item.textWarningReason })
      ]);
      box.appendChild(warningBox);
    }

    const details = createEl("details", { className: "guidance-details" });
    const summary = createEl("summary", { text: "More details" });
    details.appendChild(summary);

    const detailCopy = createEl("p", { className: "guidance-detail-copy" });
    detailCopy.appendChild(createEl("strong", { text: "Best use: " }));
    detailCopy.appendChild(document.createTextNode(config.recommendedUse));
    detailCopy.appendChild(createEl("br"));
    detailCopy.appendChild(createEl("strong", { text: "Expected: " }));
    detailCopy.appendChild(document.createTextNode(config.expectedOutput));
    details.appendChild(detailCopy);

    const scoresGrid = createEl("div", { className: "diagnostics-scores-grid" }, [
      createEl("div", { className: "score-pill", text: `Detail ${diag.detailRetentionScore}%` }),
      createEl("div", { className: "score-pill", text: `Paths ${diag.pathComplexityScore}%` }),
      createEl("div", { className: "score-pill", text: `Color ${diag.colorPreservationScore}%` }),
      createEl("div", { className: "score-pill", text: `Edges ${diag.edgePreservationScore}%` }),
      createEl("div", { className: "score-pill", text: `Text risk ${diag.textRiskScore}%` }),
      createEl("div", { className: "score-pill", text: `Editability ${diag.editabilityScore}%` })
    ]);
    details.appendChild(scoresGrid);

    const tradeoffs = createEl("div", { className: "guidance-tradeoffs" }, [
      createEl("span", { className: "tradeoff-label", text: "Tradeoff" }),
      createEl("span", { className: "tradeoff-item", text: config.tradeoffs })
    ]);
    details.appendChild(tradeoffs);

    const suggestion = createEl("div", { className: "guidance-suggestion" });
    suggestion.appendChild(createEl("strong", { text: "Next try: " }));
    suggestion.appendChild(document.createTextNode(diag.alternateSuggestion));
    details.appendChild(suggestion);

    box.appendChild(details);
  }

  function applyPreset(name, { silent = false, isRecommended = false } = {}) {
    const controls = getPresetControls(name);
    if (!controls) return;

    const isBuiltIn = isBuiltInPresetName(name);
    const basePresetName = isBuiltIn ? name : getCurrentBasePresetName();

    if (isRecommended) {
      state.recommendedPresetName = basePresetName;
    }

    state.activePresetName = basePresetName;
    state.activeControlPresetName = name;
    state.suppressRetrace = silent;
    applyControlLimits(basePresetName, controls);

    for (const [input, prop, key] of [
      [dom.colorsInput, "value", "colors"],
      [dom.ltresInput, "value", "ltres"],
      [dom.qtresInput, "value", "qtres"],
      [dom.pathomitInput, "value", "pathomit"],
      [dom.blurInput, "value", "blurradius"],
      [dom.scaleInput, "value", "scale"],
      [dom.optimizeInput, "checked", "optimize"],
      [dom.outlineInput, "checked", "outline"],
      [dom.highQualityInput, "checked", "highQuality"],
    ]) {
      if (!input) continue;
      input[prop] = controls[key];
      updateControlBadge(input);
      updateSliderFill(input);
    }

    updateDisabledControls(basePresetName);
    updatePresetGuidance(name, basePresetName);

    dom.presetsContainer?.querySelectorAll(".preset-card[data-preset]").forEach((btn) => {
      const btnPreset = btn.getAttribute("data-preset");
      const isActive = btnPreset === basePresetName;
      btn.classList.toggle("active", isActive);

      const isBtnRecommended = btnPreset === state.recommendedPresetName;
      if (isBtnRecommended) {
        btn.setAttribute("data-recommended", "true");
        if (!btn.querySelector(".recommended-label")) {
          const label = createEl("span", {
            className: "recommended-label",
            text: "Recommended",
          });
          const titleEl = btn.querySelector(".preset-card-title");
          if (titleEl) {
            titleEl.appendChild(label);
          } else {
            btn.appendChild(label);
          }
        }
      } else {
        btn.removeAttribute("data-recommended");
        const label = btn.querySelector(".recommended-label");
        if (label) label.remove();
      }
    });

    dom.customPresetActions?.querySelectorAll(".preset-card[data-custom-preset]").forEach((btn) => {
      const btnPreset = btn.getAttribute("data-custom-preset");
      const isActive = btnPreset === state.activeControlPresetName;
      btn.classList.toggle("active", isActive);
    });

    state.suppressRetrace = false;
  }

  function renderCustomPresets() {
    const custom = getCustomPresets();
    if (dom.presetSelect) {
      dom.presetSelect.textContent = "";
      dom.presetSelect.appendChild(createEl("option", { value: "", text: "Load saved..." }));
      Object.keys(custom)
        .sort()
        .forEach((name) =>
          dom.presetSelect.appendChild(createEl("option", { value: name, text: name }))
        );
    }

    if (dom.customPresetActions) {
      dom.customPresetActions.textContent = "";
      Object.keys(custom)
        .sort()
        .forEach((name) => {
          const isActive = name === state.activeControlPresetName;
          const chip = createEl("button", {
            type: "button",
            className: `preset-card preset-custom-card ${isActive ? "active" : ""}`,
            "data-custom-preset": name,
          });
          chip.appendChild(createEl("span", { className: "preset-card-icon", text: "★" }));

          const meta = createEl("div", { className: "preset-card-meta" });
          meta.appendChild(createEl("span", { className: "preset-card-title", text: name }));
          meta.appendChild(createEl("span", { className: "preset-card-desc", text: "Custom Preset" }));
          chip.appendChild(meta);

          const deleteBtn = createEl("button", {
            type: "button",
            className: "preset-delete",
            "data-delete-preset": name,
            "aria-label": `Delete preset ${name}`,
            text: "×",
          });
          chip.appendChild(deleteBtn);

          dom.customPresetActions.appendChild(chip);
        });
    }
  }

  // ---------------------------------------------------------------------------
  // Accessible modal dialogs — replaces blocking window.confirm / window.prompt.
  // All DOM is built via createEl() so no untrusted strings ever reach innerHTML.
  // Returns a Promise that resolves to the user's answer when dismissed.
  // ---------------------------------------------------------------------------

  function createAppModal({ type, title, message, confirmLabel = "OK", defaultValue = "" }) {
    return new Promise((resolve) => {
      const modalTitleId = "app-modal-title-" + Math.random().toString(36).slice(2, 7);

      const overlay = createEl("div", {
        className: "app-modal-overlay",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": modalTitleId,
      });

      const dialog = createEl("div", { className: "app-modal-dialog" });

      const titleEl = createEl("h3", {
        className: "app-modal-title",
        id: modalTitleId,
        text: title,
      });
      const bodyEl = createEl("p", { className: "app-modal-body", text: message });
      dialog.appendChild(titleEl);
      dialog.appendChild(bodyEl);

      let inputEl = null;
      if (type === "prompt") {
        inputEl = document.createElement("input");
        inputEl.type = "text";
        inputEl.className = "app-modal-input";
        inputEl.value = defaultValue;
        inputEl.setAttribute("aria-label", message);
        dialog.appendChild(inputEl);
      }

      const actionsEl = createEl("div", { className: "app-modal-actions" });

      const close = (result) => {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        resolve(result);
      };

      const cancelBtn = createEl("button", {
        type: "button",
        className: "btn btn-secondary",
        text: "Cancel",
      });
      cancelBtn.addEventListener("click", () => close(type === "confirm" ? false : null));

      const confirmBtn = createEl("button", {
        type: "button",
        className: "btn btn-accent",
        text: confirmLabel,
      });
      confirmBtn.addEventListener("click", () => {
        close(type === "prompt" ? (inputEl?.value ?? "") : true);
      });

      actionsEl.append(cancelBtn, confirmBtn);
      dialog.appendChild(actionsEl);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const onKeyDown = (e) => {
        if (e.key === "Escape") {
          close(type === "confirm" ? false : null);
          return;
        }
        // Focus trap: keep Tab cycling within the dialog.
        if (e.key === "Tab") {
          const focusable = [...dialog.querySelectorAll("button, input")].filter(
            (el) => !el.disabled
          );
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      };
      document.addEventListener("keydown", onKeyDown);

      // Clicking the translucent backdrop dismisses without confirming.
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close(type === "confirm" ? false : null);
      });

      // Auto-focus: input field for prompts, confirm button otherwise.
      requestAnimationFrame(() => {
        (inputEl ?? confirmBtn).focus();
      });
    });
  }

  function showConfirmModal(message, { title = "Confirm", confirmLabel = "Delete" } = {}) {
    return createAppModal({ type: "confirm", title, message, confirmLabel });
  }

  function showPromptModal(
    message,
    defaultValue = "",
    { title = "Save Preset", confirmLabel = "Save" } = {}
  ) {
    return createAppModal({ type: "prompt", title, message, defaultValue, confirmLabel });
  }

  function setupPresets() {
    const runPreset = (presetName) => {
      if (!getPresetControls(presetName)) return;
      const item = getCurrentItem();
      if (item) {
        resetItemForPresetRun(item, presetName);
        applyPreset(presetName);
        processQueueItem(state.currentFileIndex);
      } else {
        state.pendingPresetName = presetName;
        applyPreset(presetName);
        scheduleRetrace();
      }
    };

    dom.presetsContainer?.addEventListener("click", (event) => {
      const btn = event.target.closest(".preset-card[data-preset]");
      if (!btn) return;
      runPreset(btn.getAttribute("data-preset"));
    });

    dom.presetSelect?.addEventListener("change", (event) => {
      const name = event.target.value;
      if (!name) return;
      runPreset(name);
    });

    dom.customPresetActions?.addEventListener("click", async (event) => {
      const deleteBtn = event.target.closest("[data-delete-preset]");
      if (deleteBtn) {
        const name = deleteBtn.getAttribute("data-delete-preset");
        const confirmed = await showConfirmModal(
          `Delete the custom preset "${name}"? This cannot be undone.`,
          { title: "Delete Preset", confirmLabel: "Delete" }
        );
        if (confirmed) {
          deleteCustomPreset(name);
          showToast(`Preset "${name}" deleted.`);
        }
        return;
      }

      const chip = event.target.closest("[data-custom-preset]");
      if (chip) {
        runPreset(chip.getAttribute("data-custom-preset"));
      }
    });

    document.querySelector("#preset-save")?.addEventListener("click", async () => {
      const name = await showPromptModal(
        "Enter a name for your custom preset:",
        "My Custom Preset",
        { title: "Save Preset", confirmLabel: "Save" }
      );
      const cleanName = String(name || "")
        .trim()
        .replace(/[:"']/g, "");
      if (!cleanName) return;
      saveCustomPreset(cleanName, getUiOptions());
      applyPreset(cleanName, { silent: true });
      showToast(`Preset "${cleanName}" saved.`);
    });

    document.querySelector("#preset-reset")?.addEventListener("click", () => {
      runPreset(getCurrentBasePresetName("logo"));
    });

    renderCustomPresets();
  }

  // Fidelity toggle (Balanced/High/Ultra), shown only for complex/badge assets.
  function setupFidelityToggle() {
    dom.fidelityToggle?.addEventListener("click", (event) => {
      const btn = event.target.closest(".fidelity-btn[data-fidelity]");
      if (!btn) return;
      const value = btn.getAttribute("data-fidelity");
      if (value === state.badgeFidelity) return;
      state.badgeFidelity = value;
      updateFidelityToggleUi();
      reconvertCurrentComplexAsset();
    });
  }

  function updateFidelityToggleUi() {
    dom.fidelityToggle?.querySelectorAll(".fidelity-btn[data-fidelity]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-fidelity") === state.badgeFidelity);
    });
  }

  // Optimization toggle (None/Balanced/Max), shown next to fidelity toggle
  function setupOptimizationToggle() {
    dom.optimizationToggle?.addEventListener("click", (event) => {
      const btn = event.target.closest(".optimization-btn[data-optimization]");
      if (!btn) return;
      const value = btn.getAttribute("data-optimization");
      if (value === state.optimizationMode) return;
      state.optimizationMode = value;
      updateOptimizationToggleUi();
      reconvertCurrentComplexAsset();
    });
  }

  function updateOptimizationToggleUi() {
    dom.optimizationToggle
      ?.querySelectorAll(".optimization-btn[data-optimization]")
      .forEach((btn) => {
        btn.classList.toggle(
          "active",
          btn.getAttribute("data-optimization") === state.optimizationMode
        );
      });
  }

  // Re-run conversion for the current complex/sticker asset.
  function reconvertCurrentComplexAsset() {
    const item = getCurrentItem();
    if (!item) return;
    const type = item.assetProfile?.type;
    if (type !== "complex" && type !== "badge" && type !== "sticker") return;
    state.activeBatchToken += 1;
    state.isBatchRunning = false;
    item.status = "pending";
    item.svgString = "";
    processQueueItem(state.currentFileIndex);
  }

  function getStrategyLabel(strategy) {
    if (strategy === "image-wrapper-fallback") return "Raster SVG Wrapper";
    if (strategy === "quantized-path-trace-needs-refinement")
      return "Quantized Path Trace, Needs Refinement";
    if (strategy === "quantized-path-trace") return "Quantized Path Trace";
    if (strategy === "image-wrapper") return "Raster SVG Wrapper";
    if (strategy === "path-trace") return "Path Trace";
    return strategy;
  }

  // Set the strategy badge text via DOM nodes (no innerHTML) so the element's
  // own class is preserved and the label can never become live markup.
  function setStrategyBadgeText(strategyEl, text) {
    strategyEl.textContent = "";
    strategyEl.appendChild(createEl("span", { className: "badge-text", text }));
  }

  function setAssetSummary(profile, item = null) {
    if (!dom.assetSummary) return;
    const typeEl = dom.assetSummaryType;
    const detailEl = dom.assetSummaryDetail;
    const comfortEl = dom.assetSummaryComfort;
    const strategyEl = dom.assetSummaryStrategy;

    if (!typeEl || !detailEl) return;

    if (!profile) {
      typeEl.textContent = "No asset loaded";
      detailEl.textContent = "Your source image will appear here.";
      if (comfortEl) comfortEl.style.display = "none";
      if (strategyEl) strategyEl.style.display = "none";
      setFidelityToggleVisible(false);
      updateControlSafetyNote(null);
      state.recommendedPresetName = null;
      updatePresetGuidance(null);
      return;
    }

    updateDisabledControls(state.activePresetName);
    updatePresetGuidance(state.activePresetName);



    typeEl.textContent = ASSET_LABELS[profile.type] || "Detected asset";
    const comfortCopy = COMFORT_COPY[profile.type] || "";

    // Photo/gradient assets use the image-preserving wrapper. Never imply a
    // photo was cleanly path-traced.
    if (profile.type === "photo") {
      detailEl.textContent = comfortCopy;
      if (comfortEl) comfortEl.style.display = "none";
      if (strategyEl) {
        strategyEl.style.display = "block";
        setStrategyBadgeText(strategyEl, "Export strategy: Image-preserving SVG");
      }
      setFidelityToggleVisible(false);
      updateControlSafetyNote(profile);
      return;
    }

    // Detailed AI-art badge/mascot/sticker sheet: routes to quantized-path-trace. Show the
    // correct message depending on whether the trace succeeded or fell back.
    if (profile.type === "complex" || profile.type === "badge" || profile.type === "sticker") {
      const isBadgeLike =
        profile.type === "badge" || profile.subtype === "badge" || profile.subtype === "emblem";
      const isSticker = profile.type === "sticker" || profile.subtype === "sticker";
      setFidelityToggleVisible(true);
      if (item && item.exportStrategy === "image-wrapper-fallback") {
        detailEl.textContent = isBadgeLike
          ? "Detailed badge detected. Local tracing was attempted, but image-preserving SVG was used because it better preserved the artwork."
          : isSticker
            ? "Sticker sheet detected. Local quantized path tracing was attempted, but image-preserving SVG was used because it produced better visual fidelity."
            : "Complex image. Local quantized path tracing was attempted, but image-preserving SVG was used because it produced better visual fidelity.";
        if (strategyEl) {
          strategyEl.style.display = "block";
          setStrategyBadgeText(strategyEl, "Export strategy: Raster SVG Wrapper");
        }
        if (comfortEl) comfortEl.style.display = "none";
      } else {
        detailEl.textContent =
          isBadgeLike && item?.exportStrategy === "quantized-path-trace-needs-refinement"
            ? "Real vector output generated. Some lettering may need refinement."
            : isBadgeLike
              ? "Detailed badge detected. Using local high-fidelity quantized path tracing with text preservation."
              : isSticker
                ? "Sticker sheet detected. Using local high-fidelity quantized path tracing with background-component filtering."
                : comfortCopy;
        if (strategyEl) {
          strategyEl.style.display = "block";
          setStrategyBadgeText(
            strategyEl,
            `Export strategy: ${getStrategyLabel(item?.exportStrategy || "quantized-path-trace")}`
          );
        }
        // Non-scary note when the text-band quality check is uncertain.
        if (comfortEl) {
          if (isBadgeLike && item && item.textWarning && state.badgeFidelity !== "ultra") {
            comfortEl.textContent =
              "Lettering may need refinement. Try Ultra for more text detail.";
            comfortEl.style.display = "block";
          } else {
            comfortEl.style.display = "none";
          }
        }
      }
      updateControlSafetyNote(null);
      return;
    }

    // For logo, drawing, lineart: show comfort copy
    detailEl.textContent = comfortCopy;
    if (comfortEl) comfortEl.style.display = "none";
    setFidelityToggleVisible(false);

    if (strategyEl) {
      strategyEl.style.display = "block";
      setStrategyBadgeText(strategyEl, "Export strategy: Path trace");
    }
    updateControlSafetyNote(null);
  }

  function setFidelityToggleVisible(visible) {
    if (dom.fidelityToggle) {
      dom.fidelityToggle.style.display = visible ? "flex" : "none";
      dom.fidelityToggle.classList.toggle("hidden", !visible);
      if (visible) updateFidelityToggleUi();
    }
    if (dom.optimizationToggle) {
      dom.optimizationToggle.style.display = visible ? "flex" : "none";
      dom.optimizationToggle.classList.toggle("hidden", !visible);
      if (visible) updateOptimizationToggleUi();
    }
  }

  function updateMetrics(item) {
    if (!item) return;
    setText(dom.metricOriginalSize, formatBytes(item.originalSize));
    setText(dom.metricSvgSize, formatBytes(item.svgSize));
    setText(dom.metricCompression, item.compressionRatio ? `${item.compressionRatio}x` : "—");
    setText(
      dom.metricTime,
      Number.isFinite(item.processingTime) ? `${item.processingTime.toFixed(2)}s` : "—"
    );
    setText(dom.metricColors, item.colors || "—");
    setText(dom.metricPaths, item.paths || "—");

    if (dom.metricStrategyWrapper) {
      dom.metricStrategyWrapper.classList.toggle("hidden", !item.exportStrategy);
    }
    setText(dom.metricStrategy, item.exportStrategy ? getStrategyLabel(item.exportStrategy) : "—");
  }

  function getCurrentItem() {
    return state.queue[state.currentFileIndex] || null;
  }

  function countCompletedItems() {
    return state.queue.filter((item) => item.status === "completed" && item.svgString).length;
  }

  // ZIP export only makes sense with two or more completed SVGs; keep the
  // button hidden otherwise so single-file users see only "Download SVG".
  function updateZipButtonVisibility() {
    if (!dom.downloadZipBtn) return;
    const hasMultipleExports = countCompletedItems() >= 2;
    dom.downloadZipBtn.classList.toggle("hidden", !hasMultipleExports);
    dom.downloadZipBtn.disabled = !hasMultipleExports;
  }

  function updateQueueUi() {
    if (!dom.queueList) return;
    dom.batchQueueSection?.classList.toggle("hidden", state.queue.length === 0);

    dom.queueList.textContent = "";
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

    updateZipButtonVisibility();
  }

  function showErrorInPanes(message) {
    dom.originalPane.textContent = "";
    dom.vectorPane.textContent = "";

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
    dom.downloadOptions?.classList.remove("hidden");
    updateExportReadyState(false);
    updateExportFormatState(null);
    updateExportConsole(null);
  }

  // Shared core for informational status banners overlaid on the vector pane.
  // Guards against duplicates via markerClass; auto-removes after 4 s.
  function showTransientNote(markerClass, heading, body) {
    if (!dom.vectorPane || dom.vectorPane.querySelector(`.${markerClass}`)) return;
    const banner = createEl("div", {
      className: `preview-placeholder retrace-warning ${markerClass}`,
      role: "status",
    });
    banner.append(createEl("h4", { text: heading }), createEl("p", { text: body }));
    dom.vectorPane.appendChild(banner);
    setTimeout(() => banner.remove(), 4000);
  }

  // Non-destructive retrace warning: role=alert (error), removes any prior
  // warning so only one is shown at a time.
  function showRetraceWarning(message) {
    if (!dom.vectorPane) return;
    dom.vectorPane.querySelector(".retrace-warning")?.remove();
    const banner = createEl("div", {
      className: "preview-placeholder error-message retrace-warning",
      role: "alert",
    });
    banner.append(createEl("h4", { text: "Retrace Failed" }), createEl("p", { text: message }));
    dom.vectorPane.appendChild(banner);
    setTimeout(() => banner.remove(), 4000);
  }

  function showPhotoExportNote() {
    showTransientNote(
      "photo-export-note",
      "Image-preserving SVG",
      "This image exports as an embedded image for visual fidelity, so tracing settings don't apply."
    );
  }

  function showFidelityTraceNote() {
    showTransientNote(
      "fidelity-trace-note",
      "High-fidelity trace",
      "This image uses the high-fidelity tracing engine. The ImageTracer sliders don't apply; pick a preset to re-convert."
    );
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
      if (!ctx) return 0;
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

  async function loadAndClassifyItem(item, jobToken) {
    updateDropZoneState("loading");
    await validateImageFile(item.file, { maxFileSize: CONFIG.maxFileSize });
    if (jobToken !== state.activeJobToken) return null;

    const fileData = await readFileIfTiff(item.file);
    if (jobToken !== state.activeJobToken) return null;

    // Classify the raw source first so background removal can be skipped for
    // photo-like images without re-decoding later.
    if (!item.assetProfile) {
      updateDropZoneState("analyzing");
      const sourceProfile = await detectSourceProfile(item.file, fileData);
      if (jobToken !== state.activeJobToken) return null;
      item.assetProfile = sourceProfile;
    }

    if (item.selectedPresetName) {
      updateItemProfileForPreset(item, item.selectedPresetName);
    }

    const removeBackground = BACKGROUND_REMOVAL_PROFILES.includes(item.assetProfile.type);

    updateDropZoneState("preparing");
    const workingImage = await loadWorkingImage(item.file, fileData, {
      removeBackground,
      config: {
        workingImageMaxDim: CONFIG.workingImageMaxDim,
        backgroundSampleSize: CONFIG.backgroundSampleSize,
        backgroundThreshold: CONFIG.backgroundThreshold,
        maxFileSize: CONFIG.maxFileSize,
      },
    });
    if (jobToken !== state.activeJobToken) {
      cleanupImage(workingImage.img);
      return null;
    }

    if (state.currentImgElement) cleanupImage(state.currentImgElement);
    state.currentImgElement = workingImage.img;

    renderOriginal(workingImage.img);

    Object.assign(item.assetProfile, {
      originalWidth: workingImage.originalWidth,
      originalHeight: workingImage.originalHeight,
      workingWidth: workingImage.workingWidth,
      workingHeight: workingImage.workingHeight,
      downscaled: workingImage.downscaled,
      removedBackground: workingImage.removedBackground,
    });

    // For complex assets, run badge/emblem detection on the prepared image so
    // the quantized trace can apply the badge refinement pass and the summary
    // copy can name the subtype. Cheap, DOM-free, conservative.
    if (
      (item.assetProfile.type === "complex" || item.assetProfile.type === "badge") &&
      !item.assetProfile.subtype
    ) {
      try {
        const detectData = getTracingImageData(workingImage.img, 220, false);
        const signals = detectBadge(detectData);
        if (signals.isBadge || signals.isEmblem) {
          item.assetProfile.subtype = signals.subtype;
          item.assetProfile.badgeSignals = signals;
          item.assetProfile.type = "badge";
        }
      } catch (error) {
        console.warn("Badge detection skipped:", error);
      }
    }

    setAssetSummary(item.assetProfile, item);
    applyPreset(item.selectedPresetName || item.assetProfile.type, {
      silent: true,
      isRecommended: !item.selectedPresetName,
    });

    return workingImage;
  }

  async function runTraceForItem(item, workingImage, jobToken) {
    updateDropZoneState("tracing");
    const context = resolveConversionContext(item);
    const traced = await performVectorConversion(workingImage.img, item.assetProfile, {
      dataUrl: workingImage.dataUrl,
      width: workingImage.workingWidth,
      height: workingImage.workingHeight,
      maxDim: 1024,
      optimizationMode: state.optimizationMode,
      // Bind the preset to this specific queue item so it is immune to UI
      // preset-card clicks that happen while the trace is in flight.
      context,
    });
    if (jobToken !== state.activeJobToken) return null;
    return traced;
  }

  async function commitTraceResult(item, traced, start, imgElement) {
    const svgString = validateSvgString(traced.svgString, "Converted trace SVG");
    item.traceDiagnostics = traced.diagnostics || null;
    item.exportStrategy = traced.strategy || item.exportStrategy;
    item.traceEngine = traced.engine;
    item.transparentBackground = Boolean(traced.masked || traced.transparentSource);
    item.textWarning = Boolean(traced.textWarning);
    item.textWarningReason = traced.textWarningReason || "";
    item.fallbackReason = traced.fallbackReason || "";

    if (
      svgString &&
      (item.exportStrategy === "quantized-path-trace" ||
        item.exportStrategy === "quantized-path-trace-needs-refinement" ||
        item.exportStrategy === "path-trace")
    ) {
      const artifactCheck = detectBackgroundArtifacts(svgString, item.assetProfile?.type);
      item.backgroundArtifactsDetected = artifactCheck.detected;
      item.backgroundArtifactsReason = artifactCheck.reason;
    } else {
      item.backgroundArtifactsDetected = false;
      item.backgroundArtifactsReason = "";
    }

    state.currentSvgString = svgString;
    const svgSize = new Blob([svgString], { type: "image/svg+xml" }).size;

    item.svgString = svgString;
    item.svgSize = svgSize;
    item.status = "completed";
    item.processingTime = (performance.now() - start) / 1000;

    if (
      item.exportStrategy === "image-wrapper" ||
      item.exportStrategy === "image-wrapper-fallback"
    ) {
      item.paths = "N/A";
      item.colors = imgElement ? await computeColors(imgElement) : 0;
    } else {
      item.paths = traced.pathCount;
      item.colors = traced.fillColorCount;
    }

    item.compressionRatio = svgSize > 0 ? (item.originalSize / svgSize).toFixed(1) : null;

    // Update asset summary with final status so fallback message is shown if fallback was used
    setAssetSummary(item.assetProfile, item);

    updateMetrics(item);
    updateQueueUi();
    dom.downloadOptions?.classList.remove("hidden");
    updateExportFormatState(item);
    updateExportReadyState(true);
    updateExportConsole(item);
  }

  async function processQueueItem(index) {
    if (index < 0 || index >= state.queue.length) return;

    // Job token cancellation: each invocation claims a token; any async step
    // checks it and bails if a newer job (re-trace, new upload, view switch)
    // has superseded this one, preventing stale results from overwriting state.
    state.activeJobToken += 1;
    const jobToken = state.activeJobToken;
    state.currentFileIndex = index;

    const item = getCurrentItem();
    updateQueueUi();

    setPlaceholder(dom.originalPane, "Loading original...");
    setPlaceholder(dom.vectorPane, "Vectorizing...");
    dom.downloadOptions?.classList.remove("hidden");
    updateExportReadyState(false);
    updateExportFormatState(null);
    updateExportConsole(null);

    try {
      const workingImage = await loadAndClassifyItem(item, jobToken);
      if (jobToken !== state.activeJobToken || !workingImage) return;

      if (item.status === "completed" && item.svgString) {
        state.currentSvgString = item.svgString;
        renderSvg(item.svgString);
        updateMetrics(item);
        setAssetSummary(item.assetProfile, item);
        dom.downloadOptions?.classList.remove("hidden");
        updateExportConsole(item);
        fitZoomToContent();
        return;
      }

      item.status = "processing";
      item.exportStrategy = getExportStrategy(item.assetProfile.type);
      item.workingDataUrl = workingImage.dataUrl;
      updateQueueUi();

      await new Promise((resolve) => requestAnimationFrame(resolve));
      const start = performance.now();

      const traced = await runTraceForItem(item, workingImage, jobToken);
      if (jobToken !== state.activeJobToken || !traced) return;

      updateDropZoneState("rendering");
      renderSvg(traced.svgString);

      await commitTraceResult(item, traced, start, workingImage.img);
      if (jobToken !== state.activeJobToken) return;

      updateDropZoneState("complete");
      fitZoomToContent();
      announce(
        item.exportStrategy === "image-wrapper" || item.exportStrategy === "image-wrapper-fallback"
          ? `Prepared ${item.file.name} as an image-preserving SVG.`
          : `Finished vectorizing ${item.file.name}.`
      );
    } catch (error) {
      if (jobToken !== state.activeJobToken) return;
      item.status = "error";
      item.errorMessage = error.message || "Unknown error.";
      updateQueueUi();
      showErrorInPanes(item.errorMessage);
      announce(`Failed to process ${item.file.name}.`);
    }
  }

  // Convert every queued item in order. Items already completed (e.g. when the
  // user re-runs) are skipped by processQueueItem's completed short-circuit.
  async function processQueueSequentially(startIndex) {
    const batchToken = ++state.activeBatchToken;
    state.isBatchRunning = true;
    try {
      for (let i = startIndex; i < state.queue.length; i++) {
        if (batchToken !== state.activeBatchToken) return;
        if (state.queue[i].status === "completed") continue;
        await processQueueItem(i);
      }
    } finally {
      if (batchToken !== state.activeBatchToken) return;
      state.isBatchRunning = false;
      // Keep the first processed item visible after the batch settles.
      if (state.currentFileIndex !== startIndex && state.queue[startIndex]) {
        await showCompletedQueueItem(startIndex);
      }
    }
  }

  async function showCompletedQueueItem(index) {
    const item = state.queue[index];
    if (!item?.svgString) return processQueueItem(index);

    // Save job token before async call to avoid race condition!
    state.activeJobToken += 1;
    const jobToken = state.activeJobToken;

    state.currentFileIndex = index;
    state.currentSvgString = item.svgString;
    updateQueueUi();

    if (item.workingDataUrl) {
      try {
        const img = await loadImage(item.workingDataUrl);
        if (jobToken !== state.activeJobToken) {
          cleanupImage(img);
          return;
        }
        if (state.currentImgElement) cleanupImage(state.currentImgElement);
        state.currentImgElement = img;
        renderOriginal(img);
      } catch (error) {
        console.warn("Completed original preview could not be restored:", error);
      }
    }

    if (jobToken !== state.activeJobToken) return;

    renderSvg(item.svgString);
    updateMetrics(item);
    setAssetSummary(item.assetProfile, item);
    dom.downloadOptions?.classList.remove("hidden");
    updateExportFormatState(item);
    updateExportReadyState(true);
    updateExportConsole(item);
    fitZoomToContent();
  }

  async function handleFiles(fileList) {
    const allFiles = Array.from(fileList || []);
    if (!allFiles.length) return;

    state.activeBatchToken += 1;
    state.activeJobToken += 1;
    state.isBatchRunning = false;

    const files = allFiles.slice(0, CONFIG.maxBatchFiles);
    if (allFiles.length > files.length) {
      announce(`Only the first ${CONFIG.maxBatchFiles} files were queued.`);
    }

    state.queue = files.map((file) => ({
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
      exportStrategy: "path-trace",
      traceEngine: "",
      workingDataUrl: "",
      traceDiagnostics: null,
      fallbackReason: "",
      selectedPresetName:
        state.pendingPresetName && getPresetControls(state.pendingPresetName)
          ? state.pendingPresetName
          : "",
    }));

    state.currentFileIndex = -1;
    state.currentSvgString = "";
    showWorkspace();
    updateQueueUi();

    // Reset file input value so selecting the same file triggers the change event again
    if (dom.fileInput) {
      dom.fileInput.value = "";
    }

    await processQueueSequentially(0);
  }

  function removeQueueItem(index) {
    if (index === state.currentFileIndex) {
      state.activeBatchToken += 1;
      state.activeJobToken += 1;
      state.isBatchRunning = false;
    }
    const removed = state.queue.splice(index, 1)[0];
    if (removed && index === state.currentFileIndex) {
      if (state.currentImgElement) {
        cleanupImage(state.currentImgElement);
        state.currentImgElement = null;
      }
      state.currentSvgString = "";
      state.currentFileIndex = state.queue.length ? 0 : -1;
      setPlaceholder(dom.originalPane, "Your source image will appear here.");
      setPlaceholder(dom.vectorPane, "Your SVG result will appear here.");
      dom.downloadOptions?.classList.remove("hidden");
      updateExportReadyState(false);
      updateExportFormatState(null);
      updateExportConsole(null);
      setAssetSummary(null);
    } else if (state.currentFileIndex > index) {
      state.currentFileIndex -= 1;
    }

    updateQueueUi();
    if (state.currentFileIndex >= 0) showCompletedQueueItem(state.currentFileIndex);
  }

  async function retraceCurrent() {
    const item = getCurrentItem();
    if (!item || !state.currentImgElement) return;

    // Image-wrapper (photo) assets don't path-trace, so slider changes have no
    // effect. Keep the existing wrapper visible and surface a non-destructive
    // note instead of re-running the tracer.
    if (item.exportStrategy === "image-wrapper") {
      showPhotoExportNote();
      return;
    }

    state.activeJobToken += 1;
    const jobToken = state.activeJobToken;

    const previousStatus = item.status;
    item.status = "processing";
    updateQueueUi();

    dom.vectorPane.style.opacity = "0.6";
    await new Promise((resolve) => requestAnimationFrame(resolve));

    try {
      const start = performance.now();

      const context = resolveConversionContext(item);
      const traced = await performVectorConversion(state.currentImgElement, item.assetProfile, {
        dataUrl: item.workingDataUrl,
        width: item.assetProfile.workingWidth,
        height: item.assetProfile.workingHeight,
        maxDim: CONFIG.previewTraceMaxDim,
        context,
      });

      if (jobToken !== state.activeJobToken) return;
      if (!traced.svgString) throw new Error("Tracer returned an empty result.");

      renderSvg(traced.svgString);

      await commitTraceResult(item, traced, start, state.currentImgElement);
      if (jobToken !== state.activeJobToken) return;

      applyZoomPan();
    } catch (error) {
      if (jobToken !== state.activeJobToken) return;
      // Non-destructive: keep the last good SVG, restore prior status, warn only.
      console.warn("Retrace failed:", error);
      item.status = previousStatus;
      updateQueueUi();
      showRetraceWarning(error.message || "Could not apply the new settings.");
    } finally {
      if (jobToken === state.activeJobToken) dom.vectorPane.style.opacity = "1";
    }
  }

  async function getFullResolutionSvg() {
    const item = getCurrentItem();

    // Photo assets or fallen-back complex assets have no higher-resolution vector form;
    // download the exact image-preserving wrapper that is already on screen.
    if (
      item?.exportStrategy === "image-wrapper" ||
      item?.exportStrategy === "image-wrapper-fallback"
    ) {
      return item.svgString || state.currentSvgString;
    }

    if (!state.currentImgElement) {
      return state.currentSvgString;
    }

    try {
      const context = resolveConversionContext(item);
      const traced = await performVectorConversion(state.currentImgElement, item.assetProfile, {
        dataUrl: item.workingDataUrl,
        width: item.assetProfile.workingWidth,
        height: item.assetProfile.workingHeight,
        maxDim: CONFIG.workingImageMaxDim,
        context,
      });
      if (traced.svgString) {
        return traced.svgString;
      }
    } catch (error) {
      console.warn("Full-res conversion failed, falling back to cached screen SVG:", error);
    }
    return item.svgString || state.currentSvgString;
  }

  function triggerDownload(blob, filename) {
    let url;
    try {
      url = URL.createObjectURL(blob);
      const a = createEl("a", { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        if (url) URL.revokeObjectURL(url);
      }, 100);
    } catch (err) {
      console.error("Trigger download failed", err);
      if (url) URL.revokeObjectURL(url);
    }
  }

  function setupDownloads() {
    dom.downloadVectorBtn.addEventListener("click", async () => {
      const item = getCurrentItem();
      if (!item) return;
      dom.downloadVectorBtn.disabled = true;
      try {
        const svgString = await getFullResolutionSvg();
        if (!svgString) return;
        if (
          item.exportStrategy === "quantized-path-trace" ||
          item.exportStrategy === "quantized-path-trace-needs-refinement"
        ) {
          assertRealVectorSvg(svgString);
        }
        triggerDownload(
          new Blob([svgString], { type: "image/svg+xml" }),
          `${sanitizeFileName(item.file.name.replace(/\.[^/.]+$/, ""))}.svg`
        );
        showToast("SVG download started.");
      } catch (error) {
        console.warn("Download failed:", error);
        showToast("Export failed. Check the console for details.", "error");
      } finally {
        dom.downloadVectorBtn.disabled = false;
      }
    });

    dom.downloadOptimizedSvgBtn?.addEventListener("click", async () => {
      const item = getCurrentItem();
      if (!item) return;
      dom.downloadOptimizedSvgBtn.disabled = true;
      try {
        const svgString = await getFullResolutionSvg();
        if (!svgString) return;
        const optimizedSvg = optimizeSvgForExport(svgString);
        triggerDownload(
          new Blob([optimizedSvg], { type: "image/svg+xml" }),
          `${sanitizeFileName(item.file.name.replace(/\.[^/.]+$/, ""))}.optimized.svg`
        );
        showToast("Optimized SVG download started.");
      } catch (error) {
        console.warn("Optimized download failed:", error);
        showToast("Optimized export failed. Check the console for details.", "error");
      } finally {
        dom.downloadOptimizedSvgBtn.disabled = false;
      }
    });

    dom.copySvgMarkupBtn?.addEventListener("click", async () => {
      const item = getCurrentItem();
      await copyTextToClipboard(item?.svgString || state.currentSvgString, "SVG markup copied.");
    });

    dom.copyReactComponentBtn?.addEventListener("click", async () => {
      const item = getCurrentItem();
      const baseName = sanitizeComponentName(item?.file?.name || "VectorArtwork");
      const component = createReactComponent(item?.svgString || state.currentSvgString, baseName);
      await copyTextToClipboard(component, "React component copied.");
    });

    dom.copyDataUriBtn?.addEventListener("click", async () => {
      const item = getCurrentItem();
      await copyTextToClipboard(
        createInlineDataUri(item?.svgString || state.currentSvgString),
        "Inline data URI copied."
      );
    });

    dom.downloadZipBtn?.addEventListener("click", () => {
      const complete = state.queue.filter((item) => item.status === "completed" && item.svgString);
      if (!complete.length) return;

      try {
        const files = [];
        for (let i = 0; i < complete.length; i++) {
          const item = complete[i];
          try {
            if (
              item.exportStrategy === "quantized-path-trace" ||
              item.exportStrategy === "quantized-path-trace-needs-refinement"
            ) {
              assertRealVectorSvg(item.svgString);
            }
            files.push({
              name: `${sanitizeFileName(item.file.name.replace(/\.[^/.]+$/, "") || `vector-${i}`)}.svg`,
              content: item.svgString,
            });
          } catch (itemErr) {
            throw new Error(`Validation failed for "${item.file.name}": ${itemErr.message}`);
          }
        }

        const zipBlob = createZipBlob(files);
        triggerDownload(zipBlob, "vectorized-images.zip");
        showToast("ZIP export started.");
      } catch (error) {
        console.error("ZIP export failed:", error);
        showToast(error.message || "ZIP export failed.", "error");
      }
    });
  }

  function setupFileInputs() {
    const dropZone = dom.dropZone;
    const fileInput = dom.fileInput;

    const highlight = () => {
      dropZone.classList.add("highlight");
      updateDropZoneState("dragover");
    };
    const unhighlight = () => {
      dropZone.classList.remove("highlight");
      updateDropZoneState("idle");
    };

    ["dragenter", "dragover"].forEach((type) => {
      dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        highlight();
      });
    });

    ["dragleave", "dragend", "drop"].forEach((type) => {
      dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        unhighlight();
      });
    });

    // #drop-zone is a native <button> in the markup, so it already exposes
    // button semantics and keyboard activation. Only synthesize role/tabindex/
    // key handling when it is NOT a button, to avoid duplicate semantics.
    const isNativeButton = dropZone.tagName === "BUTTON";
    if (!isNativeButton) {
      dropZone.setAttribute("tabindex", "0");
      dropZone.setAttribute("role", "button");
      if (!dropZone.getAttribute("aria-label")) {
        dropZone.setAttribute("aria-label", "Upload images. Drag and drop or click to browse.");
      }
      dropZone.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          fileInput.click();
        }
      });
    }

    dropZone.addEventListener("click", () => fileInput.click());

    dropZone.addEventListener("drop", (event) => {
      const files = event.dataTransfer?.files;
      if (files?.length) handleFiles(files);
    });

    fileInput.addEventListener("change", (event) => {
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
    const landingDropZone = dom.landingDropZone;

    if (landingDropZone) {
      ["dragenter", "dragover"].forEach((type) => {
        landingDropZone.addEventListener(type, (event) => {
          event.preventDefault();
          landingDropZone.classList.add("is-dragover");
          if (dom.landingScreen) dom.landingScreen.classList.add("is-dragover");
        });
      });

      ["dragleave", "dragend", "drop"].forEach((type) => {
        landingDropZone.addEventListener(type, (event) => {
          event.preventDefault();
          landingDropZone.classList.remove("is-dragover");
          if (dom.landingScreen) dom.landingScreen.classList.remove("is-dragover");
        });
      });

      landingDropZone.addEventListener("drop", (event) => {
        const files = event.dataTransfer?.files;
        if (files?.length) handleFiles(files);
        if (dom.landingScreen) dom.landingScreen.classList.remove("is-dragover");
      });

      // Allow click on the landing drop area to open the file picker as well.
      landingDropZone.addEventListener("click", () => {
        dom.fileInput?.click();
      });
    }

    dom.landingBrowseBtn?.addEventListener("click", () => {
      dom.fileInput.click();
    });

    dom.enterAppBtn?.addEventListener("click", () => {
      showWorkspace();
      announce("Workspace ready. Drag in an image or browse to start.");

      // Briefly pulse the main workspace drop zone to guide the user's eye.
      if (dom.dropZone) {
        dom.dropZone.classList.add("pulse-highlight");
        setTimeout(() => dom.dropZone.classList.remove("pulse-highlight"), 900);
      }
    });
  }

  function resolveCriticalRefs() {
    dom.dropZone = getRequiredElement("#drop-zone", "drop zone");
    dom.fileInput = getRequiredElement("#file-input", "file input");
    dom.originalPane = getRequiredElement("#pane-original", "original preview pane");
    dom.vectorPane = getRequiredElement("#pane-vector", "vector preview pane");
    dom.downloadVectorBtn = getRequiredElement("#download-vector-btn", "download SVG button");
    dom.themeToggleBtn = getRequiredElement("#theme-toggle", "theme toggle");
  }

  function init() {
    if (!tracer) {
      console.warn("ImageTracer is unavailable. Falling back to WASM/vtracer engine if available.");
    }

    try {
      resolveCriticalRefs();
    } catch (error) {
      console.error("VectorStudio cannot start:", error.message);
      return;
    }

    // Safe to call now: critical elements in dom are set, .zoom-wrapper nodes don't exist yet on
    // a cold load so the dev assertion won't fire, but future calls during
    // pan/zoom will have the correct dom scope.
    applyZoomPan();
    initTheme();
    setupHeaderNavigation();
    setupMobilePanelTabs();
    setupScrollReactiveHeader();
    setupAppFlow();
    setupZoomPan();
    setupFileInputs();
    setupSettings();
    setupPresets();
    setupFidelityToggle();
    setupOptimizationToggle();
    setupQueueActions();
    setupDownloads();

    if (dom.landingScreen && dom.appGrid?.classList.contains("hidden")) {
      document.body.setAttribute("data-app-state", "landing");
    } else {
      document.body.setAttribute("data-app-state", "workspace");
    }

    applyPreset("logo", { silent: true });
    updateExportConsole(null);

    // Warm up the vtracer WASM module in the background so the first detailed
    // conversion isn't delayed by the load. A failure here is non-fatal: tracing
    // falls back to ImageTracer on demand.
    ensureVtracerReady().catch((error) => {
      console.warn("vtracer engine could not preload; ImageTracer fallback active:", error);
    });
  }

  document.addEventListener("DOMContentLoaded", init, { once: true });
})();
