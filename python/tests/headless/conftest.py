"""Headless viewer tests run in real Chrome with WebGPU.

The viewer requires WebGPU (there is no Canvas2D/SVG fallback), and Playwright's
bundled Chromium compiles WebGPU out, so every test in this directory launches
Chrome (``channel="chrome"``) with WebGPU enabled. The individual test modules
keep calling ``pw.chromium.launch(args=harness.CHROMIUM_ARGS)``; this hook adds
the channel and flags so they need no changes.

    python -m playwright install chrome        # once

On a machine with a GPU nothing else is needed (Metal on macOS, Vulkan on
Linux). On a GPU-less CI runner set ``GS_WEBGPU_SOFTWARE=1`` to route WebGPU
through SwiftShader's Vulkan ICD. Do not force Chrome's fallback adapter;
that freezes the page on a hosted runner.
"""
import os

import pytest

try:
    from playwright.sync_api import Browser, BrowserType
except Exception:  # pragma: no cover - playwright not installed; tests skip themselves
    Browser = BrowserType = None

# Console messages from viewer pages that flag a stale-paint bug (GS_VERIFY_PAINT=1).
_PAINT_MISSES = []

_GPU_ARGS = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]
# Chrome's fallback adapter (`--use-webgpu-adapter=swiftshader` together with
# `--use-angle=swiftshader`) freezes the page on a GPU-less runner: requestAdapter
# wedges the GPU process and Playwright calls stop returning. Route WebGPU through
# SwiftShader's Vulkan ICD instead, and don't ask ANGLE for a GL surface.
_SOFTWARE_ARGS = [
    "--use-angle=vulkan",
    "--use-vulkan=swiftshader",
    "--enable-features=Vulkan",
    "--disable-vulkan-surface",
    "--disable-gpu-sandbox",
    "--no-sandbox",
]


@pytest.fixture(scope="session", autouse=True)
def _chrome_with_webgpu():
    if BrowserType is None:
        yield
        return
    orig = BrowserType.launch

    def launch(self, **kw):
        if self.name == "chromium":
            kw.setdefault("channel", "chrome")
            kw["ignore_default_args"] = list(kw.get("ignore_default_args") or []) + ["--disable-gpu"]
            # The bundled-Chromium harness forces software GL; that flag hides WebGPU.
            args = [a for a in (kw.get("args") or []) if not a.startswith("--use-gl")]
            args += _GPU_ARGS
            if os.environ.get("GS_WEBGPU_SOFTWARE"):
                args += _SOFTWARE_ARGS
            kw["args"] = args
        return orig(self, **kw)

    BrowserType.launch = launch
    try:
        yield
    finally:
        BrowserType.launch = orig


@pytest.fixture(scope="session", autouse=True)
def _collect_paint_key_misses():
    """With GS_VERIFY_PAINT=1 the viewer repaints on every paint-signature hit and
    logs PAINT_KEY_MISS if the pixels changed; collect those from every page."""
    if Browser is None or not os.environ.get("GS_VERIFY_PAINT"):
        yield
        return
    orig = Browser.new_page

    def new_page(self, *a, **kw):
        page = orig(self, *a, **kw)
        page.on("console", lambda m: _PAINT_MISSES.append(m.text) if "PAINT_KEY_MISS" in m.text else None)
        return page

    Browser.new_page = new_page
    try:
        yield
    finally:
        Browser.new_page = orig


@pytest.fixture(autouse=True)
def _no_paint_key_misses():
    before = len(_PAINT_MISSES)
    yield
    new = _PAINT_MISSES[before:]
    assert not new, "paint signature skipped a repaint that would have changed pixels:\n" + "\n".join(new[:5])
