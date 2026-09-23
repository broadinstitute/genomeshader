"""Shared realistic kernel mock for the multi-tile / chunked-reads headless tests.

Mirrors the real diploid hifiasm test BAMs (scratch/testdata/assemblies):
  chr14: a whole-locus contig on every haplotype; hap1 additionally has three
         800M800S chimeric contigs ending at 32149950 whose SA points at chr20:32005500.
  chr20: the mirror image (800S800M starting at 32005500) plus a whole-locus contig.

Like a real BAM, a request for [start, end] returns only the reads OVERLAPPING that
window (with all their elements), so chunked fetches + client-side de-duplication are
exercised for real. The mock answers both `fetch_reads_batch` (what the client sends)
and the legacy single `fetch_reads`.
"""
from __future__ import annotations

import os
import tempfile

import harness

HAP1_001 = "gs://fake/assemblies/SYN001.hap1.bam"
HAP2_001 = "gs://fake/assemblies/SYN001.hap2.bam"
HAP1_002 = "gs://fake/assemblies/SYN002.hap1.bam"
HAP2_002 = "gs://fake/assemblies/SYN002.hap2.bam"

CFG = {
    "region": "chr14:32147950-32151950",
    "chrom_lengths": {"chr14": 107_043_718, "chr20": 64_444_167},
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

# cfg: {delay: ms per BATCH, failFirst: optional [substring,...] of bam urls to fail once}
INSTALL_JS = r"""
(cfg) => {
  const DELAY = cfg.delay;
  window.__GS_FETCH_LOG = [];      // one entry per chunk item requested
  window.__GS_BATCH_LOG = [];      // one entry per batch request
  const CHR14 = [31988132, 32254546];
  const parse = (l) => { const m = (l||'').match(/^([^:]+):(\d+)-(\d+)$/); return m ? {c:m[1], s:+m[2], e:+m[3]} : {c:'',s:0,e:0}; };
  const hap1 = (b) => String(b||'').includes('.hap1.');
  function build(sample, locus, bam) {
    const {c, s, e} = parse(locus);
    const q=[], et=[], rs=[], re=[], fw=[], hp=[], sn=[], seq=[], sa=[], mc=[], mp=[];
    const push = (name, t, a, b2, saTag, mcon, mpos) => { q.push(name); et.push(t); rs.push(a); re.push(b2); fw.push(true);
      hp.push(0); sn.push(sample); seq.push(''); sa.push(saTag||''); mc.push(mcon||''); mp.push(mpos||0); };
    // A read (row type 0) + its clip element (type 4), only when the READ overlaps [s,e].
    const readWithClip = (name, a, b2, clipA, clipB, tag, mcon, mpos) => {
      if (b2 < s || a > e) return;
      push(name, 0, a, b2, tag, mcon, mpos);
      if (clipA != null) push(name, 4, clipA, clipB, tag, mcon, mpos);
    };
    const whole = (name, a, b2) => { if (b2 >= s && a <= e) push(name, 0, a, b2); };
    if (c === 'chr14') {
      whole(sample+'#'+(hap1(bam)?1:2)+'#chr14', CHR14[0], CHR14[1]);
      if (hap1(bam)) for (let i=0;i<3;i++) {
        const st = 32149125 + i*12, en = 32149925 + i*12;
        const tag = 'chr20,'+(32005500+i)+',+,800S800M,60,0;';
        readWithClip(sample+':asm:cx:'+i, st, en, en, en+800, tag, 'chr20', 32005500+i);
      }
    } else if (c === 'chr20') {
      if (hap1(bam)) for (let i=0;i<3;i++) {
        const st = 32005500 + i, en = st + 800;
        const tag = 'chr14,'+(32149950+i)+',+,800M800S,60,0;';
        readWithClip(sample+':asm:cx:'+i, st, en, st-800, st, tag, 'chr14', 32149950+i);
      }
      whole(sample+'#'+(hap1(bam)?1:2)+'#chr20', 32000000, 32019999);
    }
    return {query_name:q, element_type:et, reference_start:rs, reference_end:re, is_forward:fw, haplotype:hp,
      sample_name:sn, sequence:seq, sa_tag:sa, mate_contig:mc, mate_pos:mp, has_md:q.map(()=>true)};
  }
  const urlsFor = (sample, bam) => bam ? [bam] : ['gs://fake/assemblies/'+sample+'.hap1.bam','gs://fake/assemblies/'+sample+'.hap2.bam'];
  const oneItem = (it) => {
    const sample = it.sample_id, locus = it.locus, bam = it.bam_url || null;
    window.__GS_FETCH_LOG.push({sample, locus, bam});
    if (window.__GS_FAIL_HOOK && window.__GS_FAIL_HOOK(it)) return {error: 'simulated failure'};
    const urls = urlsFor(sample, bam);
    return {reads: build(sample, locus, bam || urls[0]), count: 1, bam_urls: urls};
  };
  window.__GS_SEND = function (type, data) {
    if (type === 'fetch_reads_batch') {
      window.__GS_BATCH_LOG.push({n: (data.items||[]).length, t: Date.now()});
      if (window.__GS_BATCH_HOOK) { const r = window.__GS_BATCH_HOOK(data); if (r) return r; }
      return new Promise((resolve) => setTimeout(() => {
        resolve({type: 'fetch_reads_batch_response', items: (data.items||[]).map(oneItem)});
      }, DELAY));
    }
    if (type === 'fetch_reads') {
      return new Promise((resolve) => setTimeout(() => {
        const r = oneItem({sample_id: data.sample_id, locus: data.locus, bam_url: data.bam_url});
        resolve(r.error ? {type:'fetch_reads_error', error: r.error, hint:''}
          : {type:'fetch_reads_response', sample_id: data.sample_id, bam_urls: r.bam_urls, reads: r.reads, count: 1});
      }, DELAY));
    }
    return Promise.resolve({type: type + '_response'});
  };
}
"""


def open_page(browser, delay=250, config=None):
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.add_init_script(
        "try{localStorage.removeItem('genomeshader.lockView');"
        "localStorage.removeItem('genomeshader.panZoom');"
        "localStorage.setItem('genomeshader.orientation','horizontal');}catch(e){}"
    )
    f = os.path.join(tempfile.mkdtemp(), "tile_reads.html")
    open(f, "w").write(harness.build_page(config=config or CFG))
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.evaluate(INSTALL_JS, {"delay": delay})
    return page


# Adapter for the older per-test mocks that only implement the legacy single
# `fetch_reads`: answers `fetch_reads_batch` by calling it once per item, and (like a
# real BAM) keeps only reads overlapping the requested window. Install AFTER the
# test's own mock.
BATCH_SHIM_JS = r"""
() => {
  const legacy = window.__GS_SEND;
  window.__GS_BATCH_LOG = window.__GS_BATCH_LOG || [];
  const parse = (l) => { const m = (l||'').match(/^([^:]+):(\d+)-(\d+)$/); return m ? {c:m[1], s:+m[2], e:+m[3]} : null; };
  function clip(reads, s, e) {
    if (!reads || !reads.query_name) return reads;
    const cols = Object.keys(reads), n = reads.query_name.length, out = {};
    cols.forEach(c => out[c] = []);
    let keep = false;
    for (let i = 0; i < n; i++) {
      if (reads.element_type[i] === 0) keep = reads.reference_end[i] >= s && reads.reference_start[i] <= e;
      if (keep) cols.forEach(c => out[c].push(reads[c][i]));
    }
    return out;
  }
  window.__GS_SEND = function (type, data, t) {
    if (type !== 'fetch_reads_batch') return legacy(type, data, t);
    window.__GS_BATCH_LOG.push({n: (data.items||[]).length, t: Date.now()});
    return Promise.all((data.items || []).map((it) =>
      legacy('fetch_reads', {sample_id: it.sample_id, locus: it.locus, bam_url: it.bam_url}, t).then((r) => {
        if (r.type === 'fetch_reads_error') return {error: r.error};
        const p = parse(it.locus);
        return {reads: p ? clip(r.reads, p.s, p.e) : r.reads, count: r.count, bam_urls: r.bam_urls};
      }))
    ).then((items) => ({type: 'fetch_reads_batch_response', items}));
  };
}
"""
