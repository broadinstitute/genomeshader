# Rendering architecture: WebGPU-only, one shared device

Written 2026-09-20 (Claude Code), after the multi-locus tiles work.

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
| **SVG** (bounded chrome) | ruler ticks and labels, gene names, reference-base letters, cross-tile ribbons and handles |

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

## The paint signature (and how it is verified)

`gsSmartPaintKey` lists every input to a smart-track paint (tile window / size /
orientation, layout identity, display config, collapse + loading state, scroll
offset, expanded insertions, cross-tile bundle colours, and — only for tracks with
split reads — every tile's window and the focused tile). Equal key ⇒ the canvases
are left as painted. A forgotten input would be a stale-pixels bug, so:

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
- Render benchmark + profiler: `python/tests/bench/`.

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
