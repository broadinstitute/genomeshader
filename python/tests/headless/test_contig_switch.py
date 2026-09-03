"""Contig switcher (sidebar "Region" dropdown) — behavior tests.

Drives the real viewer (headless Chromium, no GPU) with a genome that has
several contigs and checks:
- the dropdown is populated from the genome's chrom_lengths,
- picking a contig moves state + sends a `navigate` request for it,
- applying the host's navigate response updates reference/variants/config.

The host round-trip is mocked via `window.__GS_SEND` (the viewer reads it at
call time through sendCommMessage), so no ipywidgets kernel is needed.
"""
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
pytest.importorskip("anywidget")

from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

VIEWPORT = {"width": 1200, "height": 900}
CONFIG = {
    "chrom_lengths": {"chr1": 1_000_000, "chr2": 500_000, "chr3": 300_000},
    "region": "chr1:100-200",
    "viewport_variant_loading": True,
}

# Mock host: log every request; answer `navigate` with a canned region payload.
INSTALL_MOCK = r"""
() => {
  window.__GS_COMM_LOG = [];
  window.__GS_SEND = function (type, data) {
    window.__GS_COMM_LOG.push({ type, data });
    if (type === "navigate") {
      return Promise.resolve({
        type: "navigate_response",
        contig: data.contig, start: data.start, end: data.end,
        reference_data: "ACGTACGTAC",
        ideogram_data: [], transcripts_data: [], repeats_data: [],
        variant_tracks: [{ name: "vp", variants_data: [
          { id: data.contig + ":150", position: 150, pos: 150, ref: "A", alt: "C",
            n_ref: 9, n_alt: 1, n_missing: 0, n_samples: 10 }] }],
        insertion_variants_lookup: [],
      });
    }
    return Promise.resolve({});
  };
}"""


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
        "try{localStorage.setItem('genomeshader.theme','light');}catch(e){}")
    html = harness.build_page(config=CONFIG)
    f = os.path.join(tempfile.mkdtemp(), "cs.html")
    open(f, "w").write(html)
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.evaluate(INSTALL_MOCK)
    return page


def test_dropdown_lists_genome_contigs(browser):
    page = _open(browser)
    opts = page.evaluate(
        "() => Array.from(document.getElementById('contigSelect').options).map(o => o.value)")
    assert opts == ["chr1", "chr2", "chr3"], opts
    page.close()


def test_switch_sends_navigate_and_moves_state(browser):
    page = _open(browser)
    page.evaluate("() => window.gsSwitchContig('chr2')")
    page.wait_for_timeout(200)  # let the mocked navigate resolve + apply
    st = page.evaluate("() => ({c: window.__GS_STATE.contig, s: window.__GS_STATE.startBp})")
    assert st["c"] == "chr2", st
    nav = page.evaluate(
        "() => (window.__GS_COMM_LOG || []).filter(e => e.type === 'navigate')")
    assert len(nav) == 1 and nav[0]["data"]["contig"] == "chr2", nav
    page.close()


def test_apply_navigate_updates_reference_and_variants(browser):
    page = _open(browser)
    page.evaluate("() => window.gsSwitchContig('chr3')")
    page.wait_for_timeout(200)
    cfg = page.evaluate(
        """() => ({ ref: window.GENOMESHADER_CONFIG.reference_data,
                    nv: ((window.GENOMESHADER_CONFIG.variant_tracks||[])[0]||{}).variants_data?.length || 0,
                    db: window.GENOMESHADER_CONFIG.data_bounds })""")
    assert cfg["ref"] == "ACGTACGTAC", cfg
    assert cfg["nv"] == 1, cfg
    assert cfg["db"] and cfg["db"]["start"] == page.evaluate("() => Math.floor(window.__GS_STATE.startBp)")
    page.close()
