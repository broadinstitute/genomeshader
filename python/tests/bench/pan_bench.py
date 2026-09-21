"""Real-interaction pan benchmark: drag with actual mouse events, record frames.

    cd python && ../venv/bin/python tests/bench/pan_bench.py [--profile]

Reproduces "3 hifiasm tracks (2 expanded), 2 tiles at ~120 kb and ~59 kb, panning
left and right": the reads mock serves a few whole-locus contigs per haplotype
(reads_mock.CFG), the page is opened WITHOUT the test-only canvas capture, and the
drag is driven through Playwright mouse events so it takes the same pointer ->
panByPixels -> scheduleRender -> renderAll path a user does.

Reports, over the drag: rAF frame interval percentiles, how many frames were
>20 / >33 / >50 ms, long tasks / long animation frames, and (with --profile) the
top functions by self time from the Chrome CPU profiler.
"""
import argparse, collections, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "headless"))
import harness, reads_mock  # noqa: E402
import bench_render  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ARGS = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]

RECORD_JS = r"""
() => {
  const rec = { frames: [], long: [], loaf: [], t0: performance.now(), stop: false };
  window.__REC = rec;
  try { new PerformanceObserver((l) => l.getEntries().forEach(e => rec.long.push([e.startTime, e.duration]))).observe({type: 'longtask', buffered: false}); } catch (e) {}
  try { new PerformanceObserver((l) => l.getEntries().forEach(e => rec.loaf.push({
      start: e.startTime, dur: e.duration, block: e.blockingDuration,
      scripts: (e.scripts || []).map(s => [s.sourceFunctionName || s.invoker, Math.round(s.duration)])
    }))).observe({type: 'long-animation-frame', buffered: false}); } catch (e) {}
  let last = performance.now();
  const tick = (now) => { rec.frames.push(now - last); last = now; if (!rec.stop) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
"""


def pct(a, p):
    b = sorted(a)
    return b[min(len(b) - 1, int(p * len(b)))] if b else 0


def rich_config():
    """reads_mock.CFG plus what a real locus has: genes, thousands of repeats and a
    variants track with hundreds of records across both windows."""
    import random
    rnd = random.Random(7)
    cfg = dict(reads_mock.CFG)
    cfg["genome_build"] = "hg38"
    genes = []
    for i in range(40):
        st = 32_020_000 + i * 6_000 + rnd.randint(0, 2000)
        en = st + rnd.randint(2_000, 5_000)
        ex = []
        p = st
        while p < en - 200:
            e = min(en, p + rnd.randint(100, 400))
            ex.append([p, e, True])
            p = e + rnd.randint(200, 600)
        genes.append({"name": f"GENE{i}", "strand": "+-"[i % 2], "start": st, "end": en, "lane": i % 3, "exons": ex})
    cfg["genes_track"] = {"id": "genes", "label": "Genes", "style": "gene", "series": [{"name": "genes", "features": genes}]}
    classes = ["LINE", "SINE", "LTR", "DNA", "Simple_repeat", "Low_complexity"]
    reps = []
    for _ in range(4000):
        st = rnd.randint(32_000_000, 32_260_000)
        reps.append({"start": st, "end": st + rnd.randint(30, 1500), "cls": rnd.choice(classes)})
    reps.sort(key=lambda r: r["start"])
    cfg["repeats_track"] = {"id": "repeats", "label": "RepeatMasker", "style": "interval", "series": [{"name": "repeats", "features": reps}]}
    vs = []
    for i in range(400):
        pos = 32_000_000 + i * 640 + rnd.randint(0, 300)
        vs.append({"id": f"chr14:{pos}", "position": pos, "pos": pos, "ref": "A", "alt": "C",
                   "n_ref": 10 + i % 5, "n_alt": 5, "n_missing": 0, "n_samples": 15 + i % 5})
    cfg["variant_tracks"] = [{"id": "variants-0", "label": "VCF", "name": "vcf", "variants_data": vs}]
    cfg["data_bounds"] = {"start": 32_000_000, "end": 32_260_000}
    return cfg


def open_scene(browser, args):
    page = browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=args.dpr)
    page.add_init_script("try{localStorage.setItem('genomeshader.orientation','horizontal');localStorage.setItem('genomeshader.theme','light');}catch(e){}")
    page.add_init_script("window.__GS_TIME_PHASES = %s;" % ("'flush'" if args.flush_probe else "true"))
    path = os.path.join(tempfile.mkdtemp(), "pan.html")
    cfg = rich_config() if args.rich else dict(reads_mock.CFG)
    names = [f"S{i:03d}" for i in range(args.samples)] if args.samples else None
    if names:   # many samples: synthetic long contigs from bench_render's mock
        cfg["read_samples"] = names
        cfg["read_bam_index"] = {n: [f"gs://bench/{n}.bam"] for n in names}
        cfg["sample_mapping"] = {n: [f"gs://bench/{n}.bam"] for n in names}
    open(path, "w").write(harness.build_page(config=cfg, capture=False))
    page.goto("file://" + path, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=30000)
    page.wait_for_function("() => window.__GS_TEST_gpuStats().ready", timeout=30000)
    if names:
        # Long, sparse alignments (assembly-like): ~2x coverage of 80 kb contigs.
        page.evaluate(bench_render.INSTALL_JS, {"coverage": args.coverage, "readLen": args.read_len,
                                                "snpRate": args.snp_rate, "indelRate": args.indel_rate})
        t_load = __import__("time").time()
        page.evaluate("async (ids) => { await Promise.all(ids.map(id => window.__GS_TEST_spawnSample(id, 'best_evidence'))); }", names)
        settle(page)
        args.load_s = __import__("time").time() - t_load
        # Open the first N tracks (like the report); the rest stay collapsed.
        page.evaluate("""(n) => { window.__GS_STATE.smartTracks.forEach((t, i) => {
            const open = i < n; t.collapsed = !open; t.readDisplay.visibility.reads = open; t.readDisplay.visibility.summary = true; });
            window.__GS_TEST_renderAll(); }""", args.open)
    else:
        page.evaluate(reads_mock.INSTALL_JS, {"delay": 30})
        page.evaluate("() => Promise.all([__GS_TEST_spawnSample('SYN001','best_evidence'), __GS_TEST_spawnSample('SYN002','best_evidence')])")
        settle(page)
        # 4 tracks (hap1/hap2 x 2 samples); open the two hap1 tracks like the report.
        page.evaluate("""() => { for (const t of window.__GS_STATE.smartTracks) {
            const open = (t.requestedBamUrl || '').includes('.hap1.');
            t.collapsed = !open; t.readDisplay.visibility.reads = open; t.readDisplay.visibility.summary = true; }
            window.__GS_TEST_renderAll(); }""")
    # Tile 1: ~120 kb on chr14; tile 2: ~59 kb on chr20 (where the SA mates land).
    page.evaluate(f"""() => {{
        const S = window.__GS_STATE; const c = 32149950;
        S.startBp = c - {args.span1 // 2}; S.endBp = c + {args.span1 // 2};
        window.__GS_tiles.pull();
        if ({args.tiles} > 1) window.__GS_tiles.add({{contig: 'chr20', startBp: 32005500 - {args.span2 // 2}, endBp: 32005500 + {args.span2 // 2}}});
        window.__GS_tiles.focus(S.tiles[0].id);
        window.__GS_TEST_renderAll(); }}""")
    settle(page)
    page.wait_for_timeout(600)
    return page


def settle(page):
    page.wait_for_function("""() => { const d = window.__GS_TEST_readsRaceDump();
        return d.fetchActive === 0 && (d.queuedKeys||[]).length === 0 && (d.readLoadsInFlight||0) === 0 && !d.schedulerPending; }""",
        timeout=60000)
    page.wait_for_timeout(300)


def drag(page, seconds, amplitude_px, hz=120):
    """Left-right drag in tile 1's track area with real mouse events."""
    # A point that really belongs to tile 1 (a sidebar can overlap its rect).
    box = page.evaluate("""() => { const t = window.__GS_STATE.tiles[0];
        const tile = document.querySelector('.gs-tile[data-tile-id="' + t.id + '"]');
        const r = tile.getBoundingClientRect();
        for (let y = r.top + 60; y < r.bottom - 10; y += 25)
          for (let x = r.left + 20; x < Math.min(r.right, window.innerWidth) - 20; x += 25) {
            const e = document.elementFromPoint(x, y);
            if (e && e.closest('.gs-tile') === tile && !e.closest('button,input,select,.gs-tile-header')) return {x, y};
          }
        return null; }""")
    assert box, "no draggable point found in tile 1"
    import math
    x0, y0 = box["x"], box["y"]
    page.mouse.move(x0, y0)
    page.mouse.down()
    n = int(seconds * hz)
    for i in range(n):
        x = x0 + amplitude_px * math.sin(2 * math.pi * i / (hz * 1.5))
        page.mouse.move(x, y0)
        page.wait_for_timeout(1000 / hz)
    page.mouse.up()


def report_trace(path, nframes):
    import json
    ev = json.load(open(path))
    ev = ev["traceEvents"] if isinstance(ev, dict) else ev
    # renderer main thread = the thread named CrRendererMain in the page's process
    names = {(e["pid"], e["tid"]): e["args"]["name"] for e in ev if e.get("ph") == "M" and e.get("name") == "thread_name"}
    main_threads = {k for k, v in names.items() if v == "CrRendererMain"}
    tot = collections.Counter(); cnt = collections.Counter()
    for e in ev:
        if e.get("ph") == "X" and (e["pid"], e["tid"]) in main_threads:
            tot[e["name"]] += e.get("dur", 0); cnt[e["name"]] += 1
    print("\nChrome main-thread time by activity (ms per frame; includes nesting, so not additive):")
    for n, us in tot.most_common(26):
        if n in ("RunTask", "ThreadControllerImpl::RunTask", "ThreadControllerImpl::DoWork"): continue
        print(f"  {us/1000/max(1,nframes):6.2f}  {n}  (x{cnt[n]})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--span1", type=int, default=120000)
    ap.add_argument("--span2", type=int, default=59000)
    ap.add_argument("--seconds", type=float, default=4.0)
    ap.add_argument("--amp", type=float, default=220)
    ap.add_argument("--profile", action="store_true")
    ap.add_argument("--samples", type=int, default=0, help="N synthetic samples (assembly-like long reads); 0 = the 2-sample hifiasm mock")
    ap.add_argument("--coverage", type=float, default=2.0)
    ap.add_argument("--read-len", type=int, default=80000)
    ap.add_argument("--snp-rate", type=float, default=0.001)
    ap.add_argument("--indel-rate", type=float, default=0.0005)
    ap.add_argument("--tiles", type=int, default=2)
    ap.add_argument("--open", type=int, default=2, help="how many tracks to expand")
    ap.add_argument("--rich", action="store_true", help="genes + 4000 repeats + 400 variants in view")
    ap.add_argument("--dpr", type=float, default=1.0, help="device scale factor (2 = Retina)")
    ap.add_argument("--headed", action="store_true", help="real window, real vsync/compositor")
    ap.add_argument("--uncapped", action="store_true", help="remove Chrome's 60 Hz frame cap: rAF cadence = real frame cost")
    ap.add_argument("--flush-probe", action="store_true", help="bill forced layout separately from each phase (perturbs timings)")
    ap.add_argument("--trace", action="store_true", help="Chrome trace: split main-thread time into style/layout/paint/commit")
    ap.add_argument("--top", type=int, default=22)
    a = ap.parse_args()
    with sync_playwright() as pw:
        br = pw.chromium.launch(channel="chrome", headless=not a.headed, ignore_default_args=["--disable-gpu"],
                                args=ARGS + (["--disable-frame-rate-limit", "--disable-gpu-vsync"] if a.uncapped else []))
        page = open_scene(br, a)
        st = page.evaluate("() => ({tiles: window.__GS_STATE.tiles.map(t => [t.contig, t.startBp, t.endBp, t.endBp - t.startBp]), tracks: window.__GS_STATE.smartTracks.length, gpu: window.__GS_TEST_gpuStats()})")
        print("scene:", st["tiles"], "tracks:", st["tracks"])
        cdp = page.context.new_cdp_session(page)
        cdp.send("HeapProfiler.enable"); cdp.send("HeapProfiler.collectGarbage")
        heap = cdp.send("Runtime.getHeapUsage")["usedSize"] / 1e6
        sc = page.evaluate("""() => { let reads = 0, elems = 0, rows = 0;
            const seen = new Set();
            for (const t of window.__GS_STATE.tiles) for (const tr of window.__GS_STATE.smartTracks) {
              const v = t._readsViews && t._readsViews.get(tr.id); const L = v && v.layout;
              if (!L || seen.has(L)) continue; seen.add(L);
              reads += L.reads.length; for (const r of L.reads) elems += r.elements.length; rows += L.rowCount || 0; }
            return {reads, elems}; }""")
        print(f"SCALE: tracks={a.samples or 'mock'} reads held={sc['reads']:,} elements held={sc['elems']:,} "
              f"JS heap={heap:.0f} MB  load={getattr(a, 'load_s', 0):.1f}s  "
              f"=> {heap*1e6/max(1, sc['reads']):.0f} B/read (incl. everything else)")
        if a.profile:
            cdp.send("Profiler.enable"); cdp.send("Profiler.setSamplingInterval", {"interval": 200}); cdp.send("Profiler.start")
        page.evaluate("() => { window.__GS_TIME_RENDER = true; window.__GS_RENDER_MS = []; }")
        page.evaluate(RECORD_JS)
        trace_path = os.path.join(tempfile.mkdtemp(), "trace.json")
        if a.trace:
            br.start_tracing(page=page, path=trace_path, categories=["devtools.timeline", "disabled-by-default-devtools.timeline", "blink"])
        drag(page, a.seconds, a.amp)
        if a.trace:
            br.stop_tracing()
            report_trace(trace_path, len(page.evaluate("() => window.__REC.frames")))
        page.wait_for_timeout(200)
        rec = page.evaluate("() => { window.__REC.stop = true; return window.__REC; }")
        fr = rec["frames"][2:]
        print(f"frames: {len(fr)}  p50 {pct(fr,.5):.1f}  p95 {pct(fr,.95):.1f}  p99 {pct(fr,.99):.1f}  max {max(fr):.1f} ms")
        print(f">20ms: {sum(f>20 for f in fr)}  >33ms: {sum(f>33 for f in fr)}  >50ms: {sum(f>50 for f in fr)}   longtasks: {len(rec['long'])}  LoAF: {len(rec['loaf'])}")
        rms = page.evaluate("() => window.__GS_RENDER_MS")
        if rms:
            print(f"renderAll (unprofiled, in-page): n={len(rms)}  p50 {pct(rms,.5):.2f}  p95 {pct(rms,.95):.2f}  p99 {pct(rms,.99):.2f}  max {max(rms):.1f} ms   (>8.3 ms: {sum(r > 8.3 for r in rms)})")
        ph = page.evaluate("() => window.__GS_PHASE_MS || {}")
        nr = len(rms) or 1
        if ph:
            print("phase cost per renderAll (ms, inclusive; unprofiled):")
            for k, v in sorted(ph.items(), key=lambda kv: -kv[1]["ms"])[:14]:
                print(f"  {v['ms']/nr:6.2f}  {k}  ({v['n']/nr:.1f} calls/renderAll)")
        worst = sorted(rec["loaf"], key=lambda e: -e["dur"])[:5]
        for e in worst:
            print(f"  LoAF {e['dur']:.0f} ms (blocking {e['block']:.0f}): {e['scripts'][:4]}")
        if a.profile:
            prof = cdp.send("Profiler.stop")["profile"]
            nodes = {n["id"]: n for n in prof["nodes"]}
            selft = collections.Counter(); tot = sum(prof["timeDeltas"])
            for sid, d in zip(prof["samples"], prof["timeDeltas"]):
                cf = nodes[sid]["callFrame"]; selft[(cf["functionName"] or "(anon)", cf["url"].split("/")[-1], cf["lineNumber"] + 1)] += d
            # Main-thread busy bursts: consecutive non-idle samples = one task's worth of
            # work. A burst longer than the frame budget (8.3 ms @120 Hz, 16.7 @60 Hz)
            # is a dropped/late frame on that display even when 60 Hz rAF looks fine.
            bursts, cur = [], 0.0
            for sid, d in zip(prof["samples"], prof["timeDeltas"]):
                name = nodes[sid]["callFrame"]["functionName"]
                if name == "(idle)":
                    if cur > 0: bursts.append(cur)
                    cur = 0.0
                else:
                    cur += d / 1000.0
            if cur > 0: bursts.append(cur)
            big = [b for b in bursts if b >= 1.0]
            print(f"\nmain-thread bursts (>=1 ms): n={len(big)}  p50 {pct(big,.5):.1f}  p95 {pct(big,.95):.1f}  p99 {pct(big,.99):.1f}  max {max(big) if big else 0:.1f} ms")
            print(f"  over 8.3 ms (120 Hz budget): {sum(b > 8.3 for b in big)}   over 16.7 ms (60 Hz): {sum(b > 16.7 for b in big)}")
            # Inclusive time per function (children counted once even if recursive).
            kids = collections.defaultdict(list)
            for n in prof["nodes"]:
                for c in n.get("children", []): kids[n["id"]].append(c)
            own = collections.Counter()
            for sid, d in zip(prof["samples"], prof["timeDeltas"]): own[sid] += d
            incl = collections.Counter()
            def walk(nid, active):
                cf = nodes[nid]["callFrame"]; key = (cf["functionName"] or "(anon)", cf["url"].split("/")[-1], cf["lineNumber"] + 1)
                t = own[nid]
                fresh = key not in active
                if fresh: active = active | {key}
                for c in kids[nid]: t += walk(c, active)
                if fresh: incl[key] += t
                return t
            walk(prof["nodes"][0]["id"], frozenset())
            nfr = max(1, len(fr))
            print("\ninclusive time per frame (ms/frame) — where a frame's work goes:")
            shown = 0
            for (fn, url, ln), us in incl.most_common(80):
                if fn in ("(root)", "(program)", "(idle)", "(anon)", "evaluate", "sleep"): continue
                print(f"  {us/1000/nfr:6.2f}  {fn}  {url}:{ln}")
                shown += 1
                if shown >= 28: break
            print("\ntop self time over the drag:")
            for (fn, url, ln), us in selft.most_common(a.top):
                print(f"  {us/tot*100:5.1f}%  {us/1000:8.1f} ms  {fn}  {url}:{ln}")
        br.close()


if __name__ == "__main__":
    main()
