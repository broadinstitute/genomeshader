"""Multi-tile visual parity: track Y alignment, focus chrome, ribbon trackId.

Catches the class of bugs where ribbons appear to jump tracks (because column B
grew taller), track handles flip with focus, and bundle colors disagree.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402
import reads_mock  # noqa: E402

ARTIFACTS = Path(__file__).resolve().parent / "_artifacts"

CFG = {
    "region": "chr14:32147950-32151950",
    "chrom_lengths": {
        "chr14": 107_043_718,
        "chr20": 64_444_167,
    },
    "viewport_variant_loading": False,
    "read_samples": ["SYN001", "SYN002"],
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


def _shot(page, name: str) -> None:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(ARTIFACTS / name), full_page=True)


def _open(browser):
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.add_init_script(
        "try{localStorage.removeItem('genomeshader.lockView');"
        "localStorage.removeItem('genomeshader.panZoom');"
        "localStorage.setItem('genomeshader.orientation','horizontal');}catch(e){}"
    )
    html = harness.build_page(config=CFG)
    f = os.path.join(tempfile.mkdtemp(), "tile_layout_parity.html")
    open(f, "w").write(html)
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_function(
        "() => !!(window.__GS_tiles && window.__GS_STATE && window.__GS_STATE.tiles)",
        timeout=10000,
    )
    return page


INSTALL_MOCK = r"""
() => {
  window.__GS_FETCH_LOG = [];
  function buildReads(sampleId, locus, nRows) {
    const m = String(locus || '').match(/^([^:]+):(\d+)-(\d+)$/);
    const contig = m ? m[1] : 'chr14';
    const start = m ? +m[2] : 32147950;
    const end = m ? +m[3] : 32151950;
    const mid = contig === 'chr14' ? 32149950 : 32005500;   // fixed anchors (chunks are wider than windows)
    const q=[], et=[], rs=[], re=[], fw=[], hp=[], sn=[], seq=[], sa=[];
    const n = Math.max(3, nRows || 3);
    for (let i = 0; i < n; i++) {
      const st = mid - 60 + i * 8;
      const en = mid + 30 + i * 2;
      q.push(sampleId + ':r' + i); et.push(0); rs.push(st); re.push(en);
      fw.push(true); hp.push(1); sn.push(sampleId); seq.push('');
      if (contig === 'chr14') sa.push('chr20,' + (32005500 + i) + ',+,100M,60,0;');
      else sa.push('chr14,' + (32149950 + i) + ',+,100M,60,0;');
    }
    return {
      query_name: q, element_type: et, reference_start: rs, reference_end: re,
      is_forward: fw, haplotype: hp, sample_name: sn, sequence: seq,
      sa_tag: sa, has_md: q.map(() => true),
    };
  }
  // Dense pileup on chr20 for SYN001 only — used to force height mismatch without the lock.
  window.__GS_SEND = function (type, data) {
    if (type !== 'fetch_reads') return Promise.resolve({ type: type + '_response' });
    const sampleId = (data && data.sample_id) || 'X';
    const locus = (data && data.locus) || '';
    const on20 = String(locus).startsWith('chr20:');
    const nRows = (sampleId === 'SYN001' && on20) ? 12 : 3;
    window.__GS_FETCH_LOG.push({ sampleId, locus, nRows });
    const bam = 'gs://fake/' + sampleId + '.bam';
    return Promise.resolve({
      type: 'fetch_reads_response',
      sample_id: sampleId,
      bam_urls: [bam],
      reads: buildReads(sampleId, locus, nRows),
      count: nRows,
    });
  };
}
"""


def _setup_two_tiles_expanded(page):
    page.evaluate(INSTALL_MOCK)
    page.evaluate(reads_mock.BATCH_SHIM_JS)
    page.evaluate(
        """async () => {
          await window.__GS_TEST_loadReads('SYN001', 'best_evidence');
          await window.__GS_TEST_loadReads('SYN002', 'best_evidence');
          // Expand reads so height lock matters.
          for (const t of (window.__GS_STATE.smartTracks || [])) {
            if (!t) continue;
            t.collapsed = false;
            if (t.readDisplay && t.readDisplay.visibility) {
              t.readDisplay.visibility.reads = true;
              t.readDisplay.visibility.summary = true;
            }
          }
          if (typeof renderAll === 'function') renderAll();
        }"""
    )
    page.wait_for_timeout(200)
    page.evaluate(
        """() => {
          const src = __GS_STATE.tiles[0].id;
          gsOpenLinkedTile({
            contig: 'chr20', pos: 32005500, strand: '+',
            sourceTileId: src, sourceStrand: '+',
          });
        }"""
    )
    page.wait_for_function(
        """() => {
          const d = window.__GS_TEST_readsRaceDump && window.__GS_TEST_readsRaceDump();
          if (!d) return (__GS_STATE.tiles || []).length >= 2;
          return d.fetchActive === 0 && (d.queuedKeys || []).length === 0
            && (__GS_STATE.tiles || []).length >= 2;
        }""",
        timeout=20000,
    )
    page.wait_for_timeout(400)
    # Ensure expanded + height locks after mate loads.
    page.evaluate(
        """() => {
          for (const t of (window.__GS_STATE.smartTracks || [])) {
            if (!t) continue;
            t.collapsed = false;
            if (t.readDisplay && t.readDisplay.visibility) {
              t.readDisplay.visibility.reads = true;
            }
          }
          if (typeof gsUpdateMultiTileHeightLocks === 'function') gsUpdateMultiTileHeightLocks();
          if (typeof renderAll === 'function') renderAll();
        }"""
    )
    page.wait_for_timeout(300)


def test_smart_track_y_aligned_across_tiles(browser):
    """Same smart-track id must sit at nearly the same strip Y in both columns."""
    page = _open(browser)
    try:
        page.wait_for_function(
            "() => typeof window.__GS_TEST_loadReads === 'function'", timeout=10000
        )
        _setup_two_tiles_expanded(page)

        info = page.evaluate(
            """() => {
              const strip = document.getElementById('tileStrip');
              const stripRect = strip.getBoundingClientRect();
              const tracks = (window.__GS_STATE.smartTracks || []).filter(Boolean);
              const tiles = window.__GS_STATE.tiles || [];
              const rows = [];
              for (const track of tracks) {
                const ys = [];
                for (const tile of tiles) {
                  const root = document.querySelector(`.gs-tile[data-tile-id="${tile.id}"]`);
                  if (!root) continue;
                  const el = root.querySelector(
                    `.smart-track-container[data-track-id="${track.id}"]`
                  );
                  if (!el) { ys.push(null); continue; }
                  const box = el.getBoundingClientRect();
                  ys.push(box.top - stripRect.top);
                }
                rows.push({
                  trackId: track.id,
                  sampleId: track.sampleId,
                  lock: track._multiTileHeightLock,
                  ys,
                  delta: (ys[0] != null && ys[1] != null) ? Math.abs(ys[0] - ys[1]) : null,
                });
              }
              return {
                rows,
                nBundles: (window.__GS_STATE.tileBundles || []).length,
                locks: tracks.map(t => ({ id: t.id, lock: t._multiTileHeightLock })),
              };
            }"""
        )
        bad = [r for r in info["rows"] if r["delta"] is not None and r["delta"] > 24]
        if bad:
            _shot(page, "fail_track_y_misaligned.png")
            pytest.fail(f"smart-track Y misaligned across tiles (>24px): {bad}\n{info}")
        # Height lock should be set for at least one expanded track with mate data.
        locks = [L for L in info["locks"] if L.get("lock")]
        assert locks, f"expected multi-tile height locks, got {info['locks']}"
    finally:
        page.close()


def test_ribbons_same_track_id_both_ends(browser):
    """Every aggregate ribbon must use one trackId; endpoints must resolve to that track."""
    page = _open(browser)
    try:
        page.wait_for_function(
            "() => typeof window.__GS_TEST_loadReads === 'function'", timeout=10000
        )
        _setup_two_tiles_expanded(page)

        info = page.evaluate(
            """() => {
              if (typeof gsRebuildTileBundles === 'function') gsRebuildTileBundles();
              if (typeof gsDrawTileArcs === 'function') gsDrawTileArcs();
              const bundles = window.__GS_STATE.tileBundles || [];
              const strip = document.getElementById('tileStrip');
              const stripRect = strip.getBoundingClientRect();
              const out = [];
              for (const b of bundles) {
                const left = window.__GS_STATE.tiles.find(t => t.id === b.tileAId);
                const right = window.__GS_STATE.tiles.find(t => t.id === b.tileBId);
                const y1info = left && gsTrackContainerYInTile
                  ? gsTrackContainerYInTile(left, b.trackId, strip, stripRect) : null;
                const y2info = right && gsTrackContainerYInTile
                  ? gsTrackContainerYInTile(right, b.trackId, strip, stripRect) : null;
                out.push({
                  id: b.id,
                  trackId: b.trackId,
                  count: b.count,
                  y1: y1info && y1info.mid,
                  y2: y2info && y2info.mid,
                  dy: (y1info && y2info) ? Math.abs(y1info.mid - y2info.mid) : null,
                  crossTrackKeys: (b.readKeys || []).some(k => k.trackId !== b.trackId),
                });
              }
              return out;
            }"""
        )
        cross = [b for b in info if b.get("crossTrackKeys")]
        if cross:
            _shot(page, "fail_ribbon_cross_track_keys.png")
            pytest.fail(f"bundle readKeys mix trackIds: {cross}")
        steep = [b for b in info if b.get("dy") is not None and b["dy"] > 40]
        if steep:
            _shot(page, "fail_ribbon_steep_dy.png")
            pytest.fail(
                f"ribbon endpoints for same trackId differ by >40px (layout skew): {steep}"
            )
    finally:
        page.close()


def test_track_controls_compact_only_when_unfocused(browser):
    """Focused tile shows full track chrome; unfocused uses gs-secondary-compact."""
    page = _open(browser)
    try:
        page.wait_for_function(
            "() => typeof window.__GS_TEST_loadReads === 'function'", timeout=10000
        )
        _setup_two_tiles_expanded(page)

        def check(focus_letter):
            return page.evaluate(
                """(letter) => {
                  const tile = window.__GS_STATE.tiles.find(t => t.letter === letter);
                  if (!tile) return { ok: false, reason: 'no tile' };
                  window.__GS_tiles.focus(tile.id);
                  if (typeof renderAll === 'function') renderAll();
                  const root = document.querySelector(`.gs-tile[data-tile-id="${tile.id}"]`);
                  const other = window.__GS_STATE.tiles.find(t => t.id !== tile.id);
                  const otherRoot = other && document.querySelector(
                    `.gs-tile[data-tile-id="${other.id}"]`);
                  const focusedCompact = root
                    ? root.querySelectorAll('.track-controls.gs-secondary-compact').length
                    : -1;
                  const otherCompact = otherRoot
                    ? otherRoot.querySelectorAll('.track-controls.gs-secondary-compact').length
                    : -1;
                  const focusedTotal = root
                    ? root.querySelectorAll('.track-controls').length : 0;
                  const otherTotal = otherRoot
                    ? otherRoot.querySelectorAll('.track-controls').length : 0;
                  return {
                    ok: true,
                    focusedId: tile.id,
                    focusedCompact,
                    otherCompact,
                    focusedTotal,
                    otherTotal,
                  };
                }""",
                focus_letter,
            )

        a = check("A")
        assert a.get("ok"), a
        # Focused A: no compact (or almost none). Unfocused B: most are compact.
        if a["focusedCompact"] > 0:
            _shot(page, "fail_controls_a_still_compact.png")
            pytest.fail(f"focused tile A still has compact controls: {a}")
        if a["otherTotal"] > 0 and a["otherCompact"] < max(1, a["otherTotal"] // 2):
            _shot(page, "fail_controls_b_not_compact.png")
            pytest.fail(f"unfocused tile B expected compact controls: {a}")

        b = check("B")
        assert b.get("ok"), b
        if b["focusedCompact"] > 0:
            _shot(page, "fail_controls_b_still_compact.png")
            pytest.fail(f"focused tile B still has compact controls: {b}")
        if b["otherTotal"] > 0 and b["otherCompact"] < max(1, b["otherTotal"] // 2):
            _shot(page, "fail_controls_a_not_compact.png")
            pytest.fail(f"unfocused tile A expected compact controls: {b}")
    finally:
        page.close()


def test_bundle_color_keys_both_tiles(browser):
    """Supporting reads should have bundle color entries for both tile ids."""
    page = _open(browser)
    try:
        page.wait_for_function(
            "() => typeof window.__GS_TEST_loadReads === 'function'", timeout=10000
        )
        _setup_two_tiles_expanded(page)
        info = page.evaluate(
            """() => {
              if (typeof gsRebuildTileBundles === 'function') gsRebuildTileBundles();
              const map = window.__GS_STATE.bundleColorByReadKey || {};
              const keys = Object.keys(map);
              const tiles = (window.__GS_STATE.tiles || []).map(t => t.id);
              const byTile = {};
              for (const id of tiles) byTile[id] = keys.filter(k => k.startsWith(id + '|')).length;
              return { nKeys: keys.length, byTile, nBundles: (window.__GS_STATE.tileBundles || []).length };
            }"""
        )
        if info["nBundles"] < 1:
            _shot(page, "fail_no_bundles.png")
            pytest.fail(f"expected tile bundles with SA reads: {info}")
        # Both tiles should have at least one color key when bundles exist.
        missing = [tid for tid, n in info["byTile"].items() if n < 1]
        if missing:
            _shot(page, "fail_bundle_color_one_tile.png")
            pytest.fail(f"bundle colors missing for tiles {missing}: {info}")
    finally:
        page.close()
