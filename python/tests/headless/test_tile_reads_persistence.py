"""Multi-tile reads must PERSIST: every tile owns its own reads stack and keeps
painting it through focus flips, pans, slow fetches and SA-open.

These tests assert on painted pixels (``__GS_TEST_tileInk``), not on cache keys
or DOM presence — the earlier suite checked internals while users saw blank
columns, "Loading…" stuck on siblings, and ribbons drawn out of empty tracks.

The shared mock (reads_mock.py) mirrors the real diploid hifiasm test BAMs.
Reads are cached as aligned CHUNKS (16 kb+), so a small pan inside loaded chunks
never fetches; scenarios that need a pending fetch pan across a chunk boundary.
"""
from __future__ import annotations

import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

import reads_mock  # noqa: E402
from reads_mock import CFG, HAP1_001, HAP2_001, HAP1_002, HAP2_002  # noqa: E402,F401


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:  # pragma: no cover
            pytest.skip(f"headless chromium unavailable: {e}")
        yield b
        b.close()


def _open(browser, delay=250):
    return reads_mock.open_page(browser, delay=delay)


def _idle(page, timeout=30000):
    page.wait_for_function(
        """() => { const d = window.__GS_TEST_readsRaceDump();
          return d.fetchActive === 0 && (d.queuedKeys || []).length === 0
            && (d.readLoadsInFlight || 0) === 0 && !d.schedulerPending; }""",
        timeout=timeout,
    )
    page.wait_for_timeout(150)


def _load_and_expand_hap1(page):
    page.evaluate(
        "() => Promise.all([__GS_TEST_spawnSample('SYN001','best_evidence'),"
        " __GS_TEST_spawnSample('SYN002','best_evidence')])"
    )
    _idle(page)
    page.evaluate(
        """() => {
          for (const t of window.__GS_STATE.smartTracks) {
            if ((t.requestedBamUrl || '').includes('.hap1.')) {
              t.collapsed = false;
              t.readDisplay.visibility.reads = true;
              t.readDisplay.visibility.summary = true;
            }
          }
          window.__GS_TEST_renderAll();
        }"""
    )
    page.wait_for_timeout(300)


def _open_sa_tile(page):
    page.evaluate(
        """() => gsOpenLinkedTile({contig:'chr20', pos:32005500, strand:'+',
             sourceTileId: window.__GS_STATE.tiles[0].id, sourceStrand:'+'})"""
    )


def _ink(page):
    """{tileId: {trackId: painted pixels}} for tracks that have any container."""
    return page.evaluate("() => window.__GS_TEST_tileInk()")


def _tile_ids(page):
    return page.evaluate("() => window.__GS_STATE.tiles.map(t => t.id)")


def _track_ids(page):
    return page.evaluate("() => window.__GS_STATE.smartTracks.map(t => t.id)")


def _focus(page, idx):
    page.evaluate("(i) => window.__GS_tiles.focus(window.__GS_STATE.tiles[i].id)", idx)


def _pan_focused(page, bp):
    page.evaluate(
        """(bp) => { const S = window.__GS_STATE; S.startBp += bp; S.endBp += bp;
          window.__GS_tiles.pull(); window.__GS_TEST_renderAll();
          window.gsScheduleSmartReadsLoad && window.gsScheduleSmartReadsLoad(); }""",
        bp,
    )


def _assert_reads_painted(page, ink, label):
    """Guard the baseline itself: an EXPANDED hap1 track (reads + soft-clip
    markers) must hold far more ink than a collapsed hap2 summary, in every tile.
    Grid lines / 'Loading…' text alone cannot satisfy this."""
    pins = page.evaluate(
        "() => Object.fromEntries(window.__GS_STATE.smartTracks.map(t => [t.id, t.requestedBamUrl || '']))"
    )
    for tid, rows in ink.items():
        hap1 = [v for k, v in rows.items() if ".hap1." in pins.get(k, "")]
        hap2 = [v for k, v in rows.items() if ".hap2." in pins.get(k, "")]
        assert hap1 and hap2, (label, tid, rows)
        assert min(hap1) > 1.5 * max(hap2), (
            f"[{label}] tile {tid}: expanded hap1 ink {hap1} not >> collapsed hap2 {hap2} "
            f"— reads were not painted"
        )


def _assert_not_blank(page, settled, floor, label):
    """Every (tile, track) that had ink when settled must still hold >= floor of it."""
    now = _ink(page)
    bad = []
    for tid, rows in settled.items():
        for trk, base in rows.items():
            if base <= 0:
                continue
            cur = now.get(tid, {}).get(trk, 0)
            if cur < base * floor:
                bad.append((tid, trk[-6:], base, cur))
    assert not bad, f"[{label}] tiles went blank/lost reads (tile, track, settled, now): {bad}"


# ---------------------------------------------------------------------------


def test_each_tile_owns_its_reads_stack(browser):
    """No shared/relocated stack: one wrapper + one container per track per tile,
    unique DOM ids, and no freeze snapshot layer anywhere."""
    page = _open(browser, delay=40)
    try:
        _load_and_expand_hap1(page)
        _open_sa_tile(page)
        _idle(page)
        page.wait_for_timeout(300)
        info = page.evaluate(
            """() => {
              const tracks = window.__GS_STATE.smartTracks.map(t => t.id);
              const tiles = window.__GS_STATE.tiles.map((t) => {
                const root = document.querySelector(`.gs-tile[data-tile-id="${t.id}"]`);
                return {
                  id: t.id,
                  wrappers: root.querySelectorAll('.gs-smart-scroll').length,
                  containers: [...root.querySelectorAll('.smart-track-container')]
                    .map(c => c.dataset.trackId).sort(),
                };
              });
              const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
              const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
              return { tracks: tracks.slice().sort(), tiles, dup,
                       freeze: document.querySelectorAll('.gs-smart-scroll-freeze').length };
            }"""
        )
        assert info["freeze"] == 0, info
        assert not info["dup"], f"duplicate DOM ids: {info['dup']}"
        assert len(info["tiles"]) == 2
        for t in info["tiles"]:
            assert t["wrappers"] == 1, info
            assert t["containers"] == info["tracks"], info
    finally:
        page.close()


def test_sa_open_and_focus_flips_never_blank_either_tile(browser):
    """Screenshots 2-6: after SA-open, flipping focus A<->B must leave BOTH
    columns showing all their reads, including while fetches are pending."""
    page = _open(browser, delay=400)
    try:
        _load_and_expand_hap1(page)
        _open_sa_tile(page)
        # Mid-flight: chr20 fetches are queued; the chr14 source column must be intact.
        page.wait_for_timeout(120)
        _idle(page)
        page.wait_for_timeout(300)
        settled = _ink(page)
        tiles = _tile_ids(page)
        _assert_reads_painted(page, settled, "settled after SA-open")
        for i in range(4):
            _focus(page, i % 2)
            page.wait_for_timeout(80)
            _assert_not_blank(page, settled, 0.5, f"flip {i} (+80ms)")
            page.wait_for_timeout(500)
            _idle(page)
            _assert_not_blank(page, settled, 0.5, f"flip {i} (settled)")
    finally:
        page.close()


def test_pan_then_focus_flip_while_fetch_pending(browser):
    """Screenshots 7-9: pan the focused tile, flip focus while its new window is
    still loading, pan the other, flip back. Nothing may blank or stick on Loading."""
    page = _open(browser, delay=700)
    try:
        _load_and_expand_hap1(page)
        _open_sa_tile(page)
        _idle(page)
        page.wait_for_timeout(300)
        _focus(page, 0)
        page.wait_for_timeout(200)
        _idle(page)
        settled = _ink(page)
        _assert_reads_painted(page, settled, "settled before pan")

        _pan_focused(page, 600)              # A: new window fetch starts (700ms)
        page.wait_for_timeout(100)
        _assert_not_blank(page, settled, 0.5, "A panned, fetch pending")
        _focus(page, 1)                      # flip to B while A is pending
        page.wait_for_timeout(200)
        _assert_not_blank(page, settled, 0.5, "focus B, A pending")
        _pan_focused(page, 500)              # pan B while A still pending
        page.wait_for_timeout(150)
        _assert_not_blank(page, settled, 0.5, "B panned, both pending")
        _focus(page, 0)                      # flip back while B is pending
        page.wait_for_timeout(150)
        _assert_not_blank(page, settled, 0.5, "focus A, B pending")
        _idle(page)
        page.wait_for_timeout(300)
        _assert_not_blank(page, settled, 0.5, "all settled")

        # Once settled, no track anywhere is left claiming to load.
        dump = page.evaluate("() => window.__GS_TEST_readsRaceDump()")
        assert dump["fetchActive"] == 0 and not dump["queuedKeys"], dump
        assert not dump["statusBusy"], f"status bar stuck busy: {dump['statusText']}"
    finally:
        page.close()


def test_two_tiles_on_same_contig_both_load(browser):
    """Both ends of a DEL sit on one contig. A second tile opened while the first
    tile's fetches are still queued must not cancel them (the queue used to drop
    any same-track same-contig job, leaving the first column empty forever)."""
    page = _open(browser, delay=250)
    try:
        # Kick off loads and DON'T wait: the first tile's jobs are still queued
        # (concurrency 1) when the second tile is added on the same contig.
        page.evaluate(
            """() => { __GS_TEST_spawnSample('SYN001','best_evidence');
                      __GS_TEST_spawnSample('SYN002','best_evidence'); }"""
        )
        page.wait_for_timeout(60)
        page.evaluate(
            "() => window.__GS_tiles.add({contig:'chr14', startBp: 32100000, endBp: 32104000})"
        )
        _idle(page, timeout=60000)
        page.wait_for_timeout(300)
        _wait_all_exact(page)
        keys = page.evaluate("() => window.__GS_TEST_readsRaceDump().cacheKeys")
        # Each tile's window is covered by a chunk of every BAM (chunk keys: sample|bam|contig|start-end).
        for pin in (HAP1_001, HAP2_001, HAP1_002, HAP2_002):
            assert any(pin in k and "|chr14|32145409-32161792" in k for k in keys), (pin, keys)
            assert any(pin in k and "|chr14|32096257-32112640" in k for k in keys), (pin, keys)
        ink = _ink(page)
        for tid, rows in ink.items():
            assert rows and all(v > 0 for v in rows.values()), (tid, rows)
        # Reads (not just grid lines) painted in BOTH same-contig tiles.
        page.evaluate(
            """() => { for (const t of window.__GS_STATE.smartTracks) if ((t.requestedBamUrl||'').includes('.hap1.')) {
                t.collapsed = false; t.readDisplay.visibility.reads = true; t.readDisplay.visibility.summary = true; }
                window.__GS_TEST_renderAll(); }"""
        )
        page.wait_for_timeout(300)
        _assert_reads_painted(page, _ink(page), "same-contig tiles")
    finally:
        page.close()


def test_ribbons_need_reads_on_both_sides_and_colors_are_stable(browser):
    """A ribbon exists iff both tiles hold supporting reads for that track, and a
    bundle keeps its color when unrelated tracks come and go (colors used to be
    assigned by creation order, so they flipped as other ribbons appeared)."""
    page = _open(browser, delay=60)
    try:
        _load_and_expand_hap1(page)
        _open_sa_tile(page)
        _idle(page)
        page.wait_for_timeout(500)

        def colors():
            return page.evaluate(
                """() => { window.gsRebuildTileBundles();
                  const out = {};
                  for (const b of window.__GS_STATE.tileBundles) {
                    out[b.trackId + '|' + b.dstContig + '|' + b.strandCombo] = b.color;
                  }
                  return out; }"""
            )

        before = colors()
        pins = page.evaluate(
            "() => Object.fromEntries(window.__GS_STATE.smartTracks.map(t => [t.id, t.requestedBamUrl]))"
        )
        hap1 = {tid for tid, pin in pins.items() if ".hap1." in pin}
        assert len(before) == 2, before          # one bundle per hap1 track, none for hap2
        assert {k.split("|")[0] for k in before} == hap1, (before, pins)

        # Drop the FIRST hap1 track; the other's ribbon color must not shift.
        first = next(t for t in page.evaluate("() => window.__GS_STATE.smartTracks.map(t => t.id)")
                     if t in hap1)
        page.evaluate(
            "(id) => { window.__GS_armRemoveSmartTrack(id); window.__GS_confirmRemoveSmartTrack(id); }",
            first,
        )
        page.wait_for_timeout(300)
        after = colors()
        assert len(after) == 1, after
        (k, c), = after.items()
        assert before[k] == c, f"bundle color changed {before[k]} -> {c}"
    finally:
        page.close()


@pytest.mark.parametrize("close_idx", [0, 1])
def test_closing_a_tile_keeps_the_other_tiles_reads(browser, close_idx):
    """Close either tile (incl. the primary): the survivor goes back to single-tile
    mode and must keep painting ITS reads — not the closed tile's, not just grid
    lines (grid lines alone are ~10-20% of a loaded track's ink)."""
    page = _open(browser, delay=60)
    try:
        _load_and_expand_hap1(page)
        _open_sa_tile(page)
        _idle(page)
        page.wait_for_timeout(300)
        # Focus the tile that will be CLOSED so its payload is the "live" one.
        _focus(page, close_idx)
        page.wait_for_timeout(200)
        settled = _ink(page)
        tiles = _tile_ids(page)
        survivor = tiles[1 - close_idx]
        page.evaluate("(i) => window.__GS_tiles.remove(window.__GS_STATE.tiles[i].id)", close_idx)
        _idle(page)
        page.wait_for_timeout(500)
        ink = _ink(page)
        assert list(ink) == [survivor], (ink, survivor)
        # Single-tile widens the column, so reads ink only grows; require the
        # tracks that had substantial reads to keep at least their old ink.
        for trk, base in settled[survivor].items():
            assert ink[survivor].get(trk, 0) >= base * 0.9, (trk[-6:], base, ink[survivor])
        info = page.evaluate(
            """() => ({ wrappers: document.querySelectorAll('.gs-smart-scroll').length,
                       containers: document.querySelectorAll('.smart-track-container').length,
                       tracks: window.__GS_STATE.smartTracks.length })"""
        )
        assert info["wrappers"] == 1 and info["containers"] == info["tracks"], info
    finally:
        page.close()


def test_tracks_added_while_tiles_are_open_load_in_every_tile(browser):
    """Loading a sample AFTER a second tile exists must fetch + paint it in BOTH tiles."""
    page = _open(browser, delay=100)
    try:
        page.evaluate(
            "() => window.__GS_tiles.add({contig:'chr20', startBp: 32003500, endBp: 32007500})"
        )
        page.wait_for_timeout(200)
        page.evaluate(
            """() => Promise.all([__GS_TEST_spawnSample('SYN001','best_evidence'),
                                  __GS_TEST_spawnSample('SYN002','best_evidence')])"""
        )
        _idle(page, timeout=60000)
        page.wait_for_timeout(400)
        page.evaluate(
            """() => { for (const t of window.__GS_STATE.smartTracks) if ((t.requestedBamUrl||'').includes('.hap1.')) {
                t.collapsed = false; t.readDisplay.visibility.reads = true; t.readDisplay.visibility.summary = true; }
                window.__GS_TEST_renderAll(); }"""
        )
        page.wait_for_timeout(300)
        ink = _ink(page)
        assert len(ink) == 2
        for tid, rows in ink.items():
            assert len(rows) == 4, (tid, rows)
        _assert_reads_painted(page, ink, "tracks added after tiles")
    finally:
        page.close()


def test_blank_tile_gets_reads_once_it_has_a_locus(browser):
    page = _open(browser, delay=100)
    try:
        _load_and_expand_hap1(page)
        page.evaluate("() => window.__GS_tiles.add({ blank: true })")
        page.wait_for_timeout(200)
        blank_id = page.evaluate("() => window.__GS_STATE.tiles[1].id")
        assert page.evaluate("() => window.__GS_STATE.tiles[1].blank") is True
        page.evaluate(
            "(id) => window.__GS_tiles.setLocus(id, 'chr20', 32003500, 32007500)", blank_id
        )
        _idle(page, timeout=60000)
        page.wait_for_timeout(400)
        ink = _ink(page)
        assert len(ink[blank_id]) == 4, ink
        _assert_reads_painted(page, {blank_id: ink[blank_id]}, "blank tile after setLocus")
    finally:
        page.close()


def test_view_scale_coverage_is_normalized_per_tile(browser):
    """Coverage summaries on the 'View' scale must normalize to EACH tile's own
    window. The max used to be computed once per frame from whichever tile painted
    first (and from the focused tile's payload) and reused for every column."""
    page = _open(browser, delay=60)
    try:
        _load_and_expand_hap1(page)
        # Tile B: same contig, window WITHOUT the chimeras => depth 1 (A has depth 4).
        page.evaluate(
            "() => window.__GS_tiles.add({contig:'chr14', startBp: 32100000, endBp: 32104000})"
        )
        _idle(page)
        page.wait_for_timeout(300)
        page.evaluate(
            """() => {
              for (const t of window.__GS_STATE.smartTracks) {
                t.collapsed = false;
                t.readDisplay.summaryField = 'coverage';
                t.readDisplay.coverageScale = { mode: 'view', fixedMin: 0, fixedMax: 30 };
                t.readDisplay.visibility.reads = true;
                t.readDisplay.visibility.summary = true;
              }
              window.__GS_STATE._viewCoverageMaxByTile = {};
              window.__GS_TEST_renderAll();
            }"""
        )
        page.wait_for_timeout(300)
        by_tile = page.evaluate("() => window.__GS_STATE._viewCoverageMaxByTile")
        ids = _tile_ids(page)
        assert set(by_tile) == set(ids), by_tile
        a, b = by_tile[ids[0]], by_tile[ids[1]]
        assert a > b, f"View-scale max should differ per tile (A has the chimeras): {by_tile}"
        assert b == 1, by_tile
    finally:
        page.close()


def _views(page):
    return page.evaluate("() => window.__GS_TEST_tileViews()")


def _wait_all_exact(page, timeout=20000):
    page.wait_for_function(
        """() => { const v = window.__GS_TEST_tileViews();
          return Object.values(v).every(rows => Object.values(rows).every(r => r.state === 'exact')); }""",
        timeout=timeout,
    )


def _hap1_ids(page):
    return page.evaluate(
        "() => window.__GS_STATE.smartTracks.filter(t => (t.requestedBamUrl||'').includes('.hap1.')).map(t => t.id)"
    )


def test_hole_without_any_queued_fetch_is_found_and_reloaded(browser):
    """A (tile, track) with no data and NOTHING queued must be noticed by the client
    itself. Before, it stayed empty/stale until an unrelated action (a focus flip)
    happened to call the loader — the 'switching focus refreshed my summary' bug."""
    page = _open(browser, delay=80)
    try:
        _load_and_expand_hap1(page)
        _open_sa_tile(page)
        _idle(page)
        page.wait_for_timeout(300)
        views = _views(page)
        tile_a = _tile_ids(page)[0]
        hap1 = _hap1_ids(page)
        for tid in hap1:
            assert views[tile_a][tid]["nSa"] > 0, views[tile_a][tid]
        dropped = page.evaluate(
            "() => window.__GS_TEST_dropReads('SYN001.hap1', 'chr14:32147950-32151950')"
        )
        assert dropped == 1, dropped
        # No focus flip, no pan: only a repaint. The client must notice and reload.
        page.evaluate("() => window.__GS_TEST_renderAll()")
        _wait_all_exact(page)
        _idle(page)
        after = _views(page)
        for tid in hap1:
            assert after[tile_a][tid]["nSa"] > 0 and after[tile_a][tid]["exact"], after[tile_a][tid]
    finally:
        page.close()


def test_failed_fetch_retries_without_user_action(browser):
    page = _open(browser, delay=60)
    try:
        page.evaluate("() => { window.__GS_READS_RETRY_BASE_MS = 80; }")
        _load_and_expand_hap1(page)
        _open_sa_tile(page)
        _idle(page)
        page.wait_for_timeout(300)
        # Fail the next two chunk requests for SYN001.hap1, then let them succeed.
        page.evaluate(
            """() => { window.__GS_FAILS = 0;
              window.__GS_FAIL_HOOK = (it) => {
                if ((it.bam_url||'').includes('SYN001.hap1') && window.__GS_FAILS < 2) {
                  window.__GS_FAILS++; return true; }
                return false; }; }"""
        )
        _focus(page, 0)
        _pan_focused(page, 32768)       # two chunks over: beyond the prefetched ring -> fresh fetch
        _wait_all_exact(page, timeout=30000)
        assert page.evaluate("() => window.__GS_FAILS") == 2
    finally:
        page.close()


def test_partial_coverage_is_dimmed_until_complete(browser):
    """A window only PARTLY covered by cached chunks draws what it has, dimmed, and
    returns to normal once the missing chunk lands. Full coverage is never dimmed."""
    page = _open(browser, delay=900)
    try:
        _load_and_expand_hap1(page)
        _open_sa_tile(page)
        _idle(page, timeout=90000)
        page.wait_for_timeout(300)
        focused = page.evaluate("() => window.__GS_STATE.focusedTileId")
        # B (chr20) cached chunk ends at 32014336; window 32011692-32015692 straddles it,
        # and the ring prefetch is NOT loaded yet if we jump before it lands.
        page.evaluate("(bp) => 0", 0)
        _pan_focused(page, 8192 + 3000)
        page.wait_for_timeout(120)
        marks = page.evaluate(
            """(id) => [...document.querySelectorAll(
                 `.gs-tile[data-tile-id="${id}"] .smart-track-container`)]
                 .map(c => c.dataset.viewState)""",
            focused,
        )
        # Either the ring prefetch already covered it (then exact) or it is partial (then dimmed):
        # what must NEVER happen is a partial view that is not marked.
        views = _views(page)[focused]
        for (tid, v), mark in zip(views.items(), marks):
            assert (mark == "exact") == bool(v["exact"]), (tid, v, mark)
        # No text badge any more — dimming is the only staleness cue.
        assert page.evaluate(
            "() => getComputedStyle(document.querySelector('.smart-track-container'), '::after').content"
        ) in ("none", "normal", '""')
        _wait_all_exact(page, timeout=90000)
        final = page.evaluate(
            """() => [...document.querySelectorAll('.smart-track-container')]
                 .map(c => c.dataset.viewState)"""
        )
        assert all(m == "exact" for m in final), final
    finally:
        page.close()


def test_retries_are_bounded_then_focus_retries_again(browser):
    """A permanently failing chunk is retried a bounded number of times (no hammering),
    shown dimmed as 'failed', and an explicit focus retries it."""
    page = _open(browser, delay=40)
    try:
        page.evaluate("() => { window.__GS_READS_RETRY_BASE_MS = 30; }")
        _load_and_expand_hap1(page)
        _open_sa_tile(page)
        _idle(page)
        page.wait_for_timeout(300)
        page.evaluate(
            """() => { window.__GS_ATTEMPTS = 0; window.__GS_BAD = true;
              window.__GS_FAIL_HOOK = (it) => {
                if (window.__GS_BAD && (it.bam_url||'').includes('SYN001.hap1')
                    && it.locus.startsWith('chr14:32178177')) { window.__GS_ATTEMPTS++; return true; }
                return false; }; }"""
        )
        _focus(page, 0)
        _pan_focused(page, 32768 + 100)      # window inside chunk 32178177-32194560 (beyond the ring)
        page.wait_for_function("() => window.__GS_ATTEMPTS >= 5", timeout=30000)
        page.wait_for_timeout(900)              # would keep climbing if unbounded
        assert page.evaluate("() => window.__GS_ATTEMPTS") == 5
        failed = page.evaluate(
            """() => [...document.querySelectorAll('.smart-track-container')]
                 .filter(c => c.dataset.viewState === 'failed').length"""
        )
        assert failed == 1, failed
        # Heal the backend; an explicit focus change retries.
        page.evaluate("() => { window.__GS_BAD = false; }")
        page.evaluate("() => window.__GS_tiles.focus(window.__GS_STATE.tiles[1].id)")
        page.evaluate("() => window.__GS_tiles.focus(window.__GS_STATE.tiles[0].id)")
        _wait_all_exact(page, timeout=30000)
    finally:
        page.close()


# ---------------------------------------------------------------------------
# Chunked cache: reloading is the worst case, not the default
# ---------------------------------------------------------------------------


def _batches(page):
    return page.evaluate("() => window.__GS_BATCH_LOG.length")


def _settle_all(page):
    """Wait for demand AND the neighbour-ring prefetch to finish."""
    for _ in range(4):
        page.wait_for_timeout(500)
        _idle(page, timeout=60000)


def test_pan_and_zoom_inside_loaded_chunks_never_fetch(browser):
    page = _open(browser, delay=120)
    try:
        _load_and_expand_hap1(page)
        _settle_all(page)
        before = _batches(page)
        for bp in (600, -1500, 2200, -900, 3000, -3000):
            _pan_focused(page, bp)
            page.wait_for_timeout(120)
            states = page.evaluate(
                "() => [...document.querySelectorAll('.smart-track-container')].map(c => c.dataset.viewState)"
            )
            assert all(m == "exact" for m in states), (bp, states)
        # Zoom out (still inside the centre chunk: span <= ~9 kb around the breakpoint), then back in.
        for f in (2.0, 0.5, 0.4):
            page.evaluate(
                """(f) => { const S = window.__GS_STATE; const c = (S.startBp+S.endBp)/2, h=(S.endBp-S.startBp)/2*f;
                    S.startBp = c-h; S.endBp = c+h; window.__GS_tiles.pull(); window.__GS_TEST_renderAll();
                    window.gsScheduleSmartReadsLoad(); }""",
                f,
            )
            page.wait_for_timeout(500)
        _idle(page)
        assert _batches(page) == before, "panning/zooming inside loaded chunks hit the kernel"
        # Zooming out INTO the already-loaded ring (spans several chunks): the view is exact
        # at once — never dimmed — even though the ring may then extend outward in the background.
        page.evaluate(
            """() => { const S = window.__GS_STATE; const c = (S.startBp+S.endBp)/2;
                S.startBp = c - 15000; S.endBp = c + 15000; window.__GS_tiles.pull();
                window.__GS_TEST_renderAll(); }"""
        )
        page.wait_for_timeout(80)
        states = page.evaluate(
            "() => [...document.querySelectorAll('.smart-track-container')].map(c => c.dataset.viewState)"
        )
        assert all(m == "exact" for m in states), states
    finally:
        page.close()


def test_neighbour_chunks_are_prefetched_once_the_window_is_complete(browser):
    page = _open(browser, delay=100)
    try:
        _load_and_expand_hap1(page)
        _settle_all(page)
        keys = page.evaluate("() => window.__GS_TEST_readsRaceDump().cacheKeys")
        for pin in (HAP1_001, HAP2_001, HAP1_002, HAP2_002):
            for chunk in ("32129025-32145408", "32145409-32161792", "32161793-32178176"):
                assert any(pin in k and k.endswith("|chr14|" + chunk) for k in keys), (pin, chunk, keys)
    finally:
        page.close()


def test_all_tracks_and_tiles_load_in_batches_not_one_by_one(browser):
    page = _open(browser, delay=100)
    try:
        _load_and_expand_hap1(page)
        _settle_all(page)
        _open_sa_tile(page)
        _settle_all(page)
        log = page.evaluate("() => window.__GS_BATCH_LOG.map(b => b.n)")
        items = page.evaluate("() => window.__GS_FETCH_LOG.length")
        assert sum(log) == items
        # 4 tracks x (demand chunk + 2 ring chunks) per tile, 2 tiles = 24 units; far fewer batches.
        assert items >= 24 and len(log) <= 6, (log, items)
        assert log[0] == 4, log          # the first batch = every track's demand chunk together
    finally:
        page.close()


def test_boundary_spanning_reads_are_deduplicated(browser):
    """The whole-locus contig sits in every chunk; assembled across chunks it must be ONE
    read, with the chimeras' elements intact."""
    page = _open(browser, delay=100)
    try:
        _load_and_expand_hap1(page)
        _settle_all(page)
        _pan_focused(page, 12000)                       # straddles chunks 1962/1963
        page.wait_for_timeout(300)
        _idle(page)
        tile = page.evaluate("() => window.__GS_STATE.focusedTileId")
        views = _views(page)[tile]
        pins = page.evaluate(
            "() => Object.fromEntries(window.__GS_STATE.smartTracks.map(t => [t.id, t.requestedBamUrl]))"
        )
        for tid, v in views.items():
            assert v["exact"], (tid, v)
            expect = 4 if ".hap1." in pins[tid] else 1     # bg contig + 3 chimeras (hap1) / bg only
            assert v["nAll"] == expect, (pins[tid], v)
    finally:
        page.close()


def test_merge_unions_elements_and_dedupes_reads(browser):
    page = _open(browser, delay=10)
    try:
        out = page.evaluate(
            """() => {
              const mk = (rows) => ({ query_name: rows.map(r => r[0]), element_type: rows.map(r => r[1]),
                reference_start: rows.map(r => r[2]), reference_end: rows.map(r => r[3]),
                is_forward: rows.map(() => true), sequence: rows.map(r => r[4] || '') });
              // Same read R (0..500) in both chunks; each chunk saw a DIFFERENT SNP element.
              const a = mk([['R',0,1,500], ['R',1,100,101,'A'], ['S',0,300,350]]);
              const b = mk([['R',0,1,500], ['R',1,400,401,'T'], ['T',0,600,700]]);
              const m = window.gsMergeReadPayloads([a, b]);
              return { names: m.query_name, types: m.element_type, starts: m.reference_start };
            }"""
        )
        assert out["names"] == ["R", "R", "R", "S", "T"], out
        assert out["types"] == [0, 1, 1, 0, 0], out
        assert out["starts"] == [1, 100, 400, 300, 600], out
    finally:
        page.close()


def test_sa_open_while_source_is_still_loading_loads_both_contigs(browser):
    """Opening the SA tile on ANOTHER contig while the source's first batch is still in
    flight must end with both tiles complete (nothing cancelled, nothing lost)."""
    page = _open(browser, delay=400)
    try:
        page.evaluate(
            """() => { __GS_TEST_spawnSample('SYN001','best_evidence');
                      __GS_TEST_spawnSample('SYN002','best_evidence'); }"""
        )
        page.wait_for_timeout(120)          # first batch in flight
        _open_sa_tile(page)
        _idle(page, timeout=90000)
        _wait_all_exact(page, timeout=90000)
        ink = _ink(page)
        assert len(ink) == 2 and all(len(r) == 4 for r in ink.values()), ink
        assert page.evaluate("() => window.__GS_TEST_readsRaceDump().statusBusy") is False
    finally:
        page.close()


# ---------------------------------------------------------------------------
# Connect / Disconnect
# ---------------------------------------------------------------------------


def test_disconnect_button_stops_all_loading_and_connect_resumes(browser):
    page = _open(browser, delay=80)
    try:
        _load_and_expand_hap1(page)
        _settle_all(page)
        btn = page.locator("#locusConnectBtn")
        assert btn.count() == 1
        assert btn.get_attribute("aria-pressed") == "false"

        btn.click()
        assert page.evaluate("() => window.__GS_OFFLINE === true")
        assert btn.get_attribute("aria-pressed") == "true"
        assert "is-active" in (btn.get_attribute("class") or "")

        before = _batches(page)
        # Cached window stays fully usable offline…
        _pan_focused(page, 2000)
        page.wait_for_timeout(500)
        states = page.evaluate(
            "() => [...document.querySelectorAll('.smart-track-container')].map(c => c.dataset.viewState)"
        )
        assert all(m == "exact" for m in states), states
        # …and a window that would need a fetch does NOT fetch — it is dimmed, with no error dialog.
        _pan_focused(page, 80000)
        page.wait_for_timeout(1200)
        assert _batches(page) == before, "a request was sent while disconnected"
        states = page.evaluate(
            "() => [...document.querySelectorAll('.smart-track-container')].map(c => c.dataset.viewState)"
        )
        assert states and all(m in ("offline", "stale") for m in states), states
        assert page.evaluate("() => document.querySelectorAll('.gs-modal-backdrop').length") == 0

        # Reconnect: loading resumes and the window completes.
        btn.click()
        assert page.evaluate("() => window.__GS_OFFLINE === false")
        _wait_all_exact(page, timeout=60000)
        assert _batches(page) > before
    finally:
        page.close()


def test_disconnected_comm_layer_refuses_data_requests_but_not_comments(browser):
    page = _open(browser, delay=10)
    try:
        page.evaluate("() => window.gsSetConnected(false)")
        out = page.evaluate(
            """async () => {
              const sent = [];
              const orig = window.__GS_SEND;
              window.__GS_SEND = (type, data) => { sent.push(type); return orig(type, data); };
              const outcome = {};
              for (const t of ['fetch_reads_batch', 'fetch_variants', 'navigate', 'resolve_feature', 'ucsc_list']) {
                try { await window.__GS_TEST_send(t, {items: []}); outcome[t] = 'sent'; }
                catch (e) { outcome[t] = e.gsDisconnected ? 'blocked' : 'error:' + e.message; }
              }
              try { await window.__GS_TEST_send('comments_list', {}); outcome.comments_list = 'sent'; }
              catch (e) { outcome.comments_list = 'error:' + e.message; }
              window.__GS_SEND = orig;
              return { outcome, sent };
            }"""
        )
        for t in ("fetch_reads_batch", "fetch_variants", "navigate", "resolve_feature", "ucsc_list"):
            assert out["outcome"][t] == "blocked", out
        assert out["outcome"]["comments_list"] == "sent", out
        assert out["sent"] == ["comments_list"], out
    finally:
        page.close()
