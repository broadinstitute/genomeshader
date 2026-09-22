# Rendering architecture: WebGPU-only, one shared device

Written 2026-09-20 (Claude Code), after the multi-locus tiles work.

**Update 2026-09-22:** the cross-tile aggregate-ribbon feature (`tile-arcs.js`
— bundle clustering, gutter SVG ribbons, per-read bundle-color tinting, and
the "unconfirmed orientation" suggestion banner it drove) was removed at the
user's request as an unwanted complication. Tile orientation is now always a
definite 5′→3′/3′→5′ choice (`tile.reversed`), never a suggested/unconfirmed
third state. Mentions of "bundles"/"ribbons"/"orientation suggestions" below
are historical (describing the code as it stood when each section was
written) except where already corrected inline.

## Decision

Genomeshader **requires WebGPU**. There is no Canvas2D/SVG fallback for data;
without WebGPU the viewer shows "GenomeShader needs WebGPU" (`gsShowWebGpuRequired`,
`ui-state.js`) and does nothing else. The audience is modern hardware and
scientific users, the target load is ~12k datasets with 20–50 samples open at a
time, and single- and multi-tile columns must paint through the same code.

Which layer draws what:

| Layer | Draws |
| --- | --- |
| **WebGPU** (anything that scales with data) | read bodies, CIGAR marks, soft-clip / SA-flag markers, strand arrows, reference-base blocks, genes / repeats / data-track marks, variant nodes, flow ribbons |
| **Canvas2D** (text and small counts) | SNP letters, "Loading…" text, grid lines, depth heatmap, node strokes, hover / selection overlays |
| **SVG** (bounded chrome) | ruler ticks and labels, gene names, reference-base letters, tile resize handles |

## How it is built

- **`webgpu-core.js`** — `GpuShared`: one adapter + `GPUDevice` + the compiled
  pipelines (`rect`, `triangle`, `line`, `bezier`) per *page* (stored on
  `window.__genomeshaderGpu`, so several viewers in one notebook share it). It
  recovers from device loss (canvases re-configure, listeners repaint).
  `WebGPUCore` is now only a per-canvas context + projection uniform.
- **`webgpu-renderer.js`** — `InstancedRenderer` stages primitives into growable
  `Float32Array`s (no per-primitive objects), uploads one buffer per kind and
  caches bind groups. `gsFlushGpuCanvas(core, renderer, canvas, ribbons)` presents
  any canvas. `GS_NULL_RENDERER` is bound until the device exists, so the very
  first paint never needs an "is the GPU up" guard.
- **Per-tile canvases** — every tile owns tracks + flow canvases and one GPU canvas
  per smart track. `gsCanvasGpu(canvas)` (in `ui-state.js`) gives each canvas its
  GPU record and `gsBindTileGpu()` re-points `webgpuCore` / `instancedRenderer` /
  `flow*` at the bound tile, exactly as `gsBindTileDom` re-points the DOM
  aliases. Closing a tile disposes its canvases.
- **`smart-tracks.js`** `initSmartTrackWebGPU` awaits the shared device (no more
  "created before init finished, so it fell back to 2D for the rest of the
  session" race).

## Where the time actually went

The original concern was Canvas2D vs WebGPU. Profiling
(`python/tests/bench/profile_render.py`, Chrome CPU profiler) showed the draw API
was <1% of a repaint. At 50 tracks × 2 tiles, **~70% was `_mergeReadPayloads` +
`gsAssembleChunks`**: the assembled-reads memo was an LRU capped at 64 entries, and
50+ (track, tile) views overflow it, so every paint evicted what the next paint
needed and re-merged every chunk. That is the >1 s cliff at ≥~75 track-tile pairs
(present on GPU and 2D alike). Fixes, in order of impact:

1. `reads-cache.js`: a view reuses its chunk objects (chunks are immutable), and the
   memo is sized to tracks × tiles.
2. `view-state.js`: `getTotalExpandedInsertionGapBp` / `getAccumulatedGapBp` /
   `getGapAfterBpPx` return immediately when no insertion is expanded (they were
   scanning every insertion once per painted coordinate).
3. `main.js` `gsTrackCulled`: smart tracks outside the scroll viewport (± half a
   screen) are not painted; a capturing scroll/resize listener repaints them as
   they approach.
4. `main.js` `gsSmartPaintKey`: a (tile, track) whose inputs are unchanged is not
   repainted (see below).
5. One device / pipeline set instead of one per canvas (52 devices → 1 at 50 tracks).

### Benchmark (`python/tests/bench/bench_render.py`)

Median main-thread ms for one `renderAll()` during a sustained pan; synthetic
long reads, 30× coverage, 12 kb reads, 0.2% SNPs + 0.2% indels (~50 elements per
read), 1600×1000 viewport, Chrome/Metal on the dev Mac.

| tracks × tiles | before | after |
| --- | --- | --- |
| 1 × 1 | 5.0 | 4.1 |
| 10 × 1 | 26.3 | 7.6 |
| 25 × 1 | 57.7 | 9.8 |
| 50 × 1 | 113.8 | 13.7 |
| 10 × 2 | 59.2 | 9.2 |
| 25 × 2 | 143.7 | 14.2 |
| 50 × 2 | 1848.8 | 21.8 |
| 10 × 3 | 86.9 | 11.2 |
| 25 × 3 | 1121.7 | 18.3 |
| 50 × 3 | did not finish loading (120 s timeout) | 29.8 |

An unchanged repaint ("idle") is now 2.6 ms at 1×1 and 24 ms at 50×3.
"Before" is a clean `git archive` of the feature/tiles HEAD. These are main-thread
CPU numbers; GPU time is not measured.

## Panning: what a frame costs (real-drag benchmark)

`renderAll` benchmarks with a synthetic pan hid a fixed per-frame cost that is
invisible at 60 Hz in headless Chrome but is the "not butter smooth" feel on a
120 Hz display (8.3 ms budget). `python/tests/bench/pan_bench.py` drives a REAL
mouse drag (pointer -> `panByPixels` -> `scheduleRender` -> `renderAll`) in a scene
like a hifiasm session — 2 tiles at ~120 kb and ~59 kb, genes + 4000 repeats +
400 variants in view, dpr 2 — and reports the in-page, unprofiled `renderAll` time
(`--samples N` scales the track count; `--uncapped` removes Chrome's 60 Hz cap so
rAF cadence is the real frame cost; `--profile`, `--trace`, `--flush-probe` for
attribution). Note the CPU profiler inflates absolute times and attributes native
getters (`clientHeight`) to the caller; trust the in-page timers.

Median `renderAll` ms during the drag:

| tracks | before | after |
| --- | --- | --- |
| 3 | 7.3 | 4.6 |
| 10 | 9.4 | 6.5 |
| 25 | 13.4 | 7.3 |
| 50 | 19.6 | 8.2 |

What it was: (1) `xGenome()` -> `tracksWidthPx()` -> `getBoundingClientRect()` per
coordinate (thousands of repeats/exons per frame), each a forced layout; widths are
now cached for one `renderAll` pass (`gsMeasureBegin/End`, invalidated by
`updateTracksHeight` / `positionSmartScrollWrapper`). (2) `renderTrackControls`
rebuilt every pill's DOM every frame and dirtied layout for everything after it
(~7.5 ms/frame of forced layout at 50 tracks); it now keeps the pills when
`gsTrackControlsKey()` is unchanged (verified: `GS_VERIFY_PAINT` rebuilds and
compares `innerHTML`). (3) Culled tracks still paid style writes + rect reads;
`gsTrackCulledFast` exits before any DOM work (conservative: it can only say
"culled" when the exact test would). (4) Bundle building scanned every read of every
track; `gsLayoutMayLink` skips tracks with no SA / off-locus-mate reads.

Remaining per frame (3 tracks): ruler/genes/repeats SVG+GPU (~2 ms for two tiles),
smart-track paint (~1 ms), bundles/arcs/chrome. The unfocused tile is still fully
repainted on every pan frame; skipping its window-independent work is the next
cheap win. The cost that remains is re-emitting geometry from JS, which only
GPU-resident geometry removes.

## Scale: millions of reads (Stage 1 done, Stages 2-4 planned)

Target: 20-50 samples of deep short-read data (~1M+ reads / ~2M+ CIGAR elements
loaded). `pan_bench.py --samples N --coverage 30 --read-len 150 --snp-rate 0.01
--indel-rate 0.001 --tiles 1 --open 2 --span1 120000 --dpr 2 --uncapped` builds
that (synthetic mock kernel) and reports reads held, JS heap, load time and the
in-page `renderAll` cost during a real drag.

Baseline (before Stage 1), 1 tile, 2 tracks expanded, others collapsed:

| samples | reads held | JS heap | pan `renderAll` | worst stall |
| --- | --- | --- | --- | --- |
| 1 | 62k | 54 MB | 24 ms | 7.4 s |
| 5 | 311k | 255 MB | 99 ms | 8.6 s |
| 10 | 622k | 506 MB | 181 ms | 17 s |

Why: reads are JS objects (~25 fields each) with a sub-object per CIGAR element,
~820 B of heap per read; row packing rescanned every row per read and re-sorted the
row on every insert (quadratic: the multi-second stalls); the collapsed-track
summary strip made one pass over every read per frame (several times) and emitted
one marker rect per CIGAR element per frame. GPU drawing was <1 ms of it.

Stage 1 (this change; same visuals, same first-fit row assignment):

- `processReadsData`: first-fit packing with binary search over per-row sorted
  starts/ends, no re-sort per insert; each layout keeps `rowReads[row]`.
- `gsWindowReads` / `gsRowReadsInWindow` (smart-tracks.js): the painter touches only
  the visible rows' reads overlapping the window (binary search on a start-sorted
  index with running-max ends), not every read the layout holds.
- Summary strip is O(pixels) per frame: per-layout precomputed typed-array events
  (`gsSummaryEvents`) folded into pixel columns (LOD; translucent kinds combine as
  `1 - prod(1 - a_i)`), per-layout overlap counts (`gsOverlapMap`), soft-clip edge
  reads (`_clipEdges`), and per-haplotype span/presence queries in O(log n)
  (`gsSpanExtents`, `gsHapPresent`). `gsMakeXMapper` binds the bp->x mapping once
  per paint.

| samples | reads held | JS heap | pan `renderAll` | worst stall |
| --- | --- | --- | --- | --- |
| 1 | 62k | 55 MB | 12 ms | 0.1 s |
| 5 | 311k | 258 MB | 17 ms | 0.5 s |
| 10 | 622k | 512 MB | 20 ms | 1.1 s |
| 20 | 1.24M | 1.05 GB | 22 ms | 2.2 s |

Steady-state pan cost is now nearly flat in the number of collapsed tracks (the
remainder is the two expanded tracks). What remains, and why the later stages exist:

- **Stalls when a chunk arrives** (0.5-2 s): a new chunk set re-merges payloads and
  re-runs `processReadsData` for hundreds of thousands of reads on the main thread.
- **Memory / load**: ~840 B per read as JS objects; 40 samples (2.5M reads) did not
  finish loading in the benchmark's 60 s. JSON payloads are also parsed on the main
  thread.
- The two expanded tracks still emit per-read/per-element rects from JS each frame.

Planned: **Stage 2** columnar typed-array layouts (no per-read objects; CSR for
elements) + incremental layout of a new chunk; **Stage 3** GPU-resident geometry for
the core horizontal modes (reads/elements uploaded once in genomic coordinates, view
transform in the vertex shader, pan = uniform update; pairs/splice/vertical stay on
the current painter until ported); **Stage 4** binary transfer from Python instead
of JSON. Tests: `test_summary_lod.py` pins what the strip draws.

## Stages 2-4 (done overnight 2026-09-21) and what the data says about the rest

**Reference bases (a real bug, separate from the perf work).** The reference was one
string per contig replaced by each viewport response, and the loader requested only
view +/- 50% (~100 bp at base zoom), so a small move left the bases uncovered until a
kernel round trip finished. Now: per-contig reference *segments* (`gsAddReferenceSegment`
/ `gsReferenceFor`, merged, bounded; two tiles on one contig each get theirs), `data_bounds`
stored per contig, jumps snapshotted per contig, and viewport loads request >= 4 kb.
(`test_tile_reference.py`; the same-contig and slow-kernel tests fail on the prior commit.)

**Stage 2a - time-sliced layout (done).** Merging chunk payloads and laying out a large
read set ran in the frame a chunk arrived. Now `processReadsData` and the merge are
generators run by a small job scheduler (`gsSubmitJob`, ~6 ms slices, most-recently-wanted
first); the tile keeps painting its previous layout ("stale") until the job finishes.
Inputs <= 20000 rows stay synchronous. Worst frame during a real drag:

| samples | before | after |
| --- | --- | --- |
| 5 (311k reads) | 570 ms | 35 ms |
| 10 (622k reads) | 1170 ms | 37 ms |

**Stage 4 - binary transport (done, OFF by default).** `reads_codec.py` +
`gsDecodeReadsBinary`; enable with `GENOMESHADER_READS_BINARY=1`. Negotiated per request,
exact-or-JSON per chunk, self-healing (a decode failure retries as JSON and disables it for
the session). I expected JSON parsing to be a large browser-side stall; measured, it is
not: `JSON.parse` of a 120k-row / 14 MB chunk is 18 ms vs 12.6 ms for the binary decode
(kernel-side the encode is ~50 ms vs 30 ms for `json.dumps`); wire size is ~25% smaller.
A modest win, and unverified against a live kernel/frontend, hence opt-in.

**Stage 2b - columnar, object-free layouts (NOT done).** ~900 B of JS heap per read =
read object (~25 fields, ~220 B) + element objects (~70 B) + raw column arrays (~300 B) + a
merged copy of the columns (~300 B) + names. 50 deep short-read samples over 120 kb would be
~3M reads / ~2.7 GB, near a tab's ceiling. Real fix: typed-array columns end to end (CSR for
elements), read objects materialised lazily for the reads actually drawn/hovered, and the
merge fused into layout so no merged copy exists. That touches every consumer of
`layout.reads` (painter, hover, selection, read-display sorting/grouping), so it
needs its own careful pass with the paint verifier on.

**Stage 3 - GPU-resident geometry (NOT done, on evidence).** Profiling the heavy case (10
samples, 2 expanded, 30x short reads, 120 kb) shows a ~20 ms frame whose top self-time is
the JS painting of the two *expanded* tracks (coordinate mapping + per-read/element loops)
and the summary strips (~0.3 ms each). GPU-resident geometry would remove those, i.e. at
most ~20-30% of that frame and ~0% of the light case (3 tracks, 2 tiles: 4.6 ms, which is
DOM/annotations, not reads). It is the right endgame for far deeper expanded views, but it
is a large rewrite of the painter's core modes with real visual-parity risk, and the
measured walls at these scales were the stalls (fixed) and memory (Stage 2b). I would do
2b first.

## The paint signature (and how it is verified)

`gsSmartPaintKey` lists every input to a smart-track paint (tile window / size /
orientation, layout identity, display config, collapse + loading state, scroll
offset, expanded insertions, and — only for tracks with split reads — every
tile's window and the focused tile, for the cross-tile split-read flag). Equal
key ⇒ the canvases are left as painted. A forgotten input would be a
stale-pixels bug, so:

```bash
GS_VERIFY_PAINT=1 pytest python/tests/headless -q
```

repaints on every hit and fails the test with `PAINT_KEY_MISS` if the pixels
changed (premultiplied tolerance 4). It has already caught one real input
(`state.focusedTileId`, used by the SA-mate flag lookup). Run it after touching
anything `renderSmartTrack` reads.

## Tests

- The whole headless suite runs in real Chrome with WebGPU (`conftest.py`); GPU
  canvases are read back through a shadow copy taken at presentation
  (`window.__GS_TEST_CAPTURE`). See `README.md` → Headless UI tests.
- `test_gpu_shared.py` guards: one `GPUDevice` and four pipelines for any number of
  canvases; every tile's tracks on the GPU; two tiles on the same locus emit
  identical primitives; closing a tile releases its canvases; recovery after the
  device is replaced; the "needs WebGPU" message.
- `test_render_skips.py`: off-screen tracks are not painted (paint signature
  unchanged on pan) and paint when scrolled into view; unchanged control pills are
  kept and a real change rebuilds them.
- Render benchmark, real-drag pan benchmark + profiler: `python/tests/bench/`.

## Not done / next

- Reference-base **letters** and the tile ruler are still SVG DOM rebuilt per
  repaint; move the letters to a Canvas2D text overlay.
- **GPU-resident geometry**: upload each layout's elements once in genomic
  coordinates and let the vertex shader apply the view transform, so a pan is a
  uniform update instead of re-emitting every rect from JS. This is the endgame for
  millions of elements; today JS still builds ~50 instances per read per paint of a
  visible track.
- LOD for sub-pixel mismatches at coarse zoom.
- Data fetch is still demand-driven for *all* tracks; only painting is culled.
- Untested here: a live JupyterLab kernel; software-WebGPU (`GS_WEBGPU_SOFTWARE=1`)
  on a Linux CI runner; a *real* GPU device loss (the test simulates the
  post-loss state and runs the real recovery path).
- Repeat-feature hover tooltips resolve only in the focused tile (hover-to-focus
  moves it); with focus-follows-mouse off, unfocused tiles show no repeat tooltip.
