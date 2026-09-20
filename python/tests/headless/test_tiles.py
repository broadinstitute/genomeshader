"""Multi-locus tile view — strip DOM, focus, resize semantics, pills, flip.

Headless Chromium (Playwright). Asserts the tile chrome and state model without
requiring WebGPU paint or a live kernel.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

CFG = {
    "region": "chr1:1000-2000",
    "chrom_lengths": {"chr1": 1_000_000, "chr2": 500_000, "chr21": 46_000_000},
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


def _open(browser, cfg=CFG):
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    page.add_init_script(
        "try{localStorage.removeItem('genomeshader.lockView');"
        "localStorage.removeItem('genomeshader.panZoom');"
        "localStorage.setItem('genomeshader.orientation','horizontal');}catch(e){}"
    )
    html = harness.build_page(config=cfg)
    f = os.path.join(tempfile.mkdtemp(), "tiles.html")
    open(f, "w").write(html)
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_function(
        "() => !!(window.__GS_tiles && window.__GS_STATE && window.__GS_STATE.tiles)",
        timeout=10000,
    )
    return page


def test_single_tile_default(browser):
    page = _open(browser)
    n = page.evaluate("() => __GS_STATE.tiles.length")
    assert n == 1
    assert page.eval_on_selector("#tileStrip", "el => !!el")
    assert page.eval_on_selector("#addTileBtn", "el => !!el")
    # Classic locus bar still visible in single-tile mode.
    multi = page.evaluate("() => document.getElementById('locusBar').classList.contains('gs-multi-tile')")
    assert multi is False
    page.close()


def test_add_blank_tile_switches_toolbar(browser):
    page = _open(browser)
    page.evaluate("() => __GS_tiles.add({ blank: true })")
    page.wait_for_timeout(200)
    n = page.evaluate("() => __GS_STATE.tiles.length")
    assert n == 2
    multi = page.evaluate("() => document.getElementById('locusBar').classList.contains('gs-multi-tile')")
    assert multi is True
    pills = page.evaluate("() => document.querySelectorAll('.gs-tile-pill').length")
    assert pills == 2
    closes = page.evaluate("() => document.querySelectorAll('.gs-tile-pill-close').length")
    assert closes == 2
    page.close()


def test_pill_close_removes_tile(browser):
    """Locus-bar pill × closes that tile without focusing it first."""
    page = _open(browser)
    page.evaluate("""() => {
      __GS_tiles.add({ contig: 'chr2', startBp: 10000, endBp: 20000 });
      __GS_tiles.focus(__GS_STATE.tiles[0].id);
    }""")
    page.wait_for_timeout(100)
    removed = page.evaluate("""() => {
      const b = __GS_STATE.tiles[1];
      const pill = document.querySelector(`.gs-tile-pill[data-tile-id="${b.id}"]`);
      const btn = pill && pill.querySelector('[data-tile-pill-close]');
      if (!btn) return { ok: false, reason: 'no close btn' };
      btn.click();
      return {
        ok: true,
        n: __GS_STATE.tiles.length,
        focused: __GS_STATE.focusedTileId,
        remaining: __GS_STATE.tiles.map(t => t.id),
        pills: document.querySelectorAll('.gs-tile-pill').length,
      };
    }""")
    assert removed.get("ok") is True, removed
    assert removed["n"] == 1, removed
    assert removed["pills"] == 0, removed  # single-tile: pills hidden/cleared
    page.close()


def test_tiles_independent_xgenome(browser):
    page = _open(browser)
    page.evaluate("""() => {
      const a = __GS_STATE.tiles[0];
      __GS_tiles.add({ contig: 'chr2', startBp: 10000, endBp: 20000 });
      const b = __GS_STATE.tiles[1];
      const xc = window.__GS_xGenomeCanonical;
      window.__xa = xc(a.startBp + 100, 800, a);
      window.__xb = xc(b.startBp + 100, 800, b);
      window.__xa2 = xc(a.endBp - 100, 800, a);
      window.__xb2 = xc(b.endBp - 100, 800, b);
    }""")
    vals = page.evaluate("() => ({xa: window.__xa, xb: window.__xb, xa2: window.__xa2, xb2: window.__xb2})")
    # Near-start positions should both map near left pad (~16)
    assert vals["xa"] < 100
    assert vals["xb"] < 100
    # Near-end positions should both map near the right
    assert vals["xa2"] > 600
    assert vals["xb2"] > 600
    page.close()


def test_flip_one_tile_only(browser):
    page = _open(browser)
    page.evaluate("""() => {
      __GS_tiles.add({ contig: 'chr2', startBp: 10000, endBp: 20000 });
      const b = __GS_STATE.tiles[1];
      __GS_tiles.setReversed(b.id, true);
      const xc = window.__GS_xGenomeCanonical;
      // For tile B, start maps to the right when reversed
      window.__revStart = xc(10000, 800, __GS_STATE.tiles[1]);
      window.__revEnd = xc(20000, 800, __GS_STATE.tiles[1]);
    }""")
    vals = page.evaluate(
        "() => ({revStart: window.__revStart, revEnd: window.__revEnd})"
    )
    # Reversed: start maps to the right, end to the left
    assert vals["revStart"] > vals["revEnd"]
    page.close()


def test_reorder_pills_reorders_tiles(browser):
    page = _open(browser)
    page.evaluate("""() => {
      __GS_tiles.add({ contig: 'chr2', startBp: 1, endBp: 1000 });
      __GS_tiles.add({ contig: 'chr21', startBp: 1, endBp: 1000 });
      // Move last to front
      __GS_tiles.reorder(2, 0);
    }""")
    order = page.evaluate("() => __GS_STATE.tiles.map(t => t.contig)")
    assert order[0] == "chr21"
    letters = page.evaluate("() => __GS_STATE.tiles.map(t => t.letter)")
    assert letters == ["A", "B", "C"]
    page.close()


def test_linked_tile_inserts_after_source(browser):
    page = _open(browser)
    page.evaluate("""() => {
      const src = __GS_STATE.tiles[0].id;
      window.__GS_open = gsOpenLinkedTile({
        contig: 'chr21', pos: 15001000, strand: '+',
        sourceTileId: src, sourceStrand: '+',
      });
    }""")
    info = page.evaluate("""() => ({
      n: __GS_STATE.tiles.length,
      contigs: __GS_STATE.tiles.map(t => t.contig),
      linkedFrom: __GS_STATE.tiles[1].linkedFromId,
      src: __GS_STATE.tiles[0].id,
    })""")
    assert info["n"] == 2
    assert info["contigs"][1] == "chr21"
    assert info["linkedFrom"] == info["src"]
    page.close()


def test_parse_sa_tag(browser):
    page = _open(browser)
    parsed = page.evaluate(
        "() => gsParseSaTag('chr21,15001000,+,100M,60,0;chr7,100,-,50M,40,1;')"
    )
    assert len(parsed) == 2
    assert parsed[0]["contig"] == "chr21"
    assert parsed[0]["pos"] == 15001000
    assert parsed[1]["strand"] == "-"
    page.close()


def test_plus_button_click_adds_tile(browser):
    page = _open(browser)
    before = page.evaluate("""() => {
      const t = __GS_STATE.tiles[0];
      return { contig: t.contig, startBp: t.startBp, endBp: t.endBp };
    }""")
    page.click("#addTileBtn", timeout=5000)
    page.wait_for_timeout(300)
    info = page.evaluate("""() => {
      const tiles = __GS_STATE.tiles;
      const b = tiles[1];
      const inputs = [...document.querySelectorAll('[data-tile-locus-input]')];
      return {
        n: tiles.length,
        contig: b.contig,
        startBp: b.startBp,
        endBp: b.endBp,
        blank: !!b.blank,
        editing: inputs.some(i => !i.hidden),
      };
    }""")
    assert info["n"] == 2
    assert info["blank"] is False
    assert info["editing"] is False
    assert info["contig"] == before["contig"]
    assert info["startBp"] == before["startBp"]
    assert info["endBp"] == before["endBp"]
    page.close()


def test_flip_toggle_click_reverses(browser):
    page = _open(browser)
    # Click the orientation pill directly
    page.click('.gs-tile [data-tile-flip]', timeout=5000)
    page.wait_for_timeout(200)
    rev = page.evaluate("() => !!__GS_STATE.tiles[0].reversed")
    assert rev is True
    label = page.evaluate(
        "() => document.querySelector('[data-tile-flip]').textContent"
    )
    assert "3" in label and "5" in label
    # Coordinates should be reversed
    order = page.evaluate("""() => {
      const t = __GS_STATE.tiles[0];
      const xc = window.__GS_xGenomeCanonical;
      return { start: xc(t.startBp, 800, t), end: xc(t.endBp, 800, t) };
    }""")
    assert order["start"] > order["end"]
    page.close()


def test_focus_does_not_blank_sibling_tile_svg(browser):
    """Regression: focusing a tile must not relocate/blank sibling track SVGs."""
    page = _open(browser)
    page.evaluate("""() => {
      __GS_tiles.add({ contig: 'chr1', startBp: 1000, endBp: 2000 });
      const a = __GS_STATE.tiles[0];
      const b = __GS_STATE.tiles[1];
      // Seed a marker rect into tile A's SVG, then focus B.
      const aSvg = document.querySelector(`#tile-${a.id} .gs-tile-body svg`)
        || document.querySelector('#tracksSvg');
      const mark = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      mark.setAttribute('data-gs-keep', '1');
      mark.setAttribute('width', '10');
      mark.setAttribute('height', '10');
      aSvg.appendChild(mark);
      __GS_tiles.focus(b.id);
    }""")
    page.wait_for_timeout(300)
    info = page.evaluate("""() => {
      const tiles = __GS_STATE.tiles;
      const a = tiles[0], b = tiles[1];
      const aRoot = document.querySelector(`.gs-tile[data-tile-id="${a.id}"]`);
      const bRoot = document.querySelector(`.gs-tile[data-tile-id="${b.id}"]`);
      const aBody = aRoot && aRoot.querySelector('.gs-tile-body');
      const bBody = bRoot && bRoot.querySelector('.gs-tile-body');
      const aHasTracks = !!(aBody && (aBody.querySelector('#tracksContainer')
        || aBody.querySelector(`[id^="tracksContainer"]`)));
      const bHasTracks = !!(bBody && (bBody.querySelector('#tracksContainer')
        || bBody.querySelector(`[id^="tracksContainer"]`)));
      const placeholder = !!(aBody && aBody.querySelector('.gs-tile-body-placeholder'));
      return {
        focused: __GS_STATE.focusedTileId,
        aHasTracks,
        bHasTracks,
        placeholder,
        aKids: aBody ? aBody.children.length : 0,
        bKids: bBody ? bBody.children.length : 0,
      };
    }""")
    assert info["focused"] == page.evaluate("() => __GS_STATE.tiles[1].id")
    assert info["aHasTracks"] is True
    assert info["bHasTracks"] is True
    assert info["placeholder"] is False
    assert info["aKids"] >= 1
    assert info["bKids"] >= 1
    page.close()


def test_reversed_interval_width_uses_abs(browser):
    """Regression: reversed mapping must not collapse intervals to 1px widths."""
    page = _open(browser)
    vals = page.evaluate("""() => {
      __GS_tiles.setReversed(__GS_STATE.tiles[0].id, true);
      const t = __GS_STATE.tiles[0];
      const xc = window.__GS_xGenomeCanonical;
      const W = 800;
      const pos1 = xc(t.startBp + 100, W, t);
      const pos2 = xc(t.startBp + 400, W, t);
      const width = Math.max(1, Math.abs(pos2 - pos1));
      const naive = Math.max(1, pos2 - pos1);
      return { pos1, pos2, width, naive, reversed: pos1 > pos2 };
    }""")
    assert vals["reversed"] is True
    assert vals["naive"] == 1  # the old bug
    assert vals["width"] > 50
    page.close()


def test_secondary_tile_gets_track_controls(browser):
    """Regression: each tile must own its trackControls host, not only t0."""
    page = _open(browser)
    page.evaluate("""() => {
      __GS_tiles.add({ contig: 'chr1', startBp: 1000, endBp: 2000 });
      if (typeof renderAll === 'function') renderAll();
    }""")
    page.wait_for_timeout(300)
    info = page.evaluate("""() => {
      const tiles = __GS_STATE.tiles;
      const out = [];
      for (const t of tiles) {
        const root = document.querySelector(`.gs-tile[data-tile-id="${t.id}"]`);
        const host = root && (
          root.querySelector('#trackControls')
          || root.querySelector(`[id^="trackControls-"]`)
        );
        const handles = host ? host.querySelectorAll('.track-resize-handle').length : 0;
        const labels = host ? host.querySelectorAll('.track-controls').length : 0;
        out.push({ id: t.id, hasHost: !!host, handles, labels });
      }
      return out;
    }""")
    assert len(info) == 2
    for row in info:
        assert row["hasHost"] is True, row
        assert row["labels"] >= 1, row
    page.close()


def test_live_pan_does_not_transform_sibling_flow(browser):
    """Regression: panning the focused tile must not translate sibling flow-tracks."""
    page = _open(browser)
    vals = page.evaluate("""() => {
      __GS_tiles.add({ contig: 'chr1', startBp: 5000, endBp: 15000 });
      for (const t of __GS_STATE.tiles) {
        const root = document.querySelector(`.gs-tile[data-tile-id="${t.id}"]`);
        const flowEl = root && root.querySelector('.flow');
        if (!flowEl) continue;
        if (!flowEl.querySelector('.flow-track')) {
          const ft = document.createElement('div');
          ft.className = 'flow-track';
          ft.dataset.trackId = 'flow';
          flowEl.appendChild(ft);
        }
      }
      __GS_tiles.focus(__GS_STATE.tiles[0].id);
      // Clear any leftover transforms, then apply a live-pan transform via the
      // real helper (scoped to the focused tile).
      document.querySelectorAll('.flow-track').forEach(e => { e.style.transform = ''; });
      __GS_STATE.livePanOffset = 55;
      __GS_STATE.renderPadPx = 0;
      window.__GS_applyPanTransform();
      const a = __GS_STATE.tiles[0].id;
      const b = __GS_STATE.tiles[1].id;
      const aFt = document.querySelector(`.gs-tile[data-tile-id="${a}"] .flow-track`);
      const bFt = document.querySelector(`.gs-tile[data-tile-id="${b}"] .flow-track`);
      const layers = (window.__GS_panLayers && window.__GS_panLayers()) || [];
      const layerInB = layers.some(el => {
        const root = document.querySelector(`.gs-tile[data-tile-id="${b}"]`);
        return root && root.contains(el);
      });
      return {
        aTx: aFt ? aFt.style.transform : null,
        bTx: bFt ? bFt.style.transform : null,
        layerInB,
        nLayers: layers.length,
      };
    }""")
    assert "55px" in (vals["aTx"] or ""), vals
    assert not vals["bTx"], vals
    assert vals["layerInB"] is False, vals
    page.close()


def test_edit_icon_shows_locus_input(browser):
    page = _open(browser)
    page.evaluate("""() => {
      const locus = document.querySelector('.gs-tile [data-tile-locus]');
      if (locus) locus.click();
    }""")
    page.wait_for_timeout(200)
    visible = page.evaluate(
        "() => { const i = document.querySelector('[data-tile-locus-input]'); return i && !i.hidden; }"
    )
    assert visible is True
    page.close()


def test_unfocused_tile_keeps_reads_freeze(browser):
    """Unfocused tiles keep a Canvas2D snapshot of reads when #smartScroll moves."""
    page = _open(browser)
    seeded = page.evaluate("""async () => {
      if (typeof window.__GS_TEST_seedSmartTrack !== 'function') return null;
      const S = window.__GS_STATE;
      const start = S.startBp;
      const n = 8;
      const reads = {
        query_name: [], element_type: [], reference_start: [], reference_end: [],
        is_forward: [], haplotype: [], sample_name: [], read_group: [],
        mapping_quality: [], insert_size: [], clip_length: [], mean_base_quality: [],
        is_paired: [], is_primary: [], is_secondary: [], is_supplementary: [],
        sequence: [],
      };
      for (let i = 0; i < n; i++) {
        reads.query_name.push('r' + i);
        reads.element_type.push(0);
        reads.reference_start.push(start + 20 + i * 10);
        reads.reference_end.push(start + 80 + i * 10);
        reads.is_forward.push(true);
        reads.haplotype.push(1);
        reads.sample_name.push('S1');
        reads.read_group.push('rg1');
        reads.mapping_quality.push(60);
        reads.insert_size.push(300);
        reads.clip_length.push(0);
        reads.mean_base_quality.push(35);
        reads.is_paired.push(false);
        reads.is_primary.push(true);
        reads.is_secondary.push(false);
        reads.is_supplementary.push(false);
        reads.sequence.push('');
      }
      return await window.__GS_TEST_seedSmartTrack('S1', reads, { collapsed: false });
    }""")
    assert seeded and seeded.get("readCount", 0) >= 1, seeded

    info = page.evaluate("""() => {
      __GS_tiles.add({ contig: 'chr1', startBp: 1000, endBp: 2000 });
      const focusedId = __GS_STATE.focusedTileId;
      if (typeof renderAll === 'function') renderAll();
      const tiles = __GS_STATE.tiles.map(t => {
        const root = document.querySelector(`.gs-tile[data-tile-id="${t.id}"]`);
        const freeze = root && root.querySelector('.gs-smart-scroll-freeze');
        const live = root && root.querySelector('#smartScroll');
        let freezeCanvas = 0;
        if (freeze) {
          freeze.querySelectorAll('canvas').forEach(c => {
            if (c.width > 0 && c.height > 0 && c.style.display !== 'none') freezeCanvas += 1;
          });
        }
        return {
          id: t.id,
          focused: t.id === focusedId,
          hasFreeze: !!freeze,
          hasLive: !!live,
          freezeCanvas,
        };
      });
      return {
        nSmartScroll: document.querySelectorAll('#smartScroll').length,
        tiles,
      };
    }""")
    assert info["nSmartScroll"] == 1, info
    focused = [t for t in info["tiles"] if t["focused"]]
    unfocused = [t for t in info["tiles"] if not t["focused"]]
    assert len(focused) == 1 and len(unfocused) == 1, info
    assert focused[0]["hasLive"] is True, info
    assert focused[0]["hasFreeze"] is False, info
    assert unfocused[0]["hasFreeze"] is True, info
    assert unfocused[0]["hasLive"] is False, info
    assert unfocused[0]["freezeCanvas"] >= 1, info
    page.close()


def test_tile_name_editable(browser):
    """Tile letter/name can be customized and survives relabel of A/B codes."""
    page = _open(browser)
    page.evaluate("""() => {
      __GS_tiles.add({ contig: 'chr1', startBp: 5000, endBp: 15000 });
      const t1 = __GS_STATE.tiles[1];
      t1.name = 'Mate locus';
      if (typeof gsUpdateTileChrome === 'function') gsUpdateTileChrome();
      if (typeof gsUpdateLocusBarMode === 'function') gsUpdateLocusBarMode();
    }""")
    page.wait_for_timeout(100)
    vals = page.evaluate("""() => {
      const t = __GS_STATE.tiles[1];
      const root = document.querySelector(`.gs-tile[data-tile-id="${t.id}"]`);
      const letter = root && root.querySelector('[data-tile-letter]');
      const pill = [...document.querySelectorAll('.gs-tile-pill-label')]
        .map(el => el.textContent).find(s => s && s.indexOf('Mate') >= 0);
      return {
        name: t.name,
        letter: t.letter,
        display: typeof __GS_tiles.displayName === 'function'
          ? __GS_tiles.displayName(t) : (t.name || t.letter),
        headerText: letter && letter.textContent,
        pillHasName: !!pill,
      };
    }""")
    assert vals["name"] == "Mate locus", vals
    assert vals["display"] == "Mate locus", vals
    assert vals["headerText"] == "Mate locus", vals
    assert vals["pillHasName"] is True, vals
    # Relabel keeps custom name while refreshing the letter code.
    page.evaluate("""() => {
      __GS_tiles.add({ contig: 'chr1', startBp: 100, endBp: 200 });
    }""")
    page.wait_for_timeout(100)
    kept = page.evaluate("""() => {
      const t = __GS_STATE.tiles.find(x => x.name === 'Mate locus');
      return t && { name: t.name, letter: t.letter,
        display: __GS_tiles.displayName(t) };
    }""")
    assert kept and kept["name"] == "Mate locus", kept
    assert kept["display"] == "Mate locus", kept
    page.close()


def test_secondary_tile_track_controls_compact(browser):
    """Non-first tiles rest as grip-only; standard tracks get a grip+chevron."""
    page = _open(browser)
    info = page.evaluate("""() => {
      __GS_tiles.add({ contig: 'chr1', startBp: 5000, endBp: 15000 });
      // Focus first tile so secondary paint path runs for tile[1].
      __GS_tiles.focus(__GS_STATE.tiles[0].id);
      if (typeof renderAll === 'function') renderAll();
      const a = __GS_STATE.tiles[0];
      const b = __GS_STATE.tiles[1];
      const rootA = document.querySelector(`.gs-tile[data-tile-id="${a.id}"]`);
      const rootB = document.querySelector(`.gs-tile[data-tile-id="${b.id}"]`);
      const genesA = rootA && rootA.querySelector('.track-controls[data-track-id="genes"]');
      const genesB = rootB && rootB.querySelector('.track-controls[data-track-id="genes"]');
      return {
        aHasGrip: !!(genesA && genesA.querySelector('.smart-track-qc-grip')),
        aHasChevron: !!(genesA && genesA.querySelector('.smart-track-qc-collapse, .track-collapse-btn')),
        aCompact: !!(genesA && genesA.classList.contains('gs-secondary-compact')),
        bCompact: !!(genesB && genesB.classList.contains('gs-secondary-compact')),
        bHasGrip: !!(genesB && genesB.querySelector('.smart-track-qc-grip')),
      };
    }""")
    assert info["aHasGrip"] is True, info
    assert info["aHasChevron"] is True, info
    assert info["aCompact"] is False, info
    assert info["bCompact"] is True, info
    assert info["bHasGrip"] is True, info
    page.close()


def test_tile_strip_scroll_helpers(browser):
    """Header/pill chrome scrolls the strip; track bodies keep genomic pan."""
    page = _open(browser)
    info = page.evaluate("""() => {
      // Force overflow: many narrow tiles.
      for (let i = 0; i < 6; i++) {
        __GS_tiles.add({ contig: 'chr1', startBp: 1000 * i, endBp: 1000 * i + 500 });
      }
      __GS_STATE.tiles.forEach(t => { t.widthPx = 320; });
      if (typeof gsEnsureTileStripDom === 'function') gsEnsureTileStripDom();
      if (typeof gsBindTileStripScrollInteractions === 'function') gsBindTileStripScrollInteractions();
      if (typeof gsUpdateLocusBarMode === 'function') gsUpdateLocusBarMode();
      if (typeof gsUpdateTileStripScrollChrome === 'function') gsUpdateTileStripScrollChrome();
      const strip = document.getElementById('tileStrip');
      const bar = document.getElementById('locusBar');
      const can = typeof gsTileStripCanScroll === 'function' && gsTileStripCanScroll();
      const left0 = strip ? strip.scrollLeft : -1;
      const scrolled = typeof gsScrollTileStripBy === 'function' && gsScrollTileStripBy(200);
      const left1 = strip ? strip.scrollLeft : -1;
      const leftBtn = document.querySelector('.gs-tile-strip-chevron-left');
      const rightBtn = document.querySelector('.gs-tile-strip-chevron-right');
      const header = document.querySelector('.gs-tile-header');
      const body = document.querySelector('.gs-tile-body');
      let headerHandled = false;
      let bodyHandled = false;
      if (header && typeof gsMaybeScrollTileStripFromWheel === 'function') {
        headerHandled = gsMaybeScrollTileStripFromWheel({
          target: header, deltaX: 0, deltaY: 150, shiftKey: false,
          ctrlKey: false, metaKey: false,
          preventDefault() {}, stopPropagation() {},
        });
      }
      if (body && typeof gsMaybeScrollTileStripFromWheel === 'function') {
        bodyHandled = gsMaybeScrollTileStripFromWheel({
          target: body, deltaX: 80, deltaY: 0, shiftKey: false,
          ctrlKey: false, metaKey: false,
          preventDefault() {}, stopPropagation() {},
        });
      }
      return {
        can, scrolled, left0, left1,
        headerHandled, bodyHandled,
        chevronsInBar: !!(bar && leftBtn && rightBtn && bar.contains(leftBtn) && bar.contains(rightBtn)),
        hasLeft: !!(leftBtn && !leftBtn.hidden),
        hasRight: !!(rightBtn && !rightBtn.hidden),
        nTiles: __GS_STATE.tiles.length,
      };
    }""")
    assert info["nTiles"] >= 7, info
    assert info["can"] is True, info
    assert info["scrolled"] is True, info
    assert info["left1"] > info["left0"], info
    assert info["headerHandled"] is True, info
    assert info["bodyHandled"] is False, info
    assert info["chevronsInBar"] is True, info
    assert info["hasLeft"] is True or info["hasRight"] is True, info
    page.close()
