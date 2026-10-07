"""A selected allele keeps the identity it had where it was picked.

Moving tile FOCUS used to change the sample-pane chip from
`chr14:32,149,950 · N[chr20:...` to `chr20:32,149,950 · Allele 2`: the contig came from
state.contig (the focused tile) and the label from the focused tile's rendered nodes. It
also made a later Load look up carriers at the wrong locus.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:  # pragma: no cover
            pytest.skip(f"headless chromium unavailable: {e}")
        yield b
        b.close()


def _open(browser, tmp_path):
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.orientation','horizontal');"
        "localStorage.setItem('genomeshader.theme','light');}catch(e){}"
    )
    page.goto(harness.write_page(tmp_path, harness.build_page()), wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_function("() => (window._alleleNodePositions || []).length > 0", timeout=20000)
    return page


def _add_other_tile(page):
    """Open a tile on a second (legitimate) contig; focus and state.contig move there."""
    page.evaluate(
        """() => {
          const cfg = window.GENOMESHADER_CONFIG;
          const lens = Object.assign({}, cfg.chrom_lengths || {});
          lens[window.__GS_STATE.contig] = lens[window.__GS_STATE.contig] || 10000000;
          lens['chrOther'] = 10000000;
          cfg.chrom_lengths = lens;
          window.__GS_tiles.add({contig: 'chrOther', startBp: 1, endBp: 5000});
        }"""
    )
    page.wait_for_timeout(300)


def _select_first_allele(page):
    return page.evaluate(
        """() => {
          const n = window._alleleNodePositions[0];
          const key = window.makeAlleleSelectionKey(n.trackId, n.variantId, n.alleleIndex);
          window.__GS_STATE.selectedAlleles = new Set([key]);
          window.updateSelectionDisplay();
          return { key, contig: window.__GS_STATE.contig };
        }"""
    )


def _chip(page):
    return page.evaluate(
        "() => [...document.querySelectorAll('.sampleAllelePillLabel')].map(e => e.textContent)"
    )


def test_chip_and_locus_do_not_change_when_focus_moves_to_another_contig(browser, tmp_path):
    page = _open(browser, tmp_path)
    try:
        picked = _select_first_allele(page)
        before = _chip(page)
        pos_before = page.evaluate("() => window.__GS_currentSelectedVariantPosition()")
        assert before and picked["contig"] in before[0], (before, picked)
        assert pos_before["contig"] == picked["contig"]

        # Open a tile on a different contig: focus (and state.contig) move there and the
        # picked allele is no longer drawn.
        _add_other_tile(page)
        assert page.evaluate("() => window.__GS_STATE.contig") == "chrOther"
        page.evaluate("() => window.updateSelectionDisplay()")
        assert _chip(page) == before, (before, _chip(page))
        assert page.evaluate("() => window.__GS_currentSelectedVariantPosition()") == pos_before
        # Comment anchors follow the allele too, not the focused tile.
        anchor = page.evaluate("() => window.__GS_getCommentAnchor()")
        assert anchor["locus"]["contig"] == picked["contig"], anchor

        # Back to the tile where it was picked: still identical.
        page.evaluate("() => window.__GS_tiles.focus(window.__GS_STATE.tiles[0].id)")
        page.wait_for_timeout(200)
        page.evaluate("() => window.updateSelectionDisplay()")
        assert _chip(page) == before
    finally:
        page.close()


def test_carrier_lookup_uses_the_alleles_contig_not_the_focused_tiles(browser, tmp_path):
    page = _open(browser, tmp_path)
    try:
        picked = _select_first_allele(page)
        _add_other_tile(page)
        pair = page.evaluate(
            """() => {
              const k = [...window.__GS_STATE.selectedAlleles][0];
              const p = window.parseAlleleSelectionKey(k);
              return window.__GS_TEST_resolveSelected(p).contig;
            }"""
        )
        assert pair == picked["contig"], (pair, picked)
    finally:
        page.close()


def test_deselected_alleles_release_their_snapshot(browser, tmp_path):
    page = _open(browser, tmp_path)
    try:
        _select_first_allele(page)
        assert page.evaluate("() => window.__GS_STATE.selectedAlleleMeta.size") == 1
        page.evaluate("() => { window.__GS_STATE.selectedAlleles = new Set(); window.updateSelectionDisplay(); }")
        assert page.evaluate("() => window.__GS_STATE.selectedAlleleMeta.size") == 0
    finally:
        page.close()
