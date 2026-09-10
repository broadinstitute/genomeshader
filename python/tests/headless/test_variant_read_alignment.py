"""Genomic-mode alignment: a variant node's center x must equal xGenome(pos) —
the exact x a read's SNP marker at that position maps to. If these drift, the
sample-track SNP markers stop lining up under the variants they support (the
whole point of "load samples that carry this variant"). Guards the shared
coordinate map (flow-local vs global xGenomeCanonical) from desyncing.

(Equidistant layout intentionally displaces variants off their genomic x, so it
is NOT expected to align with genomic reads — this test pins the GENOMIC path.)
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


def test_variant_nodes_align_with_genomic_read_x(browser):
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.theme','light');"
        "localStorage.setItem('genomeshader.variantLayoutMode','genomic');}catch(e){}")
    f = os.path.join(tempfile.mkdtemp(), "h.html")
    open(f, "w").write(harness.build_page())
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_function("() => (window._alleleNodePositions||[]).length>0", timeout=20000)
    # ZOOM IN so a base cell is several px wide — a half-base error (the bug) is
    # then a clear multi-px miss, not sub-pixel. At the default ~900bp window one
    # base is ~1.3px, so half a base (~0.6px) would slip under any sane tolerance
    # and the test couldn't tell the fix from the bug.
    page.evaluate("() => { if (window.__GS_TEST_setSpan) window.__GS_TEST_setSpan(250); }")
    page.wait_for_timeout(250)

    m = page.evaluate(
        """() => {
             const vars = window.__GS_variants || [];
             const byId = {}; vars.forEach(v => byId[String(v.id)] = v);
             const xg = window.__GS_xGenome;
             const cellPx = xg(100201) - xg(100200);   // one base cell, in px, at this zoom
             const seen = new Set(); let n = 0, worstCenter = 0, worstEdge = 1e9;
             for (const node of (window._alleleNodePositions || [])) {
               const k = String(node.variantId); if (seen.has(k)) continue; seen.add(k);
               const v = byId[k]; if (!v) continue;
               const P = Number(v.pos);
               const nodeCenter = node.x + (node.w || 0) / 2;
               // A read's SNP at P renders as a tile [xg(P), xg(P+1)]; its center
               // (and the reference base letter) is here. The variant marker must
               // land on the SAME point.
               const cellCenter = (xg(P) + xg(P + 1)) / 2;
               n++;
               worstCenter = Math.max(worstCenter, Math.abs(nodeCenter - cellCenter));
               worstEdge = Math.min(worstEdge, Math.abs(nodeCenter - xg(P)));  // dist to LEFT edge
             }
             return { n, cellPx, worstCenter, worstEdge };
        }""")
    assert m["n"] >= 1, "no variant nodes in view after zoom"
    assert m["cellPx"] > 3, f"zoom not tight enough to distinguish half a base ({m['cellPx']:.1f}px/base)"
    # (1) variant node center lands on the base-cell center == a read SNP tile's center
    assert m["worstCenter"] < 1.0, (
        f"variant node off its base-cell center by {m['worstCenter']:.1f}px — sample SNP "
        f"markers won't line up with the variants")
    # (2) and it is NOT sitting on the cell's LEFT edge (the old bug) — proves the
    # half-base centering is actually applied, so reverting it fails this test.
    assert m["worstEdge"] > m["cellPx"] * 0.3, (
        f"variant node is at the base-cell LEFT edge ({m['worstEdge']:.1f}px from it, "
        f"cell={m['cellPx']:.1f}px) — the half-base centering regressed")
