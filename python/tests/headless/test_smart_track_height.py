"""Expanded sample (Smart) tracks fit the packed read stack, capped at 220px.

Assemblies typically have one or two haplotype rows; they should not sit in a
220px empty well. A deep pileup still uses the 220px cap and scrolls.
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

CFG = {
    "region": "chr1:100000-100900",
    "chrom_lengths": {"chr1": 248000000},
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


def _open(browser):
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.orientation','horizontal');"
        "localStorage.setItem('genomeshader.theme','light');}catch(e){}"
    )
    f = os.path.join(tempfile.mkdtemp(), "h.html")
    open(f, "w").write(harness.build_page(config=CFG))
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    return page


def test_one_read_track_shrinks_below_open_cap(browser):
    page = _open(browser)
    info = page.evaluate(
        """async () => {
          const S = window.__GS_STATE;
          const reads = {query_name:['asm'], element_type:[0],
            reference_start:[S.startBp+10], reference_end:[S.endBp-10],
            is_forward:[true], haplotype:[1], sample_name:['ASM'], sequence:['']};
          const r = await window.__GS_TEST_seedSmartTrack('ASM', reads, {collapsed:false});
          const ctl = document.querySelector('.track-control-container[data-track-id="'+r.trackId+'"]');
          const layoutH = window.__GS_smartTrackLayoutHeight(
            S.tracks.find(t => t.id === r.trackId));
          return {
            rowCount: r.rowCount,
            layoutH: layoutH,
            boxH: ctl ? ctl.getBoundingClientRect().height : 0,
            cap: S.tracks.find(t => t.id === r.trackId).height,
          };
        }""")
    assert info["rowCount"] == 1, info
    assert info["cap"] == 220, info
    assert 40 <= info["layoutH"] < 120, info
    assert abs(info["boxH"] - info["layoutH"]) < 2, info
    page.close()


def test_deep_pileup_keeps_open_cap(browser):
    page = _open(browser)
    info = page.evaluate(
        """async () => {
          const S = window.__GS_STATE;
          const n = 40;
          const reads = {
            query_name: Array.from({length:n}, (_,i) => 'r'+i),
            element_type: Array(n).fill(0),
            reference_start: Array(n).fill(S.startBp+10),
            reference_end: Array(n).fill(S.endBp-10),
            is_forward: Array(n).fill(true),
            haplotype: Array(n).fill(0),
            sample_name: Array(n).fill('S1'),
            sequence: Array(n).fill(''),
          };
          const r = await window.__GS_TEST_seedSmartTrack('S1', reads, {collapsed:false});
          const ctl = document.querySelector('.track-control-container[data-track-id="'+r.trackId+'"]');
          const layoutH = window.__GS_smartTrackLayoutHeight(
            S.tracks.find(t => t.id === r.trackId));
          return {
            rowCount: r.rowCount,
            layoutH: layoutH,
            boxH: ctl ? Math.round(ctl.getBoundingClientRect().height) : 0,
            stack: (function () {
              const t = S.tracks.find(x => x.id === r.trackId);
              return t.readsLayout.rowCount * 18;
            })(),
          };
        }""")
    assert info["rowCount"] == 40, info
    assert info["layoutH"] == 220, info
    assert info["boxH"] == 220, info
    assert info["stack"] > 220, info
    page.close()


def test_first_expand_sizes_canvas_to_layout_without_pan(browser):
    # Load starts collapsed (summary strip). Expanding must size the reads
    # canvas to the open slot immediately — not leave it at ~30px until pan.
    page = _open(browser)
    seeded = page.evaluate(
        """async () => {
          const S = window.__GS_STATE;
          const n = 12;
          const reads = {
            query_name: Array.from({length:n}, (_,i) => 'r'+i),
            element_type: Array(n).fill(0),
            reference_start: Array(n).fill(S.startBp+10),
            reference_end: Array(n).fill(S.endBp-10),
            is_forward: Array(n).fill(true),
            haplotype: Array(n).fill(0),
            sample_name: Array(n).fill('SYN001'),
            sequence: Array(n).fill(''),
          };
          const r = await window.__GS_TEST_seedSmartTrack('SYN001', reads, {collapsed:true});
          const rec = S.smartTrackRenderers.get(r.trackId);
          return {
            trackId: r.trackId,
            closedH: rec && rec.container
              ? Math.round(rec.container.getBoundingClientRect().height) : 0,
          };
        }""")
    assert seeded["closedH"] <= 40, seeded
    page.evaluate(
        """(id) => {
          const btn = document.querySelector(
            '.track-control-container[data-track-id="'+id+'"] .track-collapse-btn');
          if (btn) btn.click();
        }""",
        seeded["trackId"],
    )
    info = page.evaluate(
        """(id) => {
          const S = window.__GS_STATE;
          const t = S.tracks.find(x => x.id === id);
          const rec = S.smartTrackRenderers.get(id);
          const layoutH = window.__GS_smartTrackLayoutHeight(t);
          const boxEl = (rec && rec.container) || document.querySelector(
            '.track-control-container[data-track-id="'+id+'"]');
          const box = boxEl ? boxEl.getBoundingClientRect() : null;
          const canvasH = rec && rec.webgpuCanvas ? rec.webgpuCanvas.clientHeight : 0;
          return {
            layoutH: layoutH,
            boxH: box ? Math.round(box.height) : 0,
            canvasH: Math.round(canvasH),
            collapsed: t.collapsed,
          };
        }""",
        seeded["trackId"],
    )
    assert info["collapsed"] is False, info
    assert info["layoutH"] >= 100, info
    assert abs(info["boxH"] - info["layoutH"]) < 3, info
    if info["canvasH"]:
        assert info["canvasH"] >= info["layoutH"] - 3, info
    page.close()
