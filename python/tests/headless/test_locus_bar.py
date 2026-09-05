"""Always-visible top locus bar (IGV-style): contig + position + Go.

Drives the real viewer (headless Chromium) and asserts the jump behavior:
- the bar exists and is populated from chrom_lengths,
- a start-end range jumps the view there,
- a single position expands +/-100 bp on each side,
- switching contig via the bar works.

Navigation issues a `navigate` comm which the harness rejects (no kernel), but
gsGoToLocus sets state synchronously BEFORE that, so state assertions hold.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

CFG = {
    "region": "chr1:1000-2000",
    "chrom_lengths": {"chr1": 1_000_000, "chr2": 500_000},
    "viewport_variant_loading": False,
}


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:
            pytest.skip(f"headless chromium unavailable: {e}")
        yield b
        b.close()


def _open(browser, cfg=CFG):
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    html = harness.build_page(config=cfg)
    f = os.path.join(tempfile.mkdtemp(), "lb.html")
    open(f, "w").write(html)
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    return page


def _state(page):
    return page.evaluate(
        "() => ({c: __GS_STATE.contig, s: Math.round(__GS_STATE.startBp), "
        "e: Math.round(__GS_STATE.endBp)})")


def test_bar_present_and_populated(browser):
    page = _open(browser)
    assert page.eval_on_selector("#locusBar", "el => !!el")
    opts = page.evaluate(
        "() => Array.from(document.getElementById('locusContigSelect').options).map(o => o.value)")
    assert "chr1" in opts and "chr2" in opts
    page.close()


def test_go_range(browser):
    page = _open(browser)
    page.evaluate(
        "() => { document.getElementById('locusContigSelect').value='chr1';"
        "document.getElementById('locusPosInput').value='1,000-2,000';"
        "document.getElementById('locusGoBtn').click(); }")
    s = _state(page)
    assert (s["c"], s["s"], s["e"]) == ("chr1", 1000, 2000), s
    page.close()


def test_go_single_position_expands_100bp(browser):
    page = _open(browser)
    page.evaluate(
        "() => { document.getElementById('locusContigSelect').value='chr1';"
        "document.getElementById('locusPosInput').value='1500';"
        "document.getElementById('locusGoBtn').click(); }")
    s = _state(page)
    # +/-100 each side of 1500.
    assert (s["s"], s["e"]) == (1400, 1600), s
    page.close()


def test_go_switches_contig(browser):
    page = _open(browser)
    page.evaluate("() => window.gsGoToLocus('chr2:100-200')")
    s = _state(page)
    assert (s["c"], s["s"], s["e"]) == ("chr2", 100, 200), s
    page.close()


def test_enter_key_submits(browser):
    page = _open(browser)
    page.evaluate("() => { document.getElementById('locusContigSelect').value='chr1'; }")
    page.fill("#locusPosInput", "5000-6000")
    page.press("#locusPosInput", "Enter")
    s = _state(page)
    assert (s["s"], s["e"]) == (5000, 6000), s
    page.close()
