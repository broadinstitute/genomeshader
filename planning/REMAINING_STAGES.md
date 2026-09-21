# Remaining scale/perf work: what I need to continue

Written 2026-09-21 (Claude Code), to be picked up after review. Read
`planning/RENDERING_ARCHITECTURE.md` first; this file is the plan for what is left and
exactly what I need from you to do it well.

## Where things stand

On `feature/tiles` (pushed, `d4f71a4`):

| Done | Effect |
| --- | --- |
| WebGPU required, one shared device, all tiles on the GPU | single/multi-tile paint identically |
| Stage 1: linear row packing, indexed painting, O(pixels) summary strip | 10 samples x 30x short reads: pan frame 181 -> 20 ms |
| Stage 2a: time-sliced merge + layout jobs | worst frame while panning 0.5-1.2 s -> ~35 ms |
| Reference fixes: per-contig segments, per-contig bounds, >= 4 kb viewport windows | bases survive small moves, and two tiles on one contig both keep theirs |
| Stage 4: opt-in binary reads transport | modest win, **off by default, never run against a live kernel** |

Measured limits today (synthetic, 30x short reads, 120 kb, 1 tile): 20 samples = 1.24M
reads = 1.05 GB JS heap, 22 ms per pan frame. 40 samples did not finish loading in the
benchmark's 60 s. Light case (3 tracks, 2 tiles, genes/repeats/variants): 4.6 ms.

## What is left, in the order I would do it

### 1. Stage 2b - columnar, object-free layouts (memory)  [recommended next]

**Why:** heap is ~900 B per read. Composition: read object (~25 fields) ~220 B, element
objects ~70 B, raw column arrays ~300 B, a second merged copy of the columns ~300 B,
strings. 50 deep short-read samples over 120 kb would be ~3M reads, ~2.7 GB: at the edge
of what a tab survives. It is also the remaining load-time wall.

**Design:** typed-array columns end to end (start/end Int32, flags, row, CSR offsets for
elements); read objects materialised lazily only for reads actually drawn/hovered/selected
(small LRU); the chunk merge fused into layout so no merged copy exists; layout keeps the
sorted/indexed structures Stage 1 already introduced (`rowReads`, `gsLayoutIndex`,
`gsHapIndex`, `gsSummaryEvents`). Target: <= ~300 B/read, no per-read allocation on the
paint path.

**Risk:** every consumer of `layout.reads` (painter, hover/selection, tile bundles, read
display sort/group/shade, pair/split display, tests that inspect `readsLayout`) changes
shape. I would keep a compatibility facade first, migrate hot paths, and gate every step
with `GS_VERIFY_PAINT=1` plus a new "columnar layout == object layout" equivalence test
(same approach as `test_merge_payloads.py` / `test_async_layout.py`).

**What I need from you:**
- A go/no-go on the facade approach (slower to finish, far safer) vs a hard cut-over.
- The real memory ceiling to design for: how many samples x what depth x what window do you
  actually expect at the high end? (I have been assuming 50 deep short-read samples over
  ~120 kb; the truth may be far lighter or heavier, and it decides how aggressive to be.)
- Confirmation that read hover/selection/tooltips and the read-display options (color/
  shade/group/sort, pairs, split reads, soft-clip modes) all must keep working in the first
  cut, or a ranking of which may lag.

**Done when:** `pan_bench.py --samples 20 ...` (command below) holds <= ~350 MB heap and
does not regress pan/stall numbers; the paint verifier and full headless suite are green;
the equivalence test passes on random layouts.

### 2. Stage 3 - GPU-resident geometry  [only if profiling still justifies it]

**Why it is second, not first:** in the heavy case the JS painting of expanded tracks +
summary strips is ~20-30% of a ~20 ms frame, and ~0% of the light case (which is DOM and
annotations). It only pays off with many *expanded* deep tracks visible at once.

**Design:** upload each layout's reads/elements once in genomic coordinates (Int32 offsets
from a per-layout origin, so f32 precision is not a problem at 1e8 coordinates); vertex
shader applies the view transform (start, px/bp, row, scroll); a pan becomes a uniform
update; `drawMarkerRect`-style JS emission goes away for core horizontal modes
(bodies, SNP/indel/clip markers, colorBy/shadeBy, groupBy/sort, collapsed summary +
coverage). Pairs/splice/vertical stay on the current painter until ported.

**What I need from you:**
- Which visual details must be pixel-stable? (Rounded capsule corners vs axis-aligned
  rects; sub-pixel SNP tick snapping I already introduced in the summary strip; strand
  arrows; the letter overlay.) I will otherwise treat "same look at normal zoom" as the bar.
- A real "many expanded deep tracks" scenario from your work, so I can tell whether this is
  worth doing at all. Screenshots plus track count, zoom, and data type are enough.

**Done when:** the heavy benchmark with `--open 10` drops well below the current ~28 ms, a
paint-diff test shows parity on a fixture set, and the WebGPU pixel suite has no new
failures beyond its 10 pre-existing ones.

### 3. Smaller items (each independent, ~hours)

- **Skip the unfocused tile on pure pan frames.** Halves multi-tile pan cost. Cross-tile
  dependencies (SA-mate flags, bundle colors) are already in the paint key; needs a
  `renderPan()` path. Verified the same way (`GS_VERIFY_PAINT`).
- **Reference letters and tile ruler are still SVG DOM rebuilt each repaint.** Move to a
  Canvas2D text overlay.
- **Letters in collapsed summary strips at high zoom** (draw the base when a column is
  >= 8 px wide, same rule as expanded reads). New behaviour, not a restoration; you said you
  were unsure - tell me yes/no.
- **Genes/repeats are only refreshed on jumps, not pans** (server design: they are slow and
  kept off the pan path), so a tile opened by "linked tile" shows empty gene/repeat rows.
  Options: fetch them lazily per tile once, or on idle. Needs your call on latency vs
  freshness.
- **Per-contig staleness elsewhere:** `ideogram_data` and `insertion_variants_lookup` are
  still global. I have not seen them misbehave; say so if you do.
- **Repeat-feature hover tooltips** resolve only in the focused tile.

### 4. Binary transport: validate live, then decide the default

`GENOMESHADER_READS_BINARY=1` enables it. I could not run it against a real
kernel/frontend, and measurement says the win is modest (25% smaller; 12.6 ms vs 18 ms to
decode a 120k-row chunk). **I need:** you (or CI) to run one real session with it on in
each host you care about (JupyterLab in Chrome at minimum; VS Code / Colab / Terra if they
matter) and tell me whether reads still load. Then decide whether it stays opt-in. If we
want the bigger kernel-side win, the real fix is Rust returning numpy buffers directly
instead of polars -> Python lists -> encode; that needs your OK to change the extractor
(`src/alignment.rs`) and a `maturin` rebuild on your side.

## Cross-cutting things I need

1. **Representative real data**, not just my synthetic mock: one notebook cell (or a
   sanitized description) that reproduces your heaviest realistic session - sample count,
   data types (HiFi contigs vs short reads vs ONT), zoom levels, tiles, which tracks open.
   My benchmarks are only as good as their match to this.
2. **Target hardware/browsers:** I have been measuring on this Mac (Chrome, Metal, dpr 2,
   and 120 Hz as the frame budget: 8.3 ms). Confirm that is the target and whether
   Safari/Edge/Firefox and non-Mac GPUs must be supported (WebGPU is required either way).
3. **Hosts:** which notebook hosts must work (JupyterLab only, or VS Code / Colab / Terra),
   since the transport and worker/blob-URL choices depend on it.
4. **CI:** `ci.yml` now runs the headless suite on real Chrome with SwiftShader
   (`GS_WEBGPU_SOFTWARE=1`). That has never run on a Linux runner. Someone should merge a
   PR and confirm it goes green (or tell me the runner constraints).
5. **Review feedback** on the calls I made without asking (listed below).

## Decisions I made that you should review

- **LOD in the summary strip:** sub-pixel markers now snap to pixel columns; opaque SNP
  ticks keep the last base in a column. Visible only in dense views.
- **Time-sliced layout:** inputs > 20,000 rows (`GS_SYNC_MAX_ROWS`) are laid out in ~6 ms
  slices (`GS_JOB_SLICE_MS`); the track dims ("stale") or shows "Loading..." while a job
  runs. Small inputs stay synchronous. Are the dim and the thresholds right?
- **Viewport loads request >= 4 kb** (`GS_VP_MIN_WINDOW_BP`) even when zoomed to base level.
- **Reference memory cap** 4M characters per contig (`GS_REF_MAX_CHARS_PER_CONTIG`),
  evicting least-recently-added segments no open tile shows.
- **Paint-signature skipping** (`gsSmartPaintKey`, `gsTrackControlsKey`): correct only if
  the key covers every input; `GS_VERIFY_PAINT=1` is the safety net. Should it run in CI?
- **Tests now need real Chrome** (`python -m playwright install chrome`), via
  `python/tests/headless/conftest.py`.

## How I will measure and verify

```bash
# scale + pan smoothness (real mouse drag, unprofiled in-page timers)
cd python && ../venv/bin/python tests/bench/pan_bench.py --samples 10 --coverage 30 \
  --read-len 150 --snp-rate 0.01 --indel-rate 0.001 --tiles 1 --open 2 --span1 120000 \
  --dpr 2 --uncapped               # add --profile / --trace / --flush-probe to attribute
# repaint cost grid, and the full suite (also under the paint verifier)
../venv/bin/python tests/bench/bench_render.py --tracks 1 10 25 50 --tiles 1 2 3
../venv/bin/python -m pytest tests/headless -q
GS_VERIFY_PAINT=1 ../venv/bin/python -m pytest tests/headless -q
```

Headline numbers to protect: worst frame while panning <= ~40 ms; pan `renderAll` at 10
samples <= ~20 ms; light case <= ~5 ms.

## Known gaps and honest uncertainties

- Nothing here has been exercised against a real Jupyter kernel with the opt-in binary path,
  or on a Linux CI runner.
- The benchmark reads come from an in-page mock; real kernels add Python/Rust time, network,
  and JupyterLab message handling that my numbers do not include.
- Pre-existing failures I did not touch: two `test_sidebar_title_bar.py` tests,
  `test_symbol_isolation.py`, and `tests/test_widget.py::test_credential_refresh_publishes_token`
  (needs real gcloud credentials; on failure it prints a live access token into the test
  output - worth fixing or skipping).
- The old real-GPU pixel suite (`test_webgpu_pixels.py`) fails 10 tests on the pre-work
  commit as well; I compared failing sets, not absolute pass counts.
