"""Render benchmark: how snappy is the viewer with many samples and several tiles?

Not a pytest module (no ``test_`` prefix) — run it directly and compare the JSON
before/after a rendering change:

    cd python && ../venv/bin/python tests/bench/bench_render.py \
        --tracks 1 10 25 50 --tiles 1 2 3 --out /tmp/bench.json

Runs the *real* viewer in real Chrome (WebGPU), against a mock kernel that
synthesises reads from a coverage / read-length / mismatch-rate model, so the
per-frame work matches a real many-sample session. For every (tracks, tiles)
cell it reports, over a sustained programmatic pan:

- ``paint_ms``   synchronous JS time of one ``renderAll()`` (p50 / p95). This is
                 the main-thread cost the user feels as jank.
- ``frame_ms``   rAF-to-rAF interval while re-painting every frame (p50 / p95).
- ``idle_ms``    ``renderAll()`` with nothing changed — the cost of a redundant
                 repaint (the number dirty-tracking should drive toward zero).
- ``canvases``   how many <canvas> elements the page holds (memory / compositor).
- ``devices``    GPU devices requested (should be 1 with a shared device).

It also records ``paint_ms`` for a pan of the *focused tile only*, which in a
correct multi-tile renderer should not repaint the other columns.
"""
import argparse
import json
import os
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "headless"))
import harness  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

CHROME_ARGS = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]

# Synthetic long-read model. Deterministic per (sample, chunk) so a re-fetch of the
# same chunk returns identical reads.
INSTALL_JS = r"""
(cfg) => {
  const parse = (l) => { const m = (l||'').match(/^([^:]+):(\d+)-(\d+)$/); return m ? {c:m[1], s:+m[2], e:+m[3]} : {c:'',s:0,e:0}; };
  function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const BASES = ['A','C','G','T'];
  function build(sample, locus, bam) {
    const {c, s, e} = parse(locus);
    const q=[], et=[], rs=[], re=[], fw=[], hp=[], sn=[], seq=[], sa=[], mc=[], mp=[];
    const push = (name, t, a, b2, base, hap) => { q.push(name); et.push(t); rs.push(a); re.push(b2); fw.push(true);
      hp.push(hap); sn.push(sample); seq.push(base||''); sa.push(''); mc.push(''); mp.push(0); };
    const span = e - s + 1;
    const n = Math.max(1, Math.round(cfg.coverage * span / cfg.readLen));
    const rnd = rng(hash(sample + '|' + c + '|' + s));
    for (let i = 0; i < n; i++) {
      // Reads are placed on a fixed grid keyed by absolute position so two chunks
      // that overlap agree about the reads on their shared edge.
      const st = Math.floor(s - cfg.readLen + rnd() * (span + cfg.readLen));
      const len = Math.floor(cfg.readLen * (0.7 + rnd() * 0.6));
      const en = st + len;
      if (en < s || st > e) continue;
      const hap = 1 + (i % 2);
      const name = sample + ':' + c + ':' + st + ':' + i;
      push(name, 0, st, en, '', hap);
      const nSnp = Math.round(len * cfg.snpRate);
      for (let k = 0; k < nSnp; k++) { const p = st + Math.floor(rnd() * len); push(name, 1, p, p, BASES[(rnd()*4)|0], hap); }
      const nIndel = Math.round(len * cfg.indelRate);
      for (let k = 0; k < nIndel; k++) { const p = st + Math.floor(rnd() * len); push(name, rnd() < 0.5 ? 2 : 3, p, p + 1 + ((rnd()*8)|0), '', hap); }
    }
    return {query_name:q, element_type:et, reference_start:rs, reference_end:re, is_forward:fw, haplotype:hp,
      sample_name:sn, sequence:seq, sa_tag:sa, mate_contig:mc, mate_pos:mp, has_md:q.map(()=>true)};
  }
  const oneItem = (it) => ({reads: build(it.sample_id, it.locus, it.bam_url), count: 1, bam_urls: [it.bam_url || ('gs://bench/' + it.sample_id + '.bam')]});
  window.__GS_SEND = function (type, data) {
    if (type === 'fetch_reads_batch') {
      return Promise.resolve({type: 'fetch_reads_batch_response', items: (data.items||[]).map(oneItem)});
    }
    return Promise.resolve({type: type + '_response'});
  };
}
"""

# Instruments GPU device creation so we can report how many devices the page holds.
DEVICE_COUNT_INIT = r"""
(() => {
  window.__GS_DEVICES = 0;
  if (navigator.gpu && GPUAdapter.prototype.requestDevice) {
    const orig = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = function (...a) { window.__GS_DEVICES++; return orig.apply(this, a); };
  }
})();
"""

MEASURE_JS = r"""
async ({mode, frames}) => {
  const S = window.__GS_STATE;
  const tiles = S.tiles || [];
  const focused = window.__GS_tiles.focused();
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const paint = [], frame = [];
  const q = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : 0; };
  const step = Math.max(1, Math.round((focused.endBp - focused.startBp) * 0.004));
  let dir = 1;
  await raf(); await raf();
  let last = performance.now();
  for (let i = 0; i < frames; i++) {
    if (mode === 'pan') {
      S.startBp += dir * step; S.endBp += dir * step;
      if (i % 40 === 39) dir = -dir;
      window.__GS_tiles.pull();
    }
    const t0 = performance.now();
    window.__GS_TEST_renderAll();
    paint.push(performance.now() - t0);
    await raf();
    const now = performance.now(); frame.push(now - last); last = now;
  }
  return {paint_p50: q(paint, .5), paint_p95: q(paint, .95), paint_max: Math.max(...paint),
          frame_p50: q(frame, .5), frame_p95: q(frame, .95)};
}
"""


def run_cell(browser, n_tracks, n_tiles, args):
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script(DEVICE_COUNT_INIT)
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.orientation','horizontal');"
        "localStorage.setItem('genomeshader.theme','light');}catch(e){}"
    )
    samples = [f"S{i:03d}" for i in range(n_tracks)]
    cfg = {
        "region": "chr14:32140000-32160000",
        "chrom_lengths": {"chr14": 107_043_718, "chr20": 64_444_167},
        "viewport_variant_loading": False,
        "read_samples": samples,
        "read_bam_index": {s: [f"gs://bench/{s}.bam"] for s in samples},
        "sample_mapping": {s: [f"gs://bench/{s}.bam"] for s in samples},
    }
    html = harness.build_page(config=cfg, capture=False)
    path = os.path.join(os.environ.get("TMPDIR", "/tmp"), "gs_bench.html")
    with open(path, "w") as f:
        f.write(html)
    page.goto("file://" + path, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=30000)
    # The viewer initialises WebGPU asynchronously after READY; tracks spawned before
    # that finishes would silently fall back to Canvas2D. Let it settle first.
    page.wait_for_timeout(2000)
    page.evaluate(INSTALL_JS, {"coverage": args.coverage, "readLen": args.read_len,
                               "snpRate": args.snp_rate, "indelRate": args.indel_rate})

    t0 = time.time()
    page.evaluate(
        "async (ids) => { await Promise.all(ids.map(id => window.__GS_TEST_spawnSample(id, 'best_evidence'))); }",
        samples,
    )
    # Expand every track so reads (not just summaries) are drawn.
    page.evaluate(
        """() => { for (const t of window.__GS_STATE.smartTracks) {
             t.collapsed = false; t.readDisplay.visibility.reads = true; t.readDisplay.visibility.summary = true; }
           window.__GS_TEST_renderAll(); }"""
    )
    for i in range(1, n_tiles):
        page.evaluate(
            """(i) => window.__GS_tiles.add({contig: i % 2 ? 'chr20' : 'chr14',
                 startBp: i % 2 ? 32000000 : 32140000 + i * 30000,
                 endBp:   i % 2 ? 32020000 : 32160000 + i * 30000})""",
            i,
        )
    page.wait_for_function(
        """() => { const d = window.__GS_TEST_readsRaceDump ? window.__GS_TEST_readsRaceDump() : null;
             return !d || (d.fetchActive === 0 && (d.queuedKeys||[]).length === 0 && !d.schedulerPending); }""",
        timeout=120000,
    )
    page.wait_for_timeout(800)
    load_s = time.time() - t0

    stats = page.evaluate(
        """() => ({
             canvases: document.querySelectorAll('canvas').length,
             gpuCanvases: document.querySelectorAll('canvas.webgpu-canvas').length,
             gpuTracks: [...(window.__GS_STATE.tiles||[]).flatMap(t => t._smartRenderers ? [...t._smartRenderers.values()] : []),
                         ...(window.__GS_STATE.smartTrackRenderers ? [...window.__GS_STATE.smartTrackRenderers.values()] : [])]
                         .filter((r, i, a) => a.indexOf(r) === i && r.webgpuCore).length,
             devices: window.__GS_DEVICES,
             reads: window.__GS_STATE.smartTracks.reduce((n, t) => n + ((t.readsLayout && t.readsLayout.reads) ? t.readsLayout.reads.length : 0), 0),
             tiles: window.__GS_STATE.tiles.length })"""
    )
    pan = page.evaluate(MEASURE_JS, {"mode": "pan", "frames": args.frames})
    idle = page.evaluate(MEASURE_JS, {"mode": "idle", "frames": args.frames})
    page.close()
    return {
        "tracks": n_tracks, "tiles": n_tiles, "load_s": round(load_s, 1),
        **stats,
        "pan": {k: round(v, 2) for k, v in pan.items()},
        "idle": {k: round(v, 2) for k, v in idle.items()},
        "errors": errors[:3],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracks", type=int, nargs="+", default=[1, 10, 25, 50])
    ap.add_argument("--tiles", type=int, nargs="+", default=[1, 2, 3])
    ap.add_argument("--frames", type=int, default=90)
    ap.add_argument("--coverage", type=float, default=30.0)
    ap.add_argument("--read-len", type=int, default=12000)
    ap.add_argument("--snp-rate", type=float, default=0.002)
    ap.add_argument("--indel-rate", type=float, default=0.002)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    results = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True,
                                     ignore_default_args=["--disable-gpu"], args=CHROME_ARGS)
        print(f"{'trk':>4} {'til':>3} {'reads':>7} {'cnv':>4} {'dev':>4} {'gpuT':>4} | "
              f"{'pan p50':>8} {'p95':>7} {'frm p95':>8} | {'idle p50':>9}")
        for tiles in args.tiles:
            for tracks in args.tracks:
                try:
                    r = run_cell(browser, tracks, tiles, args)
                except Exception as e:  # keep going: one bad cell shouldn't lose the rest
                    r = {"tracks": tracks, "tiles": tiles, "error": str(e)[:300]}
                    print(f"{tracks:>4} {tiles:>3}  ERROR {r['error']}")
                    results.append(r)
                    continue
                results.append(r)
                print(f"{r['tracks']:>4} {r['tiles']:>3} {r['reads']:>7} {r['canvases']:>4} {r['devices']:>4} {r['gpuTracks']:>4} | "
                      f"{r['pan']['paint_p50']:>8.1f} {r['pan']['paint_p95']:>7.1f} {r['pan']['frame_p95']:>8.1f} | "
                      f"{r['idle']['paint_p50']:>9.1f}", flush=True)
        browser.close()
    if args.out:
        with open(args.out, "w") as f:
            json.dump({"args": vars(args), "results": results}, f, indent=2)


if __name__ == "__main__":
    main()
