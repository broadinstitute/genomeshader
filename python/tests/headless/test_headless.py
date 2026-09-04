"""Headless UI regression tests (Playwright + headless Chromium).

Each test guards a real regression fixed in the viewer:

- renders in both orientations without console errors
- renders in a sandboxed / opaque origin (the localStorage-guard fix)
- ruler variant marks stay aligned with flow variant nodes
- vertical mode spreads variants across the full genome axis
- fullscreen enter/exit/enter keeps the tracks
- double-clicking an allele coalesces to a single render (not the 6-render storm)

Setup (also in README):
    pip install playwright anywidget
    python -m playwright install chromium
    pytest python/tests/headless

The whole module skips cleanly if Playwright or the browser isn't installed, so
the normal `pytest -q` run is unaffected.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
pytest.importorskip("anywidget")

from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

VIEWPORT = {"width": 1200, "height": 900}

# --- helpers ---------------------------------------------------------------

_SVG_COUNT = (
    "() => { const r=document.querySelector('[id^=\"genomeshader-root-\"]');"
    " const s=r&&r.querySelector('#tracksSvg'); return s?s.childElementCount:-1; }"
)


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:  # browser binary not installed in this env
            pytest.skip(f"headless chromium unavailable: {e}")
        yield b
        b.close()


def _open(browser, tmp_path, orientation="horizontal", config=None, instrument=False):
    """New page with orientation/theme pinned, viewer loaded, errors captured."""
    page = browser.new_page(viewport=VIEWPORT)
    errors = []
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.error: {m.text}")
            if m.type == "error" else None)
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.orientation',%r);"
        "localStorage.setItem('genomeshader.theme','light');}catch(e){}" % orientation
    )
    uri = harness.write_page(tmp_path, harness.build_page(config=config, instrument=instrument))
    page.goto(uri, wait_until="load")
    return page, errors


def _wait_ready(page):
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_timeout(300)


def _wait_nodes(page):
    page.wait_for_function(
        "() => window._alleleNodePositions && window._alleleNodePositions.length > 0",
        timeout=20000,
    )


# --- tests -----------------------------------------------------------------

@pytest.mark.parametrize("orientation", ["horizontal", "vertical"])
def test_viewer_renders(browser, tmp_path, orientation):
    page, errors = _open(browser, tmp_path, orientation)
    _wait_ready(page)
    assert page.evaluate("() => window.__GS_ERR") is None
    assert page.evaluate(_SVG_COUNT) > 0
    assert errors == [], errors
    page.close()


def test_renders_in_sandboxed_origin(browser):
    """The real ESM, imported as a strict module from an opaque blob origin
    (localStorage throws) — reproduces VS Code / Colab / Terra sandboxed output.
    Guards the gsLocalStorage shim; without it the whole viewer aborts blank."""
    page = browser.new_page(viewport=VIEWPORT)
    page.set_content("<!doctype html><html><body><div id='mount'></div></body></html>",
                     wait_until="load")
    svg_children = page.evaluate(
        """async (esmText) => {
            const url = URL.createObjectURL(new Blob([esmText], {type:'text/javascript'}));
            const mod = await import(url);
            const model = { get:(k)=>({config:{}, view_id:'gswidget'}[k]),
                            set(){}, save_changes(){}, on(){}, off(){}, send(){} };
            mod.default.render({ model, el: document.getElementById('mount') });
            await new Promise(r => setTimeout(r, 2500));
            const svg = document.querySelector('#mount [id^="genomeshader-root-"] #tracksSvg');
            return svg ? svg.childElementCount : -1;
        }""",
        harness.esm_module_source(),
    )
    assert svg_children > 0, "viewer rendered blank in a sandboxed origin"
    page.close()


def test_ruler_flow_alignment(browser, tmp_path):
    """Ruler variant marks must sit at the same x as their flow nodes."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_nodes(page)
    diffs = page.evaluate(
        """() => {
            const root = document.querySelector('[id^="genomeshader-root-"]');
            const ruler = {};
            root.querySelectorAll('#tracksSvg line[data-variant-id]').forEach(l => {
                const x1 = +l.getAttribute('x1'), x2 = +l.getAttribute('x2');
                if (Math.abs(x1 - x2) < 0.5) ruler[l.getAttribute('data-variant-id')] = x1;
            });
            const flow = {};
            (window._alleleNodePositions || []).forEach(n => {
                if (flow[n.variantId] == null) flow[n.variantId] = n.x + n.w / 2;
            });
            return Object.keys(ruler).filter(id => flow[id] != null)
                .map(id => Math.abs(ruler[id] - flow[id]));
        }"""
    )
    assert diffs, "no comparable ruler/flow variants found"
    assert all(d < 1.5 for d in diffs), f"ruler/flow misaligned: {diffs}"
    page.close()


def test_vertical_spreads_variants(browser, tmp_path):
    """Vertical mode maps variants across the full height (genome axis), not
    crammed into the band thickness."""
    page, _ = _open(browser, tmp_path, "vertical")
    _wait_nodes(page)
    ys = page.evaluate("() => (window._alleleNodePositions || []).map(n => n.y)")
    assert ys and (max(ys) - min(ys)) > 300, f"variants not spread on the genome axis: {ys}"
    page.close()


def test_fullscreen_cycle_keeps_tracks(browser, tmp_path):
    """Enter/exit/enter fullscreen must not lose the tracks."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)

    def svg_n():
        return page.evaluate(_SVG_COUNT)

    def toggle_fs():
        page.evaluate("() => { const e=document.getElementById('fullscreenItem'); if(e) e.click(); }")
        page.wait_for_timeout(400)

    assert svg_n() > 0
    for _ in range(2):
        toggle_fs()            # enter
        assert svg_n() > 0, "tracks vanished entering fullscreen"
        toggle_fs()            # exit
        assert svg_n() > 0, "tracks vanished exiting fullscreen"
    page.close()


def test_double_click_coalesces_renders(browser, tmp_path):
    """Double-clicking an allele opens both panels + switches tab. That must
    coalesce to a single render, not the 6-renderAll storm that froze the UI."""
    page, _ = _open(browser, tmp_path, "horizontal", instrument=True)
    _wait_nodes(page)
    pos = page.evaluate(
        """() => { const n = window._alleleNodePositions[0];
                   const c = document.getElementById('flowCanvas').getBoundingClientRect();
                   return { x: c.x + n.x + n.w/2, y: c.y + n.y + n.h/2 }; }"""
    )
    page.evaluate("() => { window.__rc = 0; }")
    page.mouse.dblclick(pos["x"], pos["y"])
    page.wait_for_timeout(1500)
    rc = page.evaluate("() => window.__rc")
    assert rc <= 2, f"double-click triggered {rc} renderAll (regression to the render storm)"
    page.close()

def test_right_click_does_not_stick_pan(browser, tmp_path):
    """Right-click then a button-less move must not scroll the view (the pan
    must not get stuck 'on')."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    start = page.evaluate("() => window.__GS_STATE.startBp")
    page.mouse.move(600, 400)
    page.mouse.down(button="right")
    page.mouse.up(button="right")
    page.mouse.move(400, 400)      # move with no button held
    page.mouse.move(250, 400)
    page.wait_for_timeout(200)
    end = page.evaluate("() => window.__GS_STATE.startBp")
    assert end == start, f"view scrolled after a right-click ({start} -> {end})"
    page.close()


def test_allele_reorder_indicator_matches_landing(browser, tmp_path):
    """The blue drop bar must sit exactly where the dragged allele lands. This
    guards the reorder desync bug: the move handler's drop-index, the indicator
    bar position, and the mouseup reorder all go through the shared
    allele-reorder helpers, so a sweep over pointer positions and drag sources
    proves indicator-position == landing-position. Pure geometry (the real
    exposed functions), so it runs without the WebGPU layer painting."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    mismatches = page.evaluate(
        """() => {
          const nid = window.__gsAlleleNearestDropIndex;
          const ins = window.__gsAlleleDropInsertAt;
          const pos = window.__gsAlleleDropIndicatorPos;
          if (!nid || !ins || !pos) return ['helpers not exposed'];
          const sizes = [10, 30, 8, 20, 14], gap = 8, start = 100;
          const layout = (sz) => { const p=[]; let c=start; for(const s of sz){p.push(c); c+=s+gap;} return p; };
          const mids = (sz) => layout(sz).map((x,i)=>x+sz[i]/2);
          const bad = [];
          for (let from=0; from<sizes.length; from++) {
            for (let x=start-20; x<start+220; x++) {
              // real move-handler rule via the exposed nearest-drop-index
              const m = mids(sizes);
              // emulate the handler's start/sizes: same array, same centering
              const dropIndex = nid(x, start, sizes, gap);
              const insertAt = ins(dropIndex, from);
              if (insertAt === from) continue;               // no-op, bar hidden
              const indicator = pos(start, sizes, gap, from, insertAt);
              // landing: remove dragged, insert at insertAt, relayout
              const order = sizes.map((_,i)=>i), sz = sizes.slice();
              const d = order.splice(from,1)[0], ds = sz.splice(from,1)[0];
              order.splice(insertAt,0,d); sz.splice(insertAt,0,ds);
              const landed = layout(sz)[insertAt];
              if (Math.abs(landed - indicator) > 0.001)
                bad.push(`from=${from} x=${x} drop=${dropIndex} insertAt=${insertAt} bar=${indicator} landed=${landed}`);
            }
          }
          return bad;
        }"""
    )
    assert mismatches == [], mismatches[:5]
    page.close()


def test_comment_thread_logic(browser, tmp_path):
    """Unread detection, participant check, unread-floats-to-top sort, and
    author/anchor filtering — the pure functions behind comment threads."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    out = page.evaluate(
        """() => {
          const S = window.__gsCommentSort, F = window.__gsCommentFilter,
                U = window.__gsCommentUnread, P = window.__gsCommentParticipant;
          if (!S || !F || !U || !P) return null;
          const me = "alice";
          const c1 = { id: "1", author: "alice", created: "2026-01-01T00:00Z",
                       anchor: { type: "region", locus: { contig: "x", pos: 10 } },
                       replies: [{ author: "bob", created: "2026-02-01T00:00Z", body: "r" }] };
          const c2 = { id: "2", author: "bob", created: "2026-03-01T00:00Z",
                       anchor: { type: "allele", locus: { contig: "x", pos: 20 } }, replies: [] };
          const c3 = { id: "3", author: "carol", created: "2026-04-01T00:00Z",
                       anchor: { type: "region", locus: { contig: "x", pos: 5 } }, replies: [] };
          const list = [c1, c2, c3];
          return {
            // alice authored c1; bob replied after -> unread for alice
            unread_c1: U(c1, me, null),
            // already seen past bob's reply -> not unread
            seen_c1: U(c1, me, "2026-02-02T00:00Z"),
            // alice not in c2 -> not a participant, never unread
            part_c2: P(c2, me),
            // sort by position, but unread (c1) still floats to top
            sortTop: S(list, "position", me, { "1": null }).map(c => c.id),
            // pure position order when nothing unread
            sortPos: S(list, "position", me, { "1": "2999-01-01T00:00Z" }).map(c => c.id),
            filterAuthor: F(list, { author: "bob" }).map(c => c.id),
            filterAnchor: F(list, { anchor: "allele" }).map(c => c.id),
          };
        }"""
    )
    assert out is not None, "comment helpers not exposed"
    assert out["unread_c1"] is True
    assert out["seen_c1"] is False
    assert out["part_c2"] is False
    assert out["sortTop"][0] == "1"                       # unread floats up
    assert out["sortPos"] == ["3", "1", "2"]              # by pos 5,10,20
    assert out["filterAuthor"] == ["2"]
    assert out["filterAnchor"] == ["2"]
    page.close()


def test_comment_pin_is_topmost_and_clickable(browser, tmp_path):
    """The comment pin must be the topmost element at its location — a full-track
    .track-hover-area (z-index 100) sits above #tracksSvg and used to eat the
    click, so pins render on a dedicated overlay above it. Seed a comment, force a
    real render, and elementFromPoint the pin."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    page.evaluate(
        """() => {
          const st = window.__GS_STATE;
          const mid = Math.floor((st.startBp + st.endBp) / 2);
          st.comments = [{ id: 'c1', author: 'x', body: 'hi',
            anchor: { type: 'region', locus: { contig: st.contig, pos: mid } } }];
          window.dispatchEvent(new Event('resize'));
        }"""
    )
    page.wait_for_timeout(500)
    out = page.evaluate(
        """() => {
          const pin = document.querySelector('.gs-comment-pin');
          if (!pin) return { pin: false };
          const r = pin.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { pin: true, overlay: !!document.getElementById('commentPinOverlay'),
                   pinIsTop: (top === pin || pin.contains(top)) };
        }"""
    )
    assert out["pin"] is True, "pin did not render"
    assert out["overlay"] is True, "pin overlay missing"
    assert out["pinIsTop"] is True, "pin is covered by another element (not clickable)"
    page.close()


def test_sample_load_selection_and_slider(browser, tmp_path):
    """One-track-per-sample selection (unique, skip already-loaded, cap) and the
    count-slider enable/pin rule — the pure logic behind those two bugs."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    out = page.evaluate(
        """() => {
          const sel = window.__gsSelectSamplesToLoad, sl = window.__gsSampleSliderState;
          if (!sel || !sl) return null;
          return {
            // dedupe within the request
            dedupe: sel(["a","a","b","c"], [], 5),
            // skip already-loaded samples
            skipLoaded: sel(["a","b","c"], ["b"], 5),
            // cap at numSamples (of the NEW ones)
            cap: sel(["a","b","c","d"], [], 2),
            // nothing new to load
            allLoaded: sel(["a","b"], ["a","b"], 5),
            slider0: sl(0), slider1: sl(1), slider2: sl(2), slider9: sl(9),
          };
        }"""
    )
    assert out is not None, "helpers not exposed"
    assert out["dedupe"] == ["a", "b", "c"]
    assert out["skipLoaded"] == ["a", "c"]
    assert out["cap"] == ["a", "b"]
    assert out["allLoaded"] == []
    assert out["slider0"] == {"disabled": True, "pinToOne": False}   # nothing selectable
    assert out["slider1"] == {"disabled": True, "pinToOne": True}    # exactly one -> greyed, pinned
    assert out["slider2"] == {"disabled": False, "pinToOne": False}  # 2+ -> enabled
    assert out["slider9"] == {"disabled": False, "pinToOne": False}
    page.close()


def test_indel_toggle_cycle(browser, tmp_path):
    """Mixed ins+del positions cycle off -> ins -> del -> off on click; pure
    ins/del just toggle. Guards the Indel-marker state machine."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    seq = page.evaluate(
        """() => {
          const f = window.__gsNextIndelExpansion;
          if (!f) return null;
          // mixed: walk the cycle from off
          const a = f(true, true, false, false);   // -> ins
          const b = f(true, true, a.ins, a.del);    // -> del
          const c = f(true, true, b.ins, b.del);    // -> off
          // pure insertion toggles
          const d = f(true, false, false, false);   // -> ins
          const e = f(true, false, true, false);    // -> off
          // pure deletion toggles
          const g = f(false, true, false, false);   // -> del
          return { a, b, c, d, e, g };
        }"""
    )
    assert seq is not None, "helper not exposed"
    assert seq["a"] == {"ins": True, "del": False}
    assert seq["b"] == {"ins": False, "del": True}
    assert seq["c"] == {"ins": False, "del": False}
    assert seq["d"] == {"ins": True, "del": False}
    assert seq["e"] == {"ins": False, "del": False}
    assert seq["g"] == {"ins": False, "del": True}
    page.close()


def test_zero_carrier_allele_label_is_honest(browser, tmp_path):
    """An allele carried by none of the loaded samples must say so, not render a
    bare '0 samples' that reads as a failed count."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    zero = page.evaluate("() => window.__gsFormatAlleleSampleCount ? window.__gsFormatAlleleSampleCount(0) : null")
    one = page.evaluate("() => window.__gsFormatAlleleSampleCount(1)")
    many = page.evaluate("() => window.__gsFormatAlleleSampleCount(7)")
    assert zero is not None, "formatter not exposed"
    assert "0 sample" not in zero and "carry" in zero, zero
    assert one == "1 sample"
    assert many == "7 samples"
    page.close()


def test_comment_time_has_timezone(browser, tmp_path):
    """Comment timestamps must render with a timezone token (regression: the old
    formatter dropped the zone entirely)."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    out = page.evaluate(
        "() => window.__gsFmtCommentTime ? window.__gsFmtCommentTime('2026-08-28T18:41:48+00:00') : null"
    )
    assert out is not None, "fmtTime helper not exposed"
    # e.g. "2026-08-28 14:41 EDT" — date, time, then a non-empty zone token.
    import re
    assert re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+", out), out
    page.close()


def test_paired_reads_keep_markers_on_own_read(browser, tmp_path):
    """Paired-end mates share a query_name. processReadsData must group reads by
    contiguity (one READ row + its own element rows), NOT by query_name — else a
    pair merges into one read and the mate's SNP/indel markers paint onto it,
    outside the kept read's body. Regression for 'alleles painted outside reads'."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    # Two mates, same query_name "readA": mate1 aligned 100-110 with a SNP at 105;
    # mate2 aligned 200-210 with an insertion at 205. element_type 0=READ,1=DIFF,
    # 2=INS. Rows are emitted READ-then-elements per mate, in order.
    payload = {
        "query_name":      ["readA", "readA", "readA", "readA"],
        "element_type":    [0,       1,       0,       2],
        "reference_start": [100,     105,     200,     205],
        "reference_end":   [110,     106,     210,     206],
        "is_forward":      [True,    True,    False,   False],
        "haplotype":       [0,       0,       0,       0],
        "sample_name":     ["S1",    "S1",    "S1",    "S1"],
        "sequence":        ["",      "A",     "",      "T"],
    }
    out = page.evaluate(
        "(p) => { const r = window.__GS_processReadsData(p); "
        "return r && r.reads.map(rd => ({start: rd.start, end: rd.end, "
        "elems: rd.elements.map(e => ({type: e.type, start: e.start}))})); }",
        payload,
    )
    assert out is not None, "processReadsData not exposed"
    # Two separate reads, each with only its OWN element.
    assert len(out) == 2, out
    a, b = sorted(out, key=lambda r: r["start"])
    assert a["start"] == 100 and a["end"] == 110
    assert a["elems"] == [{"type": 1, "start": 105}], a
    assert b["start"] == 200 and b["end"] == 210
    assert b["elems"] == [{"type": 2, "start": 205}], b
    page.close()


def test_virtual_row_window(browser, tmp_path):
    """Virtualized read-track row window: only the visible rows (+overscan) are
    selected, so a viewport-sized canvas can replace the full-stack one."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    fn = "(a) => window.__gsComputeVirtualRowWindow.apply(null, a)"
    # rowH=18, viewport=180 (10 rows), 1000 total rows.
    assert page.evaluate(fn, [0, 180, 18, 1000, 0]) == {"startRow": 0, "endRow": 10}
    # scrolled to row 100 (scrollTop 1800), overscan 2.
    assert page.evaluate(fn, [1800, 180, 18, 1000, 2]) == {"startRow": 98, "endRow": 112}
    # clamps to totalRows-1 at the bottom.
    r = page.evaluate(fn, [10 ** 6, 180, 18, 1000, 0])
    assert r["endRow"] == 999
    page.close()


def test_overscan_region(browser, tmp_path):
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    fn = "(a) => window.__gsOverscanRegion.apply(null, a)"
    # 1000 bp span, 50% overscan -> pad 500 each side; start clamps to >= 1.
    assert page.evaluate(fn, [1000, 2000, 0.5]) == {"start": 500, "end": 2500}
    assert page.evaluate(fn, [100, 200, 1.0])["start"] == 1  # clamp
    page.close()


def test_translate_frame(browser, tmp_path):
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    fn = "(a) => window.__gsTranslateFrame.apply(null, a)"
    # ATG AAA TGA -> M K * ; frame 0.
    out = page.evaluate(fn, ["ATGAAATGA", 0])
    assert [c["aa"] for c in out] == ["M", "K", "*"]
    assert out[1]["index"] == 3
    # frame 1 shifts the reading frame; unknown codon -> "X".
    assert page.evaluate(fn, ["NNN", 0])[0]["aa"] == "X"
    page.close()


# NOTE: allele *selection* is driven by the WebGPU interaction layer, which does
# not paint (or receive clicks) under swiftshader in headless Chromium, so
# selection behavior (e.g. double-click-keeps-selection) can't be asserted here.
# Those fixes are verified by inspection + in a real browser.


def test_window_store_update_and_coverage(browser, tmp_path):
    """P2 sparse variant-window store: merge new windows, evict distant ones,
    and test coverage to decide whether to fetch."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    up = "(a) => window.__gsWindowStoreUpdate.apply(null, a)"
    cov = "(a) => window.__gsRegionCovered.apply(null, a)"
    regions = [{"contig": "c", "start": 0, "end": 100},
               {"contig": "c", "start": 100000, "end": 100100}]
    new = {"contig": "c", "start": 200, "end": 300}
    # center near 250, keepSpan 5000 -> the far (100k) region evicts.
    out = page.evaluate(up, [regions, new, 250, 5000])
    kept = sorted(r["start"] for r in out["regions"])
    assert kept == [0, 200] and out["evicted"][0]["start"] == 100000
    # coverage: [220,280] covered by [200,300]; [400,500] not.
    assert page.evaluate(cov, [out["regions"], "c", 220, 280]) is True
    assert page.evaluate(cov, [out["regions"], "c", 400, 500]) is False
    page.close()


def test_repeats_track_dropped_without_data_still_renders(browser, tmp_path):
    """No repeats_data -> the RepeatMasker track is dropped, but the rest of the
    tracks still render. Guards the regression where removing a track tripped the
    required-layouts guard and blanked the whole SVG."""
    page, _ = _open(browser, tmp_path, "horizontal", config={"region": "chr1:100-200"})
    _wait_ready(page)
    assert page.evaluate(_SVG_COUNT) > 0, "tracks did not render with repeats absent"
    has = "() => (window.__GS_STATE.tracks||[]).some(t => t.id === 'repeats')"
    assert page.evaluate(has) is False
    page.close()

    page2, _ = _open(browser, tmp_path, "horizontal", config={
        "region": "chr1:100-200",
        "repeats_data": [{"start": 120, "end": 150, "cls": "LINE"}],
    })
    _wait_ready(page2)
    assert page2.evaluate(_SVG_COUNT) > 0
    assert page2.evaluate(has) is True
    page2.close()


def test_read_load_failure_removes_track_and_shows_modal(browser, tmp_path):
    """A failed read fetch removes the (empty) smart track and surfaces a
    centered OK modal instead of a transient status."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    page.evaluate("""() => { window.__GS_SEND = (type) =>
        type === 'fetch_reads'
          ? Promise.resolve({ type: 'fetch_reads_error', error: 'auth denied' })
          : Promise.resolve({}); }""")
    page.evaluate("() => window.__GS_TEST_loadReads('SAMPLE', 'best_evidence')")
    page.wait_for_function("() => !!document.querySelector('.gs-modal-backdrop')", timeout=5000)
    info = page.evaluate(
        "() => { const b=document.querySelector('.gs-modal-backdrop');"
        " const ok=b&&b.querySelector('.gs-modal-ok');"
        " return { ok: ok&&ok.textContent, title:(b.querySelector('.gs-modal-title')||{}).textContent,"
        " ntracks:(window.__GS_STATE.smartTracks||[]).length }; }")
    assert info["ok"] == "OK", info
    assert "Failed to load reads" in (info["title"] or "")
    assert info["ntracks"] == 0, "failed read track was not removed"
    # OK dismisses the modal
    page.evaluate("() => document.querySelector('.gs-modal-ok').click()")
    page.wait_for_timeout(100)
    assert page.evaluate("() => !document.querySelector('.gs-modal-backdrop')")
    page.close()


def test_clear_cache_button_dispatches_comm(browser, tmp_path):
    """The Settings > Local cache 'Clear' row sends the clear_cache comm and
    reports the freed count in the status bar."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    page.evaluate("""() => {
        window.__GS_CLEAR_SENT = null;
        window.__GS_SEND = (type, data) => {
            if (type === 'clear_cache') {
                window.__GS_CLEAR_SENT = true;
                return Promise.resolve({ type: 'clear_cache_response', files: 12, bytes: 5 * 1024 * 1024 });
            }
            return Promise.resolve({});
        };
        window.__GS_STATUS_LAST = null;
        const real = window.__GS_STATUS;
        window.__GS_STATUS = (m, o) => { window.__GS_STATUS_LAST = m; return real ? real(m, o) : undefined; };
    }""")
    page.evaluate("() => document.getElementById('clearCacheItem').click()")
    page.wait_for_function("() => window.__GS_CLEAR_SENT === true", timeout=5000)
    page.wait_for_function(
        "() => typeof window.__GS_STATUS_LAST === 'string' && window.__GS_STATUS_LAST.indexOf('12') >= 0",
        timeout=5000)
    msg = page.evaluate("() => window.__GS_STATUS_LAST")
    assert "cache cleared" in msg.lower() and "5" in msg, msg
    page.close()


def test_hud_stays_visible(browser, tmp_path):
    """The coordinate HUD is persistently visible (it used to auto-hide 3s
    after a render)."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    assert page.evaluate(
        "() => document.getElementById('hud').classList.contains('visible')")
    page.close()


def test_data_bounds_overlay_suppressed_when_viewport_loading(browser, tmp_path):
    """The grey out-of-data overlay draws when the view exceeds data_bounds, but
    is suppressed when viewport variant loading is on (data pages in across the
    contig)."""
    base = {"region": "chr1:1-100000", "data_bounds": {"start": 40000, "end": 60000}}
    p1, _ = _open(browser, tmp_path, "horizontal", config=dict(base))
    _wait_ready(p1)
    off = p1.evaluate("() => document.querySelectorAll('.data-bounds-overlay').length")
    p1.close()
    p2, _ = _open(browser, tmp_path, "horizontal",
                  config=dict(base, viewport_variant_loading=True))
    _wait_ready(p2)
    on = p2.evaluate("() => document.querySelectorAll('.data-bounds-overlay').length")
    p2.close()
    assert off > 0, "overlay should draw when the view exceeds data bounds"
    assert on == 0, "overlay must be suppressed when viewport variant loading is on"
