# Manual test procedures

Checks that resist reliable automation (visual/interactive nuance, real-kernel
paths). Run these by hand when touching the related area. Automated regression
tests live in `python/tests/`.

## MT-1: Layout-mode / orientation round-trip must not corrupt insertion bases

**Reported:** switching variant layout genomic → equidistant ("even") → genomic
(and/or orientation horizontal → vertical → horizontal) left the rendering
"messed up from then on — the insertion bases in particular."

**Status:** NOT reproduced in the headless/GPU harness — insertion bases render
correctly (all four base colors, aligned) after both round-trips via the test
seams. Suspected to need the real Settings-menu toggle path and/or loaded reads,
or the symptom is misalignment rather than missing bases.

**Steps:**
1. Load a viewer on a region containing an expandable insertion; expand it
   (click the insertion lollipop) and confirm the inserted bases render as
   colored tiles in the opened gap.
2. Settings → Variant layout → Equidistant. Confirm nodes render.
3. Settings → Variant layout → Genomic (back). **Check:** the insertion bases
   still render in the correct place/size (not squashed, shifted, or missing).
4. Repeat with orientation Horizontal → Vertical → Horizontal.

**If it fails,** capture: zoom level (span bp), whether reads were loaded, a
screenshot, and the browser console — then file with those details so it can be
turned into an automated test.

## MT-2: Zoomed-out variant LOD keeps pan/zoom fast

**Change:** in genomic layout mode, the flow variant list is downsampled to ~one
variant per ~3px column when zoomed out (keeping the hovered variant, any with a
selected allele, and expanded insertions). Reference bases are already capped
(10k) + sub-pixel-skipped; reads are virtualized.

**Not auto-tested:** the headless harness can't inject many variants into the
live flow render, and painted output needs the GPU pixel harness.

**Steps:**
1. Load a dataset with a dense variant region (thousands of variants across the
   window). Zoom out so the whole region is in view.
2. **Check:** pan and zoom stay smooth (no multi-second stalls); the variant
   track shows representative markers, not an unreadable solid smear.
3. Zoom into a small window (hundreds of bp). **Check:** every variant in that
   window is drawn (no LOD loss up close); a selected/hovered variant stays
   visible at all zooms.
4. Switch variant layout to Equidistant. **Check:** unaffected (evenly spaced).

**If markers vanish when zoomed IN, or a selected variant disappears zoomed out,
the coalescing threshold/keep-set is wrong** — see the `win` LOD block in
`renderFlowCanvas` (interaction.js).
