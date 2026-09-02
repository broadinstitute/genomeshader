# Data loading at scale — v1 (near-term, 30K-sample plan)

> **Read as a pair with [`DATA_LOADING_SCALE_V2.md`](DATA_LOADING_SCALE_V2.md).**
> This doc (v1) is the *near-term* plan: make a 30K-sample VCF behave on the live
> rust-htslib backend (aggregate-only payload + viewport loading). **v2 is the
> long-term, tiered architecture** that scales the same tool to All of Us
> (~1M samples) by adding a precomputed producer behind the same contract. v1 ≈
> Tiers 1–2 of v2. The recommended path is to **build v1 using v2's aggregate
> contract as the interface**, so Tier 3 is an additive producer later, not a
> rewrite. See v2's side-by-side table to choose scope. Nothing in either doc is
> implemented.

**Question.** Can genomeshader actually explore a 30K-sample callset, and can it
load more data as you scroll / move loci? **Investigation + design only — nothing
here is implemented.**

## Verdict

- **Backend read is fine.** Variants are pulled by **indexed region seek** (only
  the visible locus is decoded), and staged to a parquet cache per region.
- **The wall is the payload, not the decode** — and the Rust source already says
  so verbatim (`src/variants.rs:203`: *"the wall is the per-(variant,sample)
  payload sent to the browser"*). Every variant ships a **full per-sample
  genotype map** (`sampleGenotypes`), so the payload scales with
  **variants × samples**. At 30K samples a few hundred variants = millions of
  genotype entries = tens–hundreds of MB of JSON.
- **It's inlined, in one shot.** In the notebook (anywidget) path the whole
  payload is inlined into the config traitlet and synced at once. The
  chunked+gzip comm delivery that exists in the code (`fetch_variant_payload_*`)
  is **dead** — not wired into `widget.py._on_custom_msg`.
- **No viewport loading.** Data loads once at `render(locus)`. Pan/zoom re-renders
  from the already-loaded array; **moving to a new locus needs a fresh
  `render()`/`show_widget()`.** Your belief is correct.

So today the practical answer for 30K is the escape hatch the code already has:
**subset to a handful of samples** (`src/variants.rs:206` post-read filter). That
defeats the point of exploring the *whole* callset.

## Current data path (end to end)

| Stage | Where | Behavior | Scales with |
|-------|-------|----------|-------------|
| Region read | `src/variants.rs:242` `reader.fetch(rid,start,stop)` | Indexed seek; decodes genotypes for **all** samples per record; optional post-read sample subset (`:206`) | region size |
| Emit | `extract_variants` → **long-format** DataFrame (one row per variant×sample) | genotype strings materialized for every sample | **variants × samples** |
| Reshape | `view.py:_build_variants_data_for_track` (`:1228`) | Groups by variant; computes `alleleFrequencies` + `alleleSampleCounts` (aggregate) **and** builds `sampleGenotypes` (full per-sample map, `:1541`) | **variants × samples** |
| Deliver | `render(inline_payload=True)` (`:2887`) | Inlines `variant_tracks` into the config traitlet; comm/url paths are fallbacks (comm handler is **absent** → dead) | **variants × samples** |
| Load (JS) | `view-state.js:98–175` | Loads the payload **once** at init; sets global `variants` | — |
| Render (JS) | `interaction.js` flow | Band sizes use **aggregates** (`alleleFrequencies`/`alleleSampleCounts`); ribbons + carrier lookup use `sampleGenotypes` | render uses aggregates; ribbons loop all samples |
| Pan/zoom | `main.js` | Re-renders from the loaded `variants`; **no re-fetch** | — |

## The bottlenecks

1. **B1 — payload ∝ variants × samples.** `sampleGenotypes` per variant is the
   dominant cost across the whole chain: Rust→Python long DataFrame, JSON
   serialize, traitlet sync, JS parse, JS heap. This is *the* 30K wall.
2. **B2 — all-at-once, un-chunked.** The notebook path inlines the entire region
   before first paint; the existing chunk/gzip transfer is unused.
3. **B3 — no windowing.** Can't scroll into unloaded regions or jump loci without
   re-`render()`; the whole region stays resident even when off-screen.
4. **B4 — client-side per-sample compute.** Ribbon `computeTransitions`
   (`interaction.js:2140`) loops **all 30K samples** per adjacent variant pair,
   every render — yet its output is just aggregate pair counts.

## The key insight

**Everything the viewer *renders* is derivable from aggregates.** Flow band
sizes need `alleleSampleCounts`/`alleleFrequencies` (O(alleles) per variant).
Ribbon widths need allele-pair **transition counts** (O(alleles²) per adjacent
pair). Both are **independent of sample count**. The full per-sample
`sampleGenotypes` map is only needed for the **deep-dive** — "who carries this
allele" → Smart Tracks — which is already an on-demand user action (reads are
already fetched lazily over the comm). So the per-sample data never needs to ship
up front.

## Proposed design (phased — for discussion)

### Phase 1 — Aggregate-only render payload + lazy carriers  *(biggest win, on-mission)*
- **Rust** computes per-variant aggregates (AC/AN/AF, per-allele sample counts)
  **and** per-adjacent-pair transition counts, server-side. Genotypes are decoded
  in Rust but **nothing per-sample crosses to Python/JS**.
- **Drop `sampleGenotypes`** from the render payload → payload becomes ~constant
  in sample count. 30K behaves like 100 for the flow.
- **Carriers on demand:** a `fetch_carriers(track, contig, pos, ref, allele,
  page)` comm handler returns the (paginated) carrier sample list only when an
  allele is selected — mirrors `fetch_reads`.
- *Reuse:* the flow already sizes bands from aggregates; ribbons switch to
  server-supplied transition counts; carrier lookup (`main.js:4065`) moves to the
  comm. **Effort: M–L.**

### Phase 2 — Viewport-driven windowed loading  *(delivers "scroll / move loci")*
- `fetch_variants(contig, start, end)` comm handler (Rust region-seek →
  aggregates from Phase 1).
- **Frontend:** on pan/zoom, debounce and request the visible window ± overscan;
  merge into a sparse per-region store; evict distant regions.
- *Reuse:* the region-interval index + subset helpers already exist
  (`view.py:_find_covering_variant_payload_interval`, `_subset_variant_payload`,
  the region cache) and the live-pan + reads-disk-cache patterns from recent work.
  **Effort: M.**

### Phase 3 — Level-of-detail for wide views
- When a window holds thousands of variants, draw a **binned AF density track**
  instead of every variant/ribbon; expand to the full flow on zoom-in; cap
  variants per frame. **Effort: M.**

### Phase 4 — Backend precompute + columnar cache
- Precompute per-site aggregates (AC/AN/AF, and per-group with sample metadata —
  ties to feature-gap #1/#3) into a compact **parquet keyed by region/genome**, so
  repeat visits and wide scans are instant. Extends the staged-variant parquet
  already present (`src/lib.rs:215`). **Effort: M–L.**

### Phase 5 — (optional, extreme scale) pre-tiled aggregates
- Genome-browser-style zoom-level tiles (aggregate bigBed/parquet) for true
  streaming at 30K–300K across arbitrary loci. **Effort: L–XL.**

## Recommendation

**Phase 1 + Phase 2 together answer the ask.** Phase 1 removes the 30K wall
(payload stops scaling with sample count) and is squarely on-mission —
population-scale means *aggregate-first, per-sample on demand*. Phase 2 adds the
scroll/jump-loci loading you correctly identified as missing, on infrastructure
that's already half-built. Phases 3–5 are follow-ons for very wide views and
very large cohorts.

---

## Chosen direction (2026-09-02) — live producer, no precompute

**Decision.** Build the **live producer** (Phases 1–2) so genomeshader works on
**any dataset as it loads** — no Hail, no tiled precompute store. Keep the
aggregate contract (v2 §2) as the interface so a precompute producer (v2 Tier 3)
is an *additive* backend later, not a rewrite. Precompute is explicitly deferred.
This handles general callsets well up to the point where live decode of the
in-view window over all samples stops being interactive (empirically ~100K on a
region-indexed VCF/BCF); beyond that, the same frontend gets a precompute
producer behind the same contract.

### P1 build spec (aggregate-only payload) — grounded in current code

Today `extract_variants` (`src/variants.rs:183`) emits a **long-format**
DataFrame (one row per variant×sample, `genotypes` materialized for every
sample), and `_build_variants_data_for_track` (`view.py`, appends at `:1558`)
adds `sampleGenotypes` **and** `sampleAlleles` (`:1573-1574`) — both per-sample.
JS uses the per-sample maps in exactly two places: `computeTransitions`
(`interaction.js:2123`, ribbons) and carrier lookup
(`computeCandidateSamplesForAlleles` / `sampleHasSelectedAllele`). The flow bands
already run on `alleleFrequencies` + `alleleSampleCounts` (aggregates that ship).

Steps:
1. **Server-side transitions (match `computeTransitions` exactly).** The current
   JS (`interaction.js:2123`) counts transitions **per haplotype**, not per
   sample: for each sample it parses the src/dst GT strings into allele indices,
   pairs them positionally (`h = 0..min(ploidy)` — a phased assumption), maps each
   index → allele label via `getAlleleLabelForIndex` **against the
   support-resorted alt order** (`view.py:1490`), and does
   `transitions[srcLabel][dstLabel] += 1`. Null/`.` → the "." label. The server
   port must reproduce this — including the alt relabel — and a test must compare
   its output to `computeTransitions` on the same synthetic genotypes.
   Compute per **adjacent in-view pair** and ship a `transitions` field on the
   src variant (`{srcKey -> {dstKey -> count}}`). Aggregates (AC/AN/AF, per-allele
   counts) already exist server-side (`allele_frequencies`/`allele_sample_counts`,
   `view.py:1496-1518`) — no change needed there for P1.
2. **Drop per-sample fields** from the payload: remove `sampleGenotypes` and
   `sampleAlleles`; ship `transitions` instead. Payload becomes ~constant in
   sample count.
3. **JS: ribbons from server.** Replace `computeTransitions`'s genotype loop with
   the server-supplied `transitions`.
4. **JS: carriers on demand.** New `fetch_carriers(track, contig, pos, ref,
   allele, strategy, n)` comm handler (Rust region-seek → sampled carrier IDs);
   `computeCandidateSamplesForAlleles` calls it instead of reading `sampleAlleles`.
   Mirrors the existing `fetch_reads` path.
5. **Test** against a synthetic multi-sample VCF: aggregates + transitions match a
   brute-force count; payload size is flat as sample count grows.

### P2 build spec (viewport loading)

6. `fetch_variants(contig, start, end)` comm handler (P1 producer per window).
7. Frontend: on pan/zoom, debounce → request visible window ± overscan → merge
   into a sparse per-region store → evict distant regions. Reuse the
   region-interval index + subset helpers (`_find_covering_variant_payload_interval`,
   `_subset_variant_payload`) and the live-pan / reads-disk-cache patterns.

*Nothing above is implemented yet — this is the spec for the build.*
