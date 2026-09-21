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
      return Promise.resolve({type: 'fetch_variants_response',
        variant_tracks: [{id: 'v0', label: 'VCF', name: 'vcf', variants_data: []}],
        insertion_variants_lookup: [], reference_data: ref, data_bounds: {start: s0, end: e0}});
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
