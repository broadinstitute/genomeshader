# Render overscan for live pan (no blank leading edge)

Status: **BUILT for horizontal (2026-09-08); vertical deferred.** Stages 1-5
landed on `jts_vertical_mode`. Horizontal live pan is overscan-backed (no blank
leading edge, no per-frame rebuild stutter). Vertical still pans by full
re-render (`panByPixels`) — the render-window abstraction (Stages 1-4) is
already wired for both axes, so vertical overscan only needs its geometry +
trigger. See the "DONE" note at the bottom.

## Problem

During a live drag-pan the viewer CSS-translates the pan layers (`_panLayers()`:
`tracksSvg`, `tracksWebGPU`, `flowCanvas`, `flowWebGPU`, `flowOverlay`,
`commentPinOverlay`, `smartScroll`, `.flow-track`) for 60fps smoothness, and
rebuilds only when the drag settles (debounced 110ms — see `livePanBy`). The
canvases/SVG are viewport-width, so the newly-revealed leading edge is **blank
until the pan stops**.

`livePanBy` already updates `state.startBp/endBp` on every move; only the RENDER
is stale. So the fix is to pre-render a region **wider** than the viewport and
show the center, so translating reveals pre-painted content.

## Why it's not a quick fix

- Coordinates come from `xGenomeCanonical(bp, tracksWidthPx())` mapping
  `[startBp,endBp] → [0,W]`, and **~100 sites** in `tracks.js`/`main.js` filter
  and draw against `state.startBp/endBp`.
- The cheap hack (temporarily expand `startBp/endBp` + widen layers around one
  `renderAll()`, then restore) **breaks**: the WebGPU pass reads the window
  asynchronously after the restore, so it draws the wrong region.
- The other cheap alternative (periodic rebuild *during* the drag) was already
  tried and rejected — it flickers in fullscreen and snaps the static tracks
  (chromosome/genes). See the comment in `livePanBy`.
- There are **three** independent pan containers (tracks `#tracksContainer`,
  flow `#flow`, reads `#smartScroll`) each with its own width basis
  (`tracksWidthPx`, `flowWidthPx`), so the widen/offset must be done per
  container.

Interaction/hit-testing is suspended during a live pan (`interaction.js`:
`if (state.livePanOffset) return`), so the overscan coordinate system only needs
to be correct for the transient drag visual — but at REST everything must be the
normal view window, so the split has to be clean.

## Design: render-window vs view-window

Introduce an explicit **render window** (possibly wider) distinct from the
**view window** (visible), off by default so behavior is identical until a pan
turns it on.

New helpers (ui-state.js):
- `renderStartBp()` / `renderEndBp()` — the view window `± state.renderPadBp`
  (0 by default).
- `renderWidthPx()` — `tracksWidthPx() + 2*state.renderPadPx` (0 by default);
  same for `renderFlowWidthPx()`.
- `state.renderPadBp` / `state.renderPadPx` — the overscan, set only during a
  pan-overscan render, else 0. Zoom is preserved because
  `renderPadPx = renderPadBp * pxPerBp`.

Migration (the bulk of the work, but SAFE because it's a no-op when pad=0):
- Replace `state.startBp/endBp` in **render range filters and x/width math** with
  `renderStartBp()/renderEndBp()/renderWidthPx()`. Do NOT touch interaction /
  hit-test / HUD / pan-math sites — those keep the view window.
- Size + offset the pan layers to `renderWidthPx()` and `left: -renderPadPx`
  (each of the 3 containers) so the viewport shows the center `[startBp,endBp]`.

## Overscan lifecycle

- `_beginPanOverscan()`: `renderPadPx = 0.5 * W` (half a viewport each side; a
  tunable knob), `renderPadBp = 0.5 * span`; size/offset the 3 containers;
  `renderAll()`; reset `livePanOffset = 0` (new translate baseline).
- `livePanBy(dx)`: translate the (now wider) layers as today. When
  `|livePanOffset|` exceeds ~`0.6 * renderPadPx`, call `_beginPanOverscan()`
  again to re-center (infrequent — once per ~half viewport of pan, so no
  per-frame flicker; the re-render draws the same content re-centered, no snap).
- `_commitLivePan()` (settle): `renderPadPx = renderPadBp = 0`, restore layer
  width/offset, `renderAll()` (normal), then `gsScheduleViewportVariantLoad()`.

## Staged delivery (each a commit, GPU-verified, safe-when-off)

1. Add the render-window abstraction (defaults to the view window → zero change).
2. Migrate the **tracks** render path; wire the overscan render + widen/offset
   for the tracks SVG + WebGPU canvas; GPU-verify a drag reveals pre-painted
   content and hit-testing at rest is unchanged.
3. Same for the **flow (variants)** container.
4. Same for the **reads** stack (`#smartScroll` + smart-track canvases).
5. Wire the trigger (begin at drag start, re-center past the buffer, reset on
   settle). Tune the overscan fraction; verify both orientations, fullscreen,
   and that variant/read viewport loading still fires on settle.

## Risks / verification

- Coordinate consistency: a missed render site draws at the wrong x → that track
  is misplaced during a drag (cosmetic, only while dragging) — catch per-track on
  GPU.
- Layout: the widened+offset layers must be clipped by an `overflow:hidden`
  ancestor; confirm the tracks/flow/reads regions clip.
- ResizeObserver: the smart-track ResizeObservers re-render on size change — make
  sure the width flips don't cascade into a render loop.
- Perf: the overscan render is ~1.5–2× the pixels; verify it stays 60fps at the
  chosen pad.

---

## RESUME HERE (2026-09-08) — build overscan on-GPU

Decision: **build overscan** (user confirmed live-pan stutter with the interim
full-render). GPU is being restored so the flow/reads WebGPU layers can be
pixel-verified during a drag.

### Current interim state (commit a50f6bb)
- Horizontal AND vertical drag both call `panByPixels(...)` in `onPointerMove`
  (main.js ~5944-5958): full render per frame via `scheduleRender()`. No blank
  edges, but stutters on heavy views — this is what overscan replaces.
- The transform live-pan (`livePanBy` / `_panLayers` / `_commitLivePan`) is still
  present but only `livePanBy` is now unused by the drag path (kept for wheel? no
  — wheel pans via panByPixels too). Verify before deleting.

### Do this (staged, each commit safe-when-off; pad defaults 0 = identity)
1. **Abstraction (ui-state.js), pad=0 no-op:**
   - `state.renderPadBp=0`, `state.renderPadPx=0` in state init.
   - `renderStartBp()= state.startBp - renderPadBp`, `renderEndBp()= state.endBp + renderPadBp`.
   - `renderWidthPx()= tracksWidthPx()+2*renderPadPx`, `renderHeightPx()= tracksHeightPx()+2*renderPadPx`,
     `renderFlowWidthPx()`, `renderFlowHeightPx()`.
   - In `xGenomeCanonical`/`yGenomeCanonical`, replace `state.startBp/endBp` (span,
     bpOffset) with `renderStartBp()/renderEndBp()`. Leave the expanded-insertion
     gap helpers as-is (view-restricted; transient-drag edge case). Headless-assert
     identity at pad=0 and correct shift at pad>0.
2. **Tracks SVG (tracks.js):** line 18 `const W = isVertical? tracksHeightPx():tracksWidthPx()`
   -> `renderHeightPx()/renderWidthPx()`; migrate the in-view FILTERS
   (`bp>=state.startBp && bp<=state.endBp` and gene/repeat clip `Math.max(...,state.startBp)`)
   to `renderStartBp()/renderEndBp()`. DOM-verifiable headless (reference bases /
   genes drawn beyond the viewport). Do NOT touch HUD/interaction/pan-math.
3. **Flow (interaction.js):** the flow `W/H` (lines 85-86) + `xGenomeCanonical`
   local (line ~112) + the `win = variants.filter(pos in [start,end])` (line ~183)
   -> render window. GPU-pixel-verify a drag shows variant nodes in the margin.
4. **Reads (#smartScroll + smart-track canvases):** widen + offset per the design.
   GPU-verify.
5. **Wire the pan (main.js):** revert the drag to the transform path; add
   `_beginPanOverscan()` (renderPadPx=0.5*W, renderPadBp=0.5*span, size+offset the
   3 containers to render dims at left/top:-renderPadPx, renderAll, reset
   livePanOffset), re-center in `livePanBy` past ~0.6*pad, reset in
   `_commitLivePan`. Make it work for BOTH axes (vertical offsets top, horizontal
   offsets left).

### Verify
- `scripts/setup_gpu_webgpu.sh` then the GPU pixel harness
  (`test_webgpu_pixels.py`, needs the container launched with
  `--device /dev/nvidia-modeset`). Add drag-overscan pixel tests: drag reveals
  pre-painted content (no blank leading edge) in BOTH orientations; resting
  hit-testing unchanged.
- Headless geometry guards for the SVG tracks + pad=0 identity.

---

## DONE (2026-09-08) — horizontal overscan shipped

**What landed (5 commits on `jts_vertical_mode`):**
1. Abstraction: `state.renderPadBp/renderPadPx` (0 at rest) + `renderStartBp/
   renderEndBp/renderWidthPx/renderHeightPx/renderFlowWidthPx/renderFlowHeightPx`
   in `ui-state.js`; `xGenome/yGenome` map through them. No-op at pad=0.
2. Tracks SVG render path → render window (whole-file swap; tracks.js is pure render).
3. Flow/variants (`interaction.js`) → render window; kept the viewport variant-
   LOAD trigger (currentViewportRange) + insertion-gap helpers on the VIEW window.
4. Reads (`renderSmartTrack`, main.js 65-997) → render window; genomic-axis
   canvas dim padded by 2·renderPadPx.
5. Pan wiring: `_beginPanOverscan` / `_setPanLayerOverscan` / `_applyPanTransform`
   / `livePanBy` / `_commitLivePan`. Horizontal only.

**Gotcha that cost a debug cycle:** the reads canvas is `position:sticky`, and
`left` on a sticky box is only the stick THRESHOLD — it does NOT shift the box.
So the -renderPadPx centering CANNOT live in `style.left`; it lives in the
`transform` baseline (`translateX(offset - pad)`), which works on sticky AND
absolute layers. `_setPanLayerOverscan` therefore only sets `width`, never `left`.

**Tests:** `test_overscan.py` (pad=0 identity + pad>0 shift-by-padPx, both axes;
tracks paint into the margin) and `test_webgpu_pixels.py::
test_overscan_live_pan_reveals_content` (real drag: overscan engages, reads
canvas widens+shifts, reads keep painting, settle restores + pans).

**To finish vertical overscan later:**
- `_beginPanOverscan`: drop the `isVerticalMode()` early-return; pad the Y axis
  (renderHeightPx) and widen layers by height (`calc(100% + 2pad)` on the
  cross... no — on the genomic axis = height), transform `translateY`.
- `_setPanLayerOverscan` / `_applyPanTransform`: branch on orientation (height/
  translateY vs width/translateX).
- Reads: the vertical smart canvas is virtualized + sticky + `marginTop`-stacked;
  the genomic axis is height. Verify the padded height + translateY doesn't fight
  the sticky/scroll offset before enabling. This is why it was deferred.
- `onPointerMove` vertical branch: swap `panByPixels(0,dy)` → `livePanBy`-equivalent.
