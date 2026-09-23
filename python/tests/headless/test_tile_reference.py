"""Each tile keeps its OWN reference bases, whichever tile loaded last.

The reference string is stored per contig, but data_bounds (its genomic origin)
used to be one global overwritten by whichever tile's viewport load landed last.
The other tile then indexed its own sequence with the wrong origin and its
reference bases vanished when zoomed in. (Found while zooming two tiles to ~50 bp;
it predates the WebGPU/perf work.)
"""
from __future__ import annotations

import os
import random
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

_rnd = random.Random(3)
REF_A = "".join(_rnd.choice("ACGT") for _ in range(4001))
CFG = {
    "region": "chr14:32147950-32151950", "genome_build": "hg38",
    "reference_data": REF_A, "data_bounds": {"start": 32147950, "end": 32151950},
    "chrom_lengths": {"chr14": 107043718, "chr20": 64444167},
    "viewport_variant_loading": True,
    "variant_tracks": [{"id": "v0", "label": "VCF", "name": "vcf", "variants_data": []}],
}

# Serve a per-window reference (with its own data_bounds) like the real kernel.
MOCK = r"""
() => {
  const BASES = ['A','C','G','T'];
  window.__GS_SEND = function (type, data) {
    if (type === 'fetch_variants') {
      const {contig, start, end} = data;
      const s0 = Math.max(0, start - 500), e0 = end + 500;
      let ref = ''; for (let i = s0; i <= e0; i++) ref += BASES[(i * 7 + (contig === 'chr20' ? 1 : 0)) & 3];
      const resp = {type: 'fetch_variants_response',
        variant_tracks: [{id: 'v0', label: 'VCF', name: 'vcf', variants_data: []}],
        insertion_variants_lookup: [], reference_data: ref, data_bounds: {start: s0, end: e0}};
      // A busy kernel answers slowly (window.__GS_VP_DELAY ms).
      return window.__GS_VP_DELAY ? new Promise(r => setTimeout(() => r(resp), window.__GS_VP_DELAY)) : Promise.resolve(resp);
    }
    if (type === 'navigate') {
      // A locus JUMP: reference for exactly [start, end], plus genes for that window.
      const {contig, start, end} = data;
      let ref = ''; for (let i = start; i <= end; i++) ref += BASES[(i * 7 + (contig === 'chr20' ? 1 : 0)) & 3];
      return Promise.resolve({type: 'navigate_response', contig, start, end, reference_data: ref,
        genes_track: {id: 'genes', label: 'Genes', style: 'gene', series: [{name: 'genes', features: [
          {name: 'G-' + contig, strand: '+', start: start + 5, end: end - 5, lane: 0, exons: []}]}]},
        repeats_track: {id: 'repeats', label: 'RepeatMasker', style: 'interval', series: [{name: 'repeats', features: []}]},
        variant_tracks: [{id: 'v0', label: 'VCF', name: 'vcf', variants_data: []}], insertion_variants_lookup: []});
    }
    return Promise.resolve({type: type + '_response'});
  };
}
"""

LETTERS = r"""
() => Object.fromEntries(window.__GS_STATE.tiles.map(t => {
  const root = document.querySelector('.gs-tile[data-tile-id="' + t.id + '"]');
  const svg = root.querySelector('svg[id^="tracksSvg"]');
  const n = svg ? [...svg.querySelectorAll('text')].filter(x => /^[ACGT]$/.test(x.textContent)).length : 0;
  return [t.contig, n];
}))
"""


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:  # pragma: no cover
            pytest.skip(f"chrome unavailable: {e}")
        yield b
        b.close()


def _zoom(page, idx, center, span=50):
    page.evaluate(
        """([i, ctr, sp]) => { const S = window.__GS_STATE; window.__GS_tiles.focus(S.tiles[i].id);
             S.startBp = ctr - sp / 2; S.endBp = ctr + sp / 2; window.__GS_tiles.pull();
             window.gsScheduleViewportVariantLoad && window.gsScheduleViewportVariantLoad();
             window.__GS_TEST_renderAll(); }""",
        [idx, center, span],
    )
    page.wait_for_timeout(2500)


def test_both_tiles_show_reference_bases_when_zoomed_in(browser):
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.add_init_script("try{localStorage.setItem('genomeshader.orientation','horizontal');}catch(e){}")
    f = os.path.join(tempfile.mkdtemp(), "ref.html")
    open(f, "w").write(harness.build_page(config=CFG))
    page.goto("file://" + f)
    page.wait_for_function("() => window.__GS_READY === true", timeout=30000)
    page.wait_for_function("() => window.__GS_TEST_gpuStats().ready", timeout=20000)
    page.evaluate(MOCK)
    page.evaluate("() => window.__GS_tiles.add({contig: 'chr20', startBp: 32005000, endBp: 32009000})")
    page.wait_for_timeout(2000)

    # Tile B loads its window, THEN tile A loads its own: B's origin must not
    # overwrite A's (and vice versa).
    _zoom(page, 1, 32006757)
    _zoom(page, 0, 32149944)
    n = page.evaluate(LETTERS)
    assert n["chr14"] > 0, f"tile A lost its reference bases: {n}"
    assert n["chr20"] > 0, f"tile B lost its reference bases: {n}"

    # Focus (and reload) B again: A must keep its bases.
    _zoom(page, 1, 32006757)
    n = page.evaluate(LETTERS)
    assert n["chr14"] > 0 and n["chr20"] > 0, n
    page.close()


def test_a_locus_jump_in_one_tile_does_not_cost_either_tile_its_reference(browser):
    """A jump (navigate) delivers reference/genes for ITS tile. Until that was
    snapshotted per contig, the next paint restored the tile's older snapshot, so the
    jumped tile lost its reference bases and genes (and focusing the other tile made
    it worse)."""
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.add_init_script("try{localStorage.setItem('genomeshader.orientation','horizontal');}catch(e){}")
    f = os.path.join(tempfile.mkdtemp(), "ref2.html")
    open(f, "w").write(harness.build_page(config=CFG))
    page.goto("file://" + f)
    page.wait_for_function("() => window.__GS_READY === true", timeout=30000)
    page.wait_for_function("() => window.__GS_TEST_gpuStats().ready", timeout=20000)
    page.evaluate(MOCK)
    page.evaluate("() => window.__GS_tiles.add({contig: 'chr20', startBp: 32005000, endBp: 32009000})")
    page.wait_for_timeout(2000)
    _zoom(page, 1, 32006757)
    _zoom(page, 0, 32149944)

    # Jump tile B somewhere else on chr20 via the locus-jump path.
    page.evaluate("() => window.__GS_tiles.focus(window.__GS_STATE.tiles[1].id)")
    page.evaluate("() => window.__GS_TEST_requestNavigate('chr20', 32005405, 32005455)")
    page.wait_for_timeout(2500)
    n = page.evaluate(LETTERS)
    assert n["chr20"] > 0, f"jumped tile lost its reference bases: {n}"

    # Focus A and back: neither may lose its bases.
    page.evaluate("() => window.__GS_tiles.focus(window.__GS_STATE.tiles[0].id)")
    page.wait_for_timeout(1500)
    n = page.evaluate(LETTERS)
    assert n["chr14"] > 0 and n["chr20"] > 0, n
    page.evaluate("() => window.__GS_tiles.focus(window.__GS_STATE.tiles[1].id)")
    page.wait_for_timeout(1500)
    n = page.evaluate(LETTERS)
    assert n["chr14"] > 0 and n["chr20"] > 0, n
    page.close()


def _open_two(browser, name):
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.add_init_script("try{localStorage.setItem('genomeshader.orientation','horizontal');}catch(e){}")
    f = os.path.join(tempfile.mkdtemp(), name)
    open(f, "w").write(harness.build_page(config=CFG))
    page.goto("file://" + f)
    page.wait_for_function("() => window.__GS_READY === true", timeout=30000)
    page.wait_for_function("() => window.__GS_TEST_gpuStats().ready", timeout=20000)
    page.evaluate(MOCK)
    return page


def _letters_for(page, idx):
    return page.evaluate(
        """(i) => { const t = window.__GS_STATE.tiles[i];
             const root = document.querySelector('.gs-tile[data-tile-id="' + t.id + '"]');
             const svg = root.querySelector('svg[id^="tracksSvg"]');
             return svg ? [...svg.querySelectorAll('text')].filter(x => /^[ACGT]$/.test(x.textContent)).length : 0; }""",
        idx,
    )


def test_revisiting_a_loaded_region_at_base_zoom_keeps_its_bases(browser):
    """A tile's region is loaded at ~4 kb (variants covered), zoomed to 50 bp in one
    spot (its reference string replaced by that narrow window), then moved to another
    spot INSIDE the already-loaded 4 kb: variants count as covered, so no reference
    was refetched and the bases vanished."""
    page = _open_two(browser, "ref3.html")
    page.evaluate("() => window.__GS_tiles.add({contig: 'chr20', startBp: 32005000, endBp: 32009000})")
    page.wait_for_timeout(2500)          # tile B's 4 kb window (variants + reference) loads
    _zoom(page, 1, 32006757)
    assert _letters_for(page, 1) > 0, "no bases at the first spot"
    _zoom(page, 1, 32005430)             # elsewhere inside the region loaded at 4 kb
    assert _letters_for(page, 1) > 0, "bases vanished after moving within a loaded region"
    _zoom(page, 1, 32006757)             # and back
    assert _letters_for(page, 1) > 0, "bases vanished when returning to the first spot"
    page.close()


def test_two_tiles_on_the_same_contig_both_keep_reference_bases(browser):
    """One reference string per contig could only ever serve one window; two tiles
    on the same chromosome (a breakpoint pair) need two. B is far from the startup
    region so it cannot ride on A's sequence."""
    page = _open_two(browser, "ref4.html")
    page.evaluate("() => window.__GS_tiles.add({contig: 'chr14', startBp: 32170000, endBp: 32170050})")
    page.wait_for_timeout(1500)
    _zoom(page, 1, 32170025)
    _zoom(page, 0, 32149944)
    assert _letters_for(page, 0) > 0, "tile A lost its bases"
    assert _letters_for(page, 1) > 0, "tile B lost its bases"
    _zoom(page, 1, 32170025)             # focus/reload B again: A must keep its own
    assert _letters_for(page, 0) > 0 and _letters_for(page, 1) > 0
    page.close()


def test_small_moves_at_base_zoom_do_not_blank_the_reference_while_the_kernel_is_busy(browser):
    """The viewport loader used to request view +/- 50% (~100 bp at 50 bp zoom), so moving
    a kilobase left the reference uncovered until a kernel round trip finished — seconds
    when the kernel is busy loading reads. It now loads a few kb, so the move is covered
    and the bases stay put even if every reply is slow."""
    page = _open_two(browser, "ref5.html")
    # The tile starts already zoomed to base level, so its only load is a narrow one.
    page.evaluate("() => window.__GS_tiles.add({contig: 'chr20', startBp: 32006732, endBp: 32006782})")
    page.wait_for_timeout(500)
    _zoom(page, 1, 32006757)
    assert _letters_for(page, 1) > 0
    page.evaluate("() => { window.__GS_VP_DELAY = 6000; }")       # kernel now busy
    page.evaluate(
        """() => { const S = window.__GS_STATE; window.__GS_tiles.focus(S.tiles[1].id);
             S.startBp = 32005405; S.endBp = 32005455; window.__GS_tiles.pull();
             window.gsScheduleViewportVariantLoad && window.gsScheduleViewportVariantLoad();
             window.__GS_TEST_renderAll(); }"""
    )
    page.wait_for_timeout(700)            # far less than the 6 s reply
    assert _letters_for(page, 1) > 0, "bases blanked after a ~1.3 kb move while the kernel was busy"
    page.close()
