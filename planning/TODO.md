# genomeshader — TODO / deferred work

## UCSC signal tracks (bigWig/wig) — deferred

The UCSC Tracks tab currently supports **interval** tracks only (BED/bigBed/
genePred rendered as boxes). **Signal** tracks — a continuous value along the
genome (conservation phyloP/phastCons, GC%, mappability, ENCODE pileups) — are
not yet supported because they need a new renderer.

What's needed:
- **Data path:** generalize the UCSC fetch to return value-spans
  (`[{start, end, value}]`) for wig/bigWig tracks, in addition to the interval
  path. The UCSC REST API returns these per-region.
- **Renderer (new track type):** map `value → y-height` (or `value → color` for
  a heatmap row); draw a line/filled-area (or heatmap) instead of boxes.
- **Binning/downsampling:** at zoomed-out views there are many values per pixel
  column — aggregate (mean/min/max per column), or request pre-binned data.
- **Value scale:** a small y-axis / range gutter so heights are interpretable;
  decide auto-scale vs fixed range.

Suggested MVP: one signal track (e.g. phyloP conservation) as a filled area with
auto-scaled height, binned to one value per pixel column.

## Codon track (next to the reference) — deferred

A translation row beside the reference track.
- **MVP (frontend-only):** single selectable reading frame (default 0); group
  the visible reference sequence into codons, translate via a codon table, draw
  the amino-acid letter centered over each codon; shown only at base-level zoom.
  Reuses the reference track's coordinate mapping.
- **Phase 2 (CDS-aware):** translate only coding regions in the true frame +
  strand. Requires retaining CDS intervals + phase through `parse_gff_genes`
  (currently dropped when exons are merged into the union).

## UCSC contig-name normalization — nice-to-have

UCSC track fetches key on the contig name matching the chosen assembly's (e.g.
`chr1`). If the loaded data's contig names differ (`1` vs `chr1`, or PlasmoDB
names against hg38), the fetch returns nothing. Add contig-name normalization
(strip/add `chr`, alias map) if this bites.

## UI / infra — deferred

Discovered while iterating on the viewer; not yet done.

- **Overscan on pan (no blank edges).** Panning shows blank margins until the
  rebuild lands. Render a margin beyond the viewport so pans reveal already-drawn
  content. Substantial coordinate-system change — deferred.
- **Vertical mode: sample/read (smart) track + hover-tooltip rotation.** Vertical
  orientation still renders the smart track oddly and the hover tooltip stays
  rotated. WebGPU + comm-driven, so not reproducible headless — needs real-browser
  work. On-track text and track-name chips are already fixed.
- **Scale plan (30K → 1M / All-of-Us).** Design captured in
  `DATA_LOADING_SCALE.md` (v1, near-term) and `DATA_LOADING_SCALE_V2.md` (v2,
  tiered high-scale). Multispecies PR merged to `main` (2026-09-02); awaiting a
  go/no-go on the tiers before building. This is **variant-payload** scaling
  (aggregate-only contract, viewport loading) — distinct from the read-pileup
  canvas work under "Sample-track rendering scale" below.
- **GCS comment store via the client library.** The comment store + listing
  shell out to `gcloud`/`gsutil`. Moving to `google-cloud-storage` (Python) would
  cut latency and sidestep the CLI reauth path entirely (see the auth notes in
  the README).

See the README "Deferred / manual-check list" for behaviours the headless
harness can't reach (comment thread UI, pin placement, drag feel, the vertical
smart track) that must be checked by hand.

## Sample-track rendering scale — deferred (pinned 2026-09-02)

Current state works via a stopgap: reads capped to 300/track and the SNP base
letters removed (WebGPU has no text primitive; a 3rd 2D text canvas caused a
GPU-memory stall / "expand freeze"). Follow-ups, in order:

1. **Virtualize the canvas** — size it to the visible container height, draw only
   rows in view (offset by scrollTop) with a spacer for scroll height. Lifts the
   300-read cap; canvas size becomes constant regardless of coverage depth.
2. **One WebGPU canvas** — fold grid + variant guide lines into the instanced
   renderer, move "Loading…" to DOM, drop the separate 2D canvas (keep a minimal
   fallback if needed). Halves per-track canvas memory. Do after #1.
3. **WebGPU glyph atlas** — restore A/C/G/T letters on SNP tiles via a texture
   atlas + textured quads (GPU-side), only at base-level zoom.

## Implementation-ready specs (autonomous-session handoff, 2026-09-02)

Written during the overnight build. The scale variant-side (P1 gate,
fetch_carriers, Rust aggregate path, fetch_variants server) is DONE + tested on
`jts_scaling_updates`. These remain — each render-invasive item needs a browser
to verify (headless can't paint WebGPU), so they're specced rather than
blind-shipped. Order by value.

### P2 frontend windowing (#71 client)
Server `fetch_variants_payload(contig,start,end)` + comm handler exist. Client:
- On pan/zoom (debounced ~150ms), compute the visible window ± overscan; if not
  covered by the loaded store, `__GS_SEND("fetch_variants", {contig,start,end})`.
- Sparse store keyed by region; merge incoming variant_tracks; evict regions
  beyond a keep-radius of the current center. Pure merge/evict helper → headless
  test.
- Wire in view-state.js (loader) + a pan/zoom hook in main.js. Aggregate flag in
  the response toggles ribbons off.

### Canvas virtualization (#65)  — lifts the read cap
renderSmartTrack currently sizes canvases to the FULL stack (`totalContentHeight`,
clamped 16384) so the cap exists. Virtualize:
- Restructure the container: `overflow-y:auto`; a spacer div height =
  totalContentHeight for scrollHeight; the 2D + WebGPU canvases sized to the
  VIEWPORT (container clientHeight), `position:sticky; top:0` so they stay in view.
- Draw offset: subtract `container.scrollTop` from every y — ctx via
  `ctx.translate(0,-scrollTop)`; WebGPU by subtracting scrollTop in the addRect/
  addTriangle/drawMarkerRect calls (or a renderer y-uniform). Pure row-window
  helper `computeVirtualRowWindow(scrollTop,viewportH,rowH,totalRows,overscan)`
  → headless test.
- Remove the MAX_RENDER_READS cap (smart-tracks.js) + the MAX_CANVAS_PX clamp.
- VERIFY IN BROWSER: a wrong WebGPU y-offset silently misplaces reads.

### One WebGPU canvas (#66)  — after #65
Fold grid + variant guide lines into the instanced renderer; move "Loading…" to a
DOM element; drop the 2D canvas (keep a tiny Canvas2D fallback only for
no-WebGPU). Halves per-track canvas memory.

### WebGPU glyph atlas (#67)  — base letters back at scale
Pre-render A/C/G/T (+ maybe N) into one small texture atlas; draw textured quads
per SNP tile via the instanced renderer at base-level zoom (tile width ≥ ~8px).
Removes the text-overlay canvas need.

### Overscan on pan (#41)
Pure `overscanRegion(startBp,endBp,factor)` → fetch/draw a margin beyond the
viewport so pans reveal already-drawn content (pairs with P2 windowing). Headless-
test the region math; render wiring is browser.

### Codon track (planning/TODO "Codon track")
Pure `translateFrame(refSeq, frame)` → [{codonStartBp, aa}] (standard codon
table) — headless-testable. Render an additive row beside the reference at
base-level zoom. Phase 2 (CDS-aware) needs CDS+phase retained through
parse_gff_genes.

### UCSC signal tracks (planning/TODO "signal tracks")
New value-track renderer (line/area/heatmap, value→y, per-pixel binning, value
gutter). Data path: extend the UCSC fetch to return value-spans for wig/bigWig.

### GCS comment store via client library
Replace the gcloud/gsutil shell-outs in the comment store with
`google-cloud-storage` (Python) to cut latency + sidestep CLI reauth. New dep;
Python-testable with a mocked client.

### Vertical mode (#49)
Smart/read track renders oddly + hover tooltip stays rotated in vertical
orientation. WebGPU + comm-driven → browser-only.

### Also: reference()/repeats() should adopt the contig-name candidate retry now
in genes() (_contig_name_candidates); and the Rust aggregate path could honor
sample-subsetting (currently cohort-wide) + parquet-cache aggregates.
