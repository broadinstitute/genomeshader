# Data loading at scale — v2 (high-scale, long-term plan)

**Status (2026-09-03):** **P1 + P2 are implemented** (Tiers 1–2, the near-term
plan) — aggregate-only payload (#68), Rust per-variant aggregates (#70),
`fetch_carriers` (#69), and viewport-driven windowed loading with overscan (#71),
all tested. **Tier 3 (Population / AoU) is not built and is deliberately
deferred.** This doc is the target architecture and the record of decisions; the
sections below are updated to reflect what shipped and to reframe Tier 3 (see
§7, §13) around **on-demand windowed aggregation + a lazy cache as the default**,
with full precompute demoted to an optional accelerator.

**Relationship to v1.** `DATA_LOADING_SCALE.md` (v1) is the *near-term* plan:
make a 30K-sample VCF behave with a live rust-htslib backend (aggregate-only
payload + viewport loading). **v2 is the long-term target architecture** that
scales the same tool to **All of Us (~1M samples)**. v2 is a superset: v1 is
essentially "Tier 1 + Tier 2" of v2's tiered model. This doc exists so we can
evaluate the two side by side and decide how far up front to build. Refactors
between v1 and v2 are expected and acceptable; the goal is that v1's choices are
*forward-compatible* with v2, not thrown away.

See the side-by-side comparison at the end.

---

## 1. The one idea that makes 1M possible

**Everything the viewer renders is derivable from aggregates that are independent
of sample count** (per-allele AF/AC/AN for band sizes; allele-pair transition
counts for ribbon widths). The full per-sample genotype map is only needed for
the **deep-dive** ("who carries this allele" → reads), which is already an
on-demand action. So the browser never needs a genotype at 1M.

The architecture therefore splits into two decoupled halves:

- **One aggregate data contract** the frontend consumes (same at 100 or 1M samples).
- **Swappable producers** behind it, chosen by scale.

A **tier** is just the policy that picks the producer and the level of detail for
a given cohort size. "Level of detail" and "sample count" are the same knob.

## 2. The aggregate data contract (the durable interface)

Getting this schema right is the high-leverage decision — producers come and go
behind it. Sketch (per variant, per window):

```
Variant {
  id, contig, pos, ref, alt[],
  alleleFrequencies: { alleleKey -> AF },        // O(alleles)
  alleleSampleCounts: { alleleKey -> count },    // O(alleles)
  transitions?: { srcAlleleKey -> { dstAlleleKey -> count } },  // to next variant, O(alleles^2)
  callRate, filter, info?: {...},                // QC
  // NO per-sample genotypes
}
WindowMeta { contig, start, end, tier, suppressedBelowCount?, producer }
```

Carriers are **not** in the payload; they are fetched on demand (§6). Per-group
aggregates (ancestry/case-control) are an extension: `alleleSampleCounts` becomes
`{ group -> { alleleKey -> count } }` when a sample-metadata table is present
(ties to feature-gap #1/#3).

## 3. The three tiers

Named by the fidelity the user sees, because that is what changes.

| Tier | Samples (default, tunable) | Producer | Render payload | Ribbons | Carriers | Per-sample genotypes |
|------|---------------------------|----------|----------------|---------|----------|----------------------|
| **1 · Individual** | ≤ ~5K | live rust-htslib decode | may include `sampleGenotypes` | live, exact | full list | inspectable |
| **2 · Cohort** | ~5K–100K | live decode → aggregate in Rust | aggregate-only (contract §2) | live, server-computed | lazy, sampled/paginated | on-demand only |
| **3 · Population** | > ~100K (→1M+) | **on-demand windowed aggregation over the native store + lazy per-window cache** (default); precompute→tiled store optional | aggregate-only (+ zoom LOD) | precomputed / approximate | sampled + privacy-thresholded | not exposed |

Tier 1 is today's behavior. **But note: since #68 dropped `sampleGenotypes`
entirely, Tiers 1 and 2 now render identically (aggregate-only at every size) —
the only Tier-1 distinction left is that a small cohort *could* expose
per-sample genotypes, which nothing currently does.** Tier 2 is the 30K case
(v1), shipped. Tier 3 is AoU. **Same frontend contract across all three;** only
the producer and LOD policy differ. Tier 3's default producer is *live from the
user's point of view* — it aggregates the requested window on demand and caches
it — so it keeps genomeshader's "point it at data and explore" character; full
precompute is an accelerator, not a prerequisite (§7, §13.5).

## 4. Two orthogonal axes (do not conflate)

- **Sample-count tier** (§3): how heavy each variant's cohort dimension is →
  picks producer + whether per-sample data exists.
- **Zoom / variant-density LOD:** how many variants are in view → full-flow vs a
  binned AF-density track. Applies *within every tier*.

A 1M cohort zoomed to one variant is cheap on the zoom axis but Tier 3 on the
sample axis; a 2K cohort zoomed to a whole chromosome is Tier 1 but needs density
LOD. The two axes are independent knobs.

## 5. Detection, override, adaptivity

- **When:** at `attach_variants` / render, *before* building any payload (never
  build a per-sample payload then discard it).
- **From what:** sample count is already available — Rust `vcf_sample_names`
  (VCF header) or source metadata (VDS/precomputed). Cheap.
- **Override:** thresholds are configurable defaults, not magic numbers (param/
  env). The user can force a tier ("it's AoU, start in Population") and set a
  per-view detail override.
- **Adaptive downshift (later):** start in the count-implied tier; if a region's
  payload/latency blows a budget, auto-drop one detail level. Start simple
  (count→tier); add adaptivity once measured.

## 6. Carriers + privacy (the "who carries it" piece at scale)

At 1M a common allele has ~500K carriers — you can neither list nor load them.

- **Carrier index (new data structure):** per (site, allele) → a *drawable
  sample* of carrier IDs — full list when rare, a representative sample when
  common. Feeds the existing Smart-Track loading strategies (random draw,
  best-evidence). Fetched via a `fetch_carriers(site, allele, strategy, n)` comm
  handler, mirroring `fetch_reads`.
- **Privacy (AoU):** small-cell-count suppression is a first-class rule, not an
  afterthought. Below a threshold, allele counts / carrier access are suppressed
  or bucketed per the AoU data-use policy (Registered vs Controlled tiers). The
  contract carries a `suppressedBelowCount` flag; suppressed sites are marked in
  the UI, not silently blank. This must pass AoU review before it ships.

## 7. Producers in detail

The key realization for Tier 3: **the aggregation cost is bounded, so precompute
is an optimization, not a requirement.** Per viewport window the work is
`variants_in_view × samples`; `variants_in_view` is bounded by the viewport and
capped further by density LOD (§4, P3). A narrow window over 1M samples is a few
million tallies — seconds at worst, and it's a debounced load-on-settle, not a
per-frame cost. The payload out is aggregate-only (constant in samples, #68/#70).
So aggregation at 1M is *feasible live* for bounded windows; precompute only buys
speed for wide/hot/cold-start cases. What actually forces server-side work at AoU
is the **data format** (a Hail VDS/MatrixTable is not htslib-seekable), not the
sample count — and that reader can run per-window, on demand.

- **(a) Live rust-htslib decode** — Tiers 1–2 (**shipped**). Region seek
  (`variants.rs:242`), aggregate in Rust as it decodes (AC/AN/AF + transitions),
  per-region parquet staging (`lib.rs:215`). Works whenever the source is an
  indexed VCF/BCF — including high sample counts for bounded windows.
- **(b) On-demand windowed aggregation over the native store + lazy cache** —
  **the Tier-3 default.** A producer that reads AoU's native format (VDS /
  MatrixTable, or a per-interval BCF export) for *just the requested window*,
  aggregates to the contract (§2), and returns. From the user's point of view
  this is *live* — no genome-wide build. The per-window disk cache already in the
  code (`_variant_payload_cache_uri`, `_find_covering_variant_payload_interval`,
  region parquet staging) makes it **"precompute lazily, only what's visited"**:
  first visit aggregates on demand, repeat visits are instant. The one real UX
  risk is **cold Hail/Spark spin-up latency** (tens of seconds on the first
  query) — mitigate by keeping a warm Hail context, or pre-exporting just the
  *working region* once ("warm the neighborhood," region-scoped, not the genome).
- **(c) Offline precompute → tiled store** — **optional accelerator, not the
  enabler.** A Hail/Spark job materializes per-site aggregates + transition
  summaries + the carrier index into a tiled columnar store on GCS, keyed by
  region/zoom. Reserve it for when on-demand latency is genuinely too high: very
  wide genome-scale scans, high concurrency, or unacceptable cold-start. It slots
  behind the same contract, so it's an additive backend for hot paths — not a
  prerequisite for a first Tier-3 view.
- **(d) Published AF tables** — where AoU already publishes per-ancestry allele
  frequencies / annotations, consume them directly (no compute at all). Cheapest
  path to a first Tier-3 view; limited to what's published.

## 8. Ribbons at 1M (the honest hard part)

Full alleuvial ribbons need joint genotypes across adjacent sites — pairwise,
phasing-dependent. Live at 1M is infeasible; even precomputing all adjacent-pair
transitions genome-wide is a large Hail job.

Options to decide between:
- Precompute transitions only for **adjacent in-view pairs on demand** (Tier 3
  computes them per window in the pipeline, cached).
- **Zoom-in-only ribbons:** show ribbons only when few variants are in view;
  suppress in wide windows (pairs with the density LOD).
- **Approximate / drop** ribbons at Tier 3 and rely on per-variant bands.

My lean: zoom-in-only + on-demand precomputed pairs. Worth an explicit decision.

## 9. Reads path — already 1M-safe

The deep-dive pulls a handful of carrier CRAMs on demand (`fetch_reads`, region
seek). You never load 1M read sets. No change needed; it already embodies the
"aggregate-first, per-sample on demand" principle.

## 10. Tiling: data tiles vs image tiles

Two different things, often confused:
- **Data tiles:** precomputed *numeric summaries* per zoom level, rendered
  client-side (WebGPU). bigWig zoom-levels / HiGlass. Preserves hit-testing,
  theme, DPI.
- **Image tiles:** backend rasterizes *pixels* (PNG), browser blits them. UCSC
  Genome Browser, JBrowse 1. Infinite sample scale, but kills interactivity
  (needs a hit-test sidecar + a re-render round-trip per pan/zoom) and requires a
  *second* renderer on the backend.

**Decision for the flow track: data tiles, not image tiles.** The flow is the
interactive core (click/drag/hover/deep-dive) and has dynamic layout
(equidistant vs genomic, expandable insertions) that fixed image tiles fight.
Data tiles keep it vector + interactive while delivering precomputed aggregates.
Reserve **image tiles** for a future *dense, non-interactive all-samples track*
(a genotype matrix or cross-sample pileup heatmap, feature-gap #2/#11) where
per-pixel-per-sample is the point — there, server raster genuinely wins.

## 11. Migration path v1 → v2 (what's forward-compatible, what refactors)

- **Forward-compatible (build once):** the aggregate contract (§2), the tier
  switch + detection (§5), producer (a), the `fetch_carriers` comm handler, the
  viewport-driven frontend store (v1 Phase 2). These are v2's Tiers 1–2 verbatim.
- **Additive later (no rework):** producer (b) Hail precompute + tiled store,
  producer (c) AF tables, the carrier index, privacy thresholds, data-tile
  delivery. They slot behind the same contract.
- **Likely refactors as we scale:** the delivery format (single comm response →
  tiled fetch), the ribbon strategy (§8), and the carrier source (live genotypes
  → carrier index). These are contained because they sit behind the contract.

Net: build v1 (Tiers 1–2) with the v2 contract in mind, and Tier 3 is an
additive producer + delivery layer, not a rewrite.

## 12. Build phases (tier-aware)

- **P1 — Aggregate contract + Tier 1/2 producer. ✅ DONE (#68/#69/#70).** §2
  contract; Rust aggregates + transitions; dropped `sampleGenotypes`;
  `fetch_carriers`. Unlocks up to ~100K on live VCFs. (Tier *switch* deferred —
  one-armed today, see §13.)
- **P2 — Viewport-driven loading. ✅ DONE (#71).** `fetch_variants(contig,start,
  end)` + sparse frontend store + pan/zoom fetch + overscan (#41). Unlocks
  scroll/jump-loci.
- **P3 — Zoom/density LOD.** Binned AF-density track for wide windows. Orthogonal;
  applies to all tiers. *Not built; the main lever that keeps live Tier-3
  aggregation bounded.*
- **P4 — Tier 3 producer: on-demand windowed aggregation over the native store +
  lazy per-window cache** (default; the per-window cache is half-present in the
  code). Precompute pipeline + tiled store is an **optional accelerator** for
  wide/hot/cold-start latency, not a prerequisite. Add the carrier index +
  privacy layer here. Prototype against a real AoU interval in the Workbench
  first. *Deferred.*
- **P5 — Data-tile delivery + optional dense all-samples track (image tiles).**
  Extreme-scale headroom. *Deferred.*

## 13. Decisions

Resolved with the recommended defaults (2026-09-02); updated 2026-09-03 to record
what shipped and Jonn's calls on the open items.

**Shipped (2026-09-03):** the former "NEEDS JONN — authorize P1+P2" is **done** —
P1 (aggregate-only payload, Rust aggregates, `fetch_carriers`) and P2 (viewport
loading + overscan) are implemented and tested (#68–#71). Tiers 1–2 are live.

**Jonn's calls (2026-09-03):**
- **Per-group aggregates → defer + retrofit** (revises Locked #3 below). The
  shipped Rust emit is flat scalars (`n_ref/n_alt/n_missing/n_samples`), not the
  nested `{group → {alleleKey → count}}` shape. Reserving the nesting is *not* a
  free placeholder — it threads a nested/map schema through Rust→polars→JSON→JS —
  so we ship single-group flat now and retrofit the nesting when per-ancestry /
  case-control views (feature-gap #1/#3) are actually built. Retrofit is contained
  (additive columns/nesting behind the same contract).
- **Tier detection/switch → deferred with Tier 3.** Not built, and correctly so:
  since #68 dropped per-sample genotypes, Tiers 1 and 2 render identically, and
  Tier 3's producer doesn't exist yet — so a switch today selects among one
  option (a one-armed switch = dead abstraction). It becomes a ~1-function
  addition (`sample_count → producer`) once a second producer exists, cheap
  because the aggregate contract already isolates producers.
- **Tier 3 = on-demand windowed aggregation + lazy cache as the default;
  precompute is an optional accelerator** (revises Locked #5, see §7). Precompute
  is not the enabler — the aggregation cost is bounded per window, so the default
  Tier-3 producer aggregates on demand over the native store and caches per
  window; full precompute is reserved for wide/hot/cold-start latency.

**Locked (technical defaults — proceed on these):**
1. **Ribbons at Tier 3** → **zoom-in-only + on-demand precomputed pairs.** Show
   ribbons only when few variants are in view (pairs with the density LOD);
   compute adjacent-pair transitions per window on demand and cache. Never live
   across 1M. (§8)
2. **Carrier semantics** → **always strategy-sampled; no "list all".** One
   `fetch_carriers(site, allele, strategy, n)` handler mirroring `fetch_reads`;
   full list only implicitly when the sample is smaller than the cap. (§6)
3. **Per-group aggregates** → **reserve the shape in the contract now, populate
   later.** `alleleSampleCounts` is designed as `{group -> {alleleKey -> count}}`
   from day one but is only filled when a sample-metadata table is provided; P1
   ships single-group. Cheap to reserve, expensive to retrofit. (§2, feature-gap #1/#3)
4. **Tiling delivery** → **data tiles for the flow** (client-rendered numeric
   summaries; keeps hit-testing/theme/DPI). Image tiles reserved for a future
   dense, non-interactive all-samples track only. (§10)
5. **AoU substrate** (revised 2026-09-03) → **on-demand windowed aggregation over
   the native store + lazy per-window cache is the default** (§7b); **published
   AF tables** where they exist (§7d, cheapest); **Hail precompute → tiled store**
   is an **optional accelerator** for wide/hot/cold-start latency only (§7c), not
   the enabler. Re-confirm against a real AoU interval when Tier 3 is actually the
   target — deferred, not on the P1/P2 path.
6. **Tier thresholds** → defaults **≤5K / 5K–100K / >100K**, configurable via
   param/env with a force-a-tier override. (§3, §5)

**NEEDS JONN (only gates Tier 3, which is deferred):**
- **Privacy / access tier (§6)** — the exact small-cell suppression rule and
  which AoU access tier we target (Registered vs Controlled). Compliance, with an
  **AoU review gate before ship**. Blocks Tier 3 only (not P1/P2, which shipped) —
  and it's yours, not the doc's. *Status: flagged, deferred until Tier 3 is the
  real target.*

---

## v1 vs v2 — side by side

| | **v1 (near-term)** | **v2 (long-term)** |
|---|--------------------|--------------------|
| Target | 30K-sample VCF, live | 1M / All of Us |
| Backend | rust-htslib live decode | + on-demand windowed aggregation over the native store + lazy cache (default); Hail precompute → tiled store optional |
| Tiers covered | 1 (Individual) + 2 (Cohort) | + 3 (Population) |
| Render payload | aggregate-only | aggregate-only, tiled by zoom |
| Carriers | lazy, sampled | + carrier index + privacy thresholds |
| Ribbons | live server-computed | precomputed / zoom-in-only / approximate |
| New infra | comm handlers + frontend store | + Hail pipeline, tiled store, privacy layer |
| Effort | M–L | + L–XL (mostly the pipeline) |
| Risk | contained (one repo) | + external deps (Hail/Terra), privacy review |
| When to choose | now, real 30K callsets | when a >100K / AoU callset is actually the target |

**Recommendation (updated 2026-09-03).** v1 (P1+P2) is **built** on the v2
contract §2, so 30K–100K works now and Tier 3 is an additive producer later — no
rewrite. When AoU-scale is the real target, build Tier 3 as **on-demand windowed
aggregation over the native store + the lazy per-window cache** (producer §7b) —
that's mostly a producer swap plus the cache already half-present, and it keeps
the "explore as you go" feel. Add the **precompute → tiled store** (§7c) only if
on-demand latency proves too high for wide/hot/cold-start cases. Prototype
against a live AoU interval in the Workbench before committing to any pipeline.
