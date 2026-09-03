# Task list snapshot

Persisted from the session task tracker so it survives a container rebuild.
Status as of the closed-loop-harness + scale work on branch `jts_scaling_updates`.
`[x]` done, `[ ]` open. ⚠️ = implemented blind (no browser in container), needs
verify in a real browser — see planning/MANUAL_TESTS.md.

## Open

- [ ] **#49** Vertical mode: upright text, track names/menus top-left, fix sample track. `translateFrame` core tested; render not wired. LOW PRIORITY (UI polish, off the scale path)

### Deferred / decision-gated future work (not blocking)
- **Tier 3 (Population / AoU, >~100K)** — build when an AoU-scale callset is the real target. Default producer = on-demand windowed aggregation over the native store + lazy per-window cache (NOT a precompute pipeline); precompute→tiled store is an optional accelerator. Gated on Jonn's privacy/small-cell + access-tier (Registered vs Controlled) decision + an AoU review. See DATA_LOADING_SCALE_V2.md §7/§13.
- **P3 density LOD** — binned AF track for wide windows; the lever that keeps live Tier-3 aggregation bounded. Orthogonal, deferrable.
- **Per-group aggregates** — retrofit `{group→{allele→count}}` when per-ancestry/case-control views (feature-gap #1/#3) are built (decided: defer, don't pre-reserve).

## Done

- [x] **#36** Scale plan v1/v2 — DESIGN FINALIZED + decisions recorded. Near-term (Tiers 1–2) is BUILT: P1 (#68/#69/#70) + P2 (#71). Decisions locked: per-group defer+retrofit; tier-switch deferred (one-armed today); Tier 3 = on-demand windowed aggregation + lazy cache default, precompute optional accelerator. Docs reconciled (both DATA_LOADING_SCALE*.md). Remaining Tier-3 privacy decision tracked as deferred/decision-gated above
- [x] **#35** Multi-instance: 2nd widget in a notebook renders blank
- [x] **#37** Fullscreen/live-pan stutter: debounce mid-drag rebuild
- [x] **#38** Double-click allele freezes briefly + sluggish after
- [x] **#39** Restore taller notebook height
- [x] **#40** Remove Settings button from the right panel
- [x] **#42** Make track divider/resize handles visible (both themes)
- [x] **#43** Double-click with panels open deselects the allele
- [x] **#44** Default read-selection strategy to best-evidence (random last)
- [x] **#45** Allele reorder drag must not slide the track horizontally
- [x] **#46** Close/reopen read track: reads reappear instantly (cache)
- [x] **#47** Right-click then left-click leaves pan stuck
- [x] **#48** Comment dialog: author name + anchor-type chooser
- [x] **#50** Rename Locus track to Indel track; indels-only; deletion visualization
- [x] **#51** Allele reorder: hit-test by nearest node midpoint, real-time reorder
- [x] **#52** Help: add a legend with examples of each field/allele type
- [x] **#53** Indel tooltip: show INS/DEL indicator
- [x] **#54** Track dividers: same width/appearance at rest as on hover
- [x] **#55** Deletion shading only when the deletion is selected on the Indel track
- [x] **#56** Fix incomplete Help icon
- [x] **#57** Settings inputs not following light theme
- [x] **#58** Comments on reference track, not indel track
- [x] **#59** Comments tab: total count + prev/next navigator
- [x] **#60** Include timezone in comment timestamps
- [x] **#61** Cross-reference chat/git log for missed requests
- [x] **#62** 0-sample tooltip: honest wording
- [x] **#63** Indel: toggle ins/del at mixed positions + repeated-ref deletion rows + grey
- [x] **#64** Comment threads: replies, unread badge, sort/filter
- [x] **#65** Virtualize smart-track canvas (lift 300-read cap). PIXEL-VERIFIED on real GPU: `test_webgpu_pixels.py` — 500-read pileup → >300 rows, no crash; scroll repaints the virtualized window
- [x] **#67** WebGPU SNP base letters. PIXEL-VERIFIED: SNP (Diff) elements draw base letters on the Canvas2D text overlay above the WebGPU read canvas. (Impl is a 2D overlay, not a literal WebGPU glyph atlas, but the letters render.)
- [x] **#66** Collapse smart tracks to one WebGPU canvas. OBVIATED by #65 and VERIFIED so: 4 tracks × 400-read pileup → each canvas viewport-sized (~0.26MP), depth lives in the scroll spacer not the canvas. No full-stack canvases to collapse. Regression-guarded by `test_smart_track_canvas_is_viewport_bounded`
- [x] **#71** P2 viewport-driven variant loading (frontend). Wired over the existing server `fetch_variants` handler + store cores: on pan/zoom settle fetch the visible window ± overscan (view-state.js `gsLoadVariantsForViewport`), coverage-skip, evict far windows, union+dedup into `variant_tracks`. Gated on `GENOMESHADER_CONFIG.viewport_variant_loading`. Serves the ≥1M-sample scale goal (browser pages through a cohort larger than memory). Tests: `test_viewport_variant_loading.py` (4, headless, no GPU)
- [x] **#41** No blank edges on pan (data/window overscan). Folded into #71: each fetch pulls viewport ±50% so post-pan edges already have variants. Mid-DRAG transient blank (pre-rebuild) left as optional render-overscan polish (coordinate-core, low pri)
- [x] **#68** P1: aggregate-only variant payload (drop per-sample) — gate tested
- [x] **#69** P1: fetch_carriers comm handler (carriers on demand). NOTE: found+fixed a real panic in this path (zero-width locus `chr:pos-pos` → iset panic); now integration-tested end-to-end
- [x] **#70** P1b: emit per-variant aggregates from Rust. `cargo test aggregates_match_longformat_recompute` + integration test vs brute-force truth (per-sample carrier semantics)

## Not-on-the-numbered-list, still tracked

- Closed-loop test harness — DONE: `scripts/setup_test_env.sh`, `python/tests/test_integration_extension.py`, `planning/DEV_ENV.md`
- WebGPU pixel test suite — DONE: `python/tests/headless/test_webgpu_pixels.py` + `harness_gpu.py` (real Chrome on the GPU); read-seeding seam `window.__GS_TEST_seedSmartTrack` in smart-tracks.js; caught + fixed a real `requestAdapter()` no-retry bug (first read track after load dropped to Canvas2D). Guide: `planning/WEBGPU_TESTING.md`
- Codon track render — `translateFrame` core tested, render not wired
- UCSC signal tracks (value renderer) — deferred, see [[genomeshader-deferred-work]]
- GCS comment store via client library — deferred
- WebGPU pixel testing — **NOW WORKING** on the Quadro RTX 8000 (2026-09-03). `scripts/setup_gpu_webgpu.sh` + `scripts/webgpu_smoke.py` (paints rgb(64,128,192), reads it back exact on nvidia/turing). Requires operator to launch with `--device /dev/nvidia-modeset`; then Xvfb (NVIDIA Vulkan ICD needs an X display) + real Chrome headed + localhost origin. See DEV_ENV.md "WebGPU on the real GPU". #65/#67 can now be pixel-verified in-container instead of only on the user's Mac

## North star (do not lose)

Must scale to **≥1M human samples AND ≥50k malaria samples**. Aggregate-first:
everything the viewer renders derives from per-variant aggregates independent of
sample count; carriers fetched on demand. Real malaria data points coming from
user later; synthetic/canned data fine until then.
