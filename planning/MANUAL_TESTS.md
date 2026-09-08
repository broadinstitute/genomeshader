# Manual test checklist — scale + render build (jts_scaling_updates)

Run after `maturin develop --release` + kernel restart. Things marked ⚠️ were
implemented **blind** (no browser here) and are the most likely to need debugging.

## 0. Build / smoke
- [ ] `maturin develop --release` compiles (Rust bindings: `get_locus_variant_aggregates`).
- [ ] `pytest python/tests -q` green; `cargo test --lib` green.
- [ ] Open a **normal** cohort (≤5000 samples). Everything looks/behaves exactly
      as before (no regression). Flow bands, ribbons, reads all normal.

## 1. Variant scale — payload gate (P1)
- [ ] Load a cohort with **>5000** variant samples (or `GENOMESHADER_PERSAMPLE_MAX=10`
      on a small one to force it). Flow still renders bands from aggregates.
      Ribbons OFF (expected at scale). No giant payload / hang.
- [ ] Allele node sample-count labels still show sensible numbers (from aggregates).

## 2. Variant scale — carriers on demand (fetch_carriers) ⚠️
- [ ] In gated mode, select an allele → "Load" samples. Carriers resolve (watch
      the comm; a `fetch_carriers` round-trip). Reads load for real carriers.
- [ ] Small cohort still selects carriers synchronously (unchanged).

## 3. Variant scale — 1M aggregate path (Rust) ⚠️
- [ ] Force it: `GENOMESHADER_VARIANT_AGG_MAX=0`, load any variant cohort. Flow
      renders (bands from Rust aggregates, no per-sample). No OOM.
- [ ] Sanity the counts vs a known site (AC/AF direction). `cargo test` already
      asserts aggregate == long-format equivalence on the fixture.

## 4. Viewport variant loading (P2 server) 
- [ ] `s.fetch_variants_payload("chr", start, end)` in a notebook returns
      `{variant_tracks, insertion_variants_lookup, region, aggregate}`.
      (Frontend pan-trigger NOT wired yet — see "Remaining".)

## 5. Read-track virtualization (#65) ⚠️⚠️ MOST LIKELY TO NEED DEBUG
- [ ] Load reads, expand a sample track. Reads render at the right y positions.
- [ ] Scroll inside an expanded track — reads scroll smoothly, SNP tiles + arrows
      stay aligned with read bodies (this is the ctx-vs-WebGPU scroll offset;
      a wrong offset shows reads shifted or markers detached).
- [ ] Load a **deep** pileup (>300 reads). ALL reads now render (cap removed);
      no freeze, no 16384px clipping.
- [ ] Collapse/expand/delete still smooth (no ResizeObserver freeze).
- [ ] KNOWN RISK: sticky-canvas overlap — if a track shows blank or double
      canvases, the sticky/marginTop stacking needs a tweak.

## 6. SNP base letters (#67) ⚠️
- [ ] Zoom to base level on an expanded read track. A/C/G/T letters appear on SNP
      tiles (white, centered), aligned with tiles as you scroll.
- [ ] Collapsed tracks: no letters (just colored ticks). Correct.

## 7. Contig-name normalization (UCSC genes)
- [ ] On a genome whose contigs differ from the assembly (e.g. `1` vs `chr1`),
      the Genes tab still returns genes (tries both spellings).

## Remaining (NOT implemented this pass — see planning/TODO.md specs)
These need a browser to wire safely and weren't done (budget); cores/specs ready:
- #41 overscan render (blank pan edges) — `overscanRegion` core is tested.
- #71 P2 frontend windowing (pan-triggered fetch) — store cores tested.
- Codon track render — `translateFrame` core tested.
- UCSC signal tracks (value renderer).
- GCS comment store via client library.
- #49 vertical mode fixes.
- #66 collapse-to-one-canvas: OBVIATED by #65 (viewport canvases → memory trivial).

## If something's broken
The scale variant-side (1–4) is unit/equivalence-tested and low-risk. The read
canvas (5–6) is the blind render work — most likely culprit is the WebGPU scroll
offset (`_scrollOffset` in renderSmartTrack) or the sticky-canvas layout. Ping me
the symptom (reads shifted? blank? markers off?) and it's a quick fix.
