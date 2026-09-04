# Render overscan for live pan (no blank leading edge)

Status: **planned, deferred.** Captures the design so it can be picked up later.

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
