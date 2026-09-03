"""#78 MEASURE-FIRST: does splitting a window across N cores speed first-visit?

First-visit to a fresh window is read-bound: htslib decompresses the bgzf
blocks in range and parses the text-VCF lines (~500KB/record at 20k samples).
#77 showed a revisit is ~free from the host LRU cache; this asks whether the
*first* visit can be shortened by decoding N disjoint sub-windows in parallel
on the detected cores (2-4 on target machines), then unioning.

We model the parallel decode with PROCESSES, not threads: a production impl
would use rayon inside one PyO3 call (releasing the GIL), and independent
processes upper-bound that (result aggregate DataFrames are KB, so IPC is
cheap). Each worker opens its OWN session -> this also pays the real
N-reader-open cost (N tabix loads, N seeks; remotely N TLS + N .tbi fetches).

Split is [start,mid] / [mid+1,stop]: disjoint, half-open by POS, so the union
of sub-window aggregates is bit-identical to the single full-window decode
(the per-variant tally is window-independent). We ASSERT that equality so a
"faster" number is never a wrong number.

Usage:
    python scripts/bench_parallel_decode.py                      # local mito
    python scripts/bench_parallel_decode.py <vcf_or_url> <contig> <start> <stop>
"""
import os, sys, time, hashlib
from concurrent.futures import ProcessPoolExecutor

import genomeshader.genomeshader as gs

# --- config -----------------------------------------------------------------
D = "/workspace/fiss_downloads"
DEFAULT_VCF = f"{D}/Pf_M76611.pf7.vcf.gz"
DEFAULT_CONTIG = "Pf_M76611"
DEFAULT_START, DEFAULT_STOP = 1, 6000  # whole mito: 1954 variants x 20864 samples

VCF = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_VCF
CONTIG = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_CONTIG
START = int(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_START
STOP = int(sys.argv[4]) if len(sys.argv) > 4 else DEFAULT_STOP
TBI = VCF + ".tbi"  # local path or remote URL; htslib range-fetches a URL .tbi

CORES = os.cpu_count() or 1
N_SET = [n for n in (1, 2, 4) if n <= max(1, CORES)]


def _split(start, stop, n):
    """n disjoint half-open-by-POS sub-windows covering [start,stop]."""
    edges = [start + (stop - start + 1) * i // n for i in range(n + 1)]
    return [(edges[i], edges[i + 1] - 1) for i in range(n)]


def _decode_one(args):
    """Worker: fresh session (pays reader-open cost), decode one sub-window.
    Returns (rows, open_s, decode_s). rows are plain dicts for cheap IPC."""
    vcf, tbi, contig, a, b = args
    t0 = time.time()
    sess = gs._init(None)
    sess.attach_variants([vcf], [tbi] if tbi else None, None)
    t_open = time.time() - t0
    t1 = time.time()
    agg = sess.get_locus_variant_aggregates(f"{contig}:{a}-{b}")
    t_dec = time.time() - t1
    rows = agg.to_dicts() if hasattr(agg, "to_dicts") else list(agg.iter_rows(named=True))
    return rows, t_open, t_dec


def _fingerprint(rows):
    """Order-independent hash of the aggregate tally, so N-way == 1-way is
    provable regardless of row order across the union."""
    keyed = sorted(
        (r["position"], r["ref_allele"], r["alt_allele"],
         r["n_ref"], r["n_alt"], r["n_missing"], r["n_samples"])
        for r in rows
    )
    return hashlib.sha256(repr(keyed).encode()).hexdigest()[:16], len(keyed)


def run(n):
    """Decode the window as n parallel sub-windows. Wall = the real elapsed
    (max worker + merge), which is what a user waits."""
    wins = _split(START, STOP, n)
    tasks = [(VCF, TBI, CONTIG, a, b) for (a, b) in wins]
    t0 = time.time()
    if n == 1:
        results = [_decode_one(tasks[0])]
    else:
        with ProcessPoolExecutor(max_workers=n) as ex:
            results = list(ex.map(_decode_one, tasks))
    wall = time.time() - t0
    rows = [r for rr, _, _ in results for r in rr]
    opens = [o for _, o, _ in results]
    decs = [d for _, _, d in results]
    fp, nv = _fingerprint(rows)
    print(f"  N={n}: wall={wall*1000:8.1f} ms  "
          f"open[max]={max(opens)*1000:7.1f} ms  decode[max]={max(decs)*1000:8.1f} ms  "
          f"variants={nv:5d}  fp={fp}")
    return wall, fp, nv


def main():
    print(f"host cores={CORES} (target machines assume 2-4); N set={N_SET}")
    print(f"window {CONTIG}:{START}-{STOP}  vcf={VCF}")
    print("=== parallel first-visit decode (each N is a COLD decode) ===")
    base_wall, base_fp = None, None
    for n in N_SET:
        wall, fp, _ = run(n)
        if base_wall is None:
            base_wall, base_fp = wall, fp
        else:
            assert fp == base_fp, (
                f"N={n} aggregate fingerprint {fp} != N=1 {base_fp} -- "
                f"split is NOT bit-exact, parallel decode would corrupt counts")
            print(f"       speedup vs N=1: {base_wall/wall:4.2f}x  "
                  f"(ideal {n}x; efficiency {100*base_wall/wall/n:4.0f}%)")
    print("=== verdict ===")
    print("  bit-exact across all N (asserted). Read speedup above tells go/no-go:")
    print("  local ~Nx => decode is CPU-parallelizable; then test remote where")
    print("  N reader-opens = N TLS + N .tbi fetches may eat the gain.")


if __name__ == "__main__":
    main()
