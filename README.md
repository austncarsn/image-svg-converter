# VectorStudio — Advanced Image to SVG Converter

An advanced, browser-based, high-fidelity raster-to-vector (SVG) conversion suite featuring Rust-compiled WASM tracing, intelligent image classification, color-quantization preprocessing, and automated object/badge isolation.

![Status](https://img.shields.io/badge/status-active-brightgreen)
![Tech](https://img.shields.io/badge/built_with-HTML5%20%7C%20CSS3%20%7C%20Vite%20%7C%20Rust%20WASM%20%7C%20JS-blue)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## 🌟 Overview

VectorStudio is a client-side vectorization engine that transforms PNG, JPG, BMP, TIFF, and WebP images into clean, scalable SVG paths. By combining Rust-powered `vtracer` compilation via WebAssembly with custom JS image processing filters, it delivers Illustrator-grade tracing results entirely in the browser. No images are uploaded to any server.

**Live Application:** [https://image-svg-converter-phi.vercel.app](https://image-svg-converter-phi.vercel.app)

---

## 🚀 Key Features

### 1. WASM-Powered Vector Engine
Uses a Rust-compiled WebAssembly port of the `visioncortex` vectorization engine (`vtracer-wasm`), executing parallelized boundary tracing for high-performance, crisp path generation.

### 2. Color Quantization Pre-Pass (Median-Cut)
Overcomes the typical WASM clustering limits on smooth gradients by pre-filtering images using a custom, no-dither median-cut color quantization algorithm. This posterizes inputs into clean, flat palettes prior to tracing, preventing artifacting.

### 3. Automated Image Classification
Uses real-time feature extraction (color counting, edge density, transparency ratios, circularity) to auto-route uploaded images into specialized preset pipelines:
- **Logo / Flat Graphics**: Extreme color reduction, sharp borders, clean curves.
- **Badge / Emblem**: Automatically detects badge circularity and protects fine text bands.
- **Sticker Sheet**: Detects artwork borders, preserving dark details and white backing layers.
- **Line Art / Drawing**: Optimizes for organic contours or strict monochrome paths.
- **Illustration / Detailed**: Retains complex palettes using high-density vector clustering.
- **Photo**: Preserves fidelity using embedded raster-wrappers.

### 4. Smart Preprocessing & Object Isolation
- **Background Policy Engine**: Analyzes corner pixels to determine background uniformity and isolates main subjects.
- **Rim & Arc Text Protection**: Specifically shields curved lettering inside badges using adaptive thresholding.
- **Circular Masking**: Clips isolated circular badges to produce neat bounding geometry.

### 5. Production-Grade Sanitization & Optimization
- **XML Sanitizer**: Strips event handlers (`on*`), malicious URL schemes (`javascript:`, `vbscript:`, protocol-relative `//`), and unsafe elements (`script`, `iframe`, `foreignObject`, `feImage`) to ensure vectors are safe to embed.
- **Path Merging & Speckle Filtering**: Combines adjacent paths with identical fills to reduce path counts (10x-50x file size reduction) and filters out tiny visual artifacts.

---

## 📁 Repository Structure

```
image-svg-converter-main/
├── dist/                          # Production-ready minified build outputs
├── scripts/                       # Regression and visual test suites
│   ├── test-classifier.mjs        # Classifier routing validation
│   ├── test-preset-contracts.mjs  # Preset property contract checking
│   ├── test-presets-regression.mjs# End-to-end preset output tests
│   ├── test-quantized-trace.mjs   # Quantized tracer validation
│   └── test-sticker-visual-...    # Visual edge detection checks
├── src/                           # Frontend application source
│   ├── background-policy.js       # Background detection/uniformity analysis
│   ├── badge-detect.js            # Badge boundary and text-band detection
│   ├── badge-preprocess.js        # Contrast boost, text-protection, masking
│   ├── diagnostics.js             # SVG performance profiling
│   ├── export-utils.js            # Output format helpers
│   ├── image-classifier.js        # Feature-based image category router
│   ├── image-data.js              # ImageData helper utilities
│   ├── image-prepare.js           # Downscaling, cropping, and canvas utilities
│   ├── image-quantize.js          # Median-cut quantization algorithm
│   ├── main.js                    # UI orchestrator and pipeline coordinator
│   ├── pipeline-preprocess.js     # Unified preprocessing pipeline
│   ├── presets.js                 # Global trace parameter configurations
│   ├── presets_config.js          # Preset schema and defaults
│   ├── style.css                  # UI design tokens and layout
│   ├── svg-sanitize.js            # SVG parser, optimizer, and path merger
│   ├── trace-pipeline.js          # Core trace scheduling pipeline
│   ├── vtracer-trace.js           # WebAssembly vtracer wrapper and validation
│   └── zip-helper.js              # Client-side batch ZIP exporter
├── index.html                     # Core HTML5 entry point
├── package.json                   # Project scripts and dependencies
└── README.md                      # Documentation
```

---

## 🛠️ Tech Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Build System** | Vite | Ultra-fast development server and asset packager |
| **Core UI / Styling** | Vanilla CSS | HSL color tokens, CSS nesting, and responsive grids |
| **Vector Engine** | `vtracer-wasm` | Rust-based visioncortex boundary tracing |
| **Color Quantization**| Median-Cut JS | Custom zero-dependency color-quantizer |
| **Sanitizer** | `svgo` / `svg-pathdata` | Industrial-strength SVG clean-up and path optimization |
| **Batch Exporter** | Custom ZIP Generator | Fast, client-side ZIP creator (CRC32, MS-DOS time) |

---

## ⚙️ Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (version 18 or higher recommended)

### 1. Installation
Clone the repository and install dependencies:
```bash
npm install
```

### 2. Run Locally
Start the local Vite development server:
```bash
npm run dev
```
Navigate to the local URL (typically `http://localhost:5173/`).

### 3. Build for Production
Create an optimized production bundle in the `dist/` directory:
```bash
npm run build
```

---

## 🧪 Testing Suite
Verify correctness, performance, and formatting across the pipeline by running the test suite:

- **Run all regression tests**:
  ```bash
  npm run test:preset-contracts && npm run test:quantized-trace && npm run test:classifier && npm run test:sticker-visual && npm run test:presets-regression
  ```

---

## 📄 License
This project is licensed under the MIT License. See the `LICENSE` file for details.
