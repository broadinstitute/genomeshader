
## 2026-09-01T13:52:02Z  — Read-track coordinate desync + IGV vertical-scroll plan

**Context.** User: (1) reads on a sample track move "faster than the rest" when
scrolling and don't sit at their real genome coordinates; (2) no way to scroll
down through more sample tracks when the reads area is full.

**Decision / action.** Root-caused (1): the ruler/reference/variant header maps
bp→x against tracksWidthPx() (tracks.js:18) but renderSmartTrack mapped reads
against the smart-track container's OWN width (main.js:72). When a per-sample
vertical scrollbar appears (overflowY:auto), the container width differs from the
header width, so the read genome axis is scaled differently → wrong x + different
pan rate. Fixed by introducing genomeW = tracksWidthPx() and mapping all 8+ read
genome-x calls against it (commit on jts-add-multispecies-support).

Asked the user the scroll-model fork; they chose **IGV-style**: pin
ruler/reference/variants, scroll the sample/read-track stack below as one synced
unit, remove per-sample internal scroll, reads at full height.

**Why.** (1) is a concrete, reason-verifiable bug — fixed now. (2)+the full IGV
scroll is a core vertical-layout refactor (smart tracks are absolutely positioned
by contentTop; no global scroll; header is transparent SVG so scrolled reads
would bleed into it). Cannot verify headless (WebGPU + comm).

**Outcome.** Stage 1 (coordinate/sync) shipped. Stage 2 (IGV scroll) is the next
focused step — native-scroll wrapper for the smart-track region below the flow
track, header pinned, per-sample internal scroll removed, canvases sized to full
read height. Needs real-browser iteration with the user.

## 2026-09-01T14:06:20Z  — Stage 2: IGV-style vertical scroll for the read-track stack

**Context.** User chose IGV-style: pin ruler/reference/variants; scroll the
sample-track stack below as one unit; KEEP each sample's bounded height + internal
read scroll (no full-height render — downsampled pileups coming later).

**Decision / action.** Added #smartScroll: an overflow-y:auto wrapper inside
tracksContainer positioned at the header bottom (min smart-track contentTop), with
an absolutely-positioned #smartScrollSpacer sized to the total stack height so the
wrapper has scroll height (its children are absolute). Smart-track containers now
append into #smartScroll (smart-tracks.js) and position at contentTop - headerTop
(main.js renderSmartTrack). positionSmartScrollWrapper() runs in renderAll before
the smart render loop. Wheel over the wrapper stopPropagation (no genome zoom) but
not preventDefault, so native inner->outer scroll chaining works. Horizontal pan
still translates the containers via _panLayers (X) independent of the wrapper
scroll (Y). Vertical mode: wrapper is a full-size transparent passthrough (columns
render as before) — vertical smart track is separately deferred (#49).

**Why.** Native scroll handles clipping, the scrollbar, and inner/outer chaining
for free; a manual scroll-offset + clip-path + opaque-backdrop approach fought the
transparent-SVG header z-layering. Bounded per-sample height is unchanged, per the
user's downsampling direction.

**Outcome.** Shipped. CANNOT verify headless (no smart tracks + WebGPU) — needs
Lab: confirm header pins, the stack scrolls, per-sample internal scroll still
works, reads stay x-aligned, horizontal pan still syncs.

## 2026-09-01T00:00:00Z  — Reference-based SNP calling for BAMs without MD tags

**Context.** SNPs in the read (sample) tracks were only surfaced from the `MD`
tag (`md_mismatch_positions`, added earlier). The user's BAMs ship without `MD`,
so no SNPs rendered. User: "Don't the Bam files have the actual sequences in
them?" — yes: `record.seq()` has the read bases; the only missing ingredient to
call a SNP is the reference base to compare against, and genomeshader already
stages the reference per locus.

**Decision / action.** Thread the staged reference for the locus into the Rust
read extractor and diff M-run read bases against it when the read has no `MD`.
- `alignment.rs`: new pure helper `ref_mismatches_in_run(read_bases, run_read_start,
  run_ref_start, run_len, ref_seq, ref_seq_start) -> Vec<(pos,base)>` (all 1-based,
  uppercases both sides so soft-masked lowercase reference doesn't false-positive,
  skips `N` and out-of-window positions). `extract_reads` gains `ref_seq:
  Option<&[u8]>, ref_seq_start: u32`; in the `Cigar::Match` branch, when
  `!read_has_md` and a reference is present, it emits a `DIFF` per mismatch.
- The per-read `has_md` column is repurposed to "SNPs displayable" =
  `read_has_md || ref_seq.is_some()`, so the frontend "SNPs unavailable" toast
  now fires only when neither `MD` nor a staged reference exists.
- Threaded the two new params through `stage::fetch_reads_from_bam_urls` and
  `lib::get_reads_with_cache`; staging call sites (`stage_data_from_one_file`,
  `fetch_reads_single`, `get_locus`) pass `None, 0` (reference only matters on the
  live locus fetch). `lib::fetch_reads_for_locus` gains `reference: Option<String>,
  ref_start: u32` (needs `#[pyo3(signature=...)]` since a required arg follows an
  `Option`).
- `view.py::_fetch_reads_payload`: before the fetch, `self.reference(contig,
  start-1, end)` (0-based) gives the window sequence whose first base is 1-based
  `start`, matching Rust's 1-based `ref_pos`; forwarded as `(ref_seq or None,
  start)`. Wrapped in try/except → empty ref on failure. Bumped
  `_READS_CACHE_VERSION` to `v2` so stale no-SNP disk caches miss.

**Why.** No `samtools calmd` / MD-rewrite step required; reuses the reference
genomeshader already stages (works for the non-UCSC Pf genome via the GCS
reference blob). Reference-derived SNPs only computed within the fetched window;
read bases outside it are off-screen anyway.

**Evidence.** `cargo test --lib md_tests` → 2 passed (incl. new
`ref_diff_finds_snps_with_correct_coords`: mismatch coords, soft-clip offset, `N`
skip, out-of-window skip). `cargo build --release` clean (pre-existing pyo3
`non_local_definitions` + unused-`mask` warnings only). `pytest test_widget.py
test_plasmodb.py` → 49 passed, incl. new `test_staged_reference_forwarded_to_fetch`
(asserts 0-based `reference(...,99,200)` and forward `(...,"ACGTACGT",100)`).

**Outcome.** No-MD BAMs now show SNPs from the staged reference. Needs the user's
`maturin develop --release` on the Mac + Lab verification of rendered mismatch
glyphs (end-to-end path is WebGPU/comm — added to README manual-check list).
Old reads disk caches auto-invalidated by the v2 key bump.

## 2026-09-01T00:30:00Z  — No SNPs on real data: cache suspected

**Context.** After shipping reference-based SNP calling + integration test
(commit d5ebcaa), user reports no SNPs in read tracks at
Pf3D7_01_v3:99002-101999 (sample FP0009-C).

**Evidence.** Diagnostic run: `reference(c,a-1,b)` -> reflen=2998 (matches
locus span, so reference IS served for this window). Read payload element
counts: `{4:12420, 0:9987, 3:550, 2:161}` — softclip/read/del/ins present,
**zero type-1 (SNP)** across ~10k reads over 3kb. Implausible for a locus with
selected variant alleles => ref_seq never reached the extractor this run.

**Hypothesis (leading).** `_fetch_reads_payload` (view.py:1052) serves a cached
disk payload before calling Rust. A v2 cache written earlier — when
`reference()` still returned "" (UCSC/staged cache not yet warm) — is a 0-SNP
payload that keeps being served even though `reference()` works now. The v2 key
(locus+bams) doesn't encode whether a reference was applied, so it can't
distinguish a ref-less payload from a ref-full one.

**Next.** Asked user to re-fetch with GENOMESHADER_NO_READS_CACHE=1 and report
element counts + has_md. If SNPs appear => make the reads cache key/version
depend on reference availability (or store ref presence in the payload and
invalidate). If still zero => extractor bug on real reads; dump one read's
CIGAR+SEQ to trace.
