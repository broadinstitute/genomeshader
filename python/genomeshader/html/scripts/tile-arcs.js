// Cross-tile aggregate ribbons (bundle clustering + SVG gutters).
// Replaces per-read Bezier hairballs: cluster by breakpoint/orientation, draw
// one ribbon per bundle, individual arcs only on selection.

const GS_BUNDLE_COLORS = (typeof GS_TILE_LINK_COLORS !== "undefined" && GS_TILE_LINK_COLORS)
  ? GS_TILE_LINK_COLORS
  : ["#f59e0b", "#a855f7", "#14b8a6", "#3b82f6", "#ef4444", "#22c55e"];

function gsBreakpointToleranceBp(tile) {
  const t = tile || (typeof gsFocusedTile === "function" ? gsFocusedTile() : null);
  if (!t || !Number.isFinite(t.startBp) || !Number.isFinite(t.endBp)) return 200;
  const span = Math.max(1, t.endBp - t.startBp);
  return Math.max(50, Math.min(1000, Math.round(span * 0.0075)));
}

function gsReadStrandChar(read) {
  return read && read.isForward === false ? "-" : "+";
}

function gsMateStrandFromLink(link, read) {
  if (link && (link.strand === "+" || link.strand === "-")) return link.strand;
  // PE mates: unknown strand in BAM mate fields → assume opposite of local for FR-ish default
  return gsReadStrandChar(read) === "+" ? "-" : "+";
}

/** Alignment orientation combo for clustering: FF|FR|RF|RR. */
function gsStrandCombo(localStrand, mateStrand) {
  const a = localStrand === "-" ? "R" : "F";
  const b = mateStrand === "-" ? "R" : "F";
  return a + b;
}

function gsHashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

function gsReadBundleKey(tileId, trackId, qname, start) {
  return `${tileId}|${trackId}|${qname || ""}|${start || 0}`;
}

/** Reads a tile currently shows for a track (its own per-tile view; never another tile's). */
function gsLayoutReadsForTile(track, tile) {
  if (typeof smartTrackReadsLayoutForTile === "function") {
    const lay = smartTrackReadsLayoutForTile(track, tile);
    // A tile's layout spans whole cached chunks (wider than the window): only the
    // reads actually overlapping the window may anchor a ribbon.
    if (lay && Array.isArray(lay.reads)) {
      return lay.reads.filter((r) => r && r.end >= tile.startBp && r.start <= tile.endBp);
    }
  }
  return [];
}

function gsOutgoingLinksForRead(read) {
  const links = [];
  const parse = (typeof gsParseSaTag === "function") ? gsParseSaTag : () => [];
  for (const m of parse(read.saTag || "")) {
    links.push({
      kind: "sa",
      contig: m.contig,
      pos: m.pos,
      strand: m.strand || "+",
      srcBp: read.isForward === false ? read.start : read.end,
    });
  }
  if (read.isPaired && read.mateContig && read.matePos) {
    const sameLocal = read.contig === read.mateContig
      && read.matePos >= read.start - 50
      && read.matePos <= read.end + 50;
    if (!sameLocal) {
      links.push({
        kind: "pe",
        contig: read.mateContig,
        pos: read.matePos,
        strand: gsMateStrandFromLink(null, read),
        srcBp: read.isForward === false ? read.start : read.end,
      });
    }
  }
  // Soft-clip cliff: prefer clip side facing distal mate when SA present.
  if (read.elements && read.elements.some((e) => e.type === 4)) {
    for (const link of links) {
      const hasLeft = read.elements.some((e) => e.type === 4 && e.start < read.start);
      const hasRight = read.elements.some((e) => e.type === 4 && e.start >= read.start);
      if (hasRight && !hasLeft) link.srcBp = read.end;
      else if (hasLeft && !hasRight) link.srcBp = read.start;
    }
  }
  return links;
}

/**
 * Build aggregate bundles between adjacent open tiles.
 * Stores state.tileBundles and state.bundleColorByReadKey.
 */
function gsRebuildTileBundles() {
  _gsRebuildTileBundlesRaw();
  // Content signature of what the read painter consumes from the bundles (the
  // colour map is rebuilt as a new object every render, so identity is useless).
  let sig = "";
  const m = state.bundleColorByReadKey;
  for (const k in m) sig += k + "=" + m[k] + ";";
  state._bundleColorSig = sig;
}

function _gsRebuildTileBundlesRaw() {
  state.tileBundles = [];
  state.bundleColorByReadKey = Object.create(null);
  if (typeof gsIsMultiTile !== "function" || !gsIsMultiTile()) return;
  const tiles = state.tiles || [];
  if (tiles.length < 2) return;

  // Collect link instances: each read→mate that lands in another open tile.
  const rawLinks = [];
  for (const track of state.smartTracks || []) {
    if (!track) continue;
    for (const tile of tiles) {
      if (!tile || tile.blank) continue;
      const reads = gsLayoutReadsForTile(track, tile);
      for (const read of reads) {
        if (!read) continue;
        const outgoing = gsOutgoingLinksForRead(read);
        // Prefer SA over PE when both point into the same open tile.
        const saOthers = new Set();
        for (const link of outgoing) {
          if (link.kind !== "sa") continue;
          const other = (typeof gsFindOpenTileForMate === "function")
            ? gsFindOpenTileForMate(link.contig, link.pos, tile.id)
            : null;
          if (other) saOthers.add(other.id);
        }
        for (const link of outgoing) {
          const other = (typeof gsFindOpenTileForMate === "function")
            ? gsFindOpenTileForMate(link.contig, link.pos, tile.id)
            : null;
          if (!other) continue;
          if (link.kind === "pe" && saOthers.has(other.id)) continue;
          // Adjacent columns only (ribbons live in the gutter between neighbors).
          const iA = tiles.findIndex((t) => t.id === tile.id);
          const iB = tiles.findIndex((t) => t.id === other.id);
          if (iA < 0 || iB < 0 || Math.abs(iA - iB) !== 1) continue;
          const localStrand = gsReadStrandChar(read);
          const mateStrand = gsMateStrandFromLink(link, read);
          rawLinks.push({
            tileId: tile.id,
            otherId: other.id,
            trackId: track.id,
            read,
            link,
            srcBp: Number(link.srcBp) || (read.end || read.start),
            dstBp: Number(link.pos),
            dstContig: link.contig,
            strandCombo: gsStrandCombo(localStrand, mateStrand),
            localDir: localStrand === "+" ? "fwd" : "rev",
            row: Number.isFinite(read.row) ? read.row : 0,
          });
        }
      }
    }
  }

  // Collapse A→B / B→A duplicates of the same qname (and PE/SA doubles) into
  // one undirected link so we do not draw two ribbons for one split read.
  const links = [];
  {
    const best = new Map();
    for (const L of rawLinks) {
      const pairKey = [L.tileId, L.otherId].sort().join("|");
      const qn = (L.read && L.read.name) || "";
      const key = `${L.trackId}|${pairKey}|${qn}`;
      const prev = best.get(key);
      if (!prev) {
        best.set(key, L);
        continue;
      }
      // Prefer SA; otherwise keep the left-tile origin for stable clustering.
      const preferNew = (L.link.kind === "sa" && prev.link.kind !== "sa")
        || (L.link.kind === prev.link.kind
          && tiles.findIndex((t) => t.id === L.tileId)
            < tiles.findIndex((t) => t.id === prev.tileId));
      if (preferNew) best.set(key, L);
    }
    best.forEach((L) => links.push(L));
  }

  // Cluster: greedy nearest-centroid within zoom-scaled tolerance, same
  // unordered tile-pair + track + strandCombo + dest contig.
  const used = new Set();
  const colorOrdinals = new Map();
  const bundles = [];

  for (let i = 0; i < links.length; i++) {
    if (used.has(i)) continue;
    const seed = links[i];
    const tolSrc = gsBreakpointToleranceBp(
      tiles.find((t) => t.id === seed.tileId)
    );
    const tolDst = gsBreakpointToleranceBp(
      tiles.find((t) => t.id === seed.otherId)
    );
    const pairKey = [seed.tileId, seed.otherId].sort().join("|");
    const members = [seed];
    used.add(i);
    let srcSum = seed.srcBp;
    let dstSum = seed.dstBp;

    for (let j = i + 1; j < links.length; j++) {
      if (used.has(j)) continue;
      const cand = links[j];
      const candPair = [cand.tileId, cand.otherId].sort().join("|");
      if (candPair !== pairKey) continue;
      if (cand.trackId !== seed.trackId) continue;
      if (cand.strandCombo !== seed.strandCombo) continue;
      if (cand.dstContig !== seed.dstContig) continue;
      // Same unordered orientation of endpoints: map cand src to seed's tile side.
      const candSrcOnSeedTile = cand.tileId === seed.tileId;
      const cSrc = candSrcOnSeedTile ? cand.srcBp : cand.dstBp;
      const cDst = candSrcOnSeedTile ? cand.dstBp : cand.srcBp;
      const n = members.length;
      const srcMean = srcSum / n;
      const dstMean = dstSum / n;
      if (Math.abs(cSrc - srcMean) > tolSrc) continue;
      if (Math.abs(cDst - dstMean) > tolDst) continue;
      used.add(j);
      members.push(cand);
      srcSum += cSrc;
      dstSum += cDst;
    }

    // Unique qnames (bidirectional raw members may still share a name before
    // the pre-pass; keep length as supporting-read count).
    const n = members.length;
    const srcBp = srcSum / n;
    const dstBp = dstSum / n;
    // Concordance: majority local direction; mixed if minority > 10%.
    let fwd = 0;
    let rev = 0;
    for (const m of members) {
      if (m.localDir === "fwd") fwd += 1;
      else rev += 1;
    }
    const majorityFwd = fwd >= rev;
    const minority = Math.min(fwd, rev) / n;
    const mixed = minority > 0.10;
    const majorityDir = majorityFwd ? "fwd" : "rev";

    // Stable left/right tile ids for rendering (strip order).
    const idxA = tiles.findIndex((t) => t.id === seed.tileId);
    const idxB = tiles.findIndex((t) => t.id === seed.otherId);
    const leftTile = idxA <= idxB ? seed.tileId : seed.otherId;
    const rightTile = idxA <= idxB ? seed.otherId : seed.tileId;
    // srcBp is on seed.tileId; remap centroids to left/right.
    let leftBp = srcBp;
    let rightBp = dstBp;
    if (seed.tileId !== leftTile) {
      leftBp = dstBp;
      rightBp = srcBp;
    }

    // Stable color: derived from WHAT the bundle is (track + tile pair + strand
    // combo + destination contig), not from creation order, so a ribbon keeps
    // its color while other tracks/tiles load or reload around it.
    const colorKey = `${seed.trackId}|${pairKey}|${seed.strandCombo}|${seed.dstContig}`;
    const ordinal = colorOrdinals.get(colorKey) || 0;
    colorOrdinals.set(colorKey, ordinal + 1);
    const color = GS_BUNDLE_COLORS[(gsHashString(colorKey) + ordinal) % GS_BUNDLE_COLORS.length];
    const id = `b${bundles.length}_${seed.trackId}_${Math.round(srcBp)}`;
    const readKeys = [];
    for (const m of members) {
      const rk = gsReadBundleKey(m.tileId, m.trackId, m.read.name, m.read.start);
      readKeys.push({
        tileId: m.tileId,
        trackId: m.trackId,
        qname: m.read.name,
        start: m.read.start,
        end: m.read.end,
        key: rk,
        localDir: m.localDir,
        srcBp: m.srcBp,
        dstBp: m.dstBp,
        row: Number.isFinite(m.row) ? m.row : (Number.isFinite(m.read.row) ? m.read.row : 0),
      });
      state.bundleColorByReadKey[rk] = color;
      // Also index the mate side if the same qname exists there (paint both).
      const mateRk = gsReadBundleKey(m.otherId, m.trackId, m.read.name, m.dstBp);
      // Approximate mate start with dstBp; paint lookup also tries qname-only.
      state.bundleColorByReadKey[`${m.otherId}|${m.trackId}|${m.read.name}`] = color;
    }

    bundles.push({
      id,
      tileAId: leftTile,
      tileBId: rightTile,
      trackId: seed.trackId,
      srcBp: leftBp,
      dstContig: seed.dstContig,
      dstBp: rightBp,
      strandCombo: seed.strandCombo,
      readKeys,
      count: n,
      majorityDir,
      mixed,
      color,
    });
  }

  state.tileBundles = bundles;
  // Refresh suggested orientation for unconfirmed linked tiles.
  if (typeof gsUpdateOrientationSuggestions === "function") {
    gsUpdateOrientationSuggestions();
  }
  if (typeof gsUpdateTileChrome === "function") {
    try { gsUpdateTileChrome(); } catch (_) {}
  }
}

function gsBundleColorForRead(tileId, trackId, read) {
  if (!state.bundleColorByReadKey || !read) return null;
  const exact = state.bundleColorByReadKey[gsReadBundleKey(tileId, trackId, read.name, read.start)];
  if (exact) return exact;
  const loose = state.bundleColorByReadKey[`${tileId}|${trackId}|${read.name}`];
  return loose || null;
}

function gsHexToRgb(hex) {
  if (!hex || hex.charAt(0) !== "#" || hex.length < 7) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Suggest display orientation for unconfirmed tiles from bundle evidence. */
function gsUpdateOrientationSuggestions() {
  const tiles = state.tiles || [];
  const bundles = state.tileBundles || [];
  for (const tile of tiles) {
    if (!tile || tile.blank || tile.orientationConfirmed !== false) continue;
    // Prefer the orientation that makes majorityDir align with fewer "mixed"
    // ribbons touching this tile. Proxy: if most localDirs on links into this
    // tile are reverse relative to source, suggest reversed.
    let agreeFwd = 0;
    let agreeRev = 0;
    for (const b of bundles) {
      if (b.tileAId !== tile.id && b.tileBId !== tile.id) continue;
      if (b.mixed) continue;
      if (b.majorityDir === "fwd") agreeFwd += b.count;
      else agreeRev += b.count;
    }
    if (agreeFwd + agreeRev === 0) {
      tile.suggestedReversed = null;
      tile.orientationEvidence = null;
      continue;
    }
    // Suggest reverse when reverse-majority dominates (linked from opposite strand).
    const suggestRev = agreeRev > agreeFwd;
    tile.suggestedReversed = suggestRev;
    tile.orientationEvidence = {
      agree: Math.max(agreeFwd, agreeRev),
      total: agreeFwd + agreeRev,
      label: suggestRev ? "3′ → 5′" : "5′ → 3′",
    };
  }
}

function gsTileStripLocalRect(tileEl, strip, stripRect) {
  const tr = tileEl.getBoundingClientRect();
  return {
    left: (tr.left - stripRect.left) + strip.scrollLeft,
    right: (tr.right - stripRect.left) + strip.scrollLeft,
    top: (tr.top - stripRect.top) + strip.scrollTop,
    bottom: (tr.bottom - stripRect.top) + strip.scrollTop,
    width: tr.width,
    height: tr.height,
  };
}

function gsTrackContainerYInTile(tile, trackId, strip, stripRect) {
  const tileEl = typeof gsTileRootEl === "function" ? gsTileRootEl(tile.id) : null;
  if (!tileEl) return null;
  // Every tile owns a live reads stack, so the container is always this tile's own.
  const container = tileEl.querySelector(
    `.smart-track-container[data-track-id="${CSS.escape(trackId)}"]`
  );
  if (!container) return null;
  const box = container.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  return {
    top: (box.top - stripRect.top) + strip.scrollTop,
    mid: (box.top - stripRect.top) + strip.scrollTop + box.height * 0.45,
    height: box.height,
    box,
    container,
  };
}


/** Y of a bundle endpoint inside a tile: mean read-row, not track midline.
 *  Returns null when this tile has no supporting reads for the bundle — callers
 *  must not draw a ribbon into an empty track (SA on the mate tile used to fall
 *  back to track mid and produce arcs from blank rows).
 */
function gsBundleEndpointY(tile, trackId, bundle, strip, stripRect) {
  const info = gsTrackContainerYInTile(tile, trackId, strip, stripRect);
  if (!info) return null;
  const track = (state.smartTracks || []).find((t) => t.id === trackId);
  if (!track) return null;

  const reads = gsLayoutReadsForTile(track, tile);
  const qnames = new Set();
  for (const k of (bundle.readKeys || [])) {
    if (k && k.qname) qnames.add(k.qname);
  }
  const supporting = reads.filter((rd) => rd && qnames.has(rd.name));
  if (!supporting.length) return null;

  if (track.collapsed) return info.mid;

  const rows = [];
  for (const k of (bundle.readKeys || [])) {
    let r = null;
    if (k.tileId === tile.id) {
      r = supporting.find((rd) => rd && rd.name === k.qname
        && (!Number.isFinite(k.start) || rd.start === k.start));
      if (!r) r = supporting.find((rd) => rd && rd.name === k.qname);
    } else {
      r = supporting.find((rd) => rd && rd.name === k.qname);
    }
    if (r && Number.isFinite(r.row)) rows.push(r.row);
  }
  if (!rows.length) return info.mid;

  const avgRow = rows.reduce((a, b) => a + b, 0) / rows.length;
  const labelH = 24;
  const closedSlot = track.closedHeight || 30;
  const summaryH = Math.max(12, labelH - 2);
  const summaryY = Math.max(0, Math.floor((closedSlot - summaryH) / 2));
  const top = summaryY;
  const showSummary = !track.readDisplay || track.readDisplay.visibility.summary !== false;
  const overviewH = showSummary ? (summaryY + summaryH + 4 - top) : 0;
  const readsTop = top + overviewH;
  const rowH = (typeof SMART_TRACK_ROW_H === "number") ? SMART_TRACK_ROW_H : 18;

  const scrollTop = (info.container && info.container.scrollTop) || 0;

  return info.top + readsTop + avgRow * rowH + rowH * 0.5 - scrollTop;
}

/**
 * Aggregate ribbons + optional selected read arc.
 * Endpoints clipped to tile edges (gutter-only).
 */
function gsDrawTileArcs() {
  const strip = (typeof gsTileStripEl === "function") ? gsTileStripEl() : null;
  const svg = document.getElementById("tileArcOverlay");
  if (!strip || !svg || !state.tiles || state.tiles.length < 2) {
    if (svg) while (svg.firstChild) svg.removeChild(svg.firstChild);
    return;
  }

  // Rebuild clusters for current zoom/windows (cheap vs BAM I/O).
  gsRebuildTileBundles();
  // Widen gutters before measuring so ribbon endpoints land in the gap.
  if (typeof gsApplyTileGutterWidths === "function") {
    try { gsApplyTileGutterWidths(); } catch (_) {}
  }

  const stripRect = strip.getBoundingClientRect();
  const scrollW = strip.scrollWidth;
  const scrollH = strip.clientHeight;
  svg.setAttribute("width", String(scrollW));
  svg.setAttribute("height", String(scrollH));
  svg.setAttribute("viewBox", `0 0 ${scrollW} ${scrollH}`);
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const tiles = state.tiles;
  const bundles = state.tileBundles || [];
  const selected = state.selectedArcRead || null;

  // Adjacent pairs only.
  for (let i = 0; i < tiles.length - 1; i++) {
    const left = tiles[i];
    const right = tiles[i + 1];
    if (!left || !right || left.blank || right.blank) continue;
    const leftEl = gsTileRootEl(left.id);
    const rightEl = gsTileRootEl(right.id);
    if (!leftEl || !rightEl) continue;
    const L = gsTileStripLocalRect(leftEl, strip, stripRect);
    const R = gsTileStripLocalRect(rightEl, strip, stripRect);
    const x1 = L.right;
    const x2 = R.left;
    if (x2 - x1 < 4) continue;

    const pairBundles = bundles.filter((b) =>
      (b.tileAId === left.id && b.tileBId === right.id)
      || (b.tileAId === right.id && b.tileBId === left.id));

    // Stable vertical order: by mean endpoint Y, then count.
    // Drop ribbons that lack a supporting-read endpoint on either side (empty
    // tracks must not grow arcs from the mate tile's SA alone).
    const placed = pairBundles.map((bundle) => {
      const y1 = gsBundleEndpointY(left, bundle.trackId, bundle, strip, stripRect);
      const y2 = gsBundleEndpointY(right, bundle.trackId, bundle, strip, stripRect);
      if (y1 == null || y2 == null) return null;
      return { bundle, y1, y2, yMid: (y1 + y2) / 2 };
    }).filter(Boolean).sort((a, b) => a.yMid - b.yMid || b.bundle.count - a.bundle.count);

    placed.forEach((item, bi) => {
      const bundle = item.bundle;
      let y1 = item.y1;
      let y2 = item.y2;
      // Tiny stagger only when two ribbons share nearly the same Y.
      if (bi > 0 && Math.abs(item.yMid - placed[bi - 1].yMid) < 8) {
        const nudge = 6;
        y1 += nudge;
        y2 += nudge;
      }

      const muted = !!(selected && selected.bundleId && selected.bundleId !== bundle.id);
      const count = Math.max(1, bundle.count);
      const strokeW = Math.min(18, 2 + Math.log2(count + 1) * 1.6);
      const opacity = muted ? 0.18 : Math.min(0.85, 0.35 + Math.log2(count + 1) * 0.12);

      const dx = x2 - x1;
      // Keep bow inside the gutter; avoid huge vertical loops.
      const bow = (bi % 2 === 0 ? -1 : 1) * Math.max(12, Math.min(28, Math.abs(dx) * 0.22));
      const c1x = x1 + dx * 0.35;
      const c2x = x1 + dx * 0.65;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d",
        `M ${x1.toFixed(1)} ${y1.toFixed(1)} `
        + `C ${c1x.toFixed(1)} ${(y1 + bow).toFixed(1)}, `
        + `${c2x.toFixed(1)} ${(y2 + bow).toFixed(1)}, `
        + `${x2.toFixed(1)} ${y2.toFixed(1)}`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", bundle.color);
      path.setAttribute("stroke-width", String(strokeW));
      path.setAttribute("stroke-opacity", String(opacity));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("class", "gs-tile-ribbon");
      path.style.pointerEvents = "stroke";
      path.style.cursor = "pointer";
      path.dataset.bundleId = bundle.id;
      path.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        gsSelectBundleArc(bundle.id);
      });
      svg.appendChild(path);

      // Count badge + concordance glyph in gutter center.
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2 + bow * 0.5;
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "gs-tile-ribbon-badge");
      g.style.pointerEvents = "all";
      g.style.cursor = "pointer";
      g.dataset.bundleId = bundle.id;
      const pillW = 28 + String(count).length * 6;
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(midX - pillW / 2));
      rect.setAttribute("y", String(midY - 11));
      rect.setAttribute("width", String(pillW));
      rect.setAttribute("height", "16");
      rect.setAttribute("rx", "8");
      rect.setAttribute("fill", muted ? "rgba(22,27,34,0.55)" : "rgba(22,27,34,0.92)");
      rect.setAttribute("stroke", bundle.color);
      rect.setAttribute("stroke-width", "1");
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", String(midX));
      label.setAttribute("y", String(midY));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dominant-baseline", "middle");
      label.setAttribute("fill", muted ? "#8b949e" : "#f0f3f6");
      label.setAttribute("font-size", "11");
      label.setAttribute("font-family", "ui-sans-serif, system-ui, sans-serif");
      label.setAttribute("font-weight", "600");
      label.textContent = `×${count}`;
      const glyph = document.createElementNS("http://www.w3.org/2000/svg", "text");
      glyph.setAttribute("x", String(midX));
      glyph.setAttribute("y", String(midY + 14));
      glyph.setAttribute("text-anchor", "middle");
      glyph.setAttribute("dominant-baseline", "middle");
      glyph.setAttribute("fill", muted ? "#8b949e" : "#f0f3f6");
      glyph.setAttribute("font-size", "12");
      glyph.textContent = bundle.mixed ? "↔" : (bundle.majorityDir === "fwd" ? "→" : "←");
      g.appendChild(rect);
      g.appendChild(label);
      g.appendChild(glyph);
      g.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        gsSelectBundleArc(bundle.id);
      });
      svg.appendChild(g);
    });
  }

  // Selected individual arc (high contrast).
  if (selected && selected.tileId && selected.trackId && selected.qname) {
    const bundle = bundles.find((b) => b.id === selected.bundleId);
    const left = tiles.find((t) => t.id === (bundle ? bundle.tileAId : null));
    const right = tiles.find((t) => t.id === (bundle ? bundle.tileBId : null));
    if (bundle && left && right) {
      const leftEl = gsTileRootEl(left.id);
      const rightEl = gsTileRootEl(right.id);
      if (leftEl && rightEl) {
        const L = gsTileStripLocalRect(leftEl, strip, stripRect);
        const R = gsTileStripLocalRect(rightEl, strip, stripRect);
        let y1 = gsBundleEndpointY(left, selected.trackId, bundle, strip, stripRect)
          ?? (L.top + L.height * 0.5);
        let y2 = gsBundleEndpointY(right, selected.trackId, bundle, strip, stripRect)
          ?? (R.top + R.height * 0.5);
        const x1 = L.right;
        const x2 = R.left;
        const dx = x2 - x1;
        const c1x = x1 + dx * 0.35;
        const c2x = x1 + dx * 0.65;
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d",
          `M ${x1.toFixed(1)} ${y1.toFixed(1)} `
          + `C ${c1x.toFixed(1)} ${y1.toFixed(1)}, `
          + `${c2x.toFixed(1)} ${y2.toFixed(1)}, `
          + `${x2.toFixed(1)} ${y2.toFixed(1)}`);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "#22d3ee");
        path.setAttribute("stroke-width", "2.25");
        path.setAttribute("stroke-opacity", "0.95");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("class", "gs-tile-arc-selected");
        svg.appendChild(path);
        for (const [x, y] of [[x1, y1], [x2, y2]]) {
          const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          dot.setAttribute("cx", String(x));
          dot.setAttribute("cy", String(y));
          dot.setAttribute("r", "3.5");
          dot.setAttribute("fill", "#22d3ee");
          svg.appendChild(dot);
        }
      }
    }
  }
}

function gsSelectBundleArc(bundleId) {
  const bundle = (state.tileBundles || []).find((b) => b.id === bundleId);
  if (!bundle || !bundle.readKeys.length) {
    state.selectedArcRead = null;
  } else {
    const rk = bundle.readKeys[0];
    state.selectedArcRead = {
      bundleId: bundle.id,
      tileId: rk.tileId,
      trackId: rk.trackId,
      qname: rk.qname,
      start: rk.start,
      end: rk.end,
    };
  }
  gsDrawTileArcs();
  if (typeof scheduleRender === "function") scheduleRender();
  else if (typeof renderAll === "function") renderAll();
}

function gsSelectReadArc(tileId, trackId, read) {
  if (!read) {
    state.selectedArcRead = null;
    gsDrawTileArcs();
    return;
  }
  const key = gsReadBundleKey(tileId, trackId, read.name, read.start);
  const loose = `${tileId}|${trackId}|${read.name}`;
  const bundles = state.tileBundles || [];
  let bundle = bundles.find((b) =>
    (b.readKeys || []).some((k) => k.key === key || (k.qname === read.name && k.trackId === trackId)));
  if (!bundle) {
    // Still allow selection highlight without a bundle.
    state.selectedArcRead = {
      bundleId: null,
      tileId,
      trackId,
      qname: read.name,
      start: read.start,
      end: read.end,
    };
  } else {
    state.selectedArcRead = {
      bundleId: bundle.id,
      tileId,
      trackId,
      qname: read.name,
      start: read.start,
      end: read.end,
    };
  }
  void loose;
  gsDrawTileArcs();
  if (typeof scheduleRender === "function") scheduleRender();
  else if (typeof renderAll === "function") renderAll();
}

function gsClearArcSelection() {
  if (!state.selectedArcRead) return;
  state.selectedArcRead = null;
  gsDrawTileArcs();
  if (typeof scheduleRender === "function") scheduleRender();
}

function gsInitTileArcInteractions() {
  if (document.__gsTileArcClick) return;
  document.__gsTileArcClick = true;
  document.addEventListener("click", (e) => {
    if (typeof gsIsMultiTile !== "function" || !gsIsMultiTile()) return;
    if (e.target.closest && e.target.closest(".gs-tile-ribbon, .gs-tile-ribbon-badge, .gs-context-menu")) {
      return;
    }
    // Hit-test a smart-track read.
    if (typeof gsHitTestSmartRead === "function" && typeof gsEventInGenomeshader === "function") {
      if (!gsEventInGenomeshader(e)) {
        gsClearArcSelection();
        return;
      }
      const tileEl = (e.target.closest && e.target.closest(".gs-tile"))
        || document.querySelector(".gs-tile.is-focused");
      const tileId = tileEl ? tileEl.getAttribute("data-tile-id") : state.focusedTileId;
      const tile = (state.tiles || []).find((t) => t.id === tileId);
      const hit = gsHitTestSmartRead(e.clientX, e.clientY, tile);
      if (hit && hit.read && hit.track) {
        gsSelectReadArc(tileId, hit.track.id, hit.read);
        return;
      }
    }
    // Click on empty chrome clears selection.
    if (e.target.closest && e.target.closest(".gs-tile, #main, .gs-smart-scroll")) {
      gsClearArcSelection();
    }
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") gsClearArcSelection();
  }, true);
}

if (typeof window !== "undefined") {
  window.gsBreakpointToleranceBp = gsBreakpointToleranceBp;
  window.gsRebuildTileBundles = gsRebuildTileBundles;
  window.gsDrawTileArcs = gsDrawTileArcs;
  window.gsBundleColorForRead = gsBundleColorForRead;
  window.gsHexToRgb = gsHexToRgb;
  window.gsTrackContainerYInTile = gsTrackContainerYInTile;
  window.gsBundleEndpointY = gsBundleEndpointY;
  window.gsSelectBundleArc = gsSelectBundleArc;
  window.gsSelectReadArc = gsSelectReadArc;
  window.gsClearArcSelection = gsClearArcSelection;
  window.gsUpdateOrientationSuggestions = gsUpdateOrientationSuggestions;
  window.gsInitTileArcInteractions = gsInitTileArcInteractions;
}

// Auto-init click handling once DOM is ready.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => gsInitTileArcInteractions());
  } else {
    try { gsInitTileArcInteractions(); } catch (_) {}
  }
}
