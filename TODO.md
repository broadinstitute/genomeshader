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
- **Multi-instance safety.** A second widget in the same notebook can render
  blank (shared/global state keyed by view id). Audit for cross-instance leakage.
- **Scale plan (30K → 1M / All-of-Us).** Design captured in
  `DATA_LOADING_SCALE.md` (v1, near-term) and `DATA_LOADING_SCALE_V2.md` (v2,
  tiered high-scale). Awaiting branch merge + go/no-go on the tiers.
- **GCS comment store via the client library.** The comment store + listing
  shell out to `gcloud`/`gsutil`. Moving to `google-cloud-storage` (Python) would
  cut latency and sidestep the CLI reauth path entirely (see the auth notes in
  the README).

See the README "Deferred / manual-check list" for behaviours the headless
harness can't reach (comment thread UI, pin placement, drag feel, the vertical
smart track) that must be checked by hand.
