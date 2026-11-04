# export.py: static PDF/PNG of a locus, rendered by the real viewer in headless Chrome.
#
# The viewer requires WebGPU, so export drives Google Chrome through Playwright
# against a page served by the session's ViewerServer; reads arrive through the
# same /api a browser tab would use. On a GPU-less Linux host set
# GS_WEBGPU_SOFTWARE=1 with VK_DRIVER_FILES pointing at Mesa lavapipe and run
# under Xvfb (scripts/setup_gpu_webgpu.sh) -- the CI-proven software path.
import os
import threading
from pathlib import Path
from typing import Optional, Sequence

# Playwright adds --disable-gpu by default; it hides navigator.gpu.
CHROME_WEBGPU_ARGS = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]
# Software WebGPU uses the Vulkan ICD in VK_DRIVER_FILES (lavapipe), not Chrome's
# SwiftShader fallback, which wedges requestAdapter or presents an empty canvas.
# Headed so the canvas has a surface to present (xvfb-run provides the display).
CHROME_SOFTWARE_WEBGPU_ARGS = [
    "--use-angle=vulkan",
    "--use-vulkan=native",
    "--enable-features=Vulkan",
    "--disable-gpu-sandbox",
    "--disable-dev-shm-usage",
    "--no-sandbox",
]

# Fixed presentation for figures: no panels, horizontal layout, light theme.
_FIGURE_INIT_JS = """
try {
  localStorage.setItem('genomeshader.sidebarCollapsed', 'true');
  localStorage.setItem('genomeshader.rightSidebarCollapsed', 'true');
  localStorage.setItem('genomeshader.orientation', 'horizontal');
  localStorage.setItem('genomeshader.theme', %(theme)s);
  localStorage.removeItem('genomeshader.lockView');
  localStorage.removeItem('genomeshader.panZoom');
} catch (e) {}
"""

_IDLE_JS = """() => {
  const d = window.__GS_TEST_readsRaceDump && window.__GS_TEST_readsRaceDump();
  return !!d && d.fetchActive === 0 && (d.queuedKeys || []).length === 0
    && (d.readLoadsInFlight || 0) === 0 && !d.schedulerPending;
}"""

_SETTLE_JS = """() => new Promise(r => setTimeout(() =>
  requestAnimationFrame(() => requestAnimationFrame(() => r(true))), 300))"""

# The viewer container (figure mode leaves only the tracks in it).
_CLIP_JS = """() => {
  const root = document.querySelector('[id^="genomeshader-root-"]');
  if (!root) return null;
  const r = root.getBoundingClientRect();
  return {x: r.left, y: r.top, width: r.width, height: r.height};
}"""

_TRACKS_JS = """() => {
  const d = window.__GS_TEST_readsRaceDump();
  return {
    tracks: d.tracks.map(t => ({sample: t.sampleId, bam: t.bamPin, reads: t.nReads})),
    failures: d.failures || [],
  };
}"""

# Height (px from the container top) where the last track ends. Track boxes
# keep their layout size even when scrolled out of view, so this is stable
# across container heights (unlike scrollHeight, which grows with the pane).
_CONTENT_HEIGHT_JS = """() => {
  const root = document.querySelector('[id^="genomeshader-root-"]');
  if (!root) return 0;
  const top = root.getBoundingClientRect().top;
  let bottom = 0;
  root.querySelectorAll('.smart-track-container, .track-control-container').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.height > 0) bottom = Math.max(bottom, r.bottom);
  });
  return Math.ceil(bottom - top);
}"""

_FIT_PAD_PX = 8

_RESIZE_JS = """(h) => {
  const root = document.querySelector('[id^="genomeshader-root-"]');
  root.style.height = h + 'px';
  root.style.setProperty('--gs-widget-h', h + 'px');
  window.dispatchEvent(new Event('resize'));
}"""

# Error dialogs (e.g. "Failed to load reads") are reported, then removed so
# they never land in the figure.
_TAKE_MODALS_JS = """() => {
  const out = [];
  document.querySelectorAll('.gs-modal-backdrop').forEach((b) => {
    const t = b.querySelector('.gs-modal-title'), m = b.querySelector('.gs-modal-msg');
    out.push(((t && t.textContent) || '') + ': ' + ((m && m.textContent) || ''));
    b.remove();
  });
  return out;
}"""

MAX_FIT_HEIGHT = 8000


class ExportError(RuntimeError):
    pass


def chrome_launch_kwargs(software: Optional[bool] = None) -> dict:
    """Playwright launch() kwargs for Chrome with WebGPU (hardware or lavapipe)."""
    if software is None:
        software = bool(os.environ.get("GS_WEBGPU_SOFTWARE"))
    args = list(CHROME_WEBGPU_ARGS) + (CHROME_SOFTWARE_WEBGPU_ARGS if software else [])
    return {
        "channel": "chrome",
        "args": args,
        "ignore_default_args": ["--disable-gpu"],
        "headless": not software,
    }


def _write_figure(page, out_path: Path, clip: dict, device_scale: float) -> str:
    """Write the page as PNG or PDF (by suffix); returns the format written.

    PDF comes from Chrome's print path: text, SVG and DOM stay vector and the
    WebGPU canvases are embedded as bitmaps at device_scale. Chrome only prints
    to PDF when headless, so a headed browser (the GPU-less lavapipe setup)
    falls back to a screenshot wrapped in a single-page PDF.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.suffix.lower() != ".pdf":
        page.screenshot(path=str(out_path), clip=clip)
        return "png"
    try:
        page.emulate_media(media="screen")
        page.pdf(path=str(out_path), width=f"{clip['width']}px", height=f"{clip['height']}px",
                 print_background=True, page_ranges="1",
                 margin={"top": "0", "right": "0", "bottom": "0", "left": "0"})
        return "pdf"
    except Exception as e:
        if "headless" not in str(e).lower():
            raise
    import io
    from PIL import Image
    img = Image.open(io.BytesIO(page.screenshot(clip=clip))).convert("RGB")
    # Same physical size as the vector PDF: CSS px at 96 dpi.
    img.save(str(out_path), "PDF", resolution=96.0 * device_scale)
    return "pdf-raster"


def _render_figure(url: str, out_path: Path, width: int, height: Optional[int], theme: str,
                   device_scale: float, timeout_s: float, samples: Sequence[str],
                   browser=None) -> dict:
    from playwright.sync_api import sync_playwright

    fit = height is None
    start_h = height or 900

    def _shoot(b):
        ctx = b.new_context(viewport={"width": width, "height": start_h},
                            device_scale_factor=device_scale,
                            color_scheme="dark" if theme == "dark" else "light")
        try:
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.add_init_script(_FIGURE_INIT_JS % {"theme": repr(theme)})
            ms = int(timeout_s * 1000)
            page.goto(url, wait_until="load", timeout=ms)
            page.wait_for_function("() => window.__GS_READY === true || !!window.__GS_ERR", timeout=ms)
            err = page.evaluate("() => window.__GS_ERR")
            if err:
                raise ExportError(f"viewer failed to start: {err}")
            if not page.evaluate("() => !!navigator.gpu"):
                raise ExportError("WebGPU unavailable in Chrome (see GS_WEBGPU_SOFTWARE in genomeshader.export)")
            # Map to a scalar: the settled values are live track objects, which
            # Playwright would try (and fail) to serialize.
            page.evaluate("() => window.__GS_INITIAL_LOAD.then(() => true)")
            page.wait_for_function(_IDLE_JS, timeout=ms)
            # Let the debounced (100 ms) resize/render observers fire, then two
            # frames for layout + GPU presentation. Waited in-page: a Playwright
            # wait_for_timeout here leaves the next page in the same browser
            # unable to produce frames (headless Chrome + WebGPU).
            page.evaluate(_SETTLE_JS)
            warnings = []
            h = start_h
            for _ in range(4):
                need = page.evaluate(_CONTENT_HEIGHT_JS) + _FIT_PAD_PX
                if not fit:
                    if need - _FIT_PAD_PX > h + 1:
                        warnings.append(f"{need - _FIT_PAD_PX - h}px of tracks cut off at height={height}; "
                                        "pass height=None to fit, or show fewer samples")
                    break
                if need > MAX_FIT_HEIGHT:
                    warnings.append(f"content is {need}px tall; cut off at {MAX_FIT_HEIGHT}px")
                    need = MAX_FIT_HEIGHT
                if abs(need - h) <= 2:
                    break
                h = need
                page.set_viewport_size({"width": width, "height": h})
                page.evaluate(_RESIZE_JS, h)
                page.evaluate(_SETTLE_JS)
            clip = page.evaluate(_CLIP_JS)
            if not clip:
                raise ExportError("viewer layout not found")
            state = page.evaluate(_TRACKS_JS)
            problems = page.evaluate(_TAKE_MODALS_JS)
            problems += [f"reads chunk failed ({f['attempts']}x): {f['key']}" for f in state["failures"]]
            shown = {t["sample"] for t in state["tracks"]}
            problems += [f"no read track for {s}" for s in samples if str(s) not in shown]
            if problems:
                page.evaluate(_SETTLE_JS)
            fmt = _write_figure(page, out_path, clip, device_scale)
            return {"path": str(out_path), "format": fmt, "tracks": state["tracks"],
                    "errors": problems, "warnings": warnings, "page_errors": errors}
        finally:
            ctx.close()

    if browser is not None:
        return _shoot(browser)
    with sync_playwright() as pw:
        b = pw.chromium.launch(**chrome_launch_kwargs())
        try:
            return _shoot(b)
        finally:
            b.close()


def export_locus_figure(shader, locus: str, out_path, samples: Sequence[str] = (),
                        width: int = 1600, height: Optional[int] = 1000, seed: Optional[str] = None,
                        read_set: Optional[str] = None, show_reads: bool = True,
                        theme: str = "light", device_scale: float = 2.0,
                        timeout_s: float = 180.0, browser=None) -> dict:
    """Render `locus` with one track per sample in `samples` (in order) to a
    PDF or PNG, chosen by `out_path`'s suffix.

    PDF keeps text and vector graphics sharp at any zoom, with reads embedded as
    bitmaps; PNG is a plain screenshot. `device_scale` sets the bitmap pixels
    per CSS pixel for both (2 = retina-sharp; raise it for print).

    `read_set` keeps one attach_reads label (e.g. "pacbio") per sample instead
    of every attached BAM/CRAM. `height=None` grows the image to fit every
    track; a fixed height that cuts tracks off is reported in "warnings".
    `seed` fixes any in-page sample selection (config.selection_seed). Pass an
    open Playwright `browser` to reuse one Chrome across many loci; it must be
    used from the calling thread.

    Returns {"path", "format", "tracks", "errors", "warnings", "page_errors"};
    "format" is "png", "pdf", or "pdf-raster" (headed Chrome cannot print, so
    the PDF wraps a screenshot). "errors"
    lists failed read fetches and requested samples with no track; any error
    dialog is removed from the image and reported here instead.
    """
    if theme not in ("light", "dark"):
        raise ValueError("theme must be 'light' or 'dark'")
    out_path = Path(out_path)
    if out_path.suffix.lower() not in (".pdf", ".png"):
        raise ValueError("out_path must end in .pdf or .png")
    try:
        import playwright  # noqa: F401
    except ImportError as e:
        raise ExportError("Figure export needs Playwright and Chrome: "
                          "pip install 'genomeshader[export]' && python -m playwright install chrome") from e

    from .widget import build_standalone_page

    shader.render(locus, inline_payload=True)
    config = dict(shader._last_config)
    config.update({
        "comm_available": True,
        # The window's variants are inlined; refetching them on load only adds
        # time and another source of run-to-run difference.
        "viewport_variant_loading": False,
        "initial_samples": [str(s) for s in samples],
        "initial_show_reads": bool(show_reads),
    })
    if seed is not None:
        config["selection_seed"] = str(seed)
    if read_set is not None:
        config["initial_evidence"] = str(read_set)
    srv = shader.viewer_server()
    html = build_standalone_page(config, shader._last_view_id or "gsexport", srv.token,
                                 width=width, height=height or 900, figure=True)
    url = srv.base_url + srv.add_page(html)
    samples = [str(s) for s in samples]

    if browser is not None:
        return _render_figure(url, out_path, width, height, theme, device_scale, timeout_s,
                              samples, browser)
    # Playwright's sync API refuses to run on a thread with an asyncio loop
    # (any Jupyter kernel), so drive it from a fresh thread.
    box = {}

    def _run():
        try:
            box["result"] = _render_figure(url, out_path, width, height, theme, device_scale,
                                           timeout_s, samples)
        except BaseException as e:  # re-raised on the caller's thread
            box["error"] = e

    t = threading.Thread(target=_run, name="gs-export", daemon=True)
    t.start()
    t.join()
    if "error" in box:
        raise box["error"]
    return box["result"]
