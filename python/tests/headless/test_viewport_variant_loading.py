"""Viewport-driven variant loading (#71) + overscan (#41) — behavior tests.

Drives the real viewer (headless Chromium, no GPU needed) with
`viewport_variant_loading` enabled and a mocked comm (`window.__GS_SEND`), then
asserts the windowed-fetch behavior that lets the browser page through a cohort
larger than memory:

- initial load fetches the opening window padded by overscan (#41),
- panning/zooming beyond the loaded window fetches the new window,
- staying within a loaded window fetches nothing (coverage skip),
- ranging far evicts distant windows (bounded loaded-window count).

The comm is mocked by overriding `window.__GS_SEND` (the viewer reads it at call
time via sendCommMessage), returning canned variants inside the requested
window and logging every request. No ipywidgets kernel required.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
pytest.importorskip("anywidget")

from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

VIEWPORT = {"width": 1200, "height": 900}

# Mock comm: record every request; answer fetch_variants with 3 variants inside
# the requested window. Installed after load (overrides the harness stub).
INSTALL_MOCK = r"""
() => {
  window.__GS_COMM_LOG = [];
  window.__GS_SEND = function (type, data, timeoutMs) {
    window.__GS_COMM_LOG.push({ type, data });
    if (type === "fetch_variants") {
      const { contig, start, end } = data;
      const mk = (p) => ({ id: contig + ":" + p, position: p, pos: p,
        ref: "A", alt: "C", n_ref: 10, n_alt: 5, n_missing: 0, n_samples: 15 });
      const mid = Math.floor((start + end) / 2);
      return Promise.resolve({
        type: "fetch_variants_response",
        variant_tracks: [{ name: "vp", variants_data: [mk(start + 1), mk(mid), mk(end - 1)] }],
        insertion_variants_lookup: [],
      });
    }
    return Promise.resolve({});
  };
}"""


def _fetch_calls(page):
    return page.evaluate(
        "() => (window.__GS_COMM_LOG || []).filter(e => e.type === 'fetch_variants')")


def _set_view(page, start, end):
    """Move the viewport by mutating the live state object, then run the loader."""
    return page.evaluate(
        """async (v) => {
            window.__GS_STATE.startBp = v.start;
            window.__GS_STATE.endBp = v.end;
            await window.gsLoadVariantsForViewport(false);
        }""", {"start": start, "end": end})


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:
            pytest.skip(f"headless chromium unavailable: {e}")
        yield b
        b.close()


def _open(browser):
    page = browser.new_page(viewport=VIEWPORT)
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.orientation','horizontal');"
        "localStorage.setItem('genomeshader.theme','light');}catch(e){}")
    # file:// origin via a temp file (harness pattern); config enables windowing.
    import tempfile
    html = harness.build_page(config={"viewport_variant_loading": True})
    f = os.path.join(tempfile.mkdtemp(), "vp.html")
    open(f, "w").write(html)
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.evaluate(INSTALL_MOCK)
    return page


def test_initial_load_fetches_overscanned_window(browser):
    page = _open(browser)
    view = page.evaluate("() => ({s: window.__GS_STATE.startBp, e: window.__GS_STATE.endBp})")
    page.evaluate("async () => await window.gsLoadVariantsForViewport(true)")
    calls = _fetch_calls(page)
    assert len(calls) == 1, f"expected one initial fetch, got {calls}"
    d = calls[0]["data"]
    # overscan (#41): fetched window pads the viewport on both sides.
    assert d["start"] < view["s"], f"no left overscan pad: {d} vs {view}"
    assert d["end"] > view["e"], f"no right overscan pad: {d} vs {view}"
    # variants landed in config.variant_tracks
    n = page.evaluate(
        "() => ((window.GENOMESHADER_CONFIG.variant_tracks||[])[0]||{}).variants_data?.length || 0")
    assert n == 3
    regions = page.evaluate("() => window.__gsVpState().regions")
    assert len(regions) == 1
    page.close()


def test_coverage_skip_within_loaded_window(browser):
    page = _open(browser)
    page.evaluate("async () => await window.gsLoadVariantsForViewport(true)")
    assert len(_fetch_calls(page)) == 1
    # Nudge the view a little but stay inside the already-loaded (overscanned)
    # window -> no new fetch.
    view = page.evaluate("() => ({s: window.__GS_STATE.startBp, e: window.__GS_STATE.endBp})")
    span = view["e"] - view["s"]
    _set_view(page, view["s"] + span * 0.05, view["e"] + span * 0.05)
    assert len(_fetch_calls(page)) == 1, "a within-window nudge should not refetch"
    page.close()


def test_pan_beyond_window_fetches_again(browser):
    page = _open(browser)
    page.evaluate("async () => await window.gsLoadVariantsForViewport(true)")
    assert len(_fetch_calls(page)) == 1
    view = page.evaluate("() => ({s: window.__GS_STATE.startBp, e: window.__GS_STATE.endBp})")
    span = view["e"] - view["s"]
    # Jump well past the overscan pad -> a new window must be fetched.
    _set_view(page, view["s"] + span * 5, view["e"] + span * 5)
    assert len(_fetch_calls(page)) == 2, "a pan beyond coverage should refetch"
    page.close()


def test_far_ranging_evicts_distant_windows(browser):
    page = _open(browser)
    page.evaluate("async () => await window.gsLoadVariantsForViewport(true)")
    base = page.evaluate("() => ({s: window.__GS_STATE.startBp, e: window.__GS_STATE.endBp})")
    span = base["e"] - base["s"]
    # March far away in big steps; each step loads a new window and should evict
    # ones now far from center (keepSpan = 3x span).
    for k in range(1, 7):
        _set_view(page, base["s"] + span * 10 * k, base["e"] + span * 10 * k)
    regions = page.evaluate("() => window.__gsVpState().regions")
    keys = page.evaluate("() => window.__gsVpState().windowKeys")
    assert len(regions) <= 3, f"loaded windows not evicted (bounded): {regions}"
    assert len(keys) == len(regions), "evicted window data not released"
    page.close()
