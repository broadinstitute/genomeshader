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


def _go_disabled(page):
    return page.eval_on_selector("#locusGoBtn", "el => el.disabled")


def test_go_disabled_until_edit(browser):
    page = _open(browser)
    assert _go_disabled(page) is True                 # nothing changed yet
    page.fill("#locusPosInput", "1,000-2,000")         # typing stages -> enables Go
    assert _go_disabled(page) is False
    page.click("#locusGoBtn")                          # commit -> greys out again
    assert _go_disabled(page) is True
    page.close()


def test_go_range(browser):
    page = _open(browser)
    page.fill("#locusPosInput", "1,000-2,000")         # fill fires input -> dirty -> Go on
    page.click("#locusGoBtn")
    s = _state(page)
    assert (s["c"], s["s"], s["e"]) == ("chr1", 1000, 2000), s
    page.close()


def test_go_single_position_expands_100bp(browser):
    page = _open(browser)
    page.fill("#locusPosInput", "1500")
    page.click("#locusGoBtn")
    s = _state(page)
    # +/-100 each side of 1500.
    assert (s["s"], s["e"]) == (1400, 1600), s
    page.close()


def test_contig_select_stages_not_jumps(browser):
    # Picking a contig must NOT jump; it stages the change and enables Go.
    page = _open(browser)
    page.evaluate(
        "() => { const s = document.getElementById('locusContigSelect');"
        "s.value = 'chr2'; s.dispatchEvent(new Event('change', {bubbles: true})); }")
    assert _state(page)["c"] == "chr1"                 # still on chr1 (not jumped)
    assert _go_disabled(page) is False                 # Go now enabled
    page.click("#locusGoBtn")
    assert _state(page)["c"] == "chr2"                  # committed
    page.close()


def test_chrom_click_stages_pending_box(browser):
    # Clicking the chromosome overview (opt-in) stages a pending target: sets
    # __pendingLocus, fills the bar, enables Go — but does NOT jump.
    page = _open(browser)
    before = _state(page)
    r = page.evaluate(r"""() => {
        window.__GS_STATE.chromClickJump = true;
        window.__GS_STATE.gestureMovedPx = 0;
        const hit = window.__GS_STATE.__ideogramHitRect;
        if (!hit) return { ok: false, reason: 'no hit rect' };
        const m = document.getElementById('main').getBoundingClientRect();
        // Click ~25% across the ideogram band.
        const ev = { button: 0,
            clientX: m.left + hit.x + hit.w * 0.25,
            clientY: m.top + hit.y + hit.h * 0.5 };
        const staged = window.gsMaybeChromClickStage(ev);
        return { ok: true, staged: staged, pl: window.__GS_STATE.__pendingLocus,
                 goDisabled: document.getElementById('locusGoBtn').disabled };
    }""")
    assert r["ok"], r
    assert r["staged"] is True
    assert r["pl"] and r["pl"]["contig"] == before["c"]
    assert r["goDisabled"] is False                    # Go enabled by the stage
    assert _state(page) == before                      # view NOT moved yet
    # The staged center should sit near 25% of the contig (chr1 = 1,000,000).
    center = (r["pl"]["start"] + r["pl"]["end"]) / 2
    assert 200_000 < center < 300_000, center
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
