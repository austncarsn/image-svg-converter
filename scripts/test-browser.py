"""Browser regression gate for the intake module and the built application.

Run after npm ci && npm run build:
  python -m pip install playwright==1.51.0 Pillow==11.3.0
  python -m playwright install chromium
  python scripts/test-browser.py chromium
"""
import io
import pathlib
import socket
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from contextlib import contextmanager

from PIL import Image, ImageDraw, TiffImagePlugin
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[1]
BROWSER = sys.argv[1] if len(sys.argv) > 1 else "chromium"
SVG_NS = "{http://www.w3.org/2000/svg}"


@contextmanager
def server(mode):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    # Invoke the installed Vite directly so terminating the process also
    # terminates the server, rather than leaving an npm child running.
    command = ["node", "node_modules/vite/bin/vite.js"]
    if mode == "preview":
        command.append("preview")
    command += ["--host", "127.0.0.1", "--port", str(port), "--strictPort"]
    proc = subprocess.Popen(command, cwd=ROOT)
    try:
        for _ in range(120):
            if proc.poll() is not None:
                raise RuntimeError("Vite exited during startup")
            try:
                with urllib.request.urlopen(url, timeout=1):
                    break
            except OSError:
                time.sleep(0.25)
        else:
            raise RuntimeError("Vite did not become ready")
        yield url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def encode(image, fmt, name, **kwargs):
    buffer = io.BytesIO()
    image.save(buffer, format=fmt, **kwargs)
    mime = {"JPEG": "image/jpeg", "PNG": "image/png", "BMP": "image/bmp",
            "WEBP": "image/webp", "TIFF": "image/tiff"}[fmt]
    return {"name": name, "mimeType": mime, "buffer": buffer.getvalue()}


def fixtures():
    transparent = Image.new("RGBA", (96, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(transparent)
    draw.rectangle((16, 16, 35, 35), fill=(0, 0, 0, 255))
    draw.rectangle((56, 16, 75, 35), fill=(255, 0, 0, 255))
    opaque = Image.new("RGB", transparent.size, "white")
    opaque.paste(transparent, mask=transparent.getchannel("A"))
    rotated = Image.new("RGB", (6, 4), "white")
    rotated.putpixel((0, 0), (255, 0, 0))
    tags = TiffImagePlugin.ImageFileDirectory_v2()
    tags[274] = 6
    return {
        "png": encode(transparent, "PNG", "art.png"),
        "webp": encode(transparent, "WEBP", "art.webp", lossless=True),
        "jpeg": encode(opaque, "JPEG", "art.jpg", quality=95),
        "bmp": encode(opaque, "BMP", "art.bmp"),
        "tiff": encode(opaque, "TIFF", "art.tiff", compression="tiff_lzw"),
        "tiff_raw": encode(opaque, "TIFF", "raw.tiff", compression="raw"),
        "tiff_deflate": encode(opaque, "TIFF", "deflate.tiff", compression="tiff_adobe_deflate"),
        "tiff_packbits": encode(opaque, "TIFF", "packbits.tiff", compression="packbits"),
        "tiff_multi": encode(opaque, "TIFF", "multi.tiff", save_all=True,
                             append_images=[Image.new("RGB", (8, 8), "blue")]),
        "tiff_orientation": encode(rotated, "TIFF", "rotate.tiff", tiffinfo=tags),
        "opaque": encode(opaque, "PNG", "opaque.png"),
        "partial": encode(Image.new("RGBA", (4, 4), (0, 0, 0, 128)), "PNG", "partial.png"),
        "invalid": {"name": "invalid.tiff", "mimeType": "image/tiff", "buffer": b"not an image"},
        "corrupt": {"name": "corrupt.png", "mimeType": "image/png",
                    "buffer": b"\x89PNG\r\n\x1a\n" + b"\x00" * 16},
    }


def serializable(fixture):
    return {**fixture, "buffer": list(fixture["buffer"])}


def test_intake(browser, url, fs):
    page = browser.new_page()
    page.goto(url, wait_until="domcontentloaded")
    for key in ("png", "webp", "jpeg", "bmp", "tiff", "tiff_raw", "tiff_deflate",
                "tiff_packbits", "tiff_multi", "tiff_orientation", "opaque", "partial"):
        result = page.evaluate("""async ({fixture, key}) => {
          const m = await import('/src/image-prepare.js');
          const file = new File([Uint8Array.from(fixture.buffer)], fixture.name,
                                {type: fixture.mimeType});
          const {type} = await m.validateImageFile(file);
          const {source, sourceUrl} = await m.loadSourceFromFile(file, type);
          let working;
          try {
            working = await m.prepareWorkingImage(source, {
              removeBackground: !key.startsWith('tiff_orientation'),
              config: {workingImageMaxDim: 2048}
            });
            const pixels = m.getTracingImageData(working.img, 2048);
            let black = 0, red = 0;
            for (let i = 0; i < pixels.data.length; i += 4) {
              const [r,g,b,a] = pixels.data.subarray(i, i+4);
              if (a === 255 && r === 0 && g === 0 && b === 0) black++;
              if (a === 255 && r === 255 && g === 0 && b === 0) red++;
            }
            return {type, black, red, removed: working.removedBackground,
                    width: pixels.width, height: pixels.height,
                    originalWidth: working.originalWidth, originalHeight: working.originalHeight,
                    firstAlpha: pixels.data[3], corner: Array.from(pixels.data.slice(12,16))};
          } finally {
            m.cleanupImage(working?.img);
            m.cleanupSource(source, sourceUrl);
          }
        }""", {"fixture": serializable(fs[key]), "key": key})
        if key in ("png", "webp"):
            assert (result["black"], result["red"]) == (400, 400), (key, result)
            assert (result["width"], result["height"], result["removed"]) == (96, 64, False), result
        elif key == "opaque":
            assert result["removed"] and result["black"] == result["red"] == 400, result
        elif key == "partial":
            assert not result["removed"] and result["firstAlpha"] == 128, result
        elif key == "tiff_orientation":
            assert (result["width"], result["height"]) == (4, 6), result
            assert result["corner"] == [255, 0, 0, 255], result
        else:
            assert (result["originalWidth"], result["originalHeight"]) == (96, 64), (key, result)
        print(f"Intake {key}: PASS", flush=True)

    result = page.evaluate("""async () => {
      const m = await import('/src/image-prepare.js');
      const invalid = [[0,1],[8001,4000],[16385,1],[2.5,4],[NaN,10]];
      m.validateDecodedDimensions(8000,4000);
      return invalid.every(([w,h]) => {
        try { m.validateDecodedDimensions(w,h); return false; } catch { return true; }
      });
    }""")
    assert result, "Dimension validation accepted invalid input"
    page.close()


def download(page, selector):
    with page.expect_download(timeout=90_000) as info:
        page.locator(selector).click()
    path = info.value.path()
    return path.read_bytes()


def assert_svg(data, paths=False):
    root = ET.fromstring(data)
    assert root.tag == SVG_NS + "svg", root.tag
    vb = root.attrib.get("viewBox", "").replace(",", " ").split()
    assert len(vb) == 4 and float(vb[2]) > 0 and float(vb[3]) > 0, vb
    if paths:
        assert root.findall(".//" + SVG_NS + "path"), "No editable SVG paths"
        assert not root.findall(".//" + SVG_NS + "image"), "Raster wrapper instead of vector"
    return root


def raster(page, data):
    return page.evaluate("""async svg => {
      const url = URL.createObjectURL(new Blob([svg], {type:'image/svg+xml'}));
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width=192; c.height=128;
        const ctx=c.getContext('2d');
        ctx.drawImage(img, 0, 0, c.width, c.height);
        return Array.from(ctx.getImageData(0,0,c.width,c.height).data);
      } finally { URL.revokeObjectURL(url); }
    }""", data.decode())


def test_built_app(browser, url, fs):
    context = browser.new_context(accept_downloads=True, viewport={"width": 1440, "height": 1000})
    context.add_init_script("""Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: {writeText: async value => { window.__copied = value; }}
    });""")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url, wait_until="domcontentloaded")
    with page.expect_file_chooser() as chooser:
        page.locator("#landing-browse-btn").click()
    chooser.value.set_files(fs["png"])

    upload = page.locator("#file-input")
    button = page.locator("#download-vector-btn")
    ready = lambda: expect(button).to_be_enabled(timeout=90_000)
    ready()
    # Explicit Logo mode exercises the background-removal path even if
    # classifier thresholds change.
    page.locator('[data-preset="logo"]').click()
    ready()
    plain = download(page, "#download-vector-btn")
    assert_svg(plain, paths=True)
    pixels = raster(page, plain)
    assert any(pixels[i:i+4] == [0, 0, 0, 255] for i in range(0, len(pixels), 4)), "Black artwork missing"
    assert any(pixels[i] > 200 and pixels[i+1] < 40 and pixels[i+2] < 40 and pixels[i+3] > 200
               for i in range(0, len(pixels), 4)), "Red artwork missing"
    page.locator(".export-secondary-actions summary").click()
    optimized = download(page, "#download-optimized-svg-btn")
    assert_svg(optimized, paths=True)
    assert raster(page, plain) == raster(page, optimized), "Optimized export changed rendering"
    page.locator("#copy-svg-markup-btn").click()
    page.wait_for_function("window.__copied !== undefined")
    assert page.evaluate("window.__copied").encode() == plain, "Clipboard differs from download"

    for key in ("png", "jpeg", "bmp", "tiff", "webp"):
        upload.set_input_files(fs[key])
        ready()
        assert_svg(download(page, "#download-vector-btn"))
        print(f"Built app {key}: PASS", flush=True)

    upload.set_input_files(fs["opaque"])
    ready()
    page.locator('[data-preset="logo"]').click()
    ready()
    original = page.locator("#pane-original img").evaluate("""img => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d'); ctx.drawImage(img,0,0);
      return [c.width,c.height,...ctx.getImageData(0,0,1,1).data];
    }""")
    assert original == [96, 64, 255, 255, 255, 255], original

    for key in ("invalid", "corrupt"):
        upload.set_input_files(fs[key])
        expect(page.locator("#pane-original .error-message")).to_be_visible(timeout=30_000)
        expect(button).to_be_disabled()
        upload.set_input_files(fs["png"])
        ready()

    upload.set_input_files([fs["png"], fs["webp"]])
    expect(page.locator("#queue-list .queue-item.completed")).to_have_count(2, timeout=120_000)
    page.wait_for_function("""() => !!document.querySelector(
      '#queue-list .queue-item.completed.processing[data-index="0"]'
    ) && !document.querySelector('#download-vector-btn').disabled""", timeout=90_000)
    first = download(page, "#download-vector-btn")
    archive = download(page, "#download-zip-btn")
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        assert z.testzip() is None
        assert z.namelist() == ["art.svg", "art-2.svg"], z.namelist()
        assert z.read("art.svg") == first, "Batch export differs from individual export"
        for name in z.namelist():
            assert_svg(z.read(name))

    assert not errors, errors
    context.close()


def test_mobile(browser, url, fs):
    page = browser.new_page(viewport={"width": 390, "height": 844}, has_touch=True)
    page.goto(url, wait_until="domcontentloaded")
    with page.expect_file_chooser() as chooser:
        page.locator("#landing-browse-btn").click()
    chooser.value.set_files(fs["png"])
    expect(page.locator("#queue-list .queue-item.completed")).to_have_count(1, timeout=90_000)
    page.close()


if __name__ == "__main__":
    if BROWSER not in ("chromium", "firefox", "webkit"):
        raise SystemExit("Choose chromium, firefox or webkit")
    fs = fixtures()
    with sync_playwright() as p:
        browser = getattr(p, BROWSER).launch()
        try:
            with server("dev") as url:
                test_intake(browser, url, fs)
            with server("preview") as url:
                test_built_app(browser, url, fs)
                test_mobile(browser, url, fs)
        finally:
            browser.close()
    print(f"{BROWSER}: browser regression suite passed", flush=True)
