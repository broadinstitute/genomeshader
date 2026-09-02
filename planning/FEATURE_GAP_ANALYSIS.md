# Genomeshader — feature-gap analysis

**Purpose.** A discussion menu of features genomeshader does not yet have, drawn
from what comparable tools do well. Nothing here is implemented; this is for us
to prioritize together.

## What genomeshader is (the lens for judging gaps)

Genomeshader is an **interactive, population-scale, variant-first** browser: you
navigate between variant sites, each shown with its alleles sized by cohort
frequency (the "alleuvial" flow), then **deep-dive from a variant/allele into the
reads of carrier samples** ("Smart Tracks") to confirm the call. It's
notebook-native (anywidget), GPU-rendered, reference-agnostic (multispecies),
with a UCSC annotation bridge and a shared comments layer.

That niche sits between three tool families, and the gaps below are mostly about
borrowing the best of each **without losing the variant-first, cohort-centric
identity**:

- **Read/pileup browsers** — IGV, igv.js, JBrowse 2 (single-sample, evidence-first).
- **Cohort / frequency browsers** — gnomAD browser, cBioPortal, VarSeq (aggregate/variant-first).
- **Annotation browsers** — UCSC, Ensembl/VEP (annotation-first).

## Priority key

- **P1** — directly amplifies the core mission (variant-first, cohort-scale, confirm-from-reads). Highest discussion value.
- **P2** — strong table-stakes parity with peer tools; expected by users.
- **P3** — valuable but larger or more speculative; longer horizon.

Lift = rough engineering size (S/M/L/XL) given the current Rust(htslib+polars) /
Python(anywidget host) / JS(WebGPU) architecture.

---

## A. Cohort-scale exploration — the differentiator (lean in here)

| # | Feature | Seen in | Why it's useful *for genomeshader's mission* | How it could be built here | P | Lift |
|---|---------|---------|----------------------------------------------|----------------------------|---|------|
| 1 | **Sample metadata / phenotype coloring & faceting** (case/control, population, cohort, sex) | cBioPortal, gnomAD, cellxgene | The whole point is "which variants matter and *who* carries them." Metadata turns allele bands and sample lists into signal: color/split the flow by group, load carriers by phenotype. | Accept a sample→metadata table in Python (`set_sample_metadata`), inline into config; JS colors flow bands / Smart-Track picker / genotype matrix by a chosen column; group-aware Smart-Track loading strategies. | **P1** | M |
| 2 | **Genotype matrix track** (samples × variants heatmap, oncoprint-style) | cBioPortal oncoprint, Haploview | See carriage across *many* variants and *many* samples at once — the cohort view the flow only summarizes. Click a cell → that sample+variant → reads. | Rust builds a genotype matrix from the already-parsed VCF (polars); stream to JS; WebGPU heatmap track (instanced rects, reuse `instancedRenderer`); row/col sort by AF/metadata. | **P1** | L |
| 3 | **Per-population allele-frequency breakdown** for a variant | gnomAD | "Frequency across the cohort" is central; per-group AF (e.g. by ancestry/case-control) is the next question and a headline gnomAD feature. | With metadata (#1), Rust/Python computes per-group AF from genotypes; Variants tab shows stacked/grouped AF bars; optional per-group flow bands. | **P1** | M |
| 4 | **Reference AF overlay** (gnomAD/1000G popmax per variant) | gnomAD, VarSeq | "Is this rare in the world, or just in my cohort?" — the single most common triage question, and a natural complement to cohort AF. | Bundle/point at a gnomAD sites-AF source; Rust looks up AF by locus+allele (indexed, reuses region-seek); show alongside cohort AF; color variant marks by rarity. | **P1** | M |
| 5 | **LD / haplotype-block view** (r² triangle heatmap; extend phased ribbons) | Haploview, LDmatrix, PopViz | Population-scale genetics: tag SNPs, block structure, whether nearby variants travel together. The flow already draws phased ribbons — this is the aggregate cousin. | Rust computes pairwise r²/D′ from the genotype matrix (#2); triangular WebGPU heatmap track under the ruler; hover shows the pair. | **P3** | L |
| 6 | **Variant co-occurrence** (do two variants share carriers / compound-het?) | gnomAD co-occurrence, cBioPortal | Directly serves "who carries what": compound-het discovery, phasing intuition, mutual exclusivity. | From the genotype matrix, compute co-carriage for a selected pair/set; show as a small matrix or linked highlight in the flow + sample list. | **P3** | M |

## B. Variant meaning & annotation — "which variants matter"

| # | Feature | Seen in | Why it's useful | How it could be built here | P | Lift |
|---|---------|---------|-----------------|----------------------------|---|------|
| 7 | **Functional consequence / VEP annotation** (missense/LoF, gene, protein change) | Ensembl VEP, VarSeq, gnomAD | The mission says "see *which* variants matter." Consequence is the primary "matters" signal; today variants are position-only. | Parse `ANN`/`CSQ` INFO if already in the VCF (Rust, free); else optional offline VEP/SnpEff pass in Python. Show in Variants tab; color/badge variant marks by impact; filter by consequence. | **P1** | M |
| 8 | **ClinVar / known-pathogenic overlay** | UCSC, Ensembl, VarSeq, Franklin | Instant clinical/known-significance context on a variant mark — high-value triage with low friction. | Reuse the UCSC interval-track infra (ClinVar is a UCSC track) or a bundled ClinVar VCF matched by locus+allele; badge on the variant + row in Variants tab. | **P2** | S |
| 9 | **INFO/FORMAT display & QC filtering** (QUAL, FILTER, DP, GQ, AF/AC cutoffs, missingness) | IGV, VarSeq, bcftools/gnomAD | Confidence gating so real structure stands out — extends the existing "aggregate rare alleles" idea into a full filter panel. | Rust already parses these fields; expose per-variant + per-genotype; JS filter panel (hide/fade variants failing thresholds), reusing the Settings pattern. | **P2** | M |
| 10 | **Conservation track** (phyloP/phastCons) | UCSC, Ensembl | Prioritize sites under selection — a cheap "does this position matter" prior, and a natural fit for the multispecies direction. | Ties to the deferred **signal-track** TODO: UCSC bigWig → downsampled array → WebGPU line/heat track. | **P3** | M |

## C. Read inspection — strengthen the "confirm from reads" step

| # | Feature | Seen in | Why it's useful | How it could be built here | P | Lift |
|---|---------|---------|-----------------|----------------------------|---|------|
| 11 | **Coverage / depth track** above Smart-Track reads | IGV, igv.js, JBrowse | Depth + allele balance at a glance is how you sanity-check a genotype before reading pileup detail. | Rust computes per-base depth (and ref/alt balance) while parsing reads it already reads; send arrays; WebGPU bar track above each Smart Track. | **P1** | S |
| 12 | **Sort / group / color reads** by base-at-site, strand, haplotype (HP tag), or sample | IGV (core), igv.js | The standard motions for confirming a call and eyeballing phase — currently reads are shown but not organized around the selected variant. | Reads already carry per-base + position; add JS sort/group/color modes keyed to the selected variant; pull `HP`/`SA` tags in Rust for haplotype/split grouping. | **P1** | M |
| 13 | **Read-pair / insert-size & split-read (SV) view** (discordant pairs, breakpoint arcs) | IGV, JBrowse 2, Samplot | Extends "confirm the call" to structural variants across the cohort — a space (multi-sample SV evidence) that's under-served. | Rust extracts mate/`SA`/insert-size; WebGPU arcs + pair coloring; optionally a Samplot-style stacked multi-sample SV panel driven by the existing carrier-loading. | **P3** | L |

## D. Navigation, session & output — table stakes

| # | Feature | Seen in | Why it's useful | How it could be built here | P | Lift |
|---|---------|---------|-----------------|----------------------------|---|------|
| 14 | **Search box: gene name / rsID / HGVS / region** | UCSC, IGV, Ensembl, gnomAD | Today you can jump by *sample* but not by *gene or variant* — the most common way people navigate. | Gene name → coords from the genes cache (already local); rsID/HGVS → coords via dbSNP/UCSC (reuse UCSC bridge + cache); a search box mirroring the sample-search UX. | **P1** | S |
| 15 | **Session save / restore + shareable link** (region, tracks, selections, comments) | IGV sessions, JBrowse, UCSC sessions | Reproducibility and collaboration — and comments already imply a shared workspace. "Open where my colleague was looking." | Serialize view-state → JSON in `gcs_session_dir`; a "share" encodes region+tracks+selection; restore on load. Natural sibling of the comments layer. | **P2** | M |
| 16 | **Bookmarks / regions-of-interest list** | IGV ROIs, UCSC | Curate a worklist of sites to revisit across a session — nearly free given the comments anchor system. | A "bookmark" is a comment with an empty body + a flag; add a ROI list panel + jump, reusing comment anchors, storage, and locus pins. | **P2** | S |
| 17 | **Export current view as figure** (SVG/PNG) | IGV, JBrowse, UCSC | Publication/slide figures straight from the tool — frequently requested, currently impossible. | The SVG track layer already exists; compose it with a rasterized snapshot of the WebGPU/flow canvases into one SVG/PNG; a toolbar "export". | **P2** | M |
| 18 | **Multi-locus / split view** (two regions or SV breakpoint ends side by side) | IGV split screen, JBrowse breakpoint view | Compare loci, or see both ends of a translocation — impossible in a single linear view. | Larger: parameterize the renderer for N panes sharing state; JS layout + per-pane view-state. Pairs well with the SV work (#13). | **P3** | XL |

## E. Extensibility & data (bring-your-own)

| # | Feature | Seen in | Why it's useful | How it could be built here | P | Lift |
|---|---------|---------|-----------------|----------------------------|---|------|
| 19 | **Load arbitrary tracks** (bigWig / bigBed / BED / GFF, local or `gs://`) | IGV, JBrowse, UCSC track hubs | Users always have their own annotations/signal; a generic loader turns genomeshader into a home base rather than a fixed viewer. | Rust bigWig/bigBed reader → interval or signal track (shares plumbing with the signal-track TODO and the scheme-aware fetch layer already built for multispecies). | **P2** | L |
| 20 | **Synteny / cross-species comparative view** | JBrowse 2, Ensembl, MCScan | Cashes in the new multispecies support — align the same locus across references/species. | XL: needs alignment data + a comparative renderer; a long-horizon flagship, listed for completeness. | **P3** | XL |

---

## Suggested first slice (my recommendation, for discussion)

If we want maximum mission-per-unit-effort, the tight cluster is **#7 (consequence)
+ #14 (gene/variant search) + #11 (coverage) + #1 (sample metadata)**: together they
close the loop the Help text already promises — *find which variants matter
(consequence, search), see who carries them (metadata), and confirm from reads
(coverage)* — and each is S–M lift on infrastructure that already exists. **#8
(ClinVar)** and **#16 (bookmarks)** are cheap wins riding the UCSC bridge and the
comments system respectively. The bigger bets (**#2 genotype matrix**, **#13 SV**,
**#18 split view**, **#20 synteny**) are where genomeshader could differentiate hardest,
but they deserve their own scoping conversation.

*Nothing above is implemented — this is a menu for us to prioritize.*
