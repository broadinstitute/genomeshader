"""WebGPU is required, shared, and identical for one tile or many.

The viewer holds ONE GPUDevice and ONE set of compiled pipelines per page; every
canvas (main tracks, flow, each smart track in each tile) is a thin context on
top of it. There is no Canvas2D/SVG fallback for data: without WebGPU the viewer
says so. These tests guard those properties.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402
import reads_mock  # noqa: E402

# Count every GPUAdapter.requestDevice() the page makes.
COUNT_DEVICES = """
(() => {
  window.__GS_DEVICES = 0;
  if (navigator.gpu && window.GPUAdapter) {
    const orig = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = function (...a) { window.__GS_DEVICES++; return orig.apply(this, a); };
  }
})();
"""


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:  # pragma: no cover
            pytest.skip(f"chrome unavailable: {e}")
        yield b
        b.close()


def _open(browser, init_script=COUNT_DEVICES):
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.add_init_script(init_script)
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.orientation','horizontal');}catch(e){}"
    )
    import tempfile
    f = os.path.join(tempfile.mkdtemp(), "gpu_shared.html")
    open(f, "w").write(harness.build_page(config=reads_mock.CFG))
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_function("() => window.__GS_TEST_gpuStats().ready", timeout=20000)
    page.evaluate(reads_mock.INSTALL_JS, {"delay": 30})
    return page


def _idle(page, timeout=30000):
    page.wait_for_function(
        """() => { const d = window.__GS_TEST_readsRaceDump();
          return d.fetchActive === 0 && (d.queuedKeys || []).length === 0
            && (d.readLoadsInFlight || 0) === 0 && !d.schedulerPending; }""",
        timeout=timeout,
    )
    page.wait_for_timeout(200)


def _load_two_samples(page):
    page.evaluate(
        "() => Promise.all([__GS_TEST_spawnSample('SYN001','best_evidence'),"
        " __GS_TEST_spawnSample('SYN002','best_evidence')])"
    )
    _idle(page)


def _open_second_tile(page, contig="chr14", start=32147950, end=32151950):
    page.evaluate(
        """(a) => window.__GS_tiles.add({contig: a.contig, startBp: a.start, endBp: a.end})""",
        {"contig": contig, "start": start, "end": end},
    )
    _idle(page)
    page.wait_for_timeout(300)


def _renderers(page):
    """[{tile, track, gpu}] for every smart-track renderer in every tile."""
    return page.evaluate(
        """() => (window.__GS_STATE.tiles || []).flatMap(t =>
             [...((t._smartRenderers && t._smartRenderers.values()) || [])].map(r =>
               ({tile: t.id, track: r.container && r.container.dataset.trackId,
                 gpu: !!(r.webgpuCore && r.instancedRenderer)})))"""
    )


def test_one_device_and_one_pipeline_set_for_any_number_of_canvases(browser):
    page = _open(browser)
    _load_two_samples(page)
    _open_second_tile(page)
    st = page.evaluate("() => ({gpu: window.__GS_TEST_gpuStats(), devices: window.__GS_DEVICES})")
    assert st["devices"] == 1, f"expected one shared GPUDevice, page requested {st['devices']}"
    # rect, triangle, line, bezier — compiled once, not per canvas.
    assert st["gpu"]["pipelines"] == 4, st
    # main + flow per tile (2) plus one per smart track per tile (2 tracks... x 2 tiles)
    assert st["gpu"]["cores"] >= 2 * 2 + 2 * 2, st
    page.close()


def test_every_tile_paints_reads_on_the_gpu(browser):
    page = _open(browser)
    _load_two_samples(page)
    _open_second_tile(page)
    rs = _renderers(page)
    assert len(rs) >= 4, rs  # 2 tracks x 2 tiles
    assert all(r["gpu"] for r in rs), f"a tile is painting without WebGPU: {rs}"
    ink = page.evaluate("() => window.__GS_TEST_tileInk()")
    for tid, rows in ink.items():
        assert rows and all(v > 0 for v in rows.values()), (tid, rows)
    page.close()


def test_second_tile_paints_identically_to_the_first(browser):
    """Same locus, same width: both columns must hand the GPU exactly the same
    primitives for every track (one code path, no drift between how tiles paint
    the same data), and end up with essentially the same pixels."""
    page = _open(browser)
    _load_two_samples(page)
    page.evaluate(
        """() => { for (const t of window.__GS_STATE.smartTracks) {
             t.collapsed = false; t.readDisplay.visibility.reads = true; } window.__GS_TEST_renderAll(); }"""
    )
    _open_second_tile(page)
    page.evaluate("() => { for (const t of window.__GS_STATE.tiles) t.widthPx = 600; }")
    page.evaluate("() => window.__GS_TEST_renderAll()")
    page.wait_for_timeout(400)
    stats = page.evaluate(
        """() => window.__GS_STATE.tiles.map(t => [...t._smartRenderers.entries()]
             .map(([id, r]) => r.instancedRenderer.getStats()))"""
    )
    assert len(stats) == 2 and stats[0] == stats[1], f"tiles emit different primitives: {stats}"
    assert any(s["totalPolygons"] > 0 for s in stats[0]), stats
    ink = page.evaluate("() => window.__GS_TEST_tileInk()")
    a, b = (sorted(v.values()) for v in ink.values())
    assert len(a) == len(b)
    for x, y in zip(a, b):
        assert abs(x - y) <= 0.01 * max(x, y), f"tiles paint differently: {a} vs {b}"
    page.close()


def test_closing_a_tile_releases_its_gpu_canvases(browser):
    page = _open(browser)
    _load_two_samples(page)
    before = page.evaluate("() => window.__GS_TEST_gpuStats().cores")
    _open_second_tile(page)
    mid = page.evaluate("() => window.__GS_TEST_gpuStats().cores")
    assert mid > before
    page.evaluate("() => window.__GS_tiles.remove(window.__GS_STATE.tiles[1].id)")
    page.wait_for_timeout(400)
    after = page.evaluate("() => window.__GS_TEST_gpuStats().cores")
    assert after == before, f"GPU canvases leaked after closing a tile: {before} -> {mid} -> {after}"
    assert page.evaluate("() => window.__GS_DEVICES") == 1
    page.close()


def test_viewer_recovers_when_the_gpu_device_is_replaced(browser):
    """After a device loss the canvases re-attach to the recovered device and the
    reads repaint from the (unchanged) data."""
    page = _open(browser)
    _load_two_samples(page)
    page.evaluate(
        """() => { for (const t of window.__GS_STATE.smartTracks) {
             t.collapsed = false; t.readDisplay.visibility.reads = true; } window.__GS_TEST_renderAll(); }"""
    )
    page.wait_for_timeout(300)
    before = page.evaluate("() => window.__GS_TEST_tileInk()")
    epoch0 = page.evaluate("() => window.__GS_TEST_gpuStats().epoch")
    # Simulate the post-loss state, then run the real recovery path.
    page.evaluate(
        """async () => { const sh = window.__genomeshaderGpu;
             const d = sh.device; sh.device = null; sh._ready = null; sh.pipelines.clear();
             d.destroy(); await sh._recover(); }"""
    )
    page.wait_for_function("(e) => window.__GS_TEST_gpuStats().epoch > e", arg=epoch0, timeout=10000)
    page.wait_for_timeout(500)
    after = page.evaluate("() => window.__GS_TEST_tileInk()")
    assert after == before, f"reads did not repaint after device recovery: {before} -> {after}"
    page.close()


def test_missing_webgpu_shows_a_clear_message_not_a_fallback(browser):
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.add_init_script("try{delete Navigator.prototype.gpu;}catch(e){}"
                         "try{Object.defineProperty(navigator,'gpu',{value:undefined});}catch(e){}")
    import tempfile
    f = os.path.join(tempfile.mkdtemp(), "no_gpu.html")
    open(f, "w").write(harness.build_page(config=reads_mock.CFG))
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_selector(".gs-webgpu-required", timeout=10000)
    text = page.inner_text(".gs-webgpu-required")
    assert "WebGPU" in text
    page.close()
