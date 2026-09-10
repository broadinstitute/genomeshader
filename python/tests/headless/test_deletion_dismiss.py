"""Deletion visualization: click the displayed deleted bases to dismiss (#98).

Expanding a deletion (via its indel marker) shows the deleted reference bases on
the reference track. Clicking those bases must un-expand the deletion (remove it
from state.expandedDeletions) and stop drawing them. SVG renders under software
GL, so this runs on the plain headless harness.
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


def test_click_deleted_bases_dismisses_the_deletion(browser):
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    page.add_init_script("try{localStorage.setItem('genomeshader.theme','light');}catch(e){}")
    f = os.path.join(tempfile.mkdtemp(), "h.html")
    open(f, "w").write(harness.build_page())
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)

    # Inject a deletion variant, expand it, render.
    page.evaluate(
        """() => { const S = window.__GS_STATE; const pos = Math.round((S.startBp + S.endBp) / 2);
             const v = { id: 'del1', pos, refAllele: 'ACGTA', altAlleles: ['A'],
                         isDeletion: true, maxDeletionLength: 4,
                         altSampleCounts: [1], alleleFrequencies: [0.5] };
             const cfg = window.GENOMESHADER_CONFIG || {};
             cfg.variant_tracks = [{ track_id: 0, variants_data: [v] }];
             window.GENOMESHADER_CONFIG = cfg;
             S.expandedDeletions = new Set(['del1']);
             window.dispatchEvent(new Event('resize')); }""")
    page.wait_for_timeout(300)

    assert page.evaluate("() => document.querySelectorAll('.gs-del-dismiss').length") == 1, \
        "deleted bases not drawn for an expanded deletion"

    page.evaluate("() => document.querySelector('.gs-del-dismiss').dispatchEvent(new MouseEvent('click', {bubbles:true}))")
    page.wait_for_timeout(200)

    assert page.evaluate("() => [...(window.__GS_STATE.expandedDeletions||[])]") == [], \
        "clicking the deleted bases did not un-expand the deletion"
    assert page.evaluate("() => document.querySelectorAll('.gs-del-dismiss').length") == 0, \
        "deleted bases still drawn after dismiss"
    page.close()
