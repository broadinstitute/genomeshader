# Task list snapshot

Persisted from the session task tracker so it survives a container rebuild.
Status as of the closed-loop-harness + scale work on branch `jts_scaling_updates`.
`[x]` done, `[ ]` open. ⚠️ = implemented blind (no browser in container), needs
verify in a real browser — see planning/MANUAL_TESTS.md.

## Open

- [ ] **#36** Scale plan: v1 (30K live) + v2 (1M/AoU tiered) — DESIGN, awaiting merge + decisions
- [ ] **#41** No blank edges on pan: implement overscan. `overscanRegion` core tested; render wiring not done (needs browser)
- [ ] **#49** Vertical mode: upright text, track names/menus top-left, fix sample track. `translateFrame` core tested; render not wired
- [ ] **#65** Virtualize smart-track canvas (lift 300-read cap). ⚠️ IMPLEMENTED blind (viewport canvases, `_scrollOffset`, sticky, spacer). Needs pixel verify — MANUAL_TESTS §5
- [ ] **#66** Collapse smart tracks to one WebGPU canvas. OBVIATED by #65 (viewport canvases → memory trivial). Likely close, don't reopen unless #65 verify shows a need
- [ ] **#67** WebGPU glyph atlas for SNP base letters. ⚠️ IMPLEMENTED blind (letters to textCanvas, offset on scroll). Needs verify — MANUAL_TESTS §6
- [ ] **#71** P2: viewport-driven variant loading. Server `fetch_variants_payload` done + tested; frontend pan-trigger NOT wired (needs browser)

## Done

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
- [x] **#68** P1: aggregate-only variant payload (drop per-sample) — gate tested
- [x] **#69** P1: fetch_carriers comm handler (carriers on demand). NOTE: found+fixed a real panic in this path (zero-width locus `chr:pos-pos` → iset panic); now integration-tested end-to-end
- [x] **#70** P1b: emit per-variant aggregates from Rust. `cargo test aggregates_match_longformat_recompute` + integration test vs brute-force truth (per-sample carrier semantics)

## Not-on-the-numbered-list, still tracked

- Closed-loop test harness — DONE: `scripts/setup_test_env.sh`, `python/tests/test_integration_extension.py`, `planning/DEV_ENV.md`
- Codon track render — `translateFrame` core tested, render not wired
- UCSC signal tracks (value renderer) — deferred, see [[genomeshader-deferred-work]]
- GCS comment store via client library — deferred
- WebGPU headless pixel testing — CHARACTERIZED DEAD END (see DEV_ENV.md). Blocked further by: this container has a Quadro RTX 8000 but no GPU passthrough — `/dev/nvidia*` open() returns EPERM even as root (AppArmor docker-default + cgroup device filter). Needs operator to relaunch with `--gpus`. Even with GPU, headless Chrome tears down the WebGPU instance; path would be headed-Chrome-under-Xvfb + NVIDIA Vulkan ICD

## North star (do not lose)

Must scale to **≥1M human samples AND ≥50k malaria samples**. Aggregate-first:
everything the viewer renders derives from per-variant aggregates independent of
sample count; carriers fetched on demand. Real malaria data points coming from
user later; synthetic/canned data fine until then.
