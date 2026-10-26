# export.py: static PNG of a locus, rendered by the real viewer in headless Chrome.
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
  return d.tracks.map(t => ({sample: t.sampleId, bam: t.bamPin, reads: t.nReads}));
}"""


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


def _render_png(url: str, out_path: Path, width: int, height: int, theme: str,
                device_scale: float, timeout_s: float, browser=None) -> dict:
    from playwright.sync_api import sync_playwright

    def _shoot(b):
        ctx = b.new_context(viewport={"width": width, "height": height},
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
            clip = page.evaluate(_CLIP_JS)
            if not clip:
                raise ExportError("viewer layout not found")
            tracks = page.evaluate(_TRACKS_JS)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(out_path), clip=clip)
            return {"path": str(out_path), "tracks": tracks, "page_errors": errors}
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


def export_locus_png(shader, locus: str, out_path, samples: Sequence[str] = (),
                     width: int = 1600, height: int = 1000, seed: Optional[str] = None,
                     show_reads: bool = True, theme: str = "light", device_scale: float = 1.0,
                     timeout_s: float = 180.0, browser=None) -> dict:
    """Render `locus` with one track per sample in `samples` (in order) to a PNG.

    `seed` fixes any in-page sample selection (config.selection_seed). Pass an
    open Playwright `browser` to reuse one Chrome across many loci; it must be
    used from the calling thread. Returns {"path", "tracks", "page_errors"}.
    """
    if theme not in ("light", "dark"):
        raise ValueError("theme must be 'light' or 'dark'")
    try:
        import playwright  # noqa: F401
    except ImportError as e:
        raise ExportError("PNG export needs Playwright and Chrome: "
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
    srv = shader.viewer_server()
    html = build_standalone_page(config, shader._last_view_id or "gsexport", srv.token,
                                 width=width, height=height, figure=True)
    url = srv.base_url + srv.add_page(html)
    out_path = Path(out_path)

    if browser is not None:
        return _render_png(url, out_path, width, height, theme, device_scale, timeout_s, browser)
    # Playwright's sync API refuses to run on a thread with an asyncio loop
    # (any Jupyter kernel), so drive it from a fresh thread.
    box = {}

    def _run():
        try:
            box["result"] = _render_png(url, out_path, width, height, theme, device_scale, timeout_s)
        except BaseException as e:  # re-raised on the caller's thread
            box["error"] = e

    t = threading.Thread(target=_run, name="gs-export", daemon=True)
    t.start()
    t.join()
    if "error" in box:
        raise box["error"]
    return box["result"]
