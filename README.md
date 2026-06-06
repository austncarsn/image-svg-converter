# Image to SVG Converter

Browser-safe image to SVG converter with background removal, object isolation, and compact vector tracing.

![Status](https://img.shields.io/badge/status-active-brightgreen)
![Tech](https://img.shields.io/badge/built_with-HTML%20%7C%20CSS%20%7C%20Vite%20%7C%20JS-blue)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## Overview

The **Image to SVG Converter** is a client-side web app that turns PNG, JPG, BMP, and TIFF files into downloadable SVG vector output. It prepares large uploads safely, removes the connected background around the main object, and traces a compact SVG path result without uploading images to a server.

**Live app:** https://image-svg-converter-phi.vercel.app

### Features

- **Simple upload flow**: Enter the workspace, upload one image, preview the original and vector result, then download the SVG.
- **Automatic asset detection**: Classifies the image as logo, photo, drawing, or line art before applying trace settings.
- **Object isolation**: Samples the corners, removes connected background pixels, and crops around the main object before vectorizing.
- **Browser-safe tracing**: Downscales large uploads before tracing so high-resolution images are less likely to freeze the page.
- **Compact SVG output**: Uses palette simplification, path omission, coordinate rounding, viewBox normalization, and SVG cleanup to reduce path count and markup size.
- **Local processing**: Image processing runs in the browser; uploads are not sent to a backend.

### Best For

- Product cutouts on simple backgrounds
- Logos, icons, stickers, badges, and flat illustrations
- Simple drawings or line art
- Images where a slightly simplified vector result is preferred over pixel-perfect reproduction

### Limitations

- Complex photographs will be simplified and may lose fine texture.
- Background removal is corner/edge based, so busy backgrounds or objects touching the image edge may need preprocessing.
- Very large images are resized before tracing to keep the browser responsive.

---

## Folder Structure

```
image-svg-converter-main/
├── dist/                  # Production build outputs (optimized assets)
├── src/
│   ├── main.js            # UI logic, background removal, tracing, preview, downloads
│   ├── style.css          # Modern CSS tokens, nesting, theme-switching & layout styles
│   └── zip-helper.js      # Zero-dependency, client-side ZIP generator (CRC32, MS-DOS time)
├── index.html             # Application entry point with semantic markup
├── package.json           # Vite development and build scripts
└── README.md              # Project documentation
```

---

## Tech Stack

| Category          | Technology                | Description                                                            |
| ----------------- | ------------------------- | ---------------------------------------------------------------------- |
| **Build Tool**    | Vite                      | Modern, ultra-fast development server and bundle system                |
| **Styling**       | Vanilla CSS               | HSL CSS variables, native nesting, view transitions, responsive layout |
| **Vector Engine** | ImageTracer.js            | Client-side raster-to-vector tracing                                   |
| **Ext Support**   | TIFF.js                   | Client-side decoding of TIFF images                                    |
| **Safety**        | Bounded canvas processing | Prevents large synchronous traces from freezing the browser            |
| **Export**        | SVG Blob download         | Generates downloadable SVG files directly in the browser               |

---

## Getting Started

### Prerequisites

Make sure you have [Node.js](https://nodejs.org/) installed (v18+ recommended).

### 1. Installation

Install project development dependencies:

```bash
npm install
```

### 2. Run Development Server

Spin up the local Vite server:

```bash
npm run dev
```

Open the provided URL (usually `http://localhost:5173/`) in your browser.

### 3. Build for Production

Generate optimized, minified production assets in the `dist/` directory:

```bash
npm run build
```

---

## License

Distributed under the MIT License. See `LICENSE` (if applicable) for more information.
