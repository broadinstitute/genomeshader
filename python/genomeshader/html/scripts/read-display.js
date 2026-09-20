// Per-read display encodings shared by layout, paint, and the Tracks sidebar panel.
const DEFAULT_READ_DISPLAY = Object.freeze({
  summaryField: "haplotypeConsensus",
  visibility: Object.freeze({ summary: true, reads: true }),
  alignments: Object.freeze({ paired: true, supplementary: true, secondary: false }),
  mapqRange: Object.freeze({ min: 1, max: 254 }),
  coverageScale: Object.freeze({ mode: "track", fixedMin: 0, fixedMax: 30 }),
  // Group-shareable field sources: "track" | "group" (group only valid when track.groupId set).
  coverageScaleSource: "track",
  // Soft clips: "marker" = bracket + SA/mate hint; "bases" = paint clipped seq as
  // mismatches; "hide" = omit (legacy abrupt end).
  softClipMode: "marker",
  groupBy: null,
  sortBy: null,
  colorBy: null,
  shadeBy: null,
  reverse: Object.freeze({ groupBy: false, sortBy: false, colorBy: false, shadeBy: false }),
  sortAnchor: Object.freeze({ mode: "auto", position: null }),
});

// Fields that can inherit from a track group (v1: coverage scale only).
const GROUP_SHAREABLE_FIELDS = Object.freeze(["coverageScale"]);

const READ_DISPLAY_FIELDS = Object.freeze({
  summaryField: [
    ["haplotypeConsensus", "Haplotype consensus"],
    ["coverage", "Coverage"],
  ],
  softClipMode: [
    ["marker", "Marker"],
    ["bases", "Show bases"],
    ["hide", "Hide"],
  ],
  groupBy: [
    [null, "None"], ["haplotype", "Haplotype"], ["sample", "Sample"],
    ["readGroup", "Read group"], ["insertSizeClass", "Insert-size class"],
    ["svSignature", "SV signature"],
  ],
  sortBy: [
    [null, "None"], ["position", "Position"], ["clipLength", "Clip length"],
    ["insertSize", "Insert size"], ["distanceToAnchor", "Dist. to anchor"],
    ["haplotype", "Haplotype"], ["sample", "Sample"], ["readGroup", "Read group"],
    ["insertSizeClass", "Insert-size class"], ["svSignature", "SV signature"],
  ],
  colorBy: [
    [null, "None"], ["haplotype", "Haplotype"], ["sample", "Sample"],
    ["strand", "Strand"], ["readGroup", "Read group"],
  ],
  shadeBy: [
    [null, "None"], ["mappingQuality", "Map qual"],
    ["baseQuality", "Base qual"], ["insertSizeMagnitude", "Insert size"],
  ],
});

function cloneReadDisplayConfig(source) {
  const cfg = source || DEFAULT_READ_DISPLAY;
  const anchor = cfg.sortAnchor || DEFAULT_READ_DISPLAY.sortAnchor;
  const vis = cfg.visibility || DEFAULT_READ_DISPLAY.visibility;
  const aln = cfg.alignments || DEFAULT_READ_DISPLAY.alignments;
  const mapq = cfg.mapqRange || DEFAULT_READ_DISPLAY.mapqRange;
  const scale = cfg.coverageScale || DEFAULT_READ_DISPLAY.coverageScale;
  const rev = cfg.reverse || DEFAULT_READ_DISPLAY.reverse;
  const scaleMode = (scale.mode === "view" || scale.mode === "fixed") ? scale.mode : "track";
  const softClipMode = (cfg.softClipMode === "bases" || cfg.softClipMode === "hide")
    ? cfg.softClipMode
    : "marker";
  // Legacy migrate: showPairs → alignments.paired when alignments absent.
  const paired = cfg.alignments
    ? !!aln.paired
    : (cfg.showPairs != null ? !!cfg.showPairs : DEFAULT_READ_DISPLAY.alignments.paired);
  // Legacy: shade label "off" was null; keep null.
  return {
    summaryField: cfg.summaryField === "coverage" ? "coverage" : "haplotypeConsensus",
    visibility: {
      summary: vis.summary !== false,
      reads: vis.reads !== false,
    },
    alignments: {
      paired,
      supplementary: aln.supplementary !== false,
      secondary: !!aln.secondary,
    },
    mapqRange: {
      min: Number.isFinite(Number(mapq.min)) ? Number(mapq.min) : 1,
      max: Number.isFinite(Number(mapq.max)) ? Number(mapq.max) : 254,
    },
    coverageScale: {
      mode: scaleMode,
      fixedMin: Number.isFinite(Number(scale.fixedMin)) ? Number(scale.fixedMin) : 0,
      fixedMax: Number.isFinite(Number(scale.fixedMax)) ? Number(scale.fixedMax) : 30,
    },
    coverageScaleSource: cfg.coverageScaleSource === "group" ? "group" : "track",
    softClipMode,
    groupBy: cfg.groupBy == null ? null : cfg.groupBy,
    sortBy: cfg.sortBy == null ? null : cfg.sortBy,
    colorBy: cfg.colorBy == null ? null : cfg.colorBy,
    shadeBy: cfg.shadeBy == null ? null : cfg.shadeBy,
    reverse: {
      groupBy: !!rev.groupBy,
      sortBy: !!rev.sortBy,
      colorBy: !!rev.colorBy,
      shadeBy: !!rev.shadeBy,
    },
    sortAnchor: {
      mode: anchor.mode === "pinned" ? "pinned" : "auto",
      position: anchor.position
        ? { contig: String(anchor.position.contig), pos: Number(anchor.position.pos) }
        : null,
    },
  };
}

function loadReadDisplayDefaults() {
  let saved = null;
  try {
    const raw = gsLocalStorage.getItem("genomeshader.readDisplayDefaults");
    if (raw) saved = JSON.parse(raw);
  } catch (_) {}
  return cloneReadDisplayConfig(saved || DEFAULT_READ_DISPLAY);
}
state.readDisplayDefaults = state.readDisplayDefaults || loadReadDisplayDefaults();

function loadReadDisplayForTrack(trackId) {
  try {
    const raw = gsLocalStorage.getItem("genomeshader.readDisplayByTrack");
    const all = raw ? JSON.parse(raw) : {};
    if (all && all[trackId]) return cloneReadDisplayConfig(all[trackId]);
  } catch (_) {}
  return cloneReadDisplayConfig(state.readDisplayDefaults);
}

function saveReadDisplayForTrack(track) {
  if (!track || !track.id || !track.readDisplay) return;
  try {
    const raw = gsLocalStorage.getItem("genomeshader.readDisplayByTrack");
    const all = raw ? JSON.parse(raw) : {};
    all[track.id] = cloneReadDisplayConfig(track.readDisplay);
    gsLocalStorage.setItem("genomeshader.readDisplayByTrack", JSON.stringify(all));
  } catch (_) {}
}

function _readDisplayCompareKey(cfg) {
  const c = cloneReadDisplayConfig(cfg);
  // Auto-mode anchor position drifts with the review queue — ignore for "customized".
  if (c.sortAnchor && c.sortAnchor.mode === "auto") c.sortAnchor.position = null;
  return JSON.stringify(c);
}

function isReadDisplayCustomized(track) {
  if (!track || !track.readDisplay) return false;
  const defaults = state.readDisplayDefaults || DEFAULT_READ_DISPLAY;
  return _readDisplayCompareKey(track.readDisplay) !== _readDisplayCompareKey(defaults);
}

function syncTrackCollapsedFromVisibility(track) {
  if (!track || !track.readDisplay) return;
  const vis = track.readDisplay.visibility;
  track.collapsed = !vis.reads;
  // Both Summary and Reads off ≡ hide the track from the main display.
  const empty = !vis.summary && !vis.reads;
  if (empty) {
    track.hidden = true;
    track._hiddenByEmptyVisibility = true;
  } else if (track._hiddenByEmptyVisibility) {
    track.hidden = false;
    track._hiddenByEmptyVisibility = false;
  }
}

function applyVisibilityShortcut(track, collapsed) {
  if (!track) return;
  if (!track.readDisplay) track.readDisplay = cloneReadDisplayConfig(state.readDisplayDefaults);
  if (collapsed) {
    track.readDisplay.visibility.summary = true;
    track.readDisplay.visibility.reads = false;
  } else {
    track.readDisplay.visibility.reads = true;
  }
  syncTrackCollapsedFromVisibility(track);
  saveReadDisplayForTrack(track);
}

const READ_CATEGORY_COLORS = Object.freeze({
  haplotype: Object.freeze({
    HP1: [255, 100, 100], HP2: [100, 100, 255], unphased: [150, 150, 150],
  }),
  strand: Object.freeze({
    forward: [45, 180, 125], reverse: [240, 145, 55],
  }),
  svSignature: Object.freeze({
    split: [225, 87, 89], linear: [118, 183, 178],
  }),
});
const READ_HASH_PALETTE = Object.freeze([
  [78, 121, 167], [242, 142, 43], [225, 87, 89], [118, 183, 178],
  [89, 161, 79], [237, 201, 72], [176, 122, 161], [255, 157, 167],
]);

function readCategory(read, field) {
  if (!read) return "unknown";
  if (field === "haplotype") {
    return read.haplotype === 1 ? "HP1" : (read.haplotype === 2 ? "HP2" : "unphased");
  }
  if (field === "strand") return read.isForward ? "forward" : "reverse";
  if (field === "sample") return String(read.sample || "unknown");
  if (field === "readGroup") return String(read.readGroup || "unknown");
  if (field === "insertSizeClass") return String(read.insertSizeClass || "unpaired");
  if (field === "svSignature") return read.isSupplementary ? "split" : "linear";
  return "unknown";
}

function colorForCategory(field, category, reversed) {
  if (!field) return [128, 128, 138];
  const fixed = READ_CATEGORY_COLORS[field];
  if (fixed && fixed[category]) {
    if (!reversed) return fixed[category];
    const swap = {
      haplotype: { HP1: "HP2", HP2: "HP1" },
      strand: { forward: "reverse", reverse: "forward" },
      svSignature: { split: "linear", linear: "split" },
    };
    const alt = swap[field] && swap[field][category];
    if (alt && fixed[alt]) return fixed[alt];
    return fixed[category];
  }
  const text = `${field}:${category}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let idx = (hash >>> 0) % READ_HASH_PALETTE.length;
  if (reversed) idx = READ_HASH_PALETTE.length - 1 - idx;
  return READ_HASH_PALETTE[idx];
}

function medianOf(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function shadeStrength(read, field, trackMedianInsert, reversed) {
  if (!field) return 1;
  let value = 1;
  if (field === "mappingQuality") value = Number(read.mappingQuality || 0) / 60;
  else if (field === "baseQuality") value = Number(read.meanBaseQuality || 0) / 40;
  else if (field === "insertSizeMagnitude") {
    const median = Math.max(1, Number(trackMedianInsert || 0));
    value = Math.abs(Number(read.insertSize || 0)) / (median * 1.5);
  }
  value = Math.max(0.2, Math.min(1, value));
  return reversed ? Math.max(0.2, Math.min(1, 1.2 - value)) : value;
}

function readPaintStyle(read, track) {
  const display = (track && track.readDisplay) || DEFAULT_READ_DISPLAY;
  const rev = display.reverse || DEFAULT_READ_DISPLAY.reverse;
  let color = display.colorBy
    ? colorForCategory(display.colorBy, readCategory(read, display.colorBy), !!rev.colorBy)
    : [128, 128, 138];
  let bundleTinted = false;
  // Multi-tile bundles: supporting reads share the ribbon color in both tiles.
  // Haplotype/pair styling yields to bundle color when multi-tile + bundles exist.
  if (typeof gsIsMultiTile === "function" && gsIsMultiTile()
      && typeof gsBundleColorForRead === "function"
      && state.bundleColorByReadKey) {
    // Prefer the tile currently being painted (gsWithTile), not only focus —
    // otherwise unfocused freezes look up the wrong tileId and miss the tint.
    const paintTile = (typeof gsActiveTile === "function") ? gsActiveTile() : null;
    const paintTileId = (paintTile && paintTile.id)
      || state.focusedTileId
      || "t0";
    let hex = gsBundleColorForRead(paintTileId, track && track.id, read);
    // Fall back: same qname on any open tile for this track (mate side often
    // keyed without an exact start).
    if (!hex && read && read.name && track && track.id) {
      const prefix = `|${track.id}|${read.name}`;
      for (const k of Object.keys(state.bundleColorByReadKey)) {
        if (k.endsWith(prefix) || k.includes(`|${track.id}|${read.name}|`)) {
          hex = state.bundleColorByReadKey[k];
          break;
        }
      }
    }
    const rgb = hex && typeof gsHexToRgb === "function" ? gsHexToRgb(hex) : null;
    if (rgb) {
      color = rgb;
      bundleTinted = true;
    }
  }
  // WebGPU rect shader: alpha > 0.5 is stroke-only (hollow). Keep read bodies
  // in the fill-only range so Color/Shade None paints uniform solid bars.
  let alpha = 0.45;
  if (display.colorBy === "haplotype" && !bundleTinted) {
    alpha = read.haplotype ? 0.5 : 0.35;
  }
  if (display.shadeBy && !bundleTinted) {
    const s = shadeStrength(read, display.shadeBy, track && track._medianInsertSize, !!rev.shadeBy);
    alpha = 0.22 + 0.28 * s; // ~0.22–0.50
  }
  if (bundleTinted) alpha = Math.max(alpha, 0.50);
  // Selected cross-tile arc read: slight emphasis.
  const sel = state.selectedArcRead;
  if (sel && read && sel.qname && sel.qname === read.name
      && (!sel.trackId || !track || sel.trackId === track.id)) {
    alpha = Math.min(0.50, Math.max(alpha, 0.48));
  }
  return { color, alpha };
}

function visibleReadsForTrack(track) {
  const reads = track && track.readsLayout && track.readsLayout.reads;
  if (!Array.isArray(reads)) return [];
  return reads.filter((r) => r.end >= state.startBp && r.start <= state.endBp);
}

function visibleCategoryCounts(track) {
  const field = (track.readDisplay || DEFAULT_READ_DISPLAY).colorBy;
  const counts = new Map();
  if (!field) return counts;
  for (const read of visibleReadsForTrack(track)) {
    const key = readCategory(read, field);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function visibleShadeBuckets(track) {
  const buckets = [0, 0, 0];
  const field = (track.readDisplay || DEFAULT_READ_DISPLAY).shadeBy;
  if (!field) return buckets;
  for (const read of visibleReadsForTrack(track)) {
    const value = shadeStrength(read, field, track._medianInsertSize);
    buckets[value < 0.45 ? 0 : (value < 0.75 ? 1 : 2)]++;
  }
  return buckets;
}

function makeReadDisplayMiniBar(track, axis) {
  const bar = document.createElement("span");
  bar.className = `rd-mini-bar rd-mini-bar-${axis}`;
  const display = (track && track.readDisplay) || DEFAULT_READ_DISPLAY;
  const rev = display.reverse || DEFAULT_READ_DISPLAY.reverse;
  const values = axis === "colorBy"
    ? Array.from(visibleCategoryCounts(track).entries())
    : visibleShadeBuckets(track).map((count, i) => [i, count]);
  const total = values.reduce((sum, item) => sum + item[1], 0);
  if (!total) {
    const empty = document.createElement("i");
    empty.style.width = "100%";
    bar.appendChild(empty);
    return bar;
  }
  for (const [key, count] of values) {
    const segment = document.createElement("i");
    segment.style.width = `${(count / total) * 100}%`;
    if (axis === "colorBy") {
      const rgb = colorForCategory(display.colorBy, key, !!rev.colorBy);
      segment.style.background = `rgb(${rgb.join(",")})`;
    } else {
      const opacities = rev.shadeBy ? [1, 0.65, 0.35] : [0.35, 0.65, 1];
      segment.style.opacity = String(opacities[key]);
    }
    bar.appendChild(segment);
  }
  return bar;
}

function makeColorLegendStrip(track) {
  const legend = document.createElement("div");
  legend.className = "rd-legend";
  const display = (track && track.readDisplay) || DEFAULT_READ_DISPLAY;
  const field = display.colorBy;
  if (!field) return legend;
  const rev = display.reverse || DEFAULT_READ_DISPLAY.reverse;
  for (const category of visibleCategoryCounts(track).keys()) {
    const item = document.createElement("span");
    const swatch = document.createElement("i");
    const rgb = colorForCategory(field, category, !!rev.colorBy);
    swatch.style.background = `rgb(${rgb.join(",")})`;
    item.append(swatch, document.createTextNode(category));
    legend.appendChild(item);
  }
  return legend;
}

// Sidebar thumbnail for Summary → Track: mirrors the on-canvas aggregate
// summary (stacked HP1/HP2 capsule, or a low→high coverage ramp).
function makeSummaryPreview(track, summaryField) {
  const preview = document.createElement("div");
  preview.className = "rd-summary-preview";
  const mode = summaryField === "coverage" ? "coverage" : "haplotypeConsensus";
  preview.dataset.field = mode;

  if (mode === "coverage") {
    preview.classList.add("is-coverage");
    // Low (left) → high (right) scale legend for the on-canvas depth heatmap.
    preview.style.background =
      "linear-gradient(90deg, rgba(40,75,120,0.45) 0%, rgba(95,145,195,0.7) 45%, rgb(150,200,245) 100%)";
    return preview;
  }

  preview.classList.add("is-haplotype");
  let has1 = false;
  let has2 = false;
  for (const read of visibleReadsForTrack(track)) {
    if (read.haplotype === 1) has1 = true;
    else if (read.haplotype === 2) has2 = true;
    if (has1 && has2) break;
  }

  const capsule = document.createElement("div");
  capsule.className = "rd-summary-capsule";
  const addBand = (cls, rgb, alpha) => {
    const band = document.createElement("i");
    band.className = `rd-summary-hap ${cls}`;
    band.style.background = `rgba(${rgb.join(",")},${alpha})`;
    capsule.appendChild(band);
  };

  if (has1 && has2) {
    // Diploid only when both haplotypes are present. A single HP tag is
    // treated as haploid / effectively unphased — same neutral capsule.
    addBand("hp1", colorForCategory("haplotype", "HP1"), 0.55);
    addBand("hp2", colorForCategory("haplotype", "HP2"), 0.55);
  } else {
    addBand("unphased", colorForCategory("haplotype", "unphased"), 0.45);
  }
  preview.appendChild(capsule);
  return preview;
}

if (typeof window !== "undefined") {
  window.__GS_READ_DISPLAY_FIELDS = READ_DISPLAY_FIELDS;
  window.__GS_GROUP_SHAREABLE_FIELDS = GROUP_SHAREABLE_FIELDS;
  window.__GS_DEFAULT_READ_DISPLAY = DEFAULT_READ_DISPLAY;
  window.__GS_colorForCategory = colorForCategory;
  window.__GS_readCategory = readCategory;
  window.__GS_cloneReadDisplayConfig = cloneReadDisplayConfig;
  window.__GS_applyVisibilityShortcut = applyVisibilityShortcut;
  window.__GS_saveReadDisplayForTrack = saveReadDisplayForTrack;
  window.__GS_syncTrackCollapsedFromVisibility = syncTrackCollapsedFromVisibility;
  window.__GS_isReadDisplayCustomized = isReadDisplayCustomized;
  window.__GS_readPaintStyle = readPaintStyle;
  window.__GS_makeSummaryPreview = makeSummaryPreview;
}

// Shared by sidebar dropdowns (smart-tracks.js) and any leftover callers.
let openReadDisplayPopover = null;
