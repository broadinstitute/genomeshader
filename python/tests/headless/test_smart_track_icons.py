"""The Smart Tracks SIDEBAR icons must match the on-track expanded sample menu
icons (reload / shuffle / close). They drifted once — the sidebar shuffle was
U+21C4 while the on-track menu used U+21C6. Guards against re-drift.
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


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:
            pytest.skip(f"headless chromium unavailable: {e}")
        yield b
        b.close()


def test_sidebar_icons_match_on_track_menu(browser):
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    page.add_init_script("try{localStorage.setItem('genomeshader.theme','light');}catch(e){}")
    f = os.path.join(tempfile.mkdtemp(), "h.html")
    open(f, "w").write(harness.build_page())
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.evaluate(
        """async () => { const S = window.__GS_STATE;
             const reads = {query_name:['r0'], element_type:[0],
               reference_start:[S.startBp+10], reference_end:[S.endBp-10],
               is_forward:[true], haplotype:[1], sample_name:['NA12878'], sequence:['']};
             await window.__GS_TEST_seedSmartTrack('NA12878', reads, {collapsed:false});
             if (typeof renderSmartTracksSidebar === 'function') renderSmartTracksSidebar(); }""")
    page.wait_for_timeout(300)

    g = page.evaluate(
        """() => {
             const before = sel => { const el = document.querySelector(sel);
               return el ? getComputedStyle(el, '::before').content.replace(/^"|"$/g, '') : null; };
             const text = sel => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };
             return {
               sb_reload:  before('.smart-track-item-btn.refresh'),
               sb_shuffle: before('.smart-track-item-btn.shuffle'),
               sb_close:   before('.smart-track-item-btn.close'),
               ot_reload:  text('.smart-track-reload-btn'),
               ot_shuffle: text('.smart-track-shuffle-btn'),
               ot_close:   text('.smart-track-close-btn'),
             };
        }""")
    assert g["ot_reload"] and g["sb_reload"], f"icons missing: {g}"
    assert g["sb_reload"] == g["ot_reload"], f"reload icon differs: {g}"
    assert g["sb_shuffle"] == g["ot_shuffle"], f"shuffle icon differs: {g}"
    assert g["sb_close"] == g["ot_close"], f"close icon differs: {g}"
    page.close()
