// Pure geometry for allele-node drag reorder. Dependency-free and exposed on
// `window` so headless CI can assert the live drop bar lands exactly where the
// allele ends up — the reorder desync bugs recurred, so this is a regression
// guard. All three call sites (drop-index in the move handler, insert index in
// the mouseup reorder, and the indicator bar position) go through here so they
// can never drift apart again.

// Nearest-midpoint drop index along the stacking axis. Returns an insert-before
// index in [0, sizes.length]; sizes.length means "append after the last node".
function alleleNearestDropIndex(pointer, start, sizes, gap) {
  let cur = start;
  for (let j = 0; j < sizes.length; j++) {
    if (pointer < cur + sizes[j] / 2) return j;
    cur += sizes[j] + gap;
  }
  return sizes.length;
}

// Removing the dragged item shifts everything past it left by one, so the
// reorder must insert at a lower index than the drop-index when dragging down.
function alleleDropInsertAt(dropIndex, fromIndex) {
  return (dropIndex > fromIndex) ? dropIndex - 1 : dropIndex;
}

// Left/top edge where the dragged node will land: accumulate the sizes of the
// first `insertAt` OTHER nodes (the dragged one is pulled out, so the rest
// reflow). Total size is preserved on reorder, so the centering `start` passed
// in is unchanged between the current layout and the final one.
function alleleDropIndicatorPos(start, sizes, gap, fromIndex, insertAt) {
  let pos = start, acc = 0;
  for (let k = 0; k < sizes.length && acc < insertAt; k++) {
    if (k === fromIndex) continue;
    pos += sizes[k] + gap;
    acc++;
  }
  return pos;
}

if (typeof window !== "undefined") {
  window.__gsAlleleNearestDropIndex = alleleNearestDropIndex;
  window.__gsAlleleDropInsertAt = alleleDropInsertAt;
  window.__gsAlleleDropIndicatorPos = alleleDropIndicatorPos;
}
