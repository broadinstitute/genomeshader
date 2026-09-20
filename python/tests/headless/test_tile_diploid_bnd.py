"""Diploid hifiasm BND evidence: both samples' hap1 must show SA; SA-open must
keep source evidence and must not draw ribbons from empty tracks.

Reproduces the screenshot series where only the last BAM track showed the BND,
and opening a linked tile blanked tile A while drawing four arcs from the first
two (empty) rows.
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

HAP1_001 = "gs://fake/assemblies/SYN001.hap1.bam"
HAP2_001 = "gs://fake/assemblies/SYN001.hap2.bam"
HAP1_002 = "gs://fake/assemblies/SYN002.hap1.bam"
HAP2_002 = "gs://fake/assemblies/SYN002.hap2.bam"

CFG = {
    "region": "chr14:32147950-32151950",
    "chrom_lengths": {
        "chr14": 107_043_718,
        "chr20": 64_444_167,
    },
    "viewport_variant_loading": False,
    "read_samples": ["SYN001", "SYN002"],
    "read_bam_index": {
        "SYN001": [HAP1_001, HAP2_001],
        "SYN002": [HAP1_002, HAP2_002],
    },
    "sample_mapping": {
        "SYN001": [HAP1_001, HAP2_001],
        "SYN002": [HAP1_002, HAP2_002],
    },
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
    f = os.path.join(tempfile.mkdtemp(), "tile_diploid_bnd.html")
    open(f, "w").write(html)
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_function(
        "() => typeof window.__GS_TEST_spawnSample === 'function'"
        " && typeof window.__GS_TEST_readsRaceDump === 'function'",
        timeout=10000,
    )
    return page


INSTALL_DIPLOID_MOCK = r"""
() => {
  window.__GS_FETCH_LOG = [];
  window.__GS_FETCH_DONE = [];
  function parseLocus(locus) {
    if (!locus || typeof locus !== 'string') return { contig: '', start: 0, end: 0, sig: '' };
    const m = locus.match(/^([^:]+):(\d+)-(\d+)$/);
    if (!m) return { contig: '', start: 0, end: 0, sig: locus };
    return { contig: m[1], start: +m[2], end: +m[3], sig: locus };
  }
  function isHap1(bam) {
    return String(bam || '').includes('.hap1.');
  }
  function buildReads(sampleId, locus, bam) {
    const { contig, start, end } = parseLocus(locus);
    const span = Math.max(50, end - start);
    const mid = contig === 'chr14' ? 32149950 : 32005500;   // fixed anchors (chunks are wider than windows)
    const q = [], et = [], rs = [], re = [], fw = [], hp = [], sn = [], seq = [];
    const sa = [], mateC = [], mateP = [];
    if (isHap1(bam)) {
      // Three soft-clipped SA chimeras — mirrors planted assembly hap1 evidence.
      for (let i = 0; i < 3; i++) {
        const st = mid - 80 + i * 12;
        const en = mid + 20 + i * 4;
        q.push(sampleId + ':hap1:sa:' + i);
        et.push(0); rs.push(st); re.push(en); fw.push(true); hp.push(0);
        sn.push(sampleId); seq.push('');
        if (contig === 'chr14') {
          sa.push('chr20,' + (32005500 + i) + ',+,100M,60,0;');
          mateC.push('chr20'); mateP.push(32005500 + i);
        } else {
          sa.push('chr14,' + (32149950 + i) + ',+,100M,60,0;');
          mateC.push('chr14'); mateP.push(32149950 + i);
        }
        q.push(sampleId + ':hap1:sa:' + i);
        et.push(4); rs.push(en); re.push(en + 40); fw.push(true); hp.push(0);
        sn.push(sampleId); seq.push('');
        sa.push(sa[sa.length - 1]);
        mateC.push(mateC[mateC.length - 1]); mateP.push(mateP[mateP.length - 1]);
      }
      // One background match.
      q.push(sampleId + ':hap1:bg');
      et.push(0); rs.push(mid - 60); re.push(mid + 60); fw.push(true); hp.push(0);
      sn.push(sampleId); seq.push('');
      sa.push(''); mateC.push(''); mateP.push(0);
    } else {
      // hap2: a single non-chimeric contig (no BND).
      q.push(sampleId + ':hap2:bg');
      et.push(0); rs.push(mid - 60); re.push(mid + 60); fw.push(true); hp.push(0);
      sn.push(sampleId); seq.push('');
      sa.push(''); mateC.push(''); mateP.push(0);
    }
    return {
      query_name: q, element_type: et, reference_start: rs, reference_end: re,
      is_forward: fw, haplotype: hp, sample_name: sn, sequence: seq,
      sa_tag: sa, mate_contig: mateC, mate_pos: mateP,
      has_md: q.map(() => true),
    };
  }
  window.__GS_SEND = function (type, data) {
    if (type !== 'fetch_reads') {
      return Promise.resolve({ type: type + '_response' });
    }
    const sampleId = (data && data.sample_id) || 'UNKNOWN';
    const locus = (data && data.locus) || '';
    const bam = (data && data.bam_url) || null;
    const { contig, sig } = parseLocus(locus);
    // Intentionally finish hap2 before hap1 for SYN001 so empty-pin / sibling
    // clobber races are deterministic (the screenshot failure mode).
    let delay = 40;
    if (sampleId === 'SYN001' && isHap1(bam) && contig === 'chr14') delay = 180;
    if (sampleId === 'SYN001' && !isHap1(bam) && contig === 'chr14') delay = 30;
    if (contig === 'chr20') delay = 50;
    window.__GS_FETCH_LOG.push({
      sampleId, contig, locus: sig || locus, bam, delay, t: Date.now(),
    });
    return new Promise((resolve) => {
      setTimeout(() => {
        const urls = bam ? [bam] : [
          'gs://fake/assemblies/' + sampleId + '.hap1.bam',
          'gs://fake/assemblies/' + sampleId + '.hap2.bam',
        ];
        const pin = bam || urls[0];
        window.__GS_FETCH_DONE.push({
          sampleId, contig, locus: sig || locus, bam: pin, t: Date.now(),
        });
        resolve({
          type: 'fetch_reads_response',
          sample_id: sampleId,
          bam_urls: urls,
          reads: buildReads(sampleId, sig || locus, pin),
          count: isHap1(pin) ? 4 : 1,
        });
      }, delay);
    });
  };
}
"""


def _install_mock(page):
    page.evaluate(INSTALL_DIPLOID_MOCK)
    page.evaluate(reads_mock.BATCH_SHIM_JS)


def _dump(page):
    return page.evaluate("() => window.__GS_TEST_readsRaceDump()")


def _assert_or_shot(page, cond, msg, shot_name):
    if not cond:
        _shot(page, shot_name)
        dump = _dump(page)
        pytest.fail(f"{msg}\n--- dump ---\n{dump}")


def _wait_idle(page, timeout=25000):
    page.wait_for_function(
        """() => {
          const d = window.__GS_TEST_readsRaceDump();
          return d.fetchActive === 0 && (d.queuedKeys || []).length === 0
            && (d.readLoadsInFlight || 0) === 0;
        }""",
        timeout=timeout,
    )
    page.wait_for_timeout(150)


def _load_diploid_samples(page):
    page.evaluate(
        "() => Promise.all(["
        "  window.__GS_TEST_spawnSample('SYN001', 'best_evidence'),"
        "  window.__GS_TEST_spawnSample('SYN002', 'best_evidence')"
        "])"
    )
    _wait_idle(page)
    page.wait_for_function(
        """() => {
          const d = window.__GS_TEST_readsRaceDump();
          const pins = (d.tracks || []).map(t => t.bamPin || '');
          return pins.filter(p => p.includes('.hap1.')).length >= 2
            && pins.filter(p => p.includes('.hap2.')).length >= 2;
        }""",
        timeout=15000,
    )


def test_diploid_both_hap1_show_bnd_after_load(browser):
    """Both carrier hap1 tracks must carry SA evidence after loading both samples."""
    page = _open(browser)
    try:
        _install_mock(page)
        _load_diploid_samples(page)
        dump = _dump(page)

        hap1_tracks = [
            t for t in dump["tracks"]
            if t.get("bamPin") and ".hap1." in t["bamPin"]
        ]
        _assert_or_shot(
            page,
            len(hap1_tracks) == 2,
            f"expected 2 hap1 tracks, got {hap1_tracks}",
            "fail_diploid_hap1_track_count.png",
        )
        for t in hap1_tracks:
            _assert_or_shot(
                page,
                t.get("nSa", 0) >= 3 and t.get("nReads", 0) >= 3,
                f"hap1 track missing BND SA after load: {t}",
                f"fail_diploid_hap1_empty_{t.get('sampleId')}.png",
            )
        # Cache must keep distinct pins — no empty-pin clobber across hap1/hap2.
        keys = dump.get("cacheKeys") or []
        for pin in (HAP1_001, HAP2_001, HAP1_002, HAP2_002):
            _assert_or_shot(
                page,
                any(pin in k and "|chr14|" in k for k in keys),
                f"cache missing pinned entry for {pin}: {keys}",
                "fail_diploid_cache_pins.png",
            )
        empty_pin_keys = [k for k in keys if "||chr14:" in k or k.count("|") == 2 and "||" in k]
        # sampleId| |locus would be empty pin — disallow when diploid pins exist.
        bad_empty = [k for k in keys if k.startswith("SYN001||") or k.startswith("SYN002||")]
        _assert_or_shot(
            page,
            not bad_empty,
            f"empty-pin cache aliases present (clobber risk): {bad_empty}",
            "fail_diploid_empty_pin_alias.png",
        )
        _ = empty_pin_keys
    finally:
        page.close()


def test_sa_open_keeps_source_evidence_no_empty_ribbons(browser):
    """After SA-open: the source column keeps painting hap1 evidence; ribbons need both sides."""
    page = _open(browser)
    try:
        _install_mock(page)
        _load_diploid_samples(page)

        page.evaluate(
            """() => {
              const src = __GS_STATE.tiles[0].id;
              gsOpenLinkedTile({
                contig: 'chr20', pos: 32005500, strand: '+',
                sourceTileId: src, sourceStrand: '+',
              });
            }"""
        )
        _wait_idle(page)
        page.wait_for_timeout(400)
        # Rebuild ribbons after mate loads settle.
        page.evaluate(
            """() => {
              if (typeof gsRebuildTileBundles === 'function') gsRebuildTileBundles();
              if (typeof gsDrawTileArcs === 'function') gsDrawTileArcs();
              if (typeof renderAll === 'function') renderAll();
            }"""
        )
        page.wait_for_timeout(300)
        dump = _dump(page)

        src = next((t for t in dump["tiles"] if t.get("contig") == "chr14"), None)
        _assert_or_shot(
            page,
            src is not None,
            "source chr14 tile missing",
            "fail_sa_diploid_no_source.png",
        )
        # Source column must still resolve hap1 SA via per-tile layout (cache).
        hap1 = [
            t for t in dump["tracks"]
            if t.get("bamPin") and ".hap1." in t["bamPin"]
        ]
        for t in hap1:
            pt = (t.get("perTile") or {}).get(src["id"]) or {}
            _assert_or_shot(
                page,
                pt.get("nSa", 0) >= 3,
                f"source tile lost hap1 SA after SA-open: track={t} perTile={pt}",
                f"fail_sa_diploid_source_erased_{t.get('sampleId')}.png",
            )

        # The source column must still PAINT its reads (pixels, not just cache keys).
        ink = page.evaluate("() => window.__GS_TEST_tileInk()")
        for t in dump["tracks"]:
            _assert_or_shot(
                page,
                (ink.get(src["id"], {}).get(t["id"], 0)) > 0,
                f"source tile painted nothing for track {t['id']} ({t.get('bamPin')}): {ink}",
                "fail_sa_diploid_source_blank_ink.png",
            )

        # Ribbons: every drawable ribbon must have supporting reads on BOTH sides.
        # Prefer SA presence — hap2 background-only tracks must not grow arcs.
        ribbons = dump.get("ribbons") or []
        drawable = [r for r in ribbons if r.get("drawable")]
        for r in drawable:
            _assert_or_shot(
                page,
                (r.get("leftReads") or 0) > 0 and (r.get("rightReads") or 0) > 0,
                f"ribbon drawn without supporting reads on both tiles: {r}",
                "fail_sa_diploid_ribbon_empty_track.png",
            )
            _assert_or_shot(
                page,
                (r.get("leftSa") or 0) > 0 and (r.get("rightSa") or 0) > 0,
                f"ribbon drawn without SA support on both tiles: {r}",
                "fail_sa_diploid_ribbon_no_sa.png",
            )
        # hap2 tracks have no SA — must not produce drawable cross-tile ribbons.
        hap2_drawable = [
            r for r in drawable
            if r.get("bamPin") and ".hap2." in (r.get("bamPin") or "")
        ]
        _assert_or_shot(
            page,
            not hap2_drawable,
            f"hap2 tracks unexpectedly have drawable ribbons: {hap2_drawable}",
            "fail_sa_diploid_hap2_ribbons.png",
        )
        # Both samples' hap1 should contribute at least one drawable ribbon.
        hap1_samples = {
            r.get("sampleId") for r in drawable
            if r.get("bamPin") and ".hap1." in (r.get("bamPin") or "")
        }
        _assert_or_shot(
            page,
            "SYN001" in hap1_samples and "SYN002" in hap1_samples,
            f"expected drawable ribbons for both hap1 samples, got {hap1_samples}; "
            f"ribbons={ribbons}",
            "fail_sa_diploid_missing_sample_ribbon.png",
        )
    finally:
        page.close()
