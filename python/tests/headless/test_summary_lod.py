"""The collapsed-track summary strip folds CIGAR events into pixel columns.

Thousands of sub-pixel events used to be emitted as thousands of rects per frame;
now each (haplotype, kind) contributes at most one tick per pixel column. These
tests pin what is drawn: a lone event lands where it should with the right colour,
and a dense pile-up collapses to one tick instead of a smear or nothing.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

# Element types (see ElementType in src/alignment.rs).
READ, DIFF, INS, DEL = 0, 1, 2, 3


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:  # pragma: no cover
            pytest.skip(f"chrome unavailable: {e}")
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
    page.wait_for_function("() => window.__GS_TEST_gpuStats().ready", timeout=20000)
    return page


# Build raw columnar reads inside the page from a list of events relative to the
# view start: [{kind, off, len?, base?, hap?}], one long read each.
SEED_JS = r"""
async (events) => {
  const S = window.__GS_STATE;
  const s0 = Math.floor(S.startBp), s1 = Math.floor(S.endBp);
  const q=[],et=[],rs=[],re=[],fw=[],hp=[],sn=[],seq=[];
  events.forEach((ev, i) => {
    const name = 'r' + i, hap = ev.hap || 0;
    q.push(name); et.push(0); rs.push(s0 + 2); re.push(s1 - 2); fw.push(true); hp.push(hap); sn.push('S'); seq.push('');
    const p = s0 + ev.off;
    q.push(name); et.push(ev.kind); rs.push(p); re.push(ev.kind === 3 ? p + (ev.len || 2) : p);
    fw.push(true); hp.push(hap); sn.push('S'); seq.push(ev.base || '');
  });
  const raw = {query_name:q, element_type:et, reference_start:rs, reference_end:re, is_forward:fw,
               haplotype:hp, sample_name:sn, sequence:seq};
  return await window.__GS_TEST_seedSmartTrack('S', raw, {collapsed: true});
}
"""

# Coloured pixels on the track's GPU canvas (the strip is drawn there).
PIXELS_JS = r"""
(cls) => {
  const r = [...window.__GS_STATE.tiles[0]._smartRenderers.values()][0]
         || [...window.__GS_STATE.smartTrackRenderers.values()][0];
  const cv = r.webgpuCanvas, sh = cv._gsShadow;
  const d = sh.getContext('2d', {willReadFrequently: true}).getImageData(0, 0, sh.width, sh.height).data;
  const cols = [];
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i+1], B = d[i+2], A = d[i+3];
    const opaque = A >= 200;
    const green = opaque && G > 150 && R < 90 && B < 90;
    const blue = opaque && B > 200 && R < 90 && G < 90;
    const red = opaque && R > 200 && G < 90 && B < 90;
    const orange = opaque && R > 200 && G > 120 && G < 200 && B < 60;
    // translucent ticks (alpha ~0.25): judge hue, not opacity
    const purple = A >= 25 && A < 200 && R > 150 && B > 200 && G < 150;
    const dark = A >= 25 && R < 60 && G < 60 && B < 60;
    const anybase = green || blue || red || orange;
    if ({green, blue, red, orange, purple, dark, anybase}[cls]) cols.push((i / 4) % sh.width);
  }
  return cols;
}
"""


def _expected_x(page, off):
    return page.evaluate("(off) => window.__GS_xGenome(Math.floor(window.__GS_STATE.startBp) + off)", off)


def test_lone_events_land_where_they_should_with_the_right_colour(browser, tmp_path):
    page = _open(browser, tmp_path)
    span = page.evaluate("() => Math.floor(window.__GS_STATE.endBp - window.__GS_STATE.startBp)")
    a_off, c_off, ins_off, del_off = int(span * .2), int(span * .4), int(span * .6), int(span * .8)
    page.evaluate(SEED_JS, [
        {"kind": DIFF, "off": a_off, "base": "A"},
        {"kind": DIFF, "off": c_off, "base": "C"},
        {"kind": INS, "off": ins_off, "base": "GGG"},
        {"kind": DEL, "off": del_off, "len": 3},
    ])
    page.wait_for_timeout(400)
    for cls, off in (("green", a_off), ("blue", c_off), ("purple", ins_off), ("dark", del_off)):
        cols = page.evaluate(PIXELS_JS, cls)
        assert cols, f"no {cls} pixels: the {cls} event was not drawn in the summary strip"
        x = _expected_x(page, off)
        assert min(abs(c - x) for c in cols) <= 6, (cls, x, sorted(set(cols))[:10])
    page.close()


def test_dense_subpixel_events_fold_into_one_tick(browser, tmp_path):
    page = _open(browser, tmp_path)
    span = page.evaluate("() => Math.floor(window.__GS_STATE.endBp - window.__GS_STATE.startBp)")
    off = int(span * 0.5)
    # 400 reads, each with an SNP within 1 bp of the same spot (far below a pixel).
    events = [{"kind": DIFF, "off": off + (i % 2), "base": "ACGT"[i % 4]} for i in range(400)]
    page.evaluate(SEED_JS, events)
    page.wait_for_timeout(400)
    tick_cols = set(page.evaluate(PIXELS_JS, "anybase"))
    assert tick_cols, "dense SNP pile-up drew nothing"
    x = _expected_x(page, off)
    assert min(abs(c - x) for c in tick_cols) <= 6
    # One folded tick (a few px wide), not a 400-marker smear.
    assert max(tick_cols) - min(tick_cols) <= 12, sorted(tick_cols)
    page.close()


def test_stacked_translucent_insertions_combine_like_stacked_markers(browser, tmp_path):
    """k coincident translucent insertion ticks are one tick whose alpha is
    1 - prod(1 - a_i): more reads => a darker (more opaque) tick."""
    page = _open(browser, tmp_path)
    span = page.evaluate("() => Math.floor(window.__GS_STATE.endBp - window.__GS_STATE.startBp)")

    def peak_alpha(n):
        pg = _open(browser, tmp_path)
        pg.evaluate(SEED_JS, [{"kind": INS, "off": int(span * .5), "base": "GG"} for _ in range(n)])
        pg.wait_for_timeout(400)
        a = pg.evaluate(r"""() => {
          const r = [...window.__GS_STATE.tiles[0]._smartRenderers.values()][0];
          const sh = r.webgpuCanvas._gsShadow;
          const d = sh.getContext('2d', {willReadFrequently: true}).getImageData(0, 0, sh.width, sh.height).data;
          let best = 0;
          for (let i = 0; i < d.length; i += 4) { const R = d[i], B = d[i+2]; if (B > R && B > 120 && d[i+1] < R) best = Math.max(best, d[i+3]); }
          return best; }""")
        pg.close()
        return a

    a1, a8 = peak_alpha(1), peak_alpha(8)
    page.close()
    assert a1 > 0, "a single insertion drew nothing"
    assert a8 > a1, f"stacked insertions should be more opaque than one: {a1} vs {a8}"
