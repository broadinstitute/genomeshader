"""End to end: Python's real reads codec -> the viewer's real decoder -> painted reads.

A mocked kernel builds reads, hands them to the REAL ``genomeshader.reads_codec``
(via Playwright's expose_function), and answers ``fetch_reads_batch`` the way the
widget does: manifests in the items, raw bytes as ``_buffers``. The viewer must ask
for binary, decode it exactly, and paint; and a broken binary reply must fall back to
JSON on its own.
"""
from __future__ import annotations

import base64
import os
import sys
import tempfile

import pytest

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", ".."))
pytest.importorskip("playwright")
pytest.importorskip("numpy")
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402
from genomeshader import reads_codec  # noqa: E402

MOCK = r"""
(cfg) => {
  const BASES = ['A','C','G','T'];
  function build(sample, locus) {
    const m = (locus||'').match(/^([^:]+):(\d+)-(\d+)$/); const c=m[1], s=+m[2], e=+m[3];
    const q=[],et=[],rs=[],re=[],fw=[],hp=[],sn=[],seq=[],sa=[],mc=[],mp=[];
    const push=(n,t,a,b,base,f)=>{q.push(n);et.push(t);rs.push(a);re.push(b);fw.push(f);hp.push(0);sn.push(sample);seq.push(base||'');sa.push('');mc.push('');mp.push(0);};
    let k = 0;
    for (let st = s - 300; st < e; st += 900) {
      const en = st + 2000; const n = sample + ':' + c + ':' + st + ':' + (k++);
      push(n, 0, st, en, '', k % 2 === 0);
      for (let p = st + 50; p < en; p += 400) push(n, 1, p, p, BASES[(p >> 2) & 3], k % 2 === 0);
    }
    return {query_name:q,element_type:et,reference_start:rs,reference_end:re,is_forward:fw,haplotype:hp,
            sample_name:sn,sequence:seq,sa_tag:sa,mate_contig:mc,mate_pos:mp,has_md:q.map(()=>true)};
  }
  window.__GS_TRANSPORT_BINARY = true;
  window.__REQS = [];
  window.__GS_SEND = async function (type, data) {
    if (type !== 'fetch_reads_batch') return {type: type + '_response'};
    window.__REQS.push({binary: !!data.accept_binary});
    const items = [], bufs = [];
    for (const it of data.items) {
      const reads = build(it.sample_id, it.locus);
      const base = {count: 1, bam_urls: [it.bam_url || 'gs://x/' + it.sample_id + '.bam'], sample_id: it.sample_id};
      if (data.accept_binary) {
        const r = await window.pyEncode(reads, cfg.corrupt && window.__REQS.length === 1);
        const off = bufs.length;
        r.item.reads_bin.cols.forEach((c) => { c.buf += off; });
        r.buffers.forEach((b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); bufs.push(new DataView(u.buffer, 0)); });
        items.push({...base, reads_bin: r.item.reads_bin});
      } else items.push({...base, reads});
    }
    return {type: 'fetch_reads_batch_response', items, _buffers: bufs};
  };
}
"""

CFG = {
    "region": "chr14:32140000-32160000",
    "chrom_lengths": {"chr14": 107_043_718},
    "viewport_variant_loading": False,
    "read_samples": ["S0", "S1"],
    "read_bam_index": {"S0": ["gs://x/S0.bam"], "S1": ["gs://x/S1.bam"]},
    "sample_mapping": {"S0": ["gs://x/S0.bam"], "S1": ["gs://x/S1.bam"]},
    "reads_binary": True,          # opt-in (GENOMESHADER_READS_BINARY=1 on the kernel side)
}


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:  # pragma: no cover
            pytest.skip(f"chrome unavailable: {e}")
        yield b
        b.close()


def _open(browser, corrupt=False, expose=True):
    page = browser.new_page(viewport={"width": 1400, "height": 800})
    page.add_init_script("try{localStorage.setItem('genomeshader.orientation','horizontal');}catch(e){}")

    def py_encode(reads, corrupt_first):
        items, buffers = reads_codec.encode_batch_items([{"reads": reads, "count": 1}])
        item = items[0]
        assert "reads_bin" in item, "the mock's reads must be encodable"
        if corrupt_first:
            item["reads_bin"]["n"] += 1            # a manifest that lies about its row count
        return {"item": item, "buffers": [base64.b64encode(b).decode("ascii") for b in buffers]}

    if expose:
        page.expose_function("pyEncode", py_encode)
    f = os.path.join(tempfile.mkdtemp(), "bin.html")
    open(f, "w").write(harness.build_page(config=CFG))
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_function("() => window.__GS_TEST_gpuStats().ready", timeout=20000)
    page.evaluate(MOCK, {"corrupt": corrupt})
    return page


def _spawn_and_settle(page):
    # Don't await the spawn inside page.evaluate: that call has no timeout, so a
    # stalled page holds the suite until the CI step is killed.
    page.evaluate(
        """() => { window.__GS_SPAWN_DONE = false; window.__GS_SPAWN_ERR = null;
           Promise.all([__GS_TEST_spawnSample('S0','best_evidence'), __GS_TEST_spawnSample('S1','best_evidence')]).then(
             () => { window.__GS_SPAWN_DONE = true; },
             (e) => { window.__GS_SPAWN_ERR = String(e); window.__GS_SPAWN_DONE = true; }); }"""
    )
    page.wait_for_function("() => window.__GS_SPAWN_DONE === true", timeout=60000)
    err = page.evaluate("() => window.__GS_SPAWN_ERR")
    assert not err, err
    page.wait_for_function(
        """() => { const d = window.__GS_TEST_readsRaceDump();
          return d.fetchActive === 0 && (d.queuedKeys || []).length === 0
            && (d.readLoadsInFlight || 0) === 0 && !d.schedulerPending; }""",
        timeout=30000,
    )
    page.wait_for_timeout(400)


def test_viewer_requests_binary_decodes_it_and_paints(browser):
    page = _open(browser)
    _spawn_and_settle(page)
    reqs = page.evaluate("() => window.__REQS")
    assert reqs and all(r["binary"] for r in reqs), reqs
    views = page.evaluate("() => window.__GS_TEST_tileViews()")
    for tile in views.values():
        for row in tile.values():
            assert row["nReads"] > 5, row
    # decoded columns are exact: real booleans and numbers, not 0/1 or strings
    ok = page.evaluate(
        """() => { const t = window.__GS_STATE.smartTracks[0]; const L = window.__GS_TEST_layoutCompare();
                   const r = window.__GS_STATE.smartTracks[0].readsLayout.reads;
                   return {bool: r.every(x => typeof x.isForward === 'boolean'),
                           num: r.every(x => typeof x.start === 'number' && typeof x.end === 'number'),
                           elems: r.some(x => x.elements.length > 0)}; }"""
    )
    assert ok == {"bool": True, "num": True, "elems": True}, ok
    ink = page.evaluate("() => window.__GS_TEST_tileInk()")
    assert all(v > 0 for row in ink.values() for v in row.values()), ink
    page.close()


def test_a_broken_binary_reply_falls_back_to_json_transparently(browser):
    page = _open(browser, corrupt=True)
    _spawn_and_settle(page)
    reqs = page.evaluate("() => window.__REQS")
    assert reqs[0]["binary"] is True, reqs
    assert any(not r["binary"] for r in reqs[1:]), f"no JSON retry after the bad binary reply: {reqs}"
    assert page.evaluate("() => window.__GS_READS_BINARY") is False
    views = page.evaluate("() => window.__GS_TEST_tileViews()")
    assert all(row["nReads"] > 5 for tile in views.values() for row in tile.values()), views
    # the user never saw an error modal for it
    assert not page.evaluate("() => !!document.querySelector('.gs-modal, [class*=\"modal\"][class*=\"open\"]')")
    page.close()


def test_binary_is_off_by_default(browser):
    page = _open(browser)
    page.evaluate("() => { window.GENOMESHADER_CONFIG.reads_binary = undefined; window.__REQS.length = 0; }")
    _spawn_and_settle(page)
    reqs = page.evaluate("() => window.__REQS")
    assert reqs and not any(r["binary"] for r in reqs), reqs
    page.close()


def test_binary_is_off_when_the_host_transport_cannot_deliver_buffers(browser):
    page = _open(browser)
    page.evaluate("() => { window.__GS_TRANSPORT_BINARY = false; window.__REQS.length = 0; }")
    _spawn_and_settle(page)
    reqs = page.evaluate("() => window.__REQS")
    assert reqs and not any(r["binary"] for r in reqs), reqs
    page.close()
