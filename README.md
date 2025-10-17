# Image to SVG Converter 
Convert images into clean, scalable vector graphics with intelligent controls, real-time preview, and precision vectorization settings. Designed for designers, developers, and digital artists who care about visual quality.

![Status](https://img.shields.io/badge/status-active-brightgreen)
![Tech](https://img.shields.io/badge/built_with-HTML%20%7C%20CSS%20%7C%20JavaScript-blue)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## Overview
The **Image to SVG Converter** transforms raster images (PNG, JPG, BMP, TIFF) into optimized SVG vector files while preserving clarity and edge quality. It includes powerful customization controls and a professional interface that prioritizes usability and output precision.

This tool supports both **single image conversion** and **batch processing**, with quality metrics and visual comparison previews built in.

---

## Features
- Drag and drop image upload
- Live **SVG preview** + zoom and pan
- **Vectorization controls**:
  - Number of colors
  - Line and curve smoothness
  - Detail filtering
  - Outline and path optimization modes
- Batch queue processing
- Quality analysis and complexity reporting
- SVG file download options:
  - Vector only
  - Embedded pixel-perfect mode
- Keyboard accessible + screen reader friendly
- Clean, responsive UI built with **Inter** typography and modern CSS

---

## Tech Stack
| Category | Tech |
|----------|------|
| Language | HTML, CSS, JavaScript |
| Vector Engine | ImageTracer.js |
| Image Support | TIFF.js |
| UI Logic | Vanilla JS |
| Accessibility | ARIA roles + keyboard support |

---

## Folder Structure
image-to-svg-converter
│── index.html
│── app.js
│── imagetracer_v1.2.6.js
│── quality-validator.js
│── styles.css (optional if separated)
│── assets/
└── README.md


---

## Getting Started

### 1. Clone the Repo
```bash
git clone https://github.com/YOUR_USERNAME/image-to-svg-converter.git
cd image-to-svg-converter

### 2. Run Locally

No build tools required. Just open index.html in your browser.
