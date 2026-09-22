// Multi-locus tile view — ordered strip of independent genomic viewports.
// Single-tile mode mirrors today's singleton state.contig/startBp/endBp/pxPerBp.

const GS_TILE_LINK_COLORS = [
  "#f59e0b", // orange
  "#a855f7", // purple
  "#22c55e", // green
  "#3b82f6", // blue
  "#ef4444", // red
  "#14b8a6", // teal
];
let _gsTileLinkColorIdx = 0;

/** Tile currently being painted (render context). Null → focused tile / globals. */
let _gsRenderTile = null;

function gsTileLetter(index) {
  // A..Z then A2, B2, ...
  if (index < 26) return String.fromCharCode(65 + index);
  return String.fromCharCode(65 + (index % 26)) + String(Math.floor(index / 26) + 1);
}

/** Visible tile title: custom name if set, otherwise the A/B/… letter. */
function gsTileDisplayName(tile) {
  if (!tile) return "";
  const n = (tile.name != null) ? String(tile.name).trim() : "";
  return n || tile.letter || "";
}

function gsCreateTile(opts = {}) {
  const id = opts.id || (`t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  return {
    id,
    letter: opts.letter || "A",
    // Optional user-facing title; when set, replaces the letter in chrome/pills.
    name: (opts.name != null && String(opts.name).trim()) ? String(opts.name).trim() : null,
    contig: opts.contig != null ? opts.contig : (state.contig || "chr1"),
    startBp: Number.isFinite(opts.startBp) ? opts.startBp : (state.startBp || 0),
    endBp: Number.isFinite(opts.endBp) ? opts.endBp : (state.endBp || 1000),
    pxPerBp: Number.isFinite(opts.pxPerBp) ? opts.pxPerBp : (state.pxPerBp || 1),
    // Display orientation: strictly 5'->3' (false) or 3'->5' (true), always definite.
    reversed: !!opts.reversed,
    widthPx: Number.isFinite(opts.widthPx) ? opts.widthPx : null,
    linkColor: opts.linkColor || null,
    linkedFromId: opts.linkedFromId || null,
    expandedInsertions: opts.expandedInsertions instanceof Set
      ? new Set(opts.expandedInsertions)
      : new Set(),
    blank: !!opts.blank,
    renderPadBp: 0,
    renderPadPx: 0,
    // Persistent per-tile reads stack: Map<trackId, renderer> (DOM + canvases
    // that live inside THIS tile's column — see gsEnsureSmartRenderers).
    _smartRenderers: new Map(),
    // Last reads view painted per track for this tile (Map<trackId, view>);
    // lets a pan / pending fetch keep showing the previous window's reads.
    _readsViews: new Map(),
  };
}

function gsEnsureTilesInitialized() {
  if (!state.tiles || !Array.isArray(state.tiles) || state.tiles.length === 0) {
    const t = gsCreateTile({
      id: "t0",
      letter: "A",
      contig: state.contig,
      startBp: state.startBp,
      endBp: state.endBp,
      pxPerBp: state.pxPerBp,
      expandedInsertions: state.expandedInsertions,
    });
    state.tiles = [t];
    state.focusedTileId = t.id;
  }
  if (!state.focusedTileId) {
    state.focusedTileId = state.tiles[0].id;
  }
}

function gsFocusedTile() {
  gsEnsureTilesInitialized();
  const id = state.focusedTileId;
  const t = state.tiles.find((x) => x.id === id);
  return t || state.tiles[0];
}

function gsActiveTile(tile) {
  if (tile && typeof tile === "object" && Number.isFinite(tile.startBp)) return tile;
  if (_gsRenderTile) return _gsRenderTile;
  return gsFocusedTile();
}

function gsWithTile(tile, fn) {
  const prev = _gsRenderTile;
  _gsRenderTile = tile;
  try {
    return fn();
  } finally {
    _gsRenderTile = prev;
  }
}

/** Push focused-tile fields onto the legacy global aliases used by existing code. */
function gsSyncFocusedAliases() {
  gsEnsureTilesInitialized();
  const t = gsFocusedTile();
  if (!t) return;
  state.contig = t.contig;
  state.startBp = t.startBp;
  state.endBp = t.endBp;
  state.pxPerBp = t.pxPerBp;
  // Share the focused tile's expanded-insertion set with the global alias so
  // gap math that still reads state.expandedInsertions stays consistent.
  if (t.expandedInsertions instanceof Set) {
    state.expandedInsertions = t.expandedInsertions;
  }
  state.renderPadBp = t.renderPadBp || 0;
  state.renderPadPx = t.renderPadPx || 0;
  // Legacy alias: code that still reads state.smartTrackRenderers sees the
  // focused tile's renderers (single-tile mode: the only tile's).
  if (!(t._smartRenderers instanceof Map)) t._smartRenderers = new Map();
  state.smartTrackRenderers = t._smartRenderers;
}

/** Pull global aliases back onto the focused tile (after pan/zoom/goto). */
function gsPullAliasesIntoFocused() {
  gsEnsureTilesInitialized();
  const t = gsFocusedTile();
  if (!t) return;
  t.contig = state.contig;
  t.startBp = state.startBp;
  t.endBp = state.endBp;
  t.pxPerBp = state.pxPerBp;
  t.renderPadBp = state.renderPadBp || 0;
  t.renderPadPx = state.renderPadPx || 0;
  if (state.expandedInsertions instanceof Set) {
    t.expandedInsertions = state.expandedInsertions;
  }
}

function gsRelabelTiles() {
  if (!state.tiles) return;
  // Refresh the default A/B/… codes only. Custom tile.name is preserved.
  state.tiles.forEach((t, i) => {
    t.letter = gsTileLetter(i);
  });
}

function gsFocusTile(tileId, { scroll = true } = {}) {
  gsEnsureTilesInitialized();
  const t = state.tiles.find((x) => x.id === tileId);
  if (!t) return;
  if (state.focusedTileId === t.id) {
    if (scroll && typeof gsScrollTileIntoView === "function") {
      gsScrollTileIntoView(t.id);
    }
    return;
  }
  // Persist the outgoing tile's live payload + window. Every tile owns a
  // persistent reads stack (its own canvases), so there is nothing to snapshot
  // or relocate: focus only changes which tile receives input.
  if (typeof cacheLiveSmartTrackReads === "function") cacheLiveSmartTrackReads();
  gsPullAliasesIntoFocused();

  state.focusedTileId = t.id;
  gsSyncFocusedAliases();
  if (typeof gsBindTileDom === "function") gsBindTileDom(t);
  if (typeof updateDerived === "function") updateDerived();
  if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
  if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
  if (scroll && typeof gsScrollTileIntoView === "function") {
    gsScrollTileIntoView(t.id);
  }
  if (typeof renderAll === "function") renderAll();
  // Fetch whatever any open tile is missing (cache hits are instant; misses
  // are serialized so hover-focus never stampedes the kernel).
  if (!t.blank && typeof ensureSmartTracksForAllTiles === "function") {
    if (gsFocusTile._readsTimer) clearTimeout(gsFocusTile._readsTimer);
    gsFocusTile._readsTimer = setTimeout(() => {
      gsFocusTile._readsTimer = null;
      ensureSmartTracksForAllTiles({ force: true });
    }, 120);
  }
}

function gsNextLinkColor() {
  const c = GS_TILE_LINK_COLORS[_gsTileLinkColorIdx % GS_TILE_LINK_COLORS.length];
  _gsTileLinkColorIdx += 1;
  return c;
}

function gsTileLocusString(tile) {
  const t = tile || gsFocusedTile();
  if (!t || t.blank) return "";
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  if (t.reversed) {
    return `${t.contig}:${fmt(t.endBp)}–${fmt(t.startBp)}`;
  }
  return `${t.contig}:${fmt(t.startBp)}–${fmt(t.endBp)}`;
}

function gsTileSpanBp(tile) {
  const t = tile || gsFocusedTile();
  return Math.max(1, (t.endBp || 0) - (t.startBp || 0));
}

/** Compact span for titles/pills, e.g. "14 kb", "2.5 Mb", "850 bp". */
function gsFormatTileSpan(spanBp) {
  const s = Math.max(0, Math.round(Number(spanBp) || 0));
  if (s < 1000) return `${s.toLocaleString("en-US")} bp`;
  if (s < 1_000_000) {
    const kb = s / 1000;
    if (kb >= 100) return `${Math.round(kb)} kb`;
    if (kb >= 10) return `${kb.toFixed(0)} kb`;
    const t = kb.toFixed(1).replace(/\.0$/, "");
    return `${t} kb`;
  }
  const mb = s / 1_000_000;
  if (mb >= 10) return `${mb.toFixed(1).replace(/\.0$/, "")} Mb`;
  return `${mb.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} Mb`;
}

/**
 * Open a new tile. insertAfterId: place after that tile (default: end).
 * blank: no locus yet (user must enter one).
 */
function gsAddTile(opts = {}) {
  gsEnsureTilesInitialized();
  if (typeof cacheLiveSmartTrackReads === "function") cacheLiveSmartTrackReads();
  gsPullAliasesIntoFocused();
  const source = opts.linkedFromId
    ? state.tiles.find((x) => x.id === opts.linkedFromId)
    : gsFocusedTile();
  const span = source ? gsTileSpanBp(source) : 15000;
  let startBp = opts.startBp;
  let endBp = opts.endBp;
  if (opts.centerBp != null && Number.isFinite(opts.centerBp)) {
    startBp = Math.max(1, Math.round(opts.centerBp - span / 2));
    endBp = startBp + span;
  }
  const contig = opts.contig != null ? opts.contig : (opts.blank ? "" : (source && source.contig));
  // Default: clone the source/focused tile's window (and orientation) unless the
  // caller asked for a blank tile or supplied explicit coords.
  if (!opts.blank && source && !source.blank) {
    if (!Number.isFinite(startBp)) startBp = source.startBp;
    if (!Number.isFinite(endBp)) endBp = source.endBp;
  }
  // Clamp to chrom length when known.
  if (contig && typeof config !== "undefined" && config.chrom_lengths && config.chrom_lengths[contig]) {
    const len = config.chrom_lengths[contig];
    if (Number.isFinite(endBp) && endBp > len) {
      const over = endBp - len;
      endBp = len;
      startBp = Math.max(1, startBp - over);
    }
  }
  const reversed = Object.prototype.hasOwnProperty.call(opts, "reversed")
    ? !!opts.reversed
    : !!(source && source.reversed);
  const tile = gsCreateTile({
    contig: contig || "",
    startBp: Number.isFinite(startBp) ? startBp : 1,
    endBp: Number.isFinite(endBp) ? endBp : 1000,
    pxPerBp: source ? source.pxPerBp : state.pxPerBp,
    reversed,
    linkColor: opts.linkColor || (opts.linkedFromId ? gsNextLinkColor() : null),
    linkedFromId: opts.linkedFromId || null,
    blank: !!opts.blank || !contig,
    widthPx: opts.widthPx != null ? opts.widthPx : (source && source.widthPx),
  });

  let insertAt = state.tiles.length;
  if (opts.insertAfterId) {
    const idx = state.tiles.findIndex((x) => x.id === opts.insertAfterId);
    if (idx >= 0) insertAt = idx + 1;
  } else if (opts.linkedFromId) {
    const idx = state.tiles.findIndex((x) => x.id === opts.linkedFromId);
    if (idx >= 0) insertAt = idx + 1;
  }
  state.tiles.splice(insertAt, 0, tile);
  gsRelabelTiles();

  // Multi-tile forces horizontal orientation.
  if (state.tiles.length > 1 && typeof setOrientation === "function") {
    if (typeof isVerticalMode === "function" && isVerticalMode()) {
      setOrientation("horizontal");
    }
  }

  // Persist the source's live payload; its column keeps its own reads stack.
  if (typeof cacheLiveSmartTrackReads === "function") cacheLiveSmartTrackReads();

  state.focusedTileId = tile.id;
  gsSyncFocusedAliases();
  if (typeof gsEnsureTileStripDom === "function") gsEnsureTileStripDom();
  // Give the new column its own reads stack for every loaded track.
  if (typeof gsEnsureSmartRenderers === "function") gsEnsureSmartRenderers();
  if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
  if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
  if (typeof updateDerived === "function") updateDerived();
  if (typeof gsScrollTileIntoView === "function") gsScrollTileIntoView(tile.id);
  if (typeof renderAll === "function") renderAll();
  // Kick viewport loads for the new focused tile.
  if (!tile.blank && typeof gsScheduleViewportVariantLoad === "function") {
    gsScheduleViewportVariantLoad();
  }
  // Fetch every open tile's missing reads (per-tile, per-BAM; never cancels a
  // sibling's in-flight load).
  if (!tile.blank && typeof ensureSmartTracksForAllTiles === "function") {
    ensureSmartTracksForAllTiles({ force: true });
  }
  return tile;
}

function gsRemoveTile(tileId) {
  gsEnsureTilesInitialized();
  if (state.tiles.length <= 1) return false;
  const idx = state.tiles.findIndex((x) => x.id === tileId);
  if (idx < 0) return false;
  const wasFocused = state.focusedTileId === tileId;
  const [removedTile] = state.tiles.splice(idx, 1);
  if (typeof gsDisposeTileRenderers === "function") gsDisposeTileRenderers(removedTile);
  gsRelabelTiles();
  if (wasFocused) {
    const next = state.tiles[Math.min(idx, state.tiles.length - 1)];
    state.focusedTileId = next.id;
  }
  // Clear stale linkedFromId pointing at the removed tile.
  for (const t of state.tiles) {
    if (t.linkedFromId === tileId) t.linkedFromId = null;
  }
  // Single-tile: drop fixed widths so the remaining column fills the strip.
  if (state.tiles.length === 1) {
    state.tiles[0].widthPx = null;
    state.tiles[0].linkedFromId = null;
  } else {
    // Multi still: release fixed widths so flex can redistribute.
    for (const t of state.tiles) t.widthPx = null;
  }
  gsSyncFocusedAliases();
  if (typeof gsEnsureTileStripDom === "function") gsEnsureTileStripDom();
  // Back to a single tile: every tile already owns GPU renderers, so nothing to rebuild.
  if (state.tiles.length === 1 && typeof gsEnsureSmartRenderers === "function") {
    gsEnsureSmartRenderers();
    // Single-tile painting reads the tracks' live payload, which still belongs
    // to whichever tile was focused before — point it at the survivor's locus.
    if (typeof hydrateSmartTracksForCurrentLocus === "function") hydrateSmartTracksForCurrentLocus();
  }
  if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
  if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
  if (typeof updateDerived === "function") updateDerived();
  // Force layout so tracksWidthPx() sees the expanded tile, then repaint.
  const strip = (typeof gsTileStripEl === "function") ? gsTileStripEl() : document.getElementById("tileStrip");
  if (strip) void strip.offsetWidth;
  if (typeof renderAll === "function") {
    renderAll();
    requestAnimationFrame(() => {
      if (typeof updateDerived === "function") updateDerived();
      if (typeof renderAll === "function") renderAll();
    });
  }
  // Fetch anything the survivor lacks (single-tile: classic path).
  if (typeof ensureSmartTracksForAllTiles === "function") ensureSmartTracksForAllTiles({ force: true });
  return true;
}

function gsReorderTiles(fromIndex, toIndex) {
  gsEnsureTilesInitialized();
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= state.tiles.length || toIndex >= state.tiles.length) return;
  gsPullAliasesIntoFocused();
  const [item] = state.tiles.splice(fromIndex, 1);
  state.tiles.splice(toIndex, 0, item);
  gsRelabelTiles();
  gsSyncFocusedAliases();
  if (typeof gsEnsureTileStripDom === "function") gsEnsureTileStripDom();
  if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
  if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
  if (typeof renderAll === "function") renderAll();
}

function gsSetTileReversed(tileId, reversed) {
  const t = (state.tiles || []).find((x) => x.id === tileId);
  if (!t) return;
  t.reversed = !!reversed;
  if (state.focusedTileId === t.id && typeof gsSyncFocusedAliases === "function") {
    gsSyncFocusedAliases();
  }
  if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
  if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
  if (typeof renderAll === "function") renderAll();
}

/** Set display orientation from the ▶ / ◀ control: choice is "fwd" | "rev". */
function gsSetTileOrientationChoice(tileId, choice) {
  const t = (state.tiles || []).find((x) => x.id === tileId);
  if (!t) return;
  gsSetTileReversed(tileId, choice === "rev");
}

function gsSetTileLocus(tileId, contig, startBp, endBp) {
  const t = (state.tiles || []).find((x) => x.id === tileId);
  if (!t) return;
  t.contig = contig;
  t.startBp = startBp;
  t.endBp = endBp;
  t.blank = false;
  if (state.focusedTileId === t.id) {
    gsSyncFocusedAliases();
    if (typeof updateDerived === "function") updateDerived();
  }
  if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
  if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
  if (typeof gsScheduleViewportVariantLoad === "function") gsScheduleViewportVariantLoad();
  // A blank tile that just received a locus needs its reads stack.
  if (typeof gsEnsureSmartRenderers === "function") gsEnsureSmartRenderers();
  if (typeof renderAll === "function") renderAll();
  if (typeof ensureSmartTracksForAllTiles === "function") ensureSmartTracksForAllTiles({ force: true });
}

function gsIsMultiTile() {
  return !!(state.tiles && state.tiles.length > 1);
}

// Seed tiles from the initial singleton region once config is applied.
function gsInitTilesFromState() {
  state.tiles = null;
  state.focusedTileId = null;
  gsEnsureTilesInitialized();
  // The primary tile adopts the legacy renderer Map so single-tile mode (and
  // anything holding state.smartTrackRenderers) is unchanged.
  if (state.smartTrackRenderers instanceof Map && state.tiles[0]) {
    state.tiles[0]._smartRenderers = state.smartTrackRenderers;
  }
  gsSyncFocusedAliases();
}

// Initialize immediately — ui-state.js has already seeded contig/start/end.
gsInitTilesFromState();

// Expose for headless tests / harness.
try {
  window.__GS_tiles = {
    create: gsCreateTile,
    add: gsAddTile,
    remove: gsRemoveTile,
    focus: gsFocusTile,
    reorder: gsReorderTiles,
    setReversed: gsSetTileReversed,
    setOrientationChoice: gsSetTileOrientationChoice,
    setLocus: gsSetTileLocus,
    focused: gsFocusedTile,
    active: gsActiveTile,
    withTile: gsWithTile,
    sync: gsSyncFocusedAliases,
    pull: gsPullAliasesIntoFocused,
    locusString: gsTileLocusString,
    formatSpan: gsFormatTileSpan,
    displayName: gsTileDisplayName,
    isMulti: gsIsMultiTile,
  };
} catch (_) { /* non-browser */ }
