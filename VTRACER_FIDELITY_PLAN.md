# High-Fidelity Vector Tracing — Plan & Prompt

## TL;DR (read this first)

You asked to "build a better vtracer WASM." After verifying against the real
sources, **rebuilding `vtracer-wasm` from the same upstream will NOT fix the
badge.** Proof below. The genuine fix is one of:

1. A **color-quantization pre-pass** before vtracer (most promising, stays
   local + free), or
2. A **newer engine** (`@neplex/vectorizer`, Node-only — needs a different
   runtime), or
3. A **hosted API** (true Illustrator-grade, but paid + uploads the image).

This doc gives you the facts, then a concrete plan + a ready-to-paste prompt
for whichever route you choose.

---

## What we proved (don't re-derive this)

The current engine is `vtracer-wasm@0.1.0`, which embeds **`visioncortex 0.8.8`**

- the `vtracer` app, compiled with nightly Rust via `wasm-bindgen` +
  `serde-wasm-bindgen`.

Tested directly against the installed `.wasm` (Node harness):

| Finding                                                                                                              | Evidence                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `colorPrecision` default is **6** (matches upstream `cmdapp/src/config.rs`)                                          | upstream `Default` impl: `color_precision: 6`                                          |
| `colorPrecision: 7` → collapses a detailed image to ~1 averaged region                                               | sweep test                                                                             |
| `colorPrecision: 8` → **traps the wasm** (`unreachable`/hash-table overflow), poisons the module for all later calls | `color_precision_loss = 8 - color_precision` → 0 bits lost → blows the color hashtable |
| On a faithful badge sim, vtracer yields **only 6 colors** at cp6                                                     | sweep test                                                                             |
| `layerDifference` (0–16) has **zero effect** on color count for that badge                                           | sweep test — stuck at 6 colors at every value                                          |

**Conclusion:** 6 coarse colors is `visioncortex 0.8.8`'s genuine ceiling for
dense, anti-aliased AI-art at its only safe precision. A clean rebuild of the
_same source_ reproduces this exactly. The WASM packaging is not the bottleneck;
the clustering algorithm is.

There is also a real bug already fixed in `sanitizeAndOptimizeSvg` (the
trailing-zero regex corrupted high-precision coords) — keep that fix regardless
of engine.

---

## Current state of the code (so you don't regress it)

- `complex` profile (detected for detailed badges) currently routes to the
  **image-wrapper** strategy: a valid `.svg` that embeds the source PNG via
  `<image href="data:image/png;...">`. Pixel-perfect, but raster-backed — this
  is what looks like "a PNG." It IS a real `.svg` file.
- `logo` / `drawing` / `lineart` still use **real vtracer path tracing** and
  look good (flat graphics don't hit the clustering ceiling).
- `photo` uses image-wrapper by design.
- Engine module: `src/vtracer-trace.js` (lazy WASM init, `colorPrecision`
  hard-capped at 6 to avoid the cp8 trap — keep that cap for any 0.8.8 build).

---

## Route A — Color-quantization pre-pass (RECOMMENDED: local + free)

**Idea:** vtracer collapses because the badge's anti-aliased gradients defeat
its clustering. If we _quantize_ the image to a clean N-color palette FIRST
(e.g. 16–32 flat colors, no anti-aliasing), vtracer then traces each flat region
crisply — many more colors, sharp edges. This is exactly how Illustrator's
"Image Trace" gets clean results: posterize, then trace.

**Plan:**

1. Add a quantizer. Options (pick one):
   - `rgbquant` (npm, ~small, MIT) — Wu/NeuQuant color quantization in JS.
   - Or hand-roll median-cut (~80 lines, no dep) for full control / zero deps.
2. In `processQueueItem`, for `complex`: quantize the working canvas to ~24–32
   colors with **no dithering** (dithering re-introduces noise vtracer hates),
   producing a flat-color `ImageData`.
3. Feed that quantized `ImageData` to the EXISTING vtracer path
   (`traceImageDataToSvg`) with `colorPrecision: 6`, `filterSpeckle: 2–4`.
   Because the input is already flat, vtracer keeps the regions distinct.
4. Re-add `complex` to `VTRACER_PROFILES` and flip its `EXPORT_STRATEGIES` back
   to `"path-trace"`. Keep image-wrapper as the automatic fallback if the
   quantized trace yields too few paths.
5. Verify in the Node harness: quantized badge sim should now yield ~20–32
   colors / many paths instead of 6.

**Risk:** quantization choice matters; too few colors = posterized, too many =
vtracer collapses again. Tune the palette size. This is the highest-upside
local option and worth trying before anything paid.

---

## Route B — Newer engine (`@neplex/vectorizer`)

`@neplex/vectorizer` wraps a newer vtracer via **native N-API (Node only)** — it
will NOT run in the browser as-is. Only viable if you move tracing to a small
Node service / Electron main process. More fidelity than 0.8.8, but a runtime
change. Skip unless you're willing to add a backend.

---

## Route C — Hosted vectorizer API (true Illustrator-grade)

For `complex` only, POST the PNG to Vectorizer.AI or recraft.ai, get back real
multi-color vector SVG. Best quality, but: needs an API key, ~$0.10–0.20/image,
and uploads the image off-device (breaks local-only). Keep all other profiles
local. Gate behind an explicit opt-in setting so users consent to the upload.

---

## Ready-to-paste prompt (Route A — recommended)

> In this repo, detailed badges (`complex` profile) currently route to the
> image-wrapper strategy because `vtracer-wasm@0.1.0` (visioncortex 0.8.8)
> collapses anti-aliased AI-art to ~6 colors at its only safe `colorPrecision`
> (6; 7 collapses, 8 traps the wasm — see `VTRACER_FIDELITY_PLAN.md`).
>
> Implement a color-quantization pre-pass so `complex` can be path-traced with
> high fidelity, fully locally:
>
> 1. Add a no-dither color quantizer (median-cut, ~80 lines, zero deps
>    preferred; or `rgbquant` pinned exact if you justify the dep).
> 2. In `src/main.js`, before tracing a `complex` asset, quantize the working
>    `ImageData` to a tunable palette (start at 28 colors, no dithering).
> 3. Feed the quantized `ImageData` to the existing `traceImageDataToSvg`
>    (`src/vtracer-trace.js`) with `colorPrecision: 6`, `filterSpeckle: 3`.
>    Keep the `colorPrecision ≤ 6` hard cap (8 traps the wasm).
> 4. Flip `complex` back to `"path-trace"` in `EXPORT_STRATEGIES` and re-add it
>    to `VTRACER_PROFILES`. If the quantized trace yields < ~12 paths, fall back
>    to the image-wrapper automatically (don't ship a grey blob).
> 5. Keep the trailing-zero regex fix in `sanitizeAndOptimizeSvg` intact.
> 6. Verify with a Node harness (`node` script importing `vtracer-wasm` from the
>    project dir, feeding a synthetic multi-tone badge): the quantized path must
>    produce ≥ 20 distinct fill colors and many paths, vs. 6 today. Then
>    `npm run build` clean and a `vite preview` asset check.
>    Do NOT add paid services or send the image off-device. Report the
>    before/after color+path counts from the harness.

---

## What to keep no matter what

- The `colorPrecision ≤ 6` cap in `src/vtracer-trace.js` (cp8 traps the wasm).
- The trailing-zero lookahead fix in `sanitizeAndOptimizeSvg` (coordinate
  corruption bug).
- image-wrapper as the _fallback_ for `complex` when a trace would look worse
  than the raster.
