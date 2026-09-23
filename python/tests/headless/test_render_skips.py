"""Work the viewer must NOT do (and must still do when it matters).

Pan frames used to rebuild every track's control pills and paint every smart
track, visible or not. These tests pin the skips down from both sides: what is
skipped when nothing changed / nothing is visible, and that a real change or a
scroll into view still repaints.
"""
from __future__ import annotations

import os
import sys
import tempfile

import pytest

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "bench"))
pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402
import bench_render  # noqa: E402  (its synthetic-reads kernel mock)

N = 14
SAMPLES = [f"S{i:03d}" for i in range(N)]


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:  # pragma: no cover
            pytest.skip(f"chrome unavailable: {e}")
        yield b
        b.close()


def _open(browser):
    page = browser.new_page(viewport={"width": 1400, "height": 800})
    page.add_init_script("try{localStorage.setItem('genomeshader.orientation','horizontal');}catch(e){}")
    cfg = {
        "region": "chr14:32140000-32160000",
        "chrom_lengths": {"chr14": 107_043_718},
        "viewport_variant_loading": False,
        "read_samples": SAMPLES,
        "read_bam_index": {s: [f"gs://bench/{s}.bam"] for s in SAMPLES},
        "sample_mapping": {s: [f"gs://bench/{s}.bam"] for s in SAMPLES},
    }
    f = os.path.join(tempfile.mkdtemp(), "skips.html")
    open(f, "w").write(harness.build_page(config=cfg))
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_function("() => window.__GS_TEST_gpuStats().ready", timeout=20000)
    page.evaluate(bench_render.INSTALL_JS, {"coverage": 8.0, "readLen": 6000, "snpRate": 0.001, "indelRate": 0.0005})
    page.evaluate(
        "async (ids) => { await Promise.all(ids.map(id => window.__GS_TEST_spawnSample(id, 'best_evidence'))); }",
        SAMPLES,
    )
    page.wait_for_function(
        """() => { const d = window.__GS_TEST_readsRaceDump();
          return d.fetchActive === 0 && (d.queuedKeys || []).length === 0 && !d.schedulerPending; }""",
        timeout=60000,
    )
    return page


def _expand_all(page):
    page.evaluate(
        """() => { for (const t of window.__GS_STATE.smartTracks) {
             t.collapsed = false; t.readDisplay.visibility.reads = true; t.readDisplay.visibility.summary = true; }
           window.__GS_TEST_renderAll(); }"""
    )
    page.wait_for_timeout(400)


def _renderer_state(page):
    """{trackId: {culled, key}} — the paint signature a renderer last painted with."""
    return page.evaluate(
        """() => Object.fromEntries([...window.__GS_STATE.tiles[0]._smartRenderers.entries()]
             .map(([id, r]) => [id, {culled: !!r._culled, key: r._paintKey || ''}]))"""
    )


def _pan(page, bp):
    page.evaluate(
        """(bp) => { const S = window.__GS_STATE; S.startBp += bp; S.endBp += bp;
             window.__GS_tiles.pull(); window.__GS_TEST_renderAll(); }""",
        bp,
    )
    page.wait_for_timeout(200)


def _ink(page):
    return list(page.evaluate("() => window.__GS_TEST_tileInk()").values())[0]


def test_offscreen_tracks_are_not_painted_and_paint_when_scrolled_into_view(browser):
    page = _open(browser)
    _expand_all(page)
    before = _renderer_state(page)
    assert len(before) == N
    hidden = [t for t, v in before.items() if v["culled"]]
    shown = [t for t, v in before.items() if not v["culled"]]
    assert hidden and shown, f"expected a mix of painted and culled tracks: {before}"
    assert page.evaluate("() => window.__GS_TEST_gpuStats().culledTracks") == len(hidden)

    # Pan: visible tracks must repaint (new window => new signature); culled ones
    # must NOT (their signature stays what it was).
    _pan(page, 400)
    after = _renderer_state(page)
    assert all(after[t]["key"] != before[t]["key"] for t in shown), "a visible track was not repainted on pan"
    assert all(after[t]["key"] == before[t]["key"] for t in hidden), "a culled track was painted on pan"

    # Scroll the reads stack to the bottom: the previously culled tracks come into
    # range and must paint for the CURRENT window (no manual repaint — the scroll
    # listener does it).
    page.evaluate(
        "() => { const w = document.querySelector('.gs-smart-scroll'); w.scrollTop = w.scrollHeight; }"
    )
    page.wait_for_timeout(600)
    scrolled = _renderer_state(page)
    newly_visible = [t for t in hidden if not scrolled[t]["culled"]]
    assert newly_visible, f"scrolling to the bottom revealed no culled track: {scrolled}"
    assert all(scrolled[t]["key"] != after[t]["key"] for t in newly_visible), \
        "scrolled-into-view track kept its stale paint"
    ink = _ink(page)
    assert all(ink[t] > 0 for t in newly_visible), ("scrolled-into-view track has no pixels", ink)
    page.close()


def test_unchanged_track_controls_are_kept_and_changes_rebuild_them(browser):
    if os.environ.get("GS_VERIFY_PAINT"):
        pytest.skip("verify mode deliberately rebuilds the pills to compare them")
    page = _open(browser)
    _expand_all(page)
    page.evaluate("() => window.__GS_TEST_renderAll()")
    page.evaluate(
        """() => { window.__mark = document.querySelector('.track-control-container[data-track-id^="smart-track-"]');
                   window.__mark.__kept = true; }"""
    )
    page.evaluate("() => { window.__GS_TEST_renderAll(); window.__GS_TEST_renderAll(); }")
    kept = page.evaluate(
        """() => { const el = document.querySelector('.track-control-container[data-track-id^="smart-track-"]');
                  return !!(el && el.__kept); }"""
    )
    assert kept, "control pills were rebuilt although nothing they show changed"

    # A visible change (label) must rebuild them and show the new text.
    page.evaluate(
        """() => { window.__GS_STATE.smartTracks[0].label = 'RENAMED-TRACK'; window.__GS_TEST_renderAll(); }"""
    )
    txt = page.evaluate("() => document.querySelector('#trackControls, [id^=\"trackControls\"]').innerText")
    assert "RENAMED-TRACK" in txt, txt
    page.close()
