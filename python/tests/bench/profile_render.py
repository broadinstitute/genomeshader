"""CPU-profile renderAll() for one (tracks, tiles) cell of the render benchmark.

    cd python && ../venv/bin/python tests/bench/profile_render.py --tracks 50 --tiles 2

Prints the top functions by self time (and by inclusive time) so a slow cell can
be attributed to code rather than guessed at.
"""
import argparse, collections, json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_render as b
from playwright.sync_api import sync_playwright


def setup(browser, n_tracks, n_tiles, args):
    # Reuse run_cell's setup by monkey-patching the measuring steps: build the page ourselves.
    import harness
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.add_init_script(b.DEVICE_COUNT_INIT)
    page.add_init_script("try{localStorage.setItem('genomeshader.orientation','horizontal');localStorage.setItem('genomeshader.theme','light');}catch(e){}")
    samples = [f"S{i:03d}" for i in range(n_tracks)]
    cfg = {"region": "chr14:32140000-32160000", "chrom_lengths": {"chr14": 107043718, "chr20": 64444167},
           "viewport_variant_loading": False, "read_samples": samples,
           "read_bam_index": {s: [f"gs://bench/{s}.bam"] for s in samples},
           "sample_mapping": {s: [f"gs://bench/{s}.bam"] for s in samples}}
    path = os.path.join(os.environ.get("TMPDIR", "/tmp"), "gs_prof.html")
    open(path, "w").write(harness.build_page(config=cfg, capture=False))
    page.goto("file://" + path, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=30000)
    page.wait_for_timeout(2000)
    page.evaluate(b.INSTALL_JS, {"coverage": args.coverage, "readLen": args.read_len, "snpRate": args.snp_rate, "indelRate": args.indel_rate})
    page.evaluate("async (ids) => { await Promise.all(ids.map(id => window.__GS_TEST_spawnSample(id, 'best_evidence'))); }", samples)
    page.evaluate("""() => { for (const t of window.__GS_STATE.smartTracks) { t.collapsed=false; t.readDisplay.visibility.reads=true; t.readDisplay.visibility.summary=true; } window.__GS_TEST_renderAll(); }""")
    for i in range(1, n_tiles):
        page.evaluate("""(i) => window.__GS_tiles.add({contig: i % 2 ? 'chr20' : 'chr14', startBp: i % 2 ? 32000000 : 32140000 + i * 30000, endBp: i % 2 ? 32020000 : 32160000 + i * 30000})""", i)
    page.wait_for_function("""() => { const d = window.__GS_TEST_readsRaceDump(); return d.fetchActive === 0 && (d.queuedKeys||[]).length === 0 && !d.schedulerPending; }""", timeout=180000)
    page.wait_for_timeout(800)
    return page


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracks", type=int, default=50); ap.add_argument("--tiles", type=int, default=2)
    ap.add_argument("--repeat", type=int, default=3); ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--coverage", type=float, default=30.0); ap.add_argument("--read-len", type=int, default=12000)
    ap.add_argument("--snp-rate", type=float, default=0.002); ap.add_argument("--indel-rate", type=float, default=0.002)
    a = ap.parse_args()
    with sync_playwright() as pw:
        br = pw.chromium.launch(channel="chrome", headless=True, ignore_default_args=["--disable-gpu"], args=b.CHROME_ARGS)
        page = setup(br, a.tracks, a.tiles, a)
        cdp = page.context.new_cdp_session(page)
        cdp.send("Profiler.enable"); cdp.send("Profiler.setSamplingInterval", {"interval": 200})
        cdp.send("Profiler.start")
        t0 = time.time()
        page.evaluate("(n) => { for (let i = 0; i < n; i++) window.__GS_TEST_renderAll(); }", a.repeat)
        wall = time.time() - t0
        prof = cdp.send("Profiler.stop")["profile"]
        nodes = {n["id"]: n for n in prof["nodes"]}
        dt = prof["timeDeltas"]; samples = prof["samples"]
        selft = collections.Counter(); total_us = sum(dt)
        for sid, d in zip(samples, dt):
            cf = nodes[sid]["callFrame"]
            selft[(cf["functionName"] or "(anon)", cf["url"].split("/")[-1], cf["lineNumber"] + 1)] += d
        print(f"{a.tracks} tracks x {a.tiles} tiles: {wall / a.repeat * 1000:.0f} ms per renderAll  (profiled {total_us/1000:.0f} ms)")
        print("\nTop self time:")
        for (fn, url, ln), us in selft.most_common(a.top):
            print(f"  {us/total_us*100:5.1f}%  {us/1000/a.repeat:8.1f} ms  {fn}  {url}:{ln}")
        br.close()

if __name__ == "__main__":
    main()
