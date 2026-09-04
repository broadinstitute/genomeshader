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


def test_load_reports_progress_status(browser):
    # #79: a cold window fetch is multi-second at scale, so the loader must
    # surface a descriptive busy status and then clear/settle it.
    page = _open(browser)
    page.evaluate(
        """() => { window.__GS_STATUS_LOG = [];
            const real = window.__GS_STATUS;
            window.__GS_STATUS = function (msg, opts) {
              window.__GS_STATUS_LOG.push({ msg: msg, opts: opts || {} });
              return real ? real(msg, opts) : undefined;
            }; }""")
    view = page.evaluate("() => ({s: window.__GS_STATE.startBp, e: window.__GS_STATE.endBp})")
    page.evaluate("async () => await window.gsLoadVariantsForViewport(true)")
    log = page.evaluate("() => window.__GS_STATUS_LOG")
    # a descriptive, indeterminate 'Loading variants for <contig>:<win>' up front
    busy = [e for e in log if isinstance(e["msg"], str)
            and e["msg"].startswith("Loading variants for") and e["opts"].get("busy")]
    assert busy, f"no descriptive busy status emitted: {log}"
    # and a settle: either a 'Loaded N variants' summary or an explicit hide
    settled = [e for e in log if (isinstance(e["msg"], str)
               and e["msg"].startswith("Loaded")) or e["msg"] in (False, None)]
    assert settled, f"busy status never settled: {log}"
    page.close()


def test_hung_fetch_does_not_block_other_windows(browser):
    """Regression: a single fetch that never resolves (comm hangs) must NOT
    stall loading for OTHER windows. An earlier serialization ('one fetch at a
    time') let one stuck request brick all subsequent loads — the symptom was
    'now it's just not loading the data'. The loader dedups only the identical
    in-flight window, so panning to a different window still fetches."""
    page = _open(browser)
    # First fetch_variants hangs forever; later ones resolve normally.
    page.evaluate(r"""() => {
        window.__GS_COMM_LOG = [];
        let n = 0;
        window.__GS_SEND = function (type, data) {
            window.__GS_COMM_LOG.push({ type, data });
            if (type === "fetch_variants") {
                n += 1;
                if (n === 1) return new Promise(() => {});  // hang: never settles
                const { contig, start, end } = data;
                const mk = (p) => ({ id: contig + ":" + p, position: p, pos: p,
                    ref: "A", alt: "C", n_ref: 10, n_alt: 5, n_missing: 0, n_samples: 15 });
                const mid = Math.floor((start + end) / 2);
                return Promise.resolve({ type: "fetch_variants_response",
                    variant_tracks: [{ name: "vp", variants_data: [mk(start + 1), mk(mid), mk(end - 1)] }],
                    insertion_variants_lookup: [] });
            }
            return Promise.resolve({});
        };
    }""")
    base = page.evaluate("() => ({s: window.__GS_STATE.startBp, e: window.__GS_STATE.endBp})")
    span = base["e"] - base["s"]
    # Kick window A WITHOUT awaiting — its fetch hangs, leaving A in-flight.
    page.evaluate("() => { window.gsLoadVariantsForViewport(true); }")
    # Pan far to window B and await: must still fetch despite A stuck in-flight.
    _set_view(page, base["s"] + span * 5, base["e"] + span * 5)
    calls = _fetch_calls(page)
    assert len(calls) == 2, f"hung window A blocked window B: {calls}"
    n = page.evaluate(
        "() => ((window.GENOMESHADER_CONFIG.variant_tracks||[])[0]||{}).variants_data?.length || 0")
    assert n == 3, "window B variants never rendered while A was stuck"
    page.close()


def test_load_failure_shows_blocking_modal(browser):
    """A serious load failure (comm rejects — kernel drop / 30s timeout) must pop
    a centered blocking modal the user acknowledges, not a status flash. Guarded
    single-instance so repeated failures don't stack dialogs."""
    page = _open(browser)
    page.evaluate(r"""() => {
        window.__GS_SEND = function (type) {
            if (type === "fetch_variants") return Promise.reject(new Error("Request timeout"));
            return Promise.resolve({});
        };
    }""")
    page.evaluate("async () => { try { await window.gsLoadVariantsForViewport(true); } catch (e) {} }")
    page.wait_for_function(
        "() => !!document.querySelector('.gs-modal-backdrop')", timeout=5000)
    title = page.evaluate(
        "() => (document.querySelector('.gs-modal-title')||{}).textContent")
    assert title == "Variant load failed", title
    # A second failure while the modal is open must NOT stack another dialog.
    page.evaluate("async () => { try { await window.gsLoadVariantsForViewport(true); } catch (e) {} }")
    n = page.evaluate("() => document.querySelectorAll('.gs-modal-backdrop').length")
    assert n == 1, f"failure modal stacked ({n})"
    page.evaluate("() => document.querySelector('.gs-modal-ok').click()")
    assert page.evaluate("() => !document.querySelector('.gs-modal-backdrop')")
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


def test_zoom_gate_skips_wide_windows(browser):
    """Above the max-span zoom gate, individual variants aren't fetched
    (IGV-style: zoom in to load variants)."""
    page = _open(browser)
    page.evaluate("async () => await window.gsLoadVariantsForViewport(true)")
    n0 = len(_fetch_calls(page))
    # zoom out well past the 200kb default gate
    page.evaluate("""async () => {
        window.__GS_STATE.startBp = 1; window.__GS_STATE.endBp = 300000;
        await window.gsLoadVariantsForViewport(true);
    }""")
    assert len(_fetch_calls(page)) == n0, "a window wider than the gate must not fetch"
    page.close()


def test_seed_registers_startup_window(browser):
    """The startup region's variants (shipped in config) are registered with the
    pager, so panning back doesn't refetch and dynamic paging works from frame 1."""
    import tempfile
    page = browser.new_page(viewport=VIEWPORT)
    cfg = {
        "viewport_variant_loading": True,
        "region": "chr1:100-200",
        "variant_tracks": [{"id": "vp", "label": "VP", "name": "vp", "variants_data": [
            {"id": "chr1:150", "position": 150, "pos": 150, "ref": "A", "alt": "C",
             "n_ref": 9, "n_alt": 1, "n_missing": 0, "n_samples": 10}]}],
    }
    html = harness.build_page(config=cfg)
    f = os.path.join(tempfile.mkdtemp(), "seed.html")
    open(f, "w").write(html)
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    regions = page.evaluate("() => window.__gsVpState().regions")
    assert any(r["contig"] == "chr1" and r["start"] == 100 and r["end"] == 200
               for r in regions), f"startup window not seeded: {regions}"
    page.close()


def test_load_syncs_reference_and_data_bounds(browser):
    """The variant payload now carries reference/genes/data_bounds for the window,
    so paging updates the reference track and the data_bounds (grey overlay)
    instead of leaving them on the startup region."""
    page = _open(browser)
    page.evaluate("""() => { window.__GS_SEND = (type, data) => {
        window.__GS_COMM_LOG = window.__GS_COMM_LOG || [];
        window.__GS_COMM_LOG.push({ type, data });
        if (type === "fetch_variants") return Promise.resolve({
            type: "fetch_variants_response",
            variant_tracks: [{ name: "vp", variants_data: [] }],
            insertion_variants_lookup: [],
            reference_data: "ACGTACGT",
            transcripts_data: [], repeats_data: [], ideogram_data: [],
            data_bounds: { start: data.start, end: data.end },
        });
        return Promise.resolve({}); }; }""")
    page.evaluate("async () => await window.gsLoadVariantsForViewport(true)")
    page.wait_for_timeout(150)
    cfg = page.evaluate("""() => ({ ref: window.GENOMESHADER_CONFIG.reference_data,
        db: window.GENOMESHADER_CONFIG.data_bounds })""")
    assert cfg["ref"] == "ACGTACGT", cfg
    assert cfg["db"] and cfg["db"]["end"] > cfg["db"]["start"], cfg
    page.close()
