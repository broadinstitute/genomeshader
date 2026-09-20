# Multi-locus tile view — handoff for Claude Code

Prepared 2026-09-20. This is a handoff of an in-progress feature that is
**architecturally landed but not product-ready**. User QA still shows the same
class of failures (missing evidence on some tracks, blanked tiles after SA-open,
ribbons from empty rows). Treat the current implementation as a prototype that
needs a correctness pass, not polish.

Original implementation brief: 2026-09-18 (full text summarized below). Working
session transcript: Cursor agent chat covering Phases 1–7 plus subsequent race /
freeze / diploid-BAM fixes.

---

## 0. Status update — correctness pass (Claude Code, 2026-09-20)

The freeze/relocate design described in §2–§3 has been **removed**. Every tile now
owns a persistent reads stack, so focus changes cannot blank a column.

**New model (read this before touching reads code):**

- **One reads stack per tile.** `.gs-smart-scroll` wrapper + one `.smart-track-container`
  (canvases) per smart track live *inside each tile's own column* and are never moved.
  Renderers are stored on `tile._smartRenderers` (Map<trackId, renderer>);
  `state.smartTrackRenderers` is just an alias of the focused tile's map.
  DOM ids stay classic for the first holder (`smartScroll`, `smart-track-container-<id>`)
  and are suffixed with the tile id afterwards. (`gsEnsureSmartRenderers`,
  `initSmartTrackWebGPU(trackId, tile)`, `gsSmartScrollIn`.)
- **Per-tile views instead of snapshots.** `gsResolveTrackView(track, tile)` derives what a
  tile shows for a track from the chunk store (below), memoizes the packed layout per tile, and
  keeps the tile's *previous same-contig view* while nothing overlapping is cached (a jump never
  blanks a tile). `gsWithTrackView` swaps a tile's view into the track for the paint and
  restores the focused tile's live payload afterwards. Single-tile mode resolves through the
  same views.
- **Multi-tile reads paint through Canvas2D for every tile** (deterministic, identical
  columns). Single-tile mode is unchanged (WebGPU). Closing back to one tile re-creates
  WebGPU renderers if the survivor only has 2D ones.
- **Fetch identity is (sample, BAM pin, chunk)** — see "Data loading" below. A job is never
  keyed by "the current locus" at run time (a job queued while A was focused used to fetch and
  cache B's window when it finally ran), and one tile's request can never cancel another's.
- **Ribbons** read each tile's own view and its own live container (no freeze selectors);
  bundle colors are a stable hash of (track, tile pair, strand combo, dest contig), not
  creation order. "View"-scale coverage summaries normalize per tile.

**Data loading: reloading is the worst case, not the default (`reads-cache.js`).**
Reads are cached as aligned *chunks* per (sample, BAM, contig), like map tiles — never as
the literal window the user asked for.
- **Chunks.** 16 kb … 4 Mb (smallest power of two ≥ the window span). A window is served by
  assembling the chunks that cover it (`gsAssembleChunks`: reads that straddle a chunk edge
  are de-duplicated, their elements unioned). Pan/zoom inside loaded chunks does zero kernel
  work and never dims; a window is `exact` iff it is *fully covered* (`gsCoverageGaps`).
- **Prefetch.** Once a window is complete, the chunk-sized neighbour beyond each outer covering
  chunk is prefetched (anchored on the covering chunks, so zooming does not invent a new grid).
- **Batching.** The scheduler (`gsReadsWanted` / `gsEnsureReads` / `gsReadsPump`) sends every
  missing chunk of every track and every open tile as ONE `fetch_reads_batch` (bursts coalesced
  over 25 ms, ≤16 units per batch, demand before prefetch, one batch in flight). Failures
  back off (`__GS_READS_RETRY_BASE_MS`, max 5); explicit actions pass `{force:true}`. A track
  that has *never* loaded anything and fails is dropped with one modal (as before).
- **Kernel + Rust.** `GenomeShader._fetch_reads_batch_payload` resolves BAMs per item, serves
  single-BAM chunk hits from the JSON cache, computes each chunk's reference once, and makes
  ONE call to Rust `Session.fetch_reads_batch`, which fans out over chunk×BAM with rayon and
  the GIL released (~6× faster on 12 cold units here). The parquet/GCS cache key is the chunk
  itself, so chunks are shared across sessions/users. A cache hit now returns exactly what a
  fresh fetch returns (it used to re-filter element rows by window, dropping soft clips /
  SNPs outside it — different payloads for the same request). Rebuild the extension with
  `VIRTUAL_ENV=$PWD/venv PATH=$PWD/venv/bin:$PATH maturin develop --release` and restart the
  kernel. Older extensions fall back to per-unit `fetch_reads_for_locus`.
- **Disconnect** (locus-bar toggle, `gsSetConnected`): every data request (`GS_DATA_FETCH_TYPES`
  in `widget-comms.js`/`jupyter-comms.js`) is refused locally with a `gsDisconnected` error that
  callers treat as a quiet skip; queued work is dropped, a batch already running in the kernel
  is not recalled (its result is still cached). Cached windows stay fully usable; uncovered ones
  are dimmed. Connect resumes loading.
- **Staleness cue:** only the dim. Each track container carries `data-view-state` =
  `exact | stale | offline | failed | loading`; all but `exact`/`loading` render at 45% opacity.
  No text badges. "No evidence drawn" therefore means *loaded and absent*.
- **Variants** already page with overscan; the keep-span now has a 500 kb floor (zooming IN no
  longer evicts the wide window) plus an 8-region cap per contig.
- Debug from the browser console: `__GS_TEST_tileViews()` (per tile/track: window sig, exact?,
  nReads/nAll/nSa/nClip, state) and `__GS_TEST_tileAmber()` (soft-clip marker pixels). Exact with
  `nClip == 0` ⇒ the payload lacked the evidence (kernel side); `nClip > 0` and no marker ⇒ paint bug.

**Tests** (assert *painted pixels* via `__GS_TEST_tileInk`, not cache keys):
`python/tests/headless/test_tile_reads_persistence.py` + shared `reads_mock.py` (real-BAM-shaped
mock that answers `fetch_reads_batch`, returns only reads overlapping the requested chunk):
persistence through SA-open/focus flips/pans, chunk semantics (no fetch inside loaded chunks,
prefetch ring, one batch per demand set, boundary de-duplication, zoom-out served from
coverage), retry/backoff, dimming, Disconnect/Connect, close-tile, ribbons/colors, per-tile
coverage scale. Kernel side: `python/tests/test_reads_batch.py`.

**Known pre-existing failures (also fail on pristine HEAD, unrelated):**
`test_sidebar_title_bar.py::{test_chevron_syncs_with_visibility_reads,test_title_fills_when_actions_hidden}`,
10 macOS/Metal-vs-Vulkan pixel diffs in `test_webgpu_pixels.py` (run it on macOS with
`harness_gpu.GPU_CHROME_ARGS = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]`).

**Verified end to end (scratch, not in the suite):** the real client driven by real mouse events
against the real Python kernel handler + rebuilt Rust extension on `scratch/testdata` BAMs
(a session of ~12 hovers/drags across two tiles = 4 kernel round-trips, 24 chunk units).
**Not verified:** a live JupyterLab kernel against AoU/nearline GCS.

Sections 2–3 below describe the *old* design and are kept for history.

---

## 1. Original idea

### Problem

Genomeshader shows **one contiguous genomic interval** at a time. Structural
variants with distal or multi-chromosomal breakpoints (translocations, large
inversions, insertions from a distal donor) do not fit that model:

- Zooming out far enough to fit every breakpoint destroys base-level resolution.
- Breakpoints on different chromosomes cannot share one coordinate axis.

### Goal

Replace the single global viewport with an arbitrary number of independent,
resizable **tiles** in a horizontally scrolling strip:

- Each tile is a full genomic column (genes / repeats / reference / variants /
  sample reads) with its own contig, window, zoom, and optional 3′←5′ flip.
- Reads whose alignment splits across two open tiles (via `SA:Z` supplementary
  alignment, or paired-end mate) are clipped at the tile edge and connected by a
  **cross-tile arc / ribbon**.
- Primary creation path: right-click a soft-clipped / SA end → **“Open linked
  tile here”**. Secondary: docked `+`, or open from a VCF BND mate.
- Result: reconstruct how a complex rearrangement is wired by opening one tile
  per involved locus — the way you’d sketch it by hand.

### Prior art gap (why this exists)

| Tool | Gap vs. this feature |
| --- | --- |
| IGV split screen / read arcs | Arcs within one coordinate space; no true N-panel cross-chr tiles |
| JBrowse 2 Breakpoint Split View | Capped at exactly two panels; special modal, not normal track stack |
| JBrowse 2 Linear Synteny | Assembly synteny, not per-read SV breakpoints in one BAM |
| Ribbon (Marth lab) | Read-centric squiggle; not annotated genomic tiles |
| samplot / svviz | Static images, not an interactive browser |

**Gap:** interactive browser where tiles are first-class, arbitrary in number,
individually resizable/flippable, and live inside the normal track stack.

### Agreed UX (locked decisions)

- **Default:** one tile = today’s UI unchanged (contig box, Go, ideogram).
- **Resize:** widening a tile shows **more sequence at the same `pxPerBp`**
  (span grows; no zoom-driven re-fetch).
- **BND:** in v1 — open tiles from VCF breakend ALT / `MATEID`, not only from
  reads.
- **Linked-tile insert:** new tile inserted **immediately after** the source
  tile.
- **Pills:** when N≥2, toolbar swaps to truncating/scrollable locus pills;
  drag reorders tiles.
- **Focus:** exactly one focused tile; toolbar / pan / zoom target it.
- **Arcs:** clipped ends + colored directional flags; bezier ribbons in the
  gutter between adjacent tiles, colored by breakpoint group / bundle.

### Phased plan (as originally scoped)

1. **SA:Z extraction** in Rust `extract_reads` → `sa_tag` column (done).
2. **Multi-tile state** — ordered `state.tiles[]`, focus aliases onto
   `state.contig/startBp/endBp` (done, with many sharp edges).
3. **Tile strip DOM** — per-tile canvases, dividers, horizontal scroll (done).
4. **Cross-tile arcs** — evolved from per-read beziers to **aggregated
   ribbons** + soft-clip gutters (done, still buggy).
5. **Toolbar pills** (done).
6. **Per-tile flip** 5′→3′ / 3′→5′ (done).
7. **“Open linked tile here”** from SA / BND (done, race-prone).

Synthetic fixtures for QA live under `scratch/testdata` (fusion TRA
`chr14:32149950` ↔ `chr20:32005500`, INV, DEL, 3-way complex) and are exercised
from `playground.ipynb` with `attach_assemblies("hifiasm", …)` diploid hap1/hap2.

---

## 2. What was built (map for the next agent)

| Area | Primary files |
| --- | --- |
| Tile state / focus / add / pan | `python/genomeshader/html/scripts/tiles.js` |
| Strip DOM, freeze snapshot, open-linked, SA parse, context menu | `…/tile-ui.js` |
| Bundle clustering + ribbon SVG | `…/tile-arcs.js` |
| Smart-track fetch / cache / hydrate / height locks | `…/smart-tracks.js` |
| Multi-tile `renderAll` (paint every column, freeze unfocused) | `…/main.js` |
| SA column in reads payload | `src/alignment.rs` |
| BND mate fields on variants | `src/variants.rs`, `python/genomeshader/view.py` |
| Diploid assemblies as evidence | `view.py` `attach_assemblies` |

**Core architectural compromise:** the app still has a **singleton live
viewport** (`state.contig/startBp/endBp` + one relocatable `#smartScroll`
stack). Multi-tile works by:

1. Mirroring the focused tile onto those globals.
2. Painting each tile inside `gsWithTile(tile, …)`.
3. **Freezing** unfocused columns as Canvas2D snapshots
   (`.gs-smart-scroll-freeze`) so the live stack can move to the focused tile.

That freeze/hydrate/cache design is where most remaining bugs live.

---

## 3. Problems noticed in the codebase (and while implementing)

These are the systemic issues — not a changelog of every patch. Several were
“fixed” more than once and **regressed under slightly different user paths**.
Assume they are still live until proven otherwise with stronger tests + manual
QA.

### 3.1 Singleton viewport pretending to be multi-viewport

- Almost all drawing (`xGenome`, insertion gaps, variant viewport loads, gene
  restores) still assumes one contig/window.
- Multi-tile was bolted on via focus aliases + `gsWithTile` rather than true
  per-tile renderers with independent smart-scroll stacks.
- **Symptom class:** paint one column, then relocate live DOM → sibling looks
  empty / Loading / wrong locus until a freeze is captured. Focus, pan, SA-open,
  and height-lock changes all retrigger this seam.

### 3.2 Smart-read cache keyed too loosely for diploid BAMs

- Samples from `attach_assemblies` have **two BAM URLs** (hap1 + hap2) sharing
  one `sampleId`.
- An early cache design also stored under an **empty BAM pin** alias so
  hydrate-before-pin would hit. That **clobbered hap1 with hap2** (hap2 often
  has almost no fusion SA) → UI showed BND in “2 samples” but only the **last
  track** had soft-clip evidence.
- Sibling-BAM **inflight coalescing** once skipped “any fetch for this
  sample|locus,” so the second haplotype never loaded after SA-open/ensure.
- **Lesson:** cache key must be `sampleId|bamUrl|locusSig` with **no cross-BAM
  fallback** when a pin is set. Ensure/enqueue must be **per pin**, not per
  sample.

### 3.3 Fetch queue races across contigs

- Opening a linked tile enqueues chr20 fetches for the same track ids that still
  had chr14 in flight.
- An earlier coalesce rule cancelled same-track queued jobs **across contigs**,
  wiping SYN001’s source-locus load. Fixed to same-contig-only cancel; still
  easy to reintroduce.
- `spawnSmartTracksForSample` originally bypassed the serialized queue and
  stampeded the kernel (timeouts → `removeSmartTrack`).

### 3.4 Freeze snapshots are fragile

Recurring failure modes:

- Freeze captured while tracks still `loading` → permanent blank / “Loading…”
  bitmap on the unfocused column.
- Late `fetch_reads` completion cleared `_freezeReadsSig` for unfocused tiles →
  next `renderAll` relocated live stack into the source column at the **mate**
  locus → **evidence erased** after SA-open.
- Multi-tile **height locks** changing invalidated all freezes at once; rebuild
  failed while loading → blank gutters with ribbons still drawn from cache.
- Freeze “has pixels” checks are coarse (any canvas width/height > 0), so a
  mostly empty snapshot can still count as “good.”

### 3.5 Ribbons vs. painted evidence disagree

- Bundles are built from **cached layouts** (`gsLayoutReadsForTile` /
  `smartTrackReadsLayoutForTile`), not from what’s visible in the freeze.
- Endpoint Y used to fall back to **track midline** when the tile had no
  supporting reads → **arcs from empty rows** (mate-side SA alone).
- Ribbon Y also drifted when per-tile track heights / orientation banners /
  compact chrome differed between focused and unfocused columns.
- Bundle colors were sometimes keyed from the wrong tile’s paint pass.

### 3.6 Focus / pan / status bar interactions

- Pan then switch focus: unfocused freeze stuck on Loading; status bar busy
  forever (`_readLoadsInFlight` / auto-hide races).
- Hover-focus vs click-focus both trigger ensure/prefetch; easy to cancel or
  overwrite the column the user was looking at.
- SampleId / `requestedBamUrl` historically unset until the first fetch
  returned → mate prefetch skipped entire samples.

### 3.7 Annotation / flip / layout leftovers from singleton era

Discovered early and partially fixed, but indicative of the same theme:

- Reversed tiles used signed widths for genes/RepeatMasker (features vanished).
- Multi-tile still sharing one annotation blob until per-contig restore.
- Vertical orientation disabled or broken once N>1 (by design for v1, but
  vertical-mode code paths still assume one axis).

### 3.8 Test coverage was far too weak for the failure mode

Headless Playwright tests were added late and still do **not** match the
severity of user-reported bugs:

| Suite | What it catches |
| --- | --- |
| `python/tests/headless/test_tiles.py` | Basic strip / open tile plumbing |
| `test_tile_read_races.py` | SA-open must not cancel source-locus fetch; pan+focus Loading |
| `test_tile_layout_parity.py` | Ribbon Y alignment, control chrome, bundle color keys |
| `test_tile_diploid_bnd.py` | Both hap1 tracks get SA; source freeze survives SA-open; no ribbons without SA on both sides |

**Gaps the next agent should close:**

- Assert **painted** freeze content (or dump `nReads`/`nSa` per track **and**
  freeze canvas non-blank per track), not only cache keys.
- Diploid **ordering** (hap2 before hap1) and empty-pin regression under load
  races with realistic delays.
- Expand-track → right-click SA → open linked → **source tracks still show
  soft-clip ticks** in the freeze DOM.
- Ribbon count / track-id endpoints must match tracks that have supporting
  reads **on the source tile**, including after height-lock refresh.
- Real kernel path (not only mocked `__GS_SEND`) against `scratch/testdata`
  assemblies for SYN001+SYN002 hap1/hap2 at the fusion locus.
- Manual playground checklist should be automated where possible; screenshot QA
  alone is how these bugs kept shipping.

---

## 4. Known good fixture / repro

**Locus:** `chr14:32147950-32151950` (ARHGAP5 fusion BND `bnd_fusion_14`).

**Evidence:** From alleles → Evidence **hifiasm** → load SYN001 + SYN002
(both eligible; VCF says 2 samples).

**Expected:**

- Four smart tracks: SYN001 hap1, SYN001 hap2, SYN002 hap1, SYN002 hap2
  (order depends on `read_bam_index`).
- **Both hap1** tracks show soft-clipped SA at ~32,149,950 (3 chimeric contigs
  in testdata). Hap2 is nearly empty / no fusion SA.
- Expand a hap1 track → right-click SA → open linked tile on chr20.
- Tile A keeps its hap1 evidence (freeze). Gutter shows ribbons only for tracks
  that have SA support on **both** sides — not from blank hap2 / empty rows.

**Still failing in user hands (as of 2026-09-20):** same nature as above —
missing evidence on some tracks, blanked source after SA-open, arcs from empty
tracks, inconsistent colors / handles / ribbon attachment. Do not trust “tests
green” alone.

---

## 5. Suggested approach for Claude Code

1. **Reproduce in headless first** with the diploid mock + a stricter dump
   (per-track freeze + SA counts before/after `gsOpenLinkedTile`). Do not iterate
   on screenshots alone.
2. **Consider replacing freeze-relocated live stack** with per-tile smart-scroll
   (or a single compositor that never moves DOM between columns). The freeze
   approach has burned multiple fix cycles.
3. **Treat cache / inflight / freeze / ribbons as one state machine** with
   invariants written down and asserted:
   - Every smart track with a BAM pin has an independent cache entry per locus.
   - Unfocused tile freeze is only replaced when the new snapshot has ≥ prior
     supporting-read coverage for that locus (never blank over good).
   - A ribbon exists iff both endpoint tiles have layout reads for that
     qname/track.
4. **Re-read** `smart-tracks.js` (`_smartReadsCache*`, `ensureSmartTracks*`,
   `hydrateSmartTracksForCurrentLocus`, `spawnSmartTracksForSample`) and
   `main.js` `renderAll` multi-tile branch before changing arc code — most
   “arc bugs” were actually empty freezes or wrong cache hits.
5. Keep single-tile mode identical to pre-feature behavior; regressions there
   are unacceptable.

---

## 6. Open product questions (still soft)

- Ideal ribbon aggregation vs. per-read arcs when many splits share a
  breakpoint.
- Whether diploid hap1/hap2 should be visually grouped / labeled more clearly
  than today.
- How aggressive prefetch should be for every open tile (nearline / AoU cost).
- Whether BND-open and SA-open should share one code path end-to-end (they
  mostly do, but variant vs read entry still diverge in UX).

---

## 7. Pointers

- Playground walkthrough: `playground.ipynb` (complex SV section + hifiasm
  assemblies).
- Testdata generator: `scripts/generate_test_dataset.py` (fusion / INV / DEL /
  3-way).
- Headless harness: `python/tests/headless/harness.py`.
- Related planning: `planning/TODO.md` (unrelated deferred work); this file is
  the multi-locus handoff.
