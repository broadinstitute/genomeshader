"""Smart Tracks sidebar + on-canvas quick-control icons stay in sync.

Reload / resample share ::before glyphs; remove is a trash SVG in both places.
On-canvas pin expands the pill to the full title width.
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
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.theme','light');"
        "localStorage.setItem('genomeshader.pinnedSmartTrackControls','[]');}catch(e){}"
    )
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
             const app = document.querySelector('.app');
             if (app) app.classList.remove('sidebar-right-collapsed');
             if (typeof setRightSidebarCollapsed === 'function') setRightSidebarCollapsed(false);
             if (typeof renderSmartTracksSidebar === 'function') renderSmartTracksSidebar();
             if (typeof renderAll === 'function') renderAll(); }""")
    page.wait_for_timeout(300)

    g = page.evaluate(
        """() => {
             const before = sel => { const el = document.querySelector(sel);
               return el ? getComputedStyle(el, '::before').content.replace(/^"|"$/g, '') : null; };
             const first = document.querySelector('.smart-track-item[data-track-id^="smart-track-"]');
             const header = first && first.querySelector('.smart-track-item-header');
             const nav = header && header.querySelector('.smart-track-item-nav');
             const grip = nav && nav.querySelector('.smart-track-item-grip');
             const sbRemove = first && first.querySelector('.smart-track-item-btn.remove');
             const ot = document.querySelector('.track-controls[data-track-id^="smart-track-"]');
             const otRemove = ot && ot.querySelector('.smart-track-item-btn.remove');
             const otGrip = ot && ot.querySelector('.smart-track-qc-grip');
             const otLabel = ot && ot.querySelector('.track-label');
             const retracted = ot ? parseFloat(getComputedStyle(ot).maxWidth) : null;
             return {
               sb_reload:  before('.smart-track-item[data-track-id^="smart-track-"] .smart-track-item-btn.refresh'),
               sb_shuffle: before('.smart-track-item[data-track-id^="smart-track-"] .smart-track-item-btn.shuffle'),
               ot_reload:  before('.track-controls .smart-track-item-btn.refresh'),
               ot_shuffle: before('.track-controls .smart-track-item-btn.shuffle'),
               sbRemoveSvg: !!(sbRemove && sbRemove.querySelector('svg')),
               otRemoveSvg: !!(otRemove && otRemove.querySelector('svg')),
               otPin: !!(ot && ot.querySelector('.smart-track-qc-pin')),
               otVis: !!(ot && ot.querySelector('.smart-track-qc-vis')),
               otGrip: !!(otGrip && otGrip.querySelector('svg')),
               otActions: !!(ot && ot.querySelector('.smart-track-qc-actions')),
               otSettings: !!(ot && ot.querySelector('.smart-track-qc-settings')),
               pinBeforeActions: !!(ot && ot.querySelector('.smart-track-qc-pin')
                 && ot.querySelector('.smart-track-qc-actions')
                 && ot.querySelector('.smart-track-qc-pin').nextElementSibling
                    === ot.querySelector('.smart-track-qc-actions')),
               titleText: otLabel ? (otLabel.textContent || '').trim() : '',
               retractedMax: retracted,
               labelMin: otLabel ? getComputedStyle(otLabel).minWidth : null,
               actionsMax: ot && ot.querySelector('.smart-track-qc-actions')
                 ? getComputedStyle(ot.querySelector('.smart-track-qc-actions')).maxWidth
                 : null,
               gripCount: document.querySelectorAll('.smart-track-item-grip').length,
               gripFirst: !!(grip && nav && header
                 && header.firstElementChild === nav
                 && nav.firstElementChild === grip),
               hasActions: !!(first && first.querySelector('.smart-track-item-actions')),
               hasStatus: !!(first && first.querySelector('.smart-track-item-status')),
             };
        }""")
    assert g["ot_reload"] and g["sb_reload"], f"icons missing: {g}"
    assert g["sb_reload"] == g["ot_reload"], f"reload icon differs: {g}"
    assert g["sb_shuffle"] == g["ot_shuffle"], f"shuffle icon differs: {g}"
    assert g["sbRemoveSvg"] and g["otRemoveSvg"], f"trash SVG missing: {g}"
    assert g["otPin"] and g["otGrip"] and g["otActions"], f"on-track chrome missing: {g}"
    assert g["otSettings"] is True, f"settings gear missing: {g}"
    assert g["pinBeforeActions"] is True, f"pin should sit left of actions: {g}"
    assert g["otVis"] is False, f"visibility dot should not be on canvas: {g}"
    assert g["titleText"], f"retracted title should be visible: {g}"
    assert g["actionsMax"] in ("0px", "0"), f"actions should collapse when retracted: {g}"
    assert g["retractedMax"] is not None and g["retractedMax"] <= 180, f"should retract: {g}"
    assert g["gripFirst"] is True, f"grip should be leftmost in nav: {g}"
    assert g["hasActions"] and g["hasStatus"], f"row zones missing: {g}"

    # Pin expands the title but keeps action buttons retracted until hover.
    page.evaluate(
        """() => {
          const pin = document.querySelector('.track-controls[data-track-id^="smart-track-"] .smart-track-qc-pin');
          if (!pin) throw new Error('pin missing');
          pin.click();
        }"""
    )
    page.wait_for_timeout(150)
    pinned = page.evaluate(
        """() => {
          const ot = document.querySelector('.track-controls[data-track-id^="smart-track-"]');
          const label = ot && ot.querySelector('.track-label');
          const actions = ot && ot.querySelector('.smart-track-qc-actions');
          return {
            pinnedClass: !!(ot && ot.classList.contains('is-pinned')),
            labelMax: label ? getComputedStyle(label).maxWidth : null,
            actionsMax: actions ? getComputedStyle(actions).maxWidth : null,
            actionsOpacity: actions ? parseFloat(getComputedStyle(actions).opacity) : null,
          };
        }"""
    )
    assert pinned["pinnedClass"] is True, pinned
    assert pinned["labelMax"] != "88px", pinned
    assert pinned["actionsMax"] in ("0px", "0"), pinned
    assert pinned["actionsOpacity"] == 0.0, pinned
    page.close()
