/*
  Minimal application logic for Image to SVG Converter
  - Handles file input change and custom 'files-dropped' events
  - Renders the original image preview
  - Attempts vectorization via ImageTracer (if loaded)
  - Falls back to an embedded-raster SVG when ImageTracer is unavailable
  - Enables download buttons and updates basic metrics
*/
(function () {
  'use strict';

  const qs = (s) => document.querySelector(s);
  const qsa = (s) => Array.from(document.querySelectorAll(s));

  const input = qs('#file-input');
  const dropZone = qs('#drop-zone');
  const originalPreview = qs('#original-preview');
  const svgPreview = qs('#svg-preview');
  const downloadOptions = qs('#download-options');
  const downloadVectorBtn = qs('#download-vector-btn');
  const downloadEmbeddedBtn = qs('#download-embedded-btn');
  const downloadHybridBtn = qs('#download-hybrid-btn');
  const metricsPanel = qs('#metrics-panel');

  const originalZoomControls = qs('#original-zoom-controls');
  const svgZoomControls = qs('#svg-zoom-controls');

  // Metrics elements
  const metricOriginalSize = qs('#metric-original-size');
  const metricSvgSize = qs('#metric-svg-size');
  const metricCompression = qs('#metric-compression');
  const metricTime = qs('#metric-time');
  const metricColors = qs('#metric-colors');
  const metricPaths = qs('#metric-paths');

  let currentSvgString = null;
  let currentFileName = 'image';
  let currentSvgBlobUrl = null;

  function showProcessing(previewEl, text = 'Processing...') {
    clearProcessing(previewEl);
    const overlay = document.createElement('div');
    overlay.className = 'processing-overlay';
    overlay.innerHTML = `<div class="spinner" aria-hidden="true"></div><div class="processing-text">${text}</div>`;
    previewEl.appendChild(overlay);
    return overlay;
  }

  function clearProcessing(previewEl) {
    const existing = previewEl.querySelector('.processing-overlay');
    if (existing) existing.remove();
  }

  function setPlaceholder(previewEl, text) {
    previewEl.innerHTML = `<div class="preview-placeholder">${text}</div>`;
  }

  function clearPreview(previewEl) {
    previewEl.innerHTML = '';
  }

  function formatBytes(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function enableDownloadOptions() {
    if (downloadOptions) downloadOptions.classList.remove('hidden');
    if (metricsPanel) metricsPanel.classList.remove('hidden');
  }

  function disableDownloadOptions() {
    if (downloadOptions) downloadOptions.classList.add('hidden');
    if (metricsPanel) metricsPanel.classList.add('hidden');
    if (currentSvgBlobUrl) {
      URL.revokeObjectURL(currentSvgBlobUrl);
      currentSvgBlobUrl = null;
    }
  }

  async function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  async function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsArrayBuffer(file);
    });
  }

  // Very small helper: create temporary downloadable link and click it
  function triggerDownload(blob, filename) {
    if (currentSvgBlobUrl) {
      URL.revokeObjectURL(currentSvgBlobUrl);
      currentSvgBlobUrl = null;
    }
    currentSvgBlobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = currentSvgBlobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Inserts SVG string into svgPreview element safely
  function renderSVG(svgString) {
    if (!svgPreview) return;
    svgPreview.innerHTML = '';
    // Parse string to DOM
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(svgString, 'image/svg+xml');
      // Insert the SVG node into preview
      const svgNode = doc.documentElement;
      // Ensure proper width/height scaling
      svgNode.setAttribute('width', '100%');
      svgNode.setAttribute('height', '100%');
      svgNode.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svgPreview.appendChild(svgNode);
    } catch (err) {
      // Fallback: set as innerHTML
      svgPreview.innerHTML = svgString;
    }
  }

  // Main processing for a single file
  async function processFile(file) {
    console.debug('processFile: received', file && file.name, file && file.size);
    if (!file) return;
    if (!file.type || !file.type.startsWith('image')) {
      alert('Please upload an image file (PNG, JPEG, BMP, TIFF).');
      return;
    }

    currentFileName = (file.name || 'image').replace(/\.[^.]+$/, '');

    // Clear previous previews
    clearPreview(originalPreview);
    clearPreview(svgPreview);
    disableDownloadOptions();

    const startTime = performance.now();

    // Show processing overlay on original preview
    showProcessing(originalPreview, 'Loading image...');

    let dataUrl;
    try {
      dataUrl = await readFileAsDataURL(file);
    } catch (err) {
      clearProcessing(originalPreview);
      alert('Failed to read file.');
      return;
    }

    // Create image element
    const img = new Image();
    img.alt = file.name || 'Uploaded image';
    img.src = dataUrl;
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';

    // For TIFFs, some browsers cannot render them directly; use tiff.js to render to canvas
    const isTIFF = file.type === 'image/tiff' || file.name.toLowerCase().endsWith('.tif') || file.name.toLowerCase().endsWith('.tiff');
    if (isTIFF && typeof window.Tiff === 'function') {
      try {
        const buffer = await readFileAsArrayBuffer(file);
        const tiff = new Tiff({buffer});
        const canvas = tiff.toCanvas();
        // Convert canvas to dataURL
        const pngDataUrl = canvas.toDataURL('image/png');
        img.src = pngDataUrl;
      } catch (err) {
        console.warn('TIFF parsing via tiff.js failed:', err);
        // fall back to original dataUrl
      }
    }

    img.onload = async () => {
      clearProcessing(originalPreview);
      // Render original preview
      clearPreview(originalPreview);
      originalPreview.appendChild(img);
      originalZoomControls && originalZoomControls.classList.remove('hidden');

      // Prepare for conversion
      showProcessing(svgPreview, 'Converting to SVG...');

      // Attempt to use ImageTracer if present
      let svgString = null;

      if (window.ImageTracer && typeof window.ImageTracer.imageToSVG === 'function') {
        // Build options from UI controls if available
        const opts = buildOptionsFromUI();
        try {
          svgString = await promiseImageTracer(img, opts);
        } catch (err) {
          console.warn('ImageTracer conversion failed:', err);
        }
      }

      if (!svgString) {
        // Fallback: embed raster image inside an SVG wrapper
        const w = img.naturalWidth || img.width || 100;
        const h = img.naturalHeight || img.height || 100;
        svgString = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'><image href='${dataUrl}' width='${w}' height='${h}' preserveAspectRatio='xMidYMid meet'/></svg>`;
      }

      // Render SVG into preview
      renderSVG(svgString);
      clearProcessing(svgPreview);

      // Update metrics
      const endTime = performance.now();
      const elapsed = (endTime - startTime) / 1000;
      metricOriginalSize && (metricOriginalSize.textContent = formatBytes(file.size));

      // Estimate svg size
      try {
        const svgBlob = new Blob([svgString], { type: 'image/svg+xml' });
        metricSvgSize && (metricSvgSize.textContent = formatBytes(svgBlob.size));
        metricCompression && (metricCompression.textContent = ((file.size / svgBlob.size)||1).toFixed(2) + 'x');
      } catch (err) {
        metricSvgSize && (metricSvgSize.textContent = '—');
      }
      metricTime && (metricTime.textContent = elapsed.toFixed(2) + 's');

      // Basic color count via canvas sampling (downscale if necessary)
      computeColorsFromImage(img).then((colors) => {
        metricColors && (metricColors.textContent = colors);
      });

      // Paths: attempt to count <path> elements in SVG
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgString, 'image/svg+xml');
        const pathCount = doc.querySelectorAll('path').length || '—';
        metricPaths && (metricPaths.textContent = pathCount);
      } catch (err) {
        metricPaths && (metricPaths.textContent = '—');
      }

      // Store current SVG for download
      currentSvgString = svgString;

      enableDownloadOptions();

      // Wire download button behavior
      downloadVectorBtn && (downloadVectorBtn.onclick = () => {
        const blob = new Blob([currentSvgString], { type: 'image/svg+xml' });
        triggerDownload(blob, currentFileName + '.svg');
      });

      downloadEmbeddedBtn && (downloadEmbeddedBtn.onclick = () => {
        // Embedded option: wrap raster in svg (same as current fallback)
        const blob = new Blob([currentSvgString], { type: 'image/svg+xml' });
        triggerDownload(blob, currentFileName + '-embedded.svg');
      });

      downloadHybridBtn && (downloadHybridBtn.onclick = () => {
        const blob = new Blob([currentSvgString], { type: 'image/svg+xml' });
        triggerDownload(blob, currentFileName + '-hybrid.svg');
      });
    };

    img.onerror = (err) => {
      clearProcessing(originalPreview);
      alert('Failed to load image preview.');
      console.error('Image load error', err);
    };
  }

  // Promise wrapper for ImageTracer.imageToSVG API (many variations exist, so keep it tolerant)
  function promiseImageTracer(imgEl, opts) {
    return new Promise((resolve, reject) => {
      try {
        const callback = (svgStr) => {
          if (!svgStr) return reject(new Error('ImageTracer returned empty SVG')); 
          resolve(svgStr);
        };
        // Try common signatures
        if (typeof ImageTracer.imageToSVG === 'function') {
          try {
            // Some builds expect (img, options, callback)
            ImageTracer.imageToSVG(imgEl, opts, callback);
            return;
          } catch (e) {
            // Try (img, callback)
            try { ImageTracer.imageToSVG(imgEl, callback); return; } catch (e2) {}
          }
        }
        if (typeof ImageTracer.getSvg === 'function') {
          // imagetracer variants sometimes expose a getSvg method
          const svg = ImageTracer.getSvg(imgEl, opts || {});
          return resolve(svg);
        }
        reject(new Error('Unsupported ImageTracer API'));
      } catch (err) { reject(err); }
    });
  }

  // Build options from UI controls (map to imagetracer option names when possible)
  function buildOptionsFromUI() {
    const get = (id) => document.getElementById(id);
    const opts = {};
    try {
      const n = get('numberofcolors');
      if (n) opts.numberofcolors = Number(n.value);
      const lt = get('ltres'); if (lt) opts.ltres = Number(lt.value);
      const qt = get('qtres'); if (qt) opts.qtres = Number(qt.value);
      const po = get('pathomit'); if (po) opts.pathomit = Number(po.value);
      const br = get('blurradius'); if (br) opts.blurradius = Number(br.value);
      const sc = get('scale'); if (sc) opts.scale = Number(sc.value);
      const opt = get('path-optimize'); if (opt) opts.optimize = !!opt.checked;
      const ol = get('outline-mode'); if (ol) opts.outline = !!ol.checked;
      // High-quality toggle: for now just flag it
      const hq = get('high-quality'); if (hq) opts.highQuality = !!hq.checked;
    } catch (err) {
      // ignore
    }
    return opts;
  }

  // Compute approximate number of unique colors by sampling the image on an offscreen canvas
  async function computeColorsFromImage(imgEl) {
    try {
      const maxSample = 200; // sample at most 200x200
      const w = imgEl.naturalWidth || imgEl.width;
      const h = imgEl.naturalHeight || imgEl.height;
      const sw = Math.min(maxSample, w);
      const sh = Math.min(Math.round((h / w) * sw) || sw, maxSample);
      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgEl, 0, 0, sw, sh);
      const data = ctx.getImageData(0, 0, sw, sh).data;
      const set = new Set();
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
        if (a === 0) continue; // ignore transparent
        // quantize to reduce memory
        const key = ((r>>3)&31)<<10 | ((g>>3)&31)<<5 | ((b>>3)&31);
        set.add(key);
      }
      return set.size;
    } catch (err) {
      return '—';
    }
  }

  // Input change handler
  function onInputChange(ev) {
    console.debug('onInputChange', ev);
    const files = ev.target && ev.target.files;
    if (!files || !files.length) return;
    processFile(files[0]);
  }

  // Custom event 'files-dropped' from the drop zone fallback
  function onFilesDropped(e) {
    console.debug('onFilesDropped', e);
    const files = (e && e.detail && e.detail.files) || null;
    if (!files || !files.length) return;
    processFile(files[0]);
  }

  // Expose global hook for fallback
  window.handleFiles = function(files) {
    if (!files || !files.length) return;
    processFile(files[0]);
  };

  // Wire up events
  if (input) input.addEventListener('change', onInputChange);
  if (dropZone) dropZone.addEventListener('files-dropped', onFilesDropped);

  // Also wire native drop directly in case modifying input.files is restricted in some browsers
  if (dropZone) {
    dropZone.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const files = ev.dataTransfer && ev.dataTransfer.files;
      if (!files || !files.length) return;
      processFile(files[0]);
    });
  }

  // Debug helper: if debug button exists, create a tiny PNG blob and process it
  const debugBtn = document.getElementById('debug-insert-sample');
  if (debugBtn) {
    debugBtn.addEventListener('click', async () => {
      // create a 64x64 red PNG using canvas
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#d9534f';
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.fillText('SVG', 18, 36);
      const dataUrl = canvas.toDataURL('image/png');
      // convert to blob
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      blob.name = 'debug-sample.png';
      window.handleFiles([blob]);
    });
  }

  // Prevent default drop behavior when dragging files over the window
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // Initialize placeholders
  setPlaceholder(originalPreview, 'Upload an image to begin');
  setPlaceholder(svgPreview, 'SVG will appear here');

  // Small accessibility: pressing Enter on drop-zone opens file selector (already attached by HTML)

})();
