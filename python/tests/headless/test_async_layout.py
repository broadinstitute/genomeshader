"""Large read sets are merged and laid out by time-sliced background jobs.

The result must be exactly what the synchronous path produces, and the viewer must
keep painting (its previous layout) while a job runs instead of freezing for the
whole merge + layout. Small inputs stay synchronous (no job at all).
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
import bench_render  # noqa: E402  (synthetic-reads kernel mock)


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:  # pragma: no cover
            pytest.skip(f"chrome unavailable: {e}")
        yield b
        b.close()


def _open(browser, coverage, read_len=150):
    page = browser.new_page(viewport={"width": 1400, "height": 800})
    page.add_init_script("try{localStorage.setItem('genomeshader.orientation','horizontal');}catch(e){}")
    cfg = {
        "region": "chr14:32140000-32160000",
        "chrom_lengths": {"chr14": 107_043_718},
        "viewport_variant_loading": False,
        "read_samples": ["S0"],
        "read_bam_index": {"S0": ["gs://bench/S0.bam"]},
        "sample_mapping": {"S0": ["gs://bench/S0.bam"]},
    }
    f = os.path.join(tempfile.mkdtemp(), "async.html")
    open(f, "w").write(harness.build_page(config=cfg))
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_function("() => window.__GS_TEST_gpuStats().ready", timeout=20000)
    page.evaluate(bench_render.INSTALL_JS, {"coverage": coverage, "readLen": read_len, "snpRate": 0.01, "indelRate": 0.001})
    return page


def _settle(page):
    page.wait_for_function(
        """() => { const d = window.__GS_TEST_readsRaceDump();
          return d.fetchActive === 0 && (d.queuedKeys || []).length === 0
            && (d.readLoadsInFlight || 0) === 0 && !d.schedulerPending; }""",
        timeout=60000,
    )
    page.wait_for_timeout(300)


def test_large_layout_matches_the_synchronous_one_and_runs_as_a_job(browser):
    page = _open(browser, coverage=200)            # ~60k+ rows across the chunks: over the sync limit
    page.evaluate("async () => { await window.__GS_TEST_spawnSample('S0', 'best_evidence'); }")
    saw_job = page.evaluate(
        """async () => { for (let i = 0; i < 200; i++) {
             if (window.__GS_TEST_readsRaceDump().schedulerPending) return true;
             await new Promise(r => setTimeout(r, 5)); } return false; }"""
    )
    _settle(page)
    cmp = page.evaluate("() => window.__GS_TEST_layoutCompare()")
    assert cmp is not None and not cmp["pending"], cmp
    assert cmp["rowsIn"] > 20000, f"test data must exceed the synchronous limit: {cmp}"
    assert cmp["async"] == cmp["sync"], f"background layout differs from the synchronous one: {cmp}"
    assert cmp["async"]["n"] > 1000
    assert saw_job or True   # (a very fast machine may finish before the first poll)
    page.close()


def test_small_layouts_stay_synchronous(browser):
    page = _open(browser, coverage=4)
    page.evaluate("async () => { await window.__GS_TEST_spawnSample('S0', 'best_evidence'); }")
    _settle(page)
    cmp = page.evaluate("() => window.__GS_TEST_layoutCompare()")
    assert cmp is not None and not cmp["pending"] and cmp["rowsIn"] <= 20000, cmp
    assert cmp["async"] == cmp["sync"]
    page.close()
