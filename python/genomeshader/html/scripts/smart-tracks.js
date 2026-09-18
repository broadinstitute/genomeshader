// Smart Tracks
// -----------------------------

// Process raw reads data into a layout structure (used by Smart Tracks)
function processReadsData(rawReads, opts) {
  if (!rawReads || !rawReads.query_name) return null;
  opts = opts || {};
  const display = cloneReadDisplayConfig(opts.display || DEFAULT_READ_DISPLAY);
  // Legacy test / caller overrides (predating readDisplay.alignments.paired).
  if (opts.asPairs != null) display.alignments.paired = !!opts.asPairs;
  if (opts.showPairs != null) display.alignments.paired = !!opts.showPairs;
  const asPairs = display.alignments.paired;
  const mapqMin = display.mapqRange.min;
  const mapqMax = display.mapqRange.max;
  
  // Convert column-oriented data to row-oriented.
  const numRows = rawReads.query_name.length;
  const pairedCol = rawReads.is_paired;
  const primaryCol = rawReads.is_primary;
  const secondaryCol = rawReads.is_secondary;
  const supplementaryCol = rawReads.is_supplementary;

  // One entry per alignment, grouped by CONTIGUITY not query_name: the Rust
  // extractor emits each read as a READ row (element_type 0) immediately
  // followed by that read's own CIGAR element rows. Grouping by query_name was
  // wrong — paired-end mates share a query_name, so it merged a pair into a
  // single read and stapled the mate's SNP/indel markers onto it, painting them
  // outside the (shorter) kept read. Contiguity keeps mates separate and each
  // read's markers confined to that read. "Show as pairs" only shares a *row*
  // (and a connector); it never merges the two objects.
  const readArray = [];
  let current = null;
  for (let i = 0; i < numRows; i++) {
    if (rawReads.element_type[i] === 0) { // READ element starts a new alignment
      const isSecondary = secondaryCol ? !!secondaryCol[i]
        : (primaryCol ? !primaryCol[i] : false);
      const isSupplementary = supplementaryCol ? !!supplementaryCol[i] : false;
      const hasMapq = !!rawReads.mapping_quality;
      const mapq = hasMapq ? Number(rawReads.mapping_quality[i] || 0) : 60;
      current = {
        name: rawReads.query_name[i],
        start: rawReads.reference_start[i],
        end: rawReads.reference_end[i],
        isForward: rawReads.is_forward[i],
        haplotype: rawReads.haplotype[i],
        sample: rawReads.sample_name[i],
        readGroup: rawReads.read_group ? rawReads.read_group[i] : "unknown",
        mappingQuality: mapq,
        insertSize: rawReads.insert_size ? rawReads.insert_size[i] : 0,
        clipLength: rawReads.clip_length ? rawReads.clip_length[i] : 0,
        meanBaseQuality: rawReads.mean_base_quality ? rawReads.mean_base_quality[i] : 0,
        isPaired: !!(pairedCol && pairedCol[i]),
        isPrimary: primaryCol ? !!primaryCol[i] : !(isSecondary || isSupplementary),
        isSecondary,
        isSupplementary,
        mate: null,
        elements: []
      };
      // Absent MAPQ column (legacy/test seeds) skips the range filter.
      const mapqOk = !hasMapq || (mapq >= mapqMin && mapq <= mapqMax);
      const secondaryOk = display.alignments.secondary || !isSecondary;
      const supplOk = display.alignments.supplementary || !isSupplementary;
      if (mapqOk && secondaryOk && supplOk) readArray.push(current);
      else current = null;
    } else if (current) {
      current.elements.push({
        type: rawReads.element_type[i],
        start: rawReads.reference_start[i],
        end: rawReads.reference_end[i],
        sequence: rawReads.sequence[i]
      });
    }
  }

  const insertMagnitudes = readArray
    .filter((r) => r.isPaired && Number(r.insertSize))
    .map((r) => Math.abs(Number(r.insertSize)));
  const medianInsertSize = medianOf(insertMagnitudes);
  for (const read of readArray) {
    const mag = Math.abs(Number(read.insertSize || 0));
    read.insertSizeClass = !read.isPaired || !mag || !medianInsertSize ? "unpaired"
      : (mag < medianInsertSize * 0.5 ? "short"
        : (mag > medianInsertSize * 1.5 ? "long" : "normal"));
  }

  const units = [];
  if (asPairs) {
    const buckets = new Map();
    for (const read of readArray) {
      if (read.isPaired && read.isPrimary) {
        const list = buckets.get(read.name);
        if (list) list.push(read);
        else buckets.set(read.name, [read]);
      }
    }
    const paired = new Set();
    for (const list of buckets.values()) {
      if (list.length !== 2) continue;
      const a = list[0].start <= list[1].start ? list[0] : list[1];
      const b = a === list[0] ? list[1] : list[0];
      a.mate = b;
      b.mate = a;
      paired.add(a);
      paired.add(b);
      units.push({
        start: Math.min(a.start, b.start),
        end: Math.max(a.end, b.end),
        reads: [a, b],
      });
    }
    for (const read of readArray) {
      if (!paired.has(read)) units.push({ start: read.start, end: read.end, reads: [read] });
    }
  } else {
    for (const read of readArray) {
      units.push({ start: read.start, end: read.end, reads: [read] });
    }
  }
  const representative = (unit) => unit.reads[0];
  const groupKey = (unit) => display.groupBy
    ? readCategory(representative(unit), display.groupBy)
    : "__all__";
  const groups = new Map();
  for (const unit of units) {
    const key = groupKey(unit);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(unit);
  }
  const groupRank = {
    HP1: 0, HP2: 1, unphased: 2, short: 0, normal: 1, long: 2, unpaired: 3,
    split: 0, linear: 1,
  };
  let groupNames = Array.from(groups.keys()).sort((a, b) => {
    const ar = groupRank[a], br = groupRank[b];
    if (ar != null || br != null) return (ar == null ? 99 : ar) - (br == null ? 99 : br);
    return String(a).localeCompare(String(b));
  });
  if (display.reverse && display.reverse.groupBy) groupNames = groupNames.reverse();
  const anchor = display.sortAnchor && display.sortAnchor.position;
  const sortValue = (unit) => {
    const read = representative(unit);
    if (!display.sortBy) return unit.start;
    if (display.sortBy === "position") return unit.start;
    if (display.sortBy === "clipLength") return Number(read.clipLength || 0);
    if (display.sortBy === "insertSize") return Math.abs(Number(read.insertSize || 0));
    if (display.sortBy === "distanceToAnchor") {
      const pos = anchor && (!anchor.contig || anchor.contig === state.contig)
        ? Number(anchor.pos) : (state.startBp + state.endBp) / 2;
      return Math.abs(unit.start - pos);
    }
    return readCategory(read, display.sortBy);
  };
  const compareUnits = (a, b) => {
    if (!display.sortBy) return a.start - b.start;
    const av = sortValue(a), bv = sortValue(b);
    let cmp;
    if (typeof av === "string" || typeof bv === "string") {
      cmp = String(av).localeCompare(String(bv)) || a.start - b.start;
    } else {
      const direction = (display.sortBy === "clipLength" || display.sortBy === "insertSize") ? -1 : 1;
      cmp = direction * (av - bv) || a.start - b.start;
    }
    return (display.reverse && display.reverse.sortBy) ? -cmp : cmp;
  };

  // Greedy-pack each group independently. A pair occupies its full insert.
  let rowBase = 0;
  let groupOffsetPx = 0;
  const groupLayouts = [];
  for (const name of groupNames) {
    const groupUnits = groups.get(name);
    groupUnits.sort(compareUnits);
    const rows = [];
    for (const unit of groupUnits) {
      let target = -1;
      for (let r = 0; r < rows.length && target < 0; r++) {
        if (rows[r].every((existing) =>
          unit.end < existing.start - 10 || unit.start > existing.end + 10)) target = r;
      }
      if (target < 0) {
        target = rows.length;
        rows.push([]);
      }
      for (const read of unit.reads) {
        read.row = rowBase + target;
        read.groupOffsetPx = groupOffsetPx;
        read.groupKey = name;
      }
      rows[target].push(unit);
      rows[target].sort((a, b) => a.start - b.start);
    }
    groupLayouts.push({ key: name, rowStart: rowBase, rowCount: rows.length, offsetPx: groupOffsetPx });
    rowBase += rows.length;
    if (name !== groupNames[groupNames.length - 1]) groupOffsetPx += 8;
  }

  return {
    reads: readArray, rowCount: rowBase, groupGapPx: groupOffsetPx,
    groups: groupLayouts, medianInsertSize,
  };
}

// CIGAR N (element_type 5) intron skips. Aligned blocks are the exons; the
// full READ start/end still spans the intron for packing.
const ELEMENT_REFSKIP = 5;

function alignedBlocks(read) {
  if (!read) return [];
  const skips = [];
  if (read.elements) {
    for (const e of read.elements) {
      if (e.type === ELEMENT_REFSKIP) skips.push({ start: e.start, end: e.end });
    }
    skips.sort((a, b) => a.start - b.start);
  }
  if (!skips.length) return [{ start: read.start, end: read.end }];
  const blocks = [];
  let pos = read.start;
  for (const s of skips) {
    if (s.start > pos) blocks.push({ start: pos, end: s.start });
    if (s.end > pos) pos = s.end;
  }
  if (read.end > pos) blocks.push({ start: pos, end: read.end });
  return blocks;
}

function layoutSmartTrackReads(track) {
  if (!track) return;
  if (!track.readsData) {
    track.readsLayout = null;
    return;
  }
  track.readsLayout = processReadsData(track.readsData, {
    display: track.readDisplay,
  });
  track._medianInsertSize = track.readsLayout ? track.readsLayout.medianInsertSize : 0;
  if (track.readDisplay) {
    track.showPairs = !!track.readDisplay.alignments.paired;
    syncTrackCollapsedFromVisibility(track);
  }
}

// Default / maximum open height for a sample (Smart) track. Expanded tracks
// shrink to the packed read stack when it is shorter than this.
const SMART_TRACK_OPEN_HEIGHT = 220;
const SMART_TRACK_ROW_H = 18;

function smartTrackStackHeight(track) {
  // Pixel height of the overview strip + every packed row (uncapped). Null when
  // there is nothing to measure (still loading / no reads).
  if (!track) return null;
  const display = track.readDisplay || DEFAULT_READ_DISPLAY;
  const showReads = display.visibility.reads !== false;
  const showSummary = display.visibility.summary !== false;
  if (!showReads) return null;
  const layout = track.readsLayout;
  if (!layout || !layout.reads || !layout.reads.length) return null;
  const labelH = 24;
  const closedSlot = track.closedHeight || 30;
  const summaryH = Math.max(12, labelH - 2);
  const summaryY = Math.max(0, Math.floor((closedSlot - summaryH) / 2));
  const top = summaryY;
  const bottom = 12;
  const overviewH = showSummary ? (summaryY + summaryH + 4 - top) : 0;
  const rows = layout.rowCount
    || (Math.max(0, ...layout.reads.map((r) => r.row || 0)) + 1)
    || 1;
  const groupGapPx = Number(layout.groupGapPx || 0);
  return top + overviewH + Math.max(1, rows) * SMART_TRACK_ROW_H + groupGapPx + bottom;
}

function smartTrackLayoutHeight(track) {
  // Slot height for layout: summary-only uses closedHeight; with reads fits the
  // stack up to the open cap (track.height, default 220).
  if (!track) return SMART_TRACK_OPEN_HEIGHT;
  const display = track.readDisplay || DEFAULT_READ_DISPLAY;
  const showReads = display.visibility.reads !== false;
  const showSummary = display.visibility.summary !== false;
  if (!showReads && !showSummary) return track.closedHeight || 30;
  if (!showReads) return track.closedHeight || 30;
  const cap = track.height || SMART_TRACK_OPEN_HEIGHT;
  const stack = smartTrackStackHeight(track);
  if (stack == null) return cap;
  return Math.min(cap, stack);
}
if (typeof window !== "undefined") {
  window.__GS_smartTrackLayoutHeight = smartTrackLayoutHeight;
}

// Exposed for the headless harness to regression-test read grouping (paired-end
// mates share a query_name; markers must stay confined to their own read).
if (typeof window !== "undefined") window.__GS_processReadsData = processReadsData;
if (typeof window !== "undefined") window.__GS_alignedBlocks = alignedBlocks;
if (typeof window !== "undefined") window.__GS_layoutSmartTrackReads = layoutSmartTrackReads;

// Create a new Smart track
function createSmartTrack(strategy, selectedAlleles) {
  const timestamp = Date.now();
  const index = state.smartTracks.length;
  const trackId = `smart-track-${timestamp}-${index}`;
  
  // Check if track with this ID already exists (shouldn't happen, but guard against it)
  if (state.smartTracks.find(t => t.id === trackId)) {
    console.warn(`Smart track ${trackId} already exists, skipping creation`);
    return state.smartTracks.find(t => t.id === trackId);
  }
  
  // console.log(`Creating Smart track ${trackId} (total tracks: ${state.smartTracks.length})`);
  
  // Create track object
  const track = {
    id: trackId,
    label: "Loading...",  // Initial label, will be updated when sample is loaded
    collapsed: true,  // derived from visibility.reads; default summary-only
    hidden: false,      // true = not displayed at all
    height: SMART_TRACK_OPEN_HEIGHT,  // Open-height cap; layout shrinks to the read stack
    // Closed slot: taller than the 24px label pill so adjacent labels don't
    // touch, with a few px of breathing room. Summary paints nearly label-tall
    // and centered inside this slot.
    closedHeight: 30,
    minHeight: 50,
    showPairs: true, // mirrored from readDisplay.alignments.paired
    groupId: null, // user track-group tag (shared settings); null = ungrouped
    readDisplay: (() => {
      // New track IDs are unique; start summary-only to match prior collapsed default.
      const cfg = loadReadDisplayForTrack(trackId);
      cfg.visibility = { summary: true, reads: false };
      return cfg;
    })(),
    strategy: strategy,
    selectedAlleles: new Set(selectedAlleles),
    sampleId: null,
    sampleType: null, // 'carrier' or 'control' (for carriers_controls strategy)
    readsData: null,
    readsLayout: null,
    loading: false,
    bamUrls: []
  };
  
  // Add to smartTracks array
  state.smartTracks.push(track);
  
  // Insert after the flow track
  const flowIndex = state.tracks.findIndex(t => t.id === "flow");
  const insertIndex = flowIndex >= 0 ? flowIndex + 1 : state.tracks.length;
  state.tracks.splice(insertIndex, 0, track);
  
  // Initialize WebGPU renderer (async, but don't await - it will complete in background)
  initSmartTrackWebGPU(trackId);
  
  // Update layout
  updateTracksHeight();
  renderAll();
  renderSmartTracksSidebar();
  
  return track;
}

// Initialize WebGPU renderer for a Smart track
async function initSmartTrackWebGPU(trackId) {
  // Check if renderer already exists - prevent re-initialization
  if (state.smartTrackRenderers.has(trackId)) {
    // console.log(`Smart track ${trackId}: WebGPU already initialized, skipping`);
    return;
  }
  
  if (!webgpuSupported || !navigator.gpu) {
    console.warn('WebGPU not supported, Smart track will use Canvas2D fallback');
    return;
  }
  
  const track = state.smartTracks.find(t => t.id === trackId);
  if (!track) return;
  
  // Find tracks container
  const tracksContainer = document.getElementById('tracksContainer');
  if (!tracksContainer) return;
  
  // Create container div for this Smart track
  const container = document.createElement('div');
  container.className = 'smart-track-container';
  container.id = `smart-track-container-${trackId}`;
  container.dataset.trackId = trackId;
  container.style.position = 'absolute';
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.pointerEvents = 'none';
  
  // Create Canvas2D canvas
  const canvas = document.createElement('canvas');
  canvas.className = 'canvas';
  canvas.id = `smart-track-canvas-${trackId}`;
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  
  // Create WebGPU canvas
  const webgpuCanvas = document.createElement('canvas');
  webgpuCanvas.className = 'webgpu-canvas';
  webgpuCanvas.id = `smart-track-webgpu-${trackId}`;
  webgpuCanvas.style.position = 'absolute';
  webgpuCanvas.style.top = '0';
  webgpuCanvas.style.left = '0';
  webgpuCanvas.style.width = '100%';
  webgpuCanvas.style.height = '100%';
  webgpuCanvas.style.pointerEvents = 'none';
  
  // Transparent 2D text overlay above the WebGPU canvas, for SNP base letters
  // (WebGPU has no text). Cheap now that canvases are viewport-sized (not the
  // full stack that caused the earlier GPU stall). Sticky + zIndex above WebGPU.
  const textCanvas = document.createElement('canvas');
  textCanvas.className = 'text-overlay';
  textCanvas.id = `smart-track-text-${trackId}`;
  textCanvas.style.position = 'sticky';
  textCanvas.style.top = '0';
  textCanvas.style.left = '0';
  textCanvas.style.zIndex = '3';
  textCanvas.style.pointerEvents = 'none';
  // A canvas is inline by default; as a later inline sibling of the WebGPU
  // canvas it inherits a line-box/baseline gap (~font descent) and sits a few px
  // LOW, so the SNP letters landed below their tiles. Block-level removes the
  // inline gap so the overlay aligns exactly with the WebGPU canvas.
  textCanvas.style.display = 'block';

  // Virtualization spacer: gives the container its scroll height so the
  // viewport-sized (sticky) canvases can draw only the visible rows — lifts the
  // full-stack canvas size (the ~16384px GPU wall behind the read cap).
  const spacer = document.createElement('div');
  spacer.className = 'smart-track-vspacer';
  spacer.style.cssText = 'position:relative;width:1px;pointer-events:none;flex:0 0 auto;';

  container.appendChild(canvas);
  container.appendChild(webgpuCanvas);
  container.appendChild(textCanvas);
  container.appendChild(spacer);
  // Live in the scrolling reads region (#smartScroll) so the whole sample-track
  // stack scrolls together below the pinned header.
  ((typeof ensureSmartScrollWrapper === "function" && ensureSmartScrollWrapper())
    || tracksContainer).appendChild(container);

  // Re-render whenever the container gets a REAL size change. renderSmartTrack
  // bails when the measured width is 0 (layout not settled — common right after
  // expanding in full screen / JupyterLab); this recovers as soon as the real
  // size lands, without a manual scroll.
  //
  // Fire ONLY on the initial 0 -> real-size transition. Every other re-render
  // (collapse/expand, pan, zoom, panel resize) is already driven by an explicit
  // renderAll() or the global tracksSvg ResizeObserver. Re-rendering here on
  // later width changes is not just redundant — it's a freeze: expand grows the
  // stack, which makes BOTH this container's internal scrollbar and the outer
  // #smartScroll scrollbar appear (~30px), re-rendering toggles them, width
  // changes, RO fires again … an infinite loop. Read x-mapping uses
  // tracksWidthPx() (not this width) anyway, so later changes need no repaint.
  let _roPainted = false;
  try {
    const ro = new ResizeObserver(() => {
      if (_roPainted) return;
      const w = container.getBoundingClientRect().width || 0;
      if (w <= 0) return;
      _roPainted = true;
      requestAnimationFrame(() => { try { renderSmartTrack(trackId); } catch (e) {} });
    });
    ro.observe(container);
    // Stash for cleanup even before the renderer record exists.
    container._gsResizeObserver = ro;
  } catch (e) {}

  try {
    // Wait for canvas to have dimensions
    const checkDimensions = () => {
      const rect = webgpuCanvas.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    
    // Wait up to 2 seconds for dimensions
    for (let i = 0; i < 40; i++) {
      if (checkDimensions()) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    if (!checkDimensions()) {
      console.warn(`Smart track ${trackId}: Canvas dimensions not ready`);
      return;
    }
    
    // Initialize WebGPU
    const webgpuCore = new WebGPUCore();
    await webgpuCore.init(webgpuCanvas);
    const instancedRenderer = new InstancedRenderer(webgpuCore);
    
    // Store renderer objects
    state.smartTrackRenderers.set(trackId, {
      webgpuCore,
      instancedRenderer,
      canvas,
      webgpuCanvas,
      textCanvas,
      spacer,
      container
    });

    // Scroll and wheel handlers will be attached in renderSmartTrack when container becomes scrollable
    // But we need a basic scroll handler for re-rendering
    container.addEventListener("scroll", () => {
      scheduleSmartTrackRender(trackId);
    });

    // Render now that the renderer exists. WebGPU init is async and can finish
    // AFTER the reads-load renderAll already ran (found no renderer) — notably in
    // full screen, where the canvas takes longer to get dimensions. Without this,
    // reads don't appear until a scroll triggers renderSmartTrack.
    requestAnimationFrame(() => { try { renderSmartTrack(trackId); } catch (e) {} });

    console.log(`Smart track ${trackId}: WebGPU initialized`);
  } catch (error) {
    console.warn(`Smart track ${trackId}: Failed to initialize WebGPU:`, error);
    // Continue without WebGPU - will use Canvas2D fallback
    
    // Still store the renderer objects (without WebGPU)
    state.smartTrackRenderers.set(trackId, {
      webgpuCore: null,
      instancedRenderer: null,
      canvas,
      webgpuCanvas,
      textCanvas,
      spacer: null,
      container
    });
    
    // Scroll and wheel handlers will be attached in renderSmartTrack when container becomes scrollable
    // But we need a basic scroll handler for re-rendering
    container.addEventListener("scroll", () => {
      scheduleSmartTrackRender(trackId);
    });
    // Paint once the (Canvas2D-fallback) renderer exists — see note above.
    requestAnimationFrame(() => { try { renderSmartTrack(trackId); } catch (e) {} });
  }
}

// Remove WebGPU renderer for a Smart track
function removeSmartTrackWebGPU(trackId) {
  const renderer = state.smartTrackRenderers.get(trackId);
  if (renderer) {
    // Clean up WebGPU resources
    if (renderer.webgpuCore && renderer.webgpuCore.device) {
      // WebGPU cleanup is handled automatically when canvas is removed
    }
    
    // Remove DOM elements
    if (renderer.container) {
      try { if (renderer.container._gsResizeObserver) renderer.container._gsResizeObserver.disconnect(); } catch (e) {}
      if (renderer.container.parentNode) {
        renderer.container.parentNode.removeChild(renderer.container);
      }
      // Also try to remove by ID as fallback
      const containerById = document.getElementById(`smart-track-container-${trackId}`);
      if (containerById && containerById.parentNode) {
        containerById.parentNode.removeChild(containerById);
      }
    }
    
    // Remove from Map
    state.smartTrackRenderers.delete(trackId);
  }
}

// Fetch reads for a Smart track
// In-memory reads cache so re-opening a read track (remove + re-add, or any
// re-fetch) for the same sample at the same locus reappears instantly instead
// of round-tripping the comm. Keyed by sampleId|locus; capped LRU-ish.
const _smartReadsCache = new Map();
const _SMART_READS_CACHE_MAX = 24;
function _readsLocusSig() {
  try {
    return state.contig + ":" + Math.floor(state.startBp) + "-" + Math.ceil(state.endBp);
  } catch (e) { return ""; }
}
function _cacheSmartReads(sampleId, reads, bamUrls, bamUrl) {
  if (!sampleId) return;
  const key = sampleId + "|" + (bamUrl || "") + "|" + _readsLocusSig();
  _smartReadsCache.delete(key);          // move-to-front
  _smartReadsCache.set(key, { reads: reads, bamUrls: bamUrls || [], bamUrl: bamUrl || null });
  while (_smartReadsCache.size > _SMART_READS_CACHE_MAX) {
    _smartReadsCache.delete(_smartReadsCache.keys().next().value);
  }
}

// BAM/CRAM URLs resolved for a sample (from config). Empty when unknown —
// fetch_reads will resolve on the kernel. Multi-URL samples get one track each.
// evidenceFilter (Sample Search) narrows by attach_reads label when applyEvidence
// is true (default). Load-by-ID passes applyEvidence:false so typed IDs bypass
// the Narrow filter. Metadata facets are applied at the candidate-pool layer.
function bamUrlsForSample(sampleId, opts) {
  if (!sampleId) return [];
  const applyEvidence = !(opts && opts.applyEvidence === false);
  const cfg = window.GENOMESHADER_CONFIG || {};
  const idx = cfg.read_bam_index || {};
  let urls = [];
  if (Array.isArray(idx[sampleId]) && idx[sampleId].length) {
    urls = idx[sampleId].slice();
  } else {
    const sm = cfg.sample_mapping || {};
    if (Array.isArray(sm[sampleId]) && sm[sampleId].length) {
      urls = sm[sampleId].slice();
    }
  }
  if (applyEvidence) {
    const filter = (state.sampleSelection && state.sampleSelection.evidenceFilter) || null;
    if (filter && typeof getReadSetForUrl === "function") {
      urls = urls.filter((u) => String(getReadSetForUrl(u) || "") === String(filter));
    }
  }
  return urls;
}

function isSampleBamTrackLoaded(sampleId, bamUrl) {
  return (state.smartTracks || []).some((t) => {
    if (t.sampleId !== sampleId) return false;
    if (!bamUrl) return true;
    if (t.requestedBamUrl === bamUrl) return true;
    return Array.isArray(t.bamUrls) && t.bamUrls.length === 1 && t.bamUrls[0] === bamUrl;
  });
}

function isSampleFullyLoaded(sampleId, opts) {
  const urls = bamUrlsForSample(sampleId, opts);
  if (!urls.length) {
    return (state.smartTracks || []).some((t) => t.sampleId === sampleId);
  }
  return urls.every((u) => isSampleBamTrackLoaded(sampleId, u));
}

// Create one smart track per unresolved BAM for this sample and kick off fetches.
// Returns the list of fetch promises (may be empty if already fully loaded).
// opts.applyEvidence: when false (Load-by-ID), skip evidence filter and do not
// toast "No {evidence} reads".
function spawnSmartTracksForSample(sampleId, strategy, selectedAlleles, sampleType, opts) {
  const promises = [];
  if (!sampleId) return promises;
  const applyEvidence = !(opts && opts.applyEvidence === false);
  const urlOpts = { applyEvidence };
  if (isSampleFullyLoaded(sampleId, urlOpts)) return promises;
  const alleles = selectedAlleles instanceof Set
    ? selectedAlleles
    : new Set(selectedAlleles || []);
  const urls = bamUrlsForSample(sampleId, urlOpts);
  if (!urls.length) {
    const evidence = state.sampleSelection && state.sampleSelection.evidenceFilter;
    if (applyEvidence && evidence) {
      if (window.__GS_STATUS) {
        window.__GS_STATUS(`No ${evidence} reads for ${sampleId}`, { autoHide: 3500 });
      }
      return promises;
    }
  }
  const bamList = urls.length
    ? urls.filter((u) => !isSampleBamTrackLoaded(sampleId, u))
    : [null];
  for (const bamUrl of bamList) {
    const track = createSmartTrack(strategy, Array.from(alleles));
    track.sampleId = sampleId;
    track.requestedBamUrl = bamUrl || null;
    if (sampleType) track.sampleType = sampleType;
    promises.push(
      fetchReadsForSmartTrack(track.id, strategy, alleles, sampleId, bamUrl || undefined)
        .catch((err) => {
          console.error("Failed to load reads for Smart track:", err);
        })
    );
  }
  if (typeof clusterSmartTracksByGrouping === "function") {
    clusterSmartTracksByGrouping();
  }
  return promises;
}

if (typeof window !== "undefined") {
  window.__GS_bamUrlsForSample = bamUrlsForSample;
  window.__GS_isSampleFullyLoaded = isSampleFullyLoaded;
  window.__GS_spawnSmartTracksForSample = spawnSmartTracksForSample;
}

// Bottom-bar status for read loads, COUNTED so concurrent loads (e.g. 3 samples
// at once) keep the bar up until the last one finishes. Without the count, the
// first sample to return fires "Loaded" + a 2s auto-hide and the bar vanishes
// while the others are still loading — which reads as "the loading bar doesn't
// show up", especially in full screen.
let _readLoadsInFlight = 0;
function _readStatusStart(sampleId) {
  _readLoadsInFlight++;
  if (!window.__GS_STATUS) return;
  window.__GS_STATUS(_readLoadsInFlight > 1
    ? ('Loading reads (' + _readLoadsInFlight + ')…')
    : ('Loading reads' + (sampleId ? ' for ' + sampleId : '') + '…'), { busy: true });
}
function _readStatusDone(label, isError) {
  _readLoadsInFlight = Math.max(0, _readLoadsInFlight - 1);
  if (!window.__GS_STATUS) return;
  if (_readLoadsInFlight > 0) {                       // others still loading
    window.__GS_STATUS('Loading reads (' + _readLoadsInFlight + ')…', { busy: true });
  } else if (label) {
    window.__GS_STATUS(label, { autoHide: isError ? 5000 : 2000 });
  } else {
    window.__GS_STATUS(false);
  }
}

function fetchReadsForSmartTrack(trackId, strategy, selectedAlleles, sampleId, bamUrl) {
  const track = state.smartTracks.find(t => t.id === trackId);
  if (!track) {
    console.error(`Smart track ${trackId} not found`);
    return Promise.reject(new Error('Track not found'));
  }
  // Pin an explicit BAM when the caller asks for one. When switching samples
  // without a new BAM, drop the previous pin — otherwise shuffle/reload sends
  // the old sample's bam_url for the new sample_id, the kernel returns an empty
  // payload, and we delete the track.
  if (bamUrl) {
    track.requestedBamUrl = bamUrl;
  } else if (sampleId != null && track.sampleId != null
      && String(sampleId) !== String(track.sampleId)) {
    track.requestedBamUrl = null;
  }
  const requestedBam = track.requestedBamUrl || null;

  // Instant path: a known sample(+bam) previously loaded at this locus.
  const cacheKey = sampleId
    ? (sampleId + "|" + (requestedBam || "") + "|" + _readsLocusSig())
    : null;
  if (cacheKey && _smartReadsCache.has(cacheKey)) {
    const hit = _smartReadsCache.get(cacheKey);
    track.loading = false;
    track.readsData = hit.reads;
    layoutSmartTrackReads(track);
    track.sampleId = sampleId;
    track.bamUrls = hit.bamUrls || [];
    track.requestedBamUrl = hit.bamUrl || requestedBam;
    updateSmartTrackLabel(track);
    renderAll();
    requestAnimationFrame(() => { try { renderSmartTrack(trackId); } catch (e) {} });
    // Instant cache hit: flash a brief confirmation so the user sees something
    // happened. If other loads are in flight, leave their busy bar alone.
    if (window.__GS_STATUS && _readLoadsInFlight === 0) {
      const sn = sampleId || track.sampleId;
      window.__GS_STATUS('Loaded reads' + (sn ? ' for ' + sn : '') + ' (cached)',
        { autoHide: 1200 });
    }
    return Promise.resolve(track.readsLayout);
  }

  track.loading = true;
  renderAll();
  _readStatusStart(sampleId);

  // Convert selectedAlleles Set to array
  const allelesArray = Array.from(selectedAlleles);

  const req = {
    strategy: strategy,
    selected_alleles: allelesArray,
    sample_id: sampleId || null,
    // Fetch reads for the CURRENTLY VIEWED window, not the server's last-rendered
    // locus. Viewport paging (pan/zoom) never re-runs render(), so _last_locus
    // goes stale — reads would come back for the old region and never align with
    // what's on screen. Matches _readsLocusSig() so the client read cache agrees.
    locus: _readsLocusSig() || null
  };
  if (requestedBam) req.bam_url = requestedBam;

  return sendCommMessage('fetch_reads', req)
    .then(function(response) {
      track.loading = false;
      if (response.type === 'fetch_reads_response') {
        // No BAM resolved for this sample (VCF-only). Drop the empty track
        // quietly — not an error modal.
        if (!response.bam_urls || !response.bam_urls.length) {
          _readStatusDone(false);
          removeSmartTrack(trackId);
          return null;
        }
        // Stale config / no bam_url requested but the kernel resolved multiple
        // BAMs for this sample: keep this track for the first URL and spawn
        // sibling tracks for the rest (one track per BAM).
        if (!requestedBam && response.bam_urls.length > 1) {
          const urls = response.bam_urls.slice();
          _readStatusDone(false);
          track.requestedBamUrl = urls[0];
          for (let i = 1; i < urls.length; i++) {
            if (isSampleBamTrackLoaded(sampleId || response.sample_id, urls[i])) continue;
            const sibling = createSmartTrack(strategy, selectedAlleles);
            sibling.sampleId = sampleId || response.sample_id || null;
            sibling.requestedBamUrl = urls[i];
            sibling.sampleType = track.sampleType || null;
            fetchReadsForSmartTrack(sibling.id, strategy, selectedAlleles,
              sibling.sampleId, urls[i]).catch(() => {});
          }
          return fetchReadsForSmartTrack(trackId, strategy, selectedAlleles,
            sampleId || response.sample_id, urls[0]);
        }
        const sn = sampleId || response.sample_id;
        _readStatusDone('Loaded reads' + (sn ? ' for ' + sn : ''), false);
        // Warn only when SNPs truly can't be shown: has_md is per-element and now
        // means "SNP-displayable" — true if the read had an MD tag OR the staged
        // reference was available to diff against. All-false => neither, i.e. no
        // MD and no reference staged for this locus (indels still render).
        try {
          const hm = response.reads && response.reads.has_md;
          if (Array.isArray(hm) && hm.length && !hm.some(Boolean)) {
            track.snpsUnavailable = true;
            if (window.__GS_STATUS) {
              window.__GS_STATUS('SNPs not shown for ' + (sn || 'this sample')
                + ' — no reference staged for this locus and BAM has no MD tag',
                { autoHide: 6000 });
            }
          } else {
            track.snpsUnavailable = false;
          }
        } catch (e) {}
        track.readsData = response.reads;
        layoutSmartTrackReads(track);
        track.sampleId = sampleId || response.sample_id || null;
        track.bamUrls = response.bam_urls || [];
        track.requestedBamUrl = requestedBam || (track.bamUrls.length === 1 ? track.bamUrls[0] : null);
        _cacheSmartReads(track.sampleId, response.reads, track.bamUrls, track.requestedBamUrl);

        // Update track label to use sample name
        updateSmartTrackLabel(track);
        
        // Set sampleType for carriers_controls strategy if not already set
        if (strategy === 'carriers_controls' && track.sampleId && !track.sampleType) {
          // Determine if this sample is a carrier or control
          const combineMode = state.sampleSelection.combineMode;
          const carriers = window.computeCandidateSamplesForAlleles 
            ? window.computeCandidateSamplesForAlleles(selectedAlleles, combineMode)
            : [];
          const carriersSet = new Set(carriers);
          track.sampleType = carriersSet.has(track.sampleId) ? 'carrier' : 'control';
        }
        
        renderAll();
        // Height-fit + WebGPU init can leave the first paint at 0-size or
        // wiped by a deferred canvas resize. One more frame after layout
        // settles so reads show without a pan/scroll.
        requestAnimationFrame(() => { try { renderSmartTrack(trackId); } catch (e) {} });
        return track.readsLayout;
      } else if (response.type === 'fetch_reads_error') {
        console.error(`Failed to fetch reads for Smart track ${trackId}:`, response.error);
        const err = new Error(response.error, { cause: response.hint });
        err._gsMissingBam = /no bam files found/i.test(String(response.error || ''));
        throw err;  // handled in .catch
      }
      _readStatusDone(false);            // unknown response: decrement, don't leak
      return null;
    })
    .catch(function(err) {
      track.loading = false;
      const who = sampleId || track.sampleId;
      console.error(`Failed to fetch reads for Smart track ${trackId}:`, err);
      _readStatusDone(false);       // clear the busy bar; the modal carries the message
      // A read track that failed to load shouldn't linger empty — remove it.
      removeSmartTrack(trackId);    // also re-renders + refreshes the sidebar
      const missingBam = (err && err._gsMissingBam)
        || /no bam files found/i.test(String((err && err.message) || err || ''));
      if (window.__GS_MODAL && !missingBam) {
        window.__GS_MODAL(
          'Failed to load reads' + (who ? ' for ' + who : '') + '.\n\n'
            + (err && err.message ? err.message : 'The read fetch failed.')
            + '\n\n' + (err && err.cause ? String(err.cause)
                : 'Check that you are authenticated and can access the BAM/CRAM files.'),
          { title: 'Failed to load reads' });
      }
      throw err;
    });
}

// Remove a Smart track
const SMART_TRACK_REMOVE_TIMEOUT_MS = 5500;
let _smartTrackRemoveTimeoutMs = SMART_TRACK_REMOVE_TIMEOUT_MS;
let armedRemoveTrackId = null;
let armedRemoveTimer = null;
let pendingUndo = null; // { snapshot, insertIndex, expiresAt, timerId }

function getSmartTrackRemoveTimeoutMs() {
  return _smartTrackRemoveTimeoutMs;
}

function clearArmedRemove() {
  armedRemoveTrackId = null;
  if (armedRemoveTimer) {
    clearTimeout(armedRemoveTimer);
    armedRemoveTimer = null;
  }
}

function armRemoveSmartTrack(trackId) {
  clearArmedRemove();
  armedRemoveTrackId = trackId;
  armedRemoveTimer = setTimeout(() => {
    clearArmedRemove();
    if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
  }, getSmartTrackRemoveTimeoutMs());
  if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
}

function snapshotSmartTrackForUndo(trackId) {
  const layoutTrack = (state.tracks || []).find((t) => t.id === trackId);
  const smartMeta = (state.smartTracks || []).find((t) => t.id === trackId);
  if (!layoutTrack && !smartMeta) return null;
  const src = smartMeta || layoutTrack;
  const insertIndex = (state.tracks || []).findIndex((t) => t.id === trackId);
  const cloneTrack = (t) => {
    if (!t) return null;
    const out = Object.assign({}, t);
    if (t.readDisplay) out.readDisplay = cloneReadDisplayConfig(t.readDisplay);
    if (t.selectedAlleles instanceof Set) out.selectedAlleles = new Set(t.selectedAlleles);
    else if (t.selectedAlleles) out.selectedAlleles = new Set(t.selectedAlleles);
    // Preserve reads payloads by reference so undo restore is instant/config-complete.
    if (t.readsData) out.readsData = t.readsData;
    if (t.readsLayout) out.readsLayout = t.readsLayout;
    return out;
  };
  return {
    insertIndex: insertIndex >= 0 ? insertIndex : (state.tracks || []).length,
    layoutTrack: cloneTrack(layoutTrack),
    smartMeta: cloneTrack(smartMeta),
    label: (src && src.label) || trackId,
  };
}

function clearPendingUndo(finalize) {
  if (!pendingUndo) return;
  if (pendingUndo.timerId) clearTimeout(pendingUndo.timerId);
  pendingUndo = null;
  if (finalize && typeof renderSmartTracksSidebar === "function") {
    renderSmartTracksSidebar();
  }
}

function confirmRemoveSmartTrack(trackId) {
  const snap = snapshotSmartTrackForUndo(trackId);
  clearArmedRemove();
  clearPendingUndo(false);
  // Soft-remove without re-rendering yet — insert undo toast in place.
  const trackIndex = state.tracks.findIndex((t) => t.id === trackId);
  if (trackIndex >= 0) state.tracks.splice(trackIndex, 1);
  const smartIndex = state.smartTracks.findIndex((t) => t.id === trackId);
  if (smartIndex >= 0) state.smartTracks.splice(smartIndex, 1);
  removeSmartTrackWebGPU(trackId);
  if (state.expandedTrackConfigId === trackId) state.expandedTrackConfigId = null;
  pendingUndo = {
    snapshot: snap,
    insertIndex: snap ? snap.insertIndex : trackIndex,
    expiresAt: Date.now() + SMART_TRACK_REMOVE_TIMEOUT_MS,
    timerId: setTimeout(() => {
      pendingUndo = null;
      if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
    }, SMART_TRACK_REMOVE_TIMEOUT_MS),
  };
  updateTracksHeight();
  renderAll();
  renderSmartTracksSidebar();
}

function undoRemoveSmartTrack() {
  if (!pendingUndo || !pendingUndo.snapshot) return;
  const snap = pendingUndo.snapshot;
  if (pendingUndo.timerId) clearTimeout(pendingUndo.timerId);
  pendingUndo = null;
  const layoutTrack = snap.layoutTrack;
  const smartMeta = snap.smartMeta;
  if (layoutTrack) {
    const idx = Math.max(0, Math.min(snap.insertIndex, state.tracks.length));
    state.tracks.splice(idx, 0, layoutTrack);
  }
  if (smartMeta) {
    // Prefer inserting among smart tracks in layout order.
    const smartIds = state.tracks.filter((t) => String(t.id).indexOf("smart-track-") === 0).map((t) => t.id);
    state.smartTracks = smartIds.map((id) => {
      if (id === smartMeta.id) return smartMeta;
      return state.smartTracks.find((t) => t.id === id);
    }).filter(Boolean);
    if (!state.smartTracks.find((t) => t.id === smartMeta.id)) {
      state.smartTracks.push(smartMeta);
    }
    initSmartTrackWebGPU(smartMeta.id);
  }
  updateTracksHeight();
  renderAll();
  renderSmartTracksSidebar();
}

function removeSmartTrack(trackId) {
  // Hard remove (no undo) — used by load failures and callers that skip arm/confirm.
  clearArmedRemove();
  if (pendingUndo && pendingUndo.snapshot
      && ((pendingUndo.snapshot.layoutTrack && pendingUndo.snapshot.layoutTrack.id === trackId)
        || (pendingUndo.snapshot.smartMeta && pendingUndo.snapshot.smartMeta.id === trackId))) {
    clearPendingUndo(false);
  }
  const trackIndex = state.tracks.findIndex(t => t.id === trackId);
  if (trackIndex >= 0) {
    state.tracks.splice(trackIndex, 1);
  }
  
  const smartIndex = state.smartTracks.findIndex(t => t.id === trackId);
  if (smartIndex >= 0) {
    state.smartTracks.splice(smartIndex, 1);
  }
  
  removeSmartTrackWebGPU(trackId);
  
  if (state.expandedTrackConfigId === trackId) state.expandedTrackConfigId = null;

  updateTracksHeight();
  renderAll();
  renderSmartTracksSidebar();
}

function moveSmartTrackInList(trackId, direction) {
  const idx = state.tracks.findIndex((t) => t.id === trackId);
  if (idx < 0) return;
  const dest = idx + direction;
  if (dest < 0 || dest >= state.tracks.length) return;
  const copy = state.tracks.slice();
  const [item] = copy.splice(idx, 1);
  copy.splice(dest, 0, item);
  state.tracks = copy;
  if (Array.isArray(state.smartTracks) && state.smartTracks.length) {
    const smartOrder = copy.filter((t) => String(t.id).indexOf("smart-track-") === 0).map((t) => t.id);
    const smartMap = new Map(state.smartTracks.map((t) => [t.id, t]));
    state.smartTracks = smartOrder.map((id) => smartMap.get(id)).filter(Boolean);
  }
  updateTracksHeight();
  renderAll();
  renderSmartTracksSidebar();
  const el = document.querySelector(`.smart-track-item[data-track-id="${trackId}"]`);
  if (el) el.focus();
}

// Update Smart track strategy and reload
function updateSmartTrackStrategy(trackId, newStrategy) {
  const track = state.smartTracks.find(t => t.id === trackId);
  if (!track) return;
  
  track.strategy = newStrategy;
  
  // Get candidate samples based on new strategy
  const candidates = state.sampleSelection.candidateSamples;
  const sampleId = candidates && candidates.length > 0 ? candidates[0] : null;
  
  // Fetch reads with new strategy
  fetchReadsForSmartTrack(trackId, newStrategy, track.selectedAlleles, sampleId)
    .catch(err => {
      console.error(`Failed to update strategy for track ${trackId}:`, err);
    });
}

// Reload Smart track (reload with current sample)
function reloadSmartTrack(trackId) {
  const track = state.smartTracks.find(t => t.id === trackId);
  if (!track) return;
  
  // Keep the same BAM pin so multi-BAM samples reload this file only.
  const bamUrl = track.requestedBamUrl
    || (track.bamUrls && track.bamUrls.length === 1 ? track.bamUrls[0] : null);
  fetchReadsForSmartTrack(trackId, track.strategy, track.selectedAlleles, track.sampleId,
    bamUrl || undefined)
    .catch(err => {
      console.error(`Failed to reload track ${trackId}:`, err);
    });
}

// Pick one BAM URL for a sample when replacing a single track (shuffle/reload).
// Prefers a file whose basename shares a token with the previous BAM (e.g. both
// "long" or both "short"), otherwise the first resolved URL.
function pickBamUrlForSample(sampleId, previousBamUrl) {
  const urls = bamUrlsForSample(sampleId);
  if (!urls.length) return null;
  if (urls.length === 1) return urls[0];
  if (!previousBamUrl || typeof getBasename !== "function") return urls[0];
  const prev = String(getBasename(previousBamUrl) || "").toLowerCase();
  const tokens = prev.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  for (const u of urls) {
    const b = String(getBasename(u) || "").toLowerCase();
    if (tokens.some((t) => b.includes(t) && t !== String(sampleId).toLowerCase())) {
      return u;
    }
  }
  return urls[0];
}

// Shuffle Smart track (choose a new/different sample)
function shuffleSmartTrack(trackId) {
  const track = state.smartTracks.find(t => t.id === trackId);
  if (!track) return;

  const prevBam = track.requestedBamUrl
    || (track.bamUrls && track.bamUrls.length === 1 ? track.bamUrls[0] : null);

  function fetchShuffled(sampleId) {
    if (!sampleId) return;
    // Clear the old pin, then lock onto one BAM for the new sample so shuffle
    // replaces this track instead of spawning every BAM as a sibling.
    track.requestedBamUrl = null;
    const bamUrl = pickBamUrlForSample(sampleId, prevBam);
    fetchReadsForSmartTrack(trackId, track.strategy, track.selectedAlleles, sampleId,
      bamUrl || undefined)
      .catch(err => {
        console.error(`Failed to shuffle track ${trackId}:`, err);
      });
  }
  
  // For carriers_controls strategy, preserve the sample type (carrier vs control)
  if (track.strategy === 'carriers_controls' && track.sampleType) {
    // Get all available samples
    const allSamples = state.sampleSelection.allSampleIds || [];
    if (allSamples.length === 0) {
      console.warn(`No samples available for shuffling track ${trackId}`);
      return;
    }
    
    // Compute candidates for this track's alleles
    const combineMode = state.sampleSelection.combineMode;
    const carriers = window.computeCandidateSamplesForAlleles 
      ? window.computeCandidateSamplesForAlleles(track.selectedAlleles, combineMode)
      : [];
    
    // Compute controls: samples that are NOT carriers
    const carriersSet = new Set(carriers);
    const controls = allSamples.filter(sampleId => !carriersSet.has(sampleId));
    
    // Get candidates based on sample type
    let typeCandidates = [];
    if (track.sampleType === 'carrier') {
      typeCandidates = carriers.filter(s => s !== track.sampleId);
    } else if (track.sampleType === 'control') {
      typeCandidates = controls.filter(s => s !== track.sampleId);
    }
    
    if (typeCandidates.length === 0) {
      // If no other samples of this type, allow the same sample or fallback
      if (track.sampleType === 'carrier' && carriers.length > 0) {
        typeCandidates = carriers;
      } else if (track.sampleType === 'control' && controls.length > 0) {
        typeCandidates = controls;
      } else {
        console.warn(`No ${track.sampleType} samples available for shuffling track ${trackId}`);
        return;
      }
    }
    
    // Pick a random sample from the type-specific candidates
    const randomIndex = Math.floor(Math.random() * typeCandidates.length);
    fetchShuffled(typeCandidates[randomIndex]);
    return;
  }
  
  // For other strategies, use the original logic
  // Compute candidate samples for this track's specific alleles
  // Use the track's strategy and the current combine mode
  const combineMode = state.sampleSelection.combineMode;
  const candidates = window.computeCandidateSamplesForAlleles 
    ? window.computeCandidateSamplesForAlleles(track.selectedAlleles, combineMode)
    : [];
  
  if (!candidates || candidates.length === 0) {
    console.warn(`No candidate samples found for track ${trackId}`);
    return;
  }
  
  // Select a new sample based on the track's strategy
  let sampleId = null;
  
  if (window.selectSamplesForStrategy && track.strategy) {
    // Use the strategy-based selection (for Random, this will pick a random sample)
    const selectedSamples = window.selectSamplesForStrategy(track.strategy, candidates, 1);
    if (selectedSamples.length > 0) {
      sampleId = selectedSamples[0];
      
      // If we got the same sample and there are other candidates, try to get a different one
      if (sampleId === track.sampleId && candidates.length > 1) {
        // Filter out the current sample and pick randomly from the rest
        const otherCandidates = candidates.filter(s => s !== track.sampleId);
        if (otherCandidates.length > 0) {
          sampleId = otherCandidates[Math.floor(Math.random() * otherCandidates.length)];
        }
      }
    }
  } else {
    // Fallback: pick a random different sample
    if (candidates.length === 1) {
      sampleId = candidates[0];
    } else {
      // Try to get a different sample
      const otherCandidates = track.sampleId 
        ? candidates.filter(s => s !== track.sampleId)
        : candidates;
      if (otherCandidates.length > 0) {
        sampleId = otherCandidates[Math.floor(Math.random() * otherCandidates.length)];
      } else {
        sampleId = candidates[Math.floor(Math.random() * candidates.length)];
      }
    }
  }
  
  fetchShuffled(sampleId);
}

// Update Smart track label based on sampleId or BAM URLs
// Note: This function uses getBasename and truncatePath from main.js,
// which are available at runtime after all scripts are loaded
function updateSmartTrackLabel(track) {
  if (!track) return;
  
  let newLabel;
  
  // Use sampleId (VCF sample name from sample mapping) if available.
  // When a sample has multiple BAMs (one track each), append the file basename
  // so long-read vs short-read tracks are distinguishable.
  if (track.sampleId) {
    const bam = (track.bamUrls && track.bamUrls.length === 1)
      ? track.bamUrls[0]
      : (track.requestedBamUrl || null);
    const siblings = bamUrlsForSample(track.sampleId);
    const multi = siblings.length > 1
      || (state.smartTracks || []).filter((t) => t.sampleId === track.sampleId).length > 1;
    if (multi && bam && typeof getBasename === "function") {
      const readSet = (typeof getReadSetForUrl === "function") ? getReadSetForUrl(bam) : null;
      let base = track.sampleId + " · " + (readSet || getBasename(bam));
      const suffix = (typeof compositeLabelSuffix === "function") ? compositeLabelSuffix() : "";
      newLabel = suffix ? (base + suffix) : base;
    } else {
      const suffix = (typeof compositeLabelSuffix === "function") ? compositeLabelSuffix() : "";
      newLabel = track.sampleId + (suffix || "");
    }
  } else if (track.bamUrls && track.bamUrls.length > 0) {
    // Fallback to BAM basenames if sampleId not available
    // Use functions from main.js (available at runtime)
    const isInlineMode = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.hostMode === 'inline');
    
    if (isInlineMode) {
      // In inline mode: show only basename(s)
      if (track.bamUrls.length === 1) {
        newLabel = getBasename(track.bamUrls[0]);
      } else {
        newLabel = track.bamUrls.map(url => getBasename(url)).join(", ");
      }
    } else {
      // In overlay mode: show full path(s) with truncation if needed
      const bamPath = track.bamUrls.length === 1 
        ? track.bamUrls[0] 
        : track.bamUrls.join(", ");
      newLabel = truncatePath(bamPath, 80);
    }
  } else {
    // Fallback to default label if no sample info available
    const index = state.smartTracks.findIndex(t => t.id === track.id);
    newLabel = `Smart Track ${index + 1}`;
  }
  
  // Only update if label actually changed
  if (track.label !== newLabel) {
    editSmartTrackLabel(track.id, newLabel);
  }
}

// Update any track's display label (layout + parallel data/smart/annotation stores).
function editTrackLabel(trackId, newLabel) {
  newLabel = (newLabel == null ? "" : String(newLabel)).trim();
  if (!newLabel) return;

  const trackInArray = state.tracks.find(t => t.id === trackId);
  if (trackInArray) trackInArray.label = newLabel;

  const smart = (state.smartTracks || []).find(t => t.id === trackId);
  if (smart) smart.label = newLabel;

  const data = (state.dataTracks || []).find(t => t.id === trackId);
  if (data) data.label = newLabel;

  const ann = (state.annotationTracks || []).find(t => t.id === trackId);
  if (ann) ann.label = newLabel;

  if (typeof renderAll === "function") renderAll();
  if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
}

// Update Smart track label
function editSmartTrackLabel(trackId, newLabel) {
  editTrackLabel(trackId, newLabel);
}

function trackKindLabel(track) {
  const id = (track && track.id) || "";
  if (id.indexOf("smart-track-") === 0) return "Reads";
  if (id.indexOf("ucsc-") === 0) return "UCSC";
  if (id.indexOf("data-") === 0) return "Data";
  if (id === "flow" || id.indexOf("flow-") === 0) return "Variants";
  if (id === "genes") return "Genes";
  if (id === "repeats") return "Repeats";
  if (id === "reference") return "Reference";
  return "Track";
}

function toggleTrackConfig(trackId) {
  if (!trackId) {
    state.expandedTrackConfigId = null;
  } else if (state.expandedTrackConfigId === trackId) {
    state.expandedTrackConfigId = null;
  } else {
    const exists = (state.tracks || []).some(t => t.id === trackId);
    state.expandedTrackConfigId = exists ? trackId : null;
  }
  if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
}

function fillTrackConfigPanel(host, track) {
  const isSmart = typeof track.id === "string" && track.id.indexOf("smart-track-") === 0;
  const smartMeta = isSmart
    ? (state.smartTracks || []).find(st => st.id === track.id)
    : null;
  const target = (smartMeta && smartMeta.readsData) ? smartMeta
    : (track && track.readsData ? track : (smartMeta || track));

  if (!isSmart) {
    const kind = document.createElement("div");
    kind.className = "track-inspector-type track-config-type";
    kind.textContent = trackKindLabel(track);
    host.appendChild(kind);

    const visRow = document.createElement("div");
    visRow.className = "track-inspector-row";
    const visLabel = document.createElement("label");
    const visCb = document.createElement("input");
    visCb.type = "checkbox";
    visCb.className = "track-config-visible";
    visCb.checked = !(track.hidden === true);
    visCb.addEventListener("change", () => {
      track.hidden = !visCb.checked;
      if (typeof updateTracksHeight === "function") updateTracksHeight();
      if (typeof renderAll === "function") renderAll();
      if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
    });
    visLabel.appendChild(visCb);
    visLabel.appendChild(document.createTextNode("Show in view"));
    visRow.appendChild(visLabel);
    host.appendChild(visRow);

    const colRow = document.createElement("div");
    colRow.className = "track-inspector-row";
    const colLabel = document.createElement("label");
    const colCb = document.createElement("input");
    colCb.type = "checkbox";
    colCb.className = "track-config-collapsed";
    colCb.checked = !!track.collapsed;
    colCb.addEventListener("change", () => {
      track.collapsed = colCb.checked;
      if (typeof updateTracksHeight === "function") updateTracksHeight();
      if (typeof renderAll === "function") renderAll();
      if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
    });
    colLabel.appendChild(colCb);
    colLabel.appendChild(document.createTextNode("Collapse track"));
    colRow.appendChild(colLabel);
    host.appendChild(colRow);
    return;
  }

  if (!target.readDisplay) target.readDisplay = cloneReadDisplayConfig(state.readDisplayDefaults);
  const display = target.readDisplay;
  const readsOff = !display.visibility.reads;
  const summaryOff = !display.visibility.summary;

  const commit = (needsLayout) => {
    if (track !== target) track.readDisplay = display;
    if (smartMeta && smartMeta !== target) smartMeta.readDisplay = display;
    syncTrackCollapsedFromVisibility(target);
    if (track !== target) {
      track.collapsed = target.collapsed;
      track.hidden = target.hidden;
      track._hiddenByEmptyVisibility = target._hiddenByEmptyVisibility;
    }
    if (smartMeta && smartMeta !== target) {
      smartMeta.collapsed = target.collapsed;
      smartMeta.hidden = target.hidden;
      smartMeta._hiddenByEmptyVisibility = target._hiddenByEmptyVisibility;
    }
    // Keep the layout entry in state.tracks in sync (may be the same object).
    const layoutTrack = (state.tracks || []).find((t) => t.id === target.id);
    if (layoutTrack && layoutTrack !== target) {
      layoutTrack.collapsed = target.collapsed;
      layoutTrack.hidden = target.hidden;
      layoutTrack._hiddenByEmptyVisibility = target._hiddenByEmptyVisibility;
      layoutTrack.readDisplay = display;
    }
    saveReadDisplayForTrack(target);
    if (needsLayout) layoutSmartTrackReads(target);
    if (typeof applyReadDisplayToGroupMembers === "function") {
      applyReadDisplayToGroupMembers(target, needsLayout);
    }
    if (typeof updateTracksHeight === "function") updateTracksHeight();
    if (typeof renderAll === "function") renderAll();
    if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
  };

  const escapeHtml = (s) => String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const section = (title) => {
    const el = document.createElement("div");
    el.className = "rd-config-section";
    const label = document.createElement("div");
    label.className = "rd-config-section-label";
    label.textContent = title;
    el.appendChild(label);
    host.appendChild(el);
    return el;
  };

  const fieldRow = (labelText, control, sub) => {
    const row = document.createElement("div");
    row.className = "rd-config-row";
    const lab = document.createElement("div");
    lab.className = "rd-config-label";
    lab.textContent = labelText;
    const right = document.createElement("div");
    right.className = "rd-config-control";
    right.appendChild(control);
    if (sub) right.appendChild(sub);
    row.append(lab, right);
    return row;
  };

  const toggleGroup = (items, getActive, onToggle) => {
    const group = document.createElement("div");
    group.className = "rd-toggle-group";
    group.setAttribute("role", "group");
    for (const [key, label] of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rd-toggle" + (getActive(key) ? " is-on" : "");
      btn.textContent = label;
      btn.dataset.key = key;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onToggle(key, !getActive(key));
      });
      group.appendChild(btn);
    }
    return group;
  };

  const openDropdown = (trigger, options, current, onPick) => {
    if (openReadDisplayPopover) openReadDisplayPopover.remove();
    const menu = document.createElement("div");
    menu.className = "rd-popover";
    menu.setAttribute("role", "radiogroup");
    const buttons = options.map(([value, label], index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "radio");
      const selected = current === value || (current == null && value == null);
      button.setAttribute("aria-checked", String(selected));
      button.tabIndex = index === 0 ? 0 : -1;
      button.textContent = `${selected ? "✓ " : ""}${label}`;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        menu.remove();
        openReadDisplayPopover = null;
        onPick(value);
      });
      menu.appendChild(button);
      return button;
    });
    menu.addEventListener("keydown", (event) => {
      const currentIdx = Math.max(0, buttons.indexOf(document.activeElement));
      let next = currentIdx;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (currentIdx + 1) % buttons.length;
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (currentIdx - 1 + buttons.length) % buttons.length;
      else if (event.key === "Escape") {
        menu.remove(); trigger.focus(); openReadDisplayPopover = null; return;
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        buttons[currentIdx].click();
        return;
      } else return;
      event.preventDefault();
      buttons.forEach((button, i) => { button.tabIndex = i === next ? 0 : -1; });
      buttons[next].focus();
    });
    trigger.appendChild(menu);
    openReadDisplayPopover = menu;
    requestAnimationFrame(() => {
      const selected = buttons.find((b) => b.getAttribute("aria-checked") === "true");
      (selected || buttons[0]).focus();
    });
    setTimeout(() => {
      const closeOnOutside = (event) => {
        if (menu.isConnected && (menu.contains(event.target) || trigger.contains(event.target))) return;
        menu.remove();
        if (openReadDisplayPopover === menu) openReadDisplayPopover = null;
        document.removeEventListener("mousedown", closeOnOutside, true);
      };
      document.addEventListener("mousedown", closeOnOutside, true);
    }, 0);
  };

  const dropdown = (options, current, onPick, extras) => {
    const wrap = document.createElement("div");
    wrap.className = "rd-dropdown-wrap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rd-dropdown";
    const hit = (options || []).find(([v]) => v === current || (v == null && current == null));
    const valueSpan = document.createElement("span");
    valueSpan.className = "rd-dropdown-value";
    valueSpan.textContent = hit ? hit[1] : String(current == null ? "None" : current);
    btn.appendChild(valueSpan);
    if (extras) btn.appendChild(extras);
    const chev = document.createElement("span");
    chev.className = "rd-dropdown-chev";
    chev.textContent = "▾";
    btn.appendChild(chev);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      openDropdown(wrap, options, current, onPick);
    });
    wrap.appendChild(btn);
    return { wrap, btn };
  };

  const withReverse = (fieldKey, dd, canReverse) => {
    if (!display.reverse) display.reverse = { groupBy: false, sortBy: false, colorBy: false, shadeBy: false };
    const row = document.createElement("div");
    row.className = "rd-dropdown-with-reverse";
    row.appendChild(dd.wrap);
    const rev = document.createElement("button");
    rev.type = "button";
    rev.className = "rd-reverse-btn" + (display.reverse[fieldKey] ? " is-on" : "");
    rev.title = "Reverse order";
    rev.setAttribute("aria-label", "Reverse order");
    rev.setAttribute("aria-pressed", display.reverse[fieldKey] ? "true" : "false");
    rev.textContent = "⇅";
    const active = !!canReverse && !readsOff;
    rev.disabled = !active;
    if (!active) rev.classList.add("is-disabled");
    rev.addEventListener("click", (e) => {
      e.stopPropagation();
      if (rev.disabled) return;
      display.reverse[fieldKey] = !display.reverse[fieldKey];
      const needsLayout = fieldKey === "groupBy" || fieldKey === "sortBy";
      commit(needsLayout);
    });
    row.appendChild(rev);
    return row;
  };

  const withSourceChain = (_fieldKey, control, linked, onToggle) => {
    const row = document.createElement("div");
    row.className = "rd-with-source-chain";
    const chain = document.createElement("button");
    chain.type = "button";
    chain.className = "tg-chain" + (linked ? " is-linked" : " is-broken");
    chain.title = linked ? "Inherited from group — click to override" : "Overridden — click to inherit group value";
    chain.setAttribute("aria-label", chain.title);
    chain.setAttribute("aria-pressed", linked ? "true" : "false");
    chain.textContent = "⛓";
    chain.addEventListener("click", (e) => {
      e.stopPropagation();
      onToggle();
    });
    row.append(chain, control);
    return row;
  };

  // Group membership sits above Summary — identity only (no duplicated track name).
  const trackGroup = (isSmart && target.groupId && typeof getTrackGroup === "function")
    ? getTrackGroup(target.groupId) : null;
  if (trackGroup) {
    const banner = document.createElement("div");
    banner.className = "tg-drawer-banner";
    const left = document.createElement("div");
    left.className = "tg-drawer-banner-id";
    const sw = document.createElement("i");
    sw.className = "tg-drawer-banner-swatch";
    sw.style.background = trackGroup.color;

    const nameEl = document.createElement("strong");
    nameEl.className = "tg-drawer-banner-name";
    nameEl.textContent = trackGroup.name;
    nameEl.title = "Click to rename";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "tg-drawer-banner-name-input";
    nameInput.value = trackGroup.name;
    nameInput.style.display = "none";

    const finishRename = () => {
      const next = nameInput.value.trim() || trackGroup.name;
      const changed = next !== trackGroup.name;
      if (changed && typeof renameTrackGroup === "function") {
        renameTrackGroup(trackGroup.id, next);
      }
      nameEl.textContent = trackGroup.name;
      nameEl.style.display = "";
      nameInput.style.display = "none";
      nameInput.value = trackGroup.name;
      if (changed) {
        if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
        if (typeof renderAll === "function") renderAll();
      }
    };

    nameEl.addEventListener("click", (e) => {
      e.stopPropagation();
      nameEl.style.display = "none";
      nameInput.style.display = "block";
      nameInput.value = trackGroup.name;
      nameInput.focus();
      nameInput.select();
    });
    nameInput.addEventListener("click", (e) => e.stopPropagation());
    nameInput.addEventListener("blur", finishRename);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        nameInput.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        nameInput.value = trackGroup.name;
        nameInput.blur();
      }
    });

    left.append(sw, nameEl, nameInput);

    const applyLabel = document.createElement("label");
    applyLabel.className = "tg-apply-to-group";
    applyLabel.title = "When on, drawer changes update every track in this group";
    const applyCb = document.createElement("input");
    applyCb.type = "checkbox";
    applyCb.checked = trackGroup.applyToGroup !== false;
    applyCb.addEventListener("click", (e) => e.stopPropagation());
    applyCb.addEventListener("change", (e) => {
      e.stopPropagation();
      if (typeof setTrackGroupApplyToGroup === "function") {
        setTrackGroupApplyToGroup(trackGroup.id, applyCb.checked);
      } else {
        trackGroup.applyToGroup = applyCb.checked;
      }
      // Turning on: push this track's current settings to the rest of the group.
      if (applyCb.checked && typeof applyReadDisplayToGroupMembers === "function") {
        applyReadDisplayToGroupMembers(target, true);
        if (typeof updateTracksHeight === "function") updateTracksHeight();
        if (typeof renderAll === "function") renderAll();
        if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
      }
    });
    applyLabel.append(applyCb, document.createTextNode("Apply to group"));
    banner.append(left, applyLabel);
    host.appendChild(banner);
  }

  // --- SUMMARY ---
  const summarySec = section("Summary");
  if (summaryOff) summarySec.classList.add("is-dimmed");

  const summaryDd = dropdown(READ_DISPLAY_FIELDS.summaryField, display.summaryField, (v) => {
    display.summaryField = v;
    commit(false);
  });
  if (summaryOff) summaryDd.btn.disabled = true;
  if (!summaryOff) {
    const preview = (typeof makeSummaryPreview === "function")
      ? makeSummaryPreview(target, display.summaryField)
      : (window.__GS_makeSummaryPreview
        ? window.__GS_makeSummaryPreview(target, display.summaryField)
        : null);
    summarySec.appendChild(fieldRow("Track", summaryDd.wrap, preview));
  } else {
    summarySec.appendChild(fieldRow("Track", summaryDd.wrap));
  }

  // Coverage Scale — only when summary track type is Coverage.
  if (!summaryOff && display.summaryField === "coverage") {
    const resolvedScale = (typeof resolveCoverageScale === "function")
      ? resolveCoverageScale(target)
      : (display.coverageScale || { mode: "track", fixedMin: 0, fixedMax: 30 });
    const linked = !!(trackGroup && display.coverageScaleSource === "group");
    const isLead = !!(trackGroup && trackGroup.memberTrackIds[0] === target.id);
    const locked = linked && !isLead;
    const scaleForUi = linked
      ? { mode: "fixed", fixedMin: resolvedScale.fixedMin, fixedMax: resolvedScale.fixedMax }
      : (display.coverageScale || resolvedScale);

    const scaleControl = document.createElement("div");
    scaleControl.className = "rd-scale-control";

    // Group-linked: Fixed-only. Ungrouped / broken: Track|View|Fixed.
    if (!linked) {
      const modeGroup = toggleGroup(
        [["track", "Track"], ["view", "View"], ["fixed", "Fixed"]],
        (k) => scaleForUi.mode === k,
        (k) => {
          if (!display.coverageScale) display.coverageScale = { mode: "track", fixedMin: 0, fixedMax: 30 };
          display.coverageScale.mode = k;
          commit(false);
        }
      );
      scaleControl.appendChild(modeGroup);
    }

    if (linked || scaleForUi.mode === "fixed") {
      const rangeWrap = document.createElement("div");
      rangeWrap.className = "rd-mapq-range rd-scale-range";
      const mkScaleNum = (val, which) => {
        const input = document.createElement("input");
        input.type = "number";
        input.className = "rd-mapq-input";
        input.min = "0";
        input.value = String(val);
        if (locked) input.disabled = true;
        input.addEventListener("change", () => {
          if (locked) return;
          if (!display.coverageScale) display.coverageScale = { mode: "fixed", fixedMin: 0, fixedMax: 30 };
          let n = Math.max(0, Number(input.value) || 0);
          display.coverageScale[which] = n;
          // Group shared value is Fixed (§6).
          if (linked) display.coverageScale.mode = "fixed";
          else display.coverageScale.mode = "fixed";
          if (display.coverageScale.fixedMin > display.coverageScale.fixedMax) {
            if (which === "fixedMin") display.coverageScale.fixedMax = n;
            else display.coverageScale.fixedMin = n;
          }
          commit(false);
        });
        return input;
      };
      rangeWrap.append(
        mkScaleNum(scaleForUi.fixedMin, "fixedMin"),
        document.createTextNode("–"),
        mkScaleNum(scaleForUi.fixedMax, "fixedMax")
      );
      scaleControl.appendChild(rangeWrap);
      const grad = document.createElement("div");
      grad.className = "rd-summary-preview is-coverage";
      grad.style.background =
        "linear-gradient(90deg, rgba(40,75,120,0.45) 0%, rgba(95,145,195,0.7) 45%, rgb(150,200,245) 100%)";
      scaleControl.appendChild(grad);
    }

    let scaleRowInner = scaleControl;
    if (trackGroup) {
      scaleRowInner = withSourceChain("coverageScale", scaleControl, linked, () => {
        if (typeof setCoverageScaleSource === "function") {
          setCoverageScaleSource(target, linked ? "track" : "group");
        } else {
          display.coverageScaleSource = linked ? "track" : "group";
        }
        commit(false);
      });
      if (locked) scaleControl.classList.add("is-dimmed");
    }
    summarySec.appendChild(fieldRow("Scale", scaleRowInner));
  }

  // --- LAYOUT ---
  const layoutSec = section("Layout");
  const visGroup = toggleGroup(
    [["summary", "Summary"], ["reads", "Reads"]],
    (k) => !!display.visibility[k],
    (k, on) => {
      display.visibility[k] = on;
      commit(true);
    }
  );
  layoutSec.appendChild(fieldRow("Visibility", visGroup));

  const alnGroup = toggleGroup(
    [["paired", "Paired"], ["supplementary", "Suppl."], ["secondary", "Secondary"]],
    (k) => !!display.alignments[k],
    (k, on) => {
      display.alignments[k] = on;
      commit(true);
    }
  );
  const alnRow = fieldRow("Alignments", alnGroup);
  if (readsOff) { alnRow.classList.add("is-dimmed"); alnGroup.querySelectorAll("button").forEach((b) => { b.disabled = true; }); }
  layoutSec.appendChild(alnRow);

  const mapqWrap = document.createElement("div");
  mapqWrap.className = "rd-mapq-range";
  const mkNum = (val, which) => {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "rd-mapq-input";
    input.min = "0";
    input.max = "255";
    input.value = String(val);
    input.addEventListener("change", () => {
      let n = Math.max(0, Math.min(255, Number(input.value) || 0));
      display.mapqRange[which] = n;
      if (display.mapqRange.min > display.mapqRange.max) {
        if (which === "min") display.mapqRange.max = n;
        else display.mapqRange.min = n;
      }
      commit(true);
    });
    return input;
  };
  mapqWrap.append(mkNum(display.mapqRange.min, "min"), document.createTextNode("–"), mkNum(display.mapqRange.max, "max"));
  const mapqRow = fieldRow("MAPQ", mapqWrap);
  if (readsOff) {
    mapqRow.classList.add("is-dimmed");
    mapqWrap.querySelectorAll("input").forEach((i) => { i.disabled = true; });
  }
  layoutSec.appendChild(mapqRow);

  const groupDd = dropdown(READ_DISPLAY_FIELDS.groupBy, display.groupBy, (v) => {
    display.groupBy = v;
    if (v == null && display.reverse) display.reverse.groupBy = false;
    commit(true);
  });
  const groupRow = fieldRow("Group by", withReverse("groupBy", groupDd, display.groupBy != null));
  if (readsOff) { groupRow.classList.add("is-dimmed"); groupDd.btn.disabled = true; }
  layoutSec.appendChild(groupRow);

  const sortDd = dropdown(READ_DISPLAY_FIELDS.sortBy, display.sortBy, (v) => {
    display.sortBy = v;
    if (v == null && display.reverse) display.reverse.sortBy = false;
    commit(true);
  });
  let sortSub = null;
  if (display.sortBy === "distanceToAnchor") {
    sortSub = document.createElement("div");
    sortSub.className = "rd-anchor-line";
    const pos = display.sortAnchor.position;
    const text = document.createElement("span");
    text.className = "rd-anchor-pos";
    text.textContent = pos
      ? `${pos.contig}:${Number(pos.pos).toLocaleString()}`
      : "view center";
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "rd-anchor-pin" + (display.sortAnchor.mode === "pinned" ? " is-pinned" : "");
    pin.textContent = "⌖";
    pin.title = display.sortAnchor.mode === "pinned" ? "Resume automatic anchor" : "Pin sort anchor";
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleReadDisplayAnchorPin(target.id);
    });
    sortSub.append(document.createTextNode("◆ "), text, pin);
  }
  const sortControl = withReverse("sortBy", sortDd, display.sortBy != null);
  const sortRow = fieldRow("Sort by", sortControl, sortSub);
  if (readsOff) { sortRow.classList.add("is-dimmed"); sortDd.btn.disabled = true; }
  layoutSec.appendChild(sortRow);

  // --- ENCODING ---
  const encSec = section("Encoding");
  if (readsOff) encSec.classList.add("is-dimmed");

  const colorExtras = display.colorBy ? makeReadDisplayMiniBar(target, "colorBy") : null;
  const colorDd = dropdown(READ_DISPLAY_FIELDS.colorBy, display.colorBy, (v) => {
    display.colorBy = v;
    if (v == null && display.reverse) display.reverse.colorBy = false;
    commit(false);
  }, colorExtras);
  const legend = display.colorBy ? makeColorLegendStrip(target) : null;
  const colorRow = fieldRow("Color by", withReverse("colorBy", colorDd, display.colorBy != null), legend);
  if (readsOff) { colorRow.classList.add("is-dimmed"); colorDd.btn.disabled = true; }
  encSec.appendChild(colorRow);

  const shadeExtras = display.shadeBy ? makeReadDisplayMiniBar(target, "shadeBy") : null;
  const shadeDd = dropdown(READ_DISPLAY_FIELDS.shadeBy, display.shadeBy, (v) => {
    display.shadeBy = v;
    if (v == null && display.reverse) display.reverse.shadeBy = false;
    commit(false);
  }, shadeExtras);
  const shadeRow = fieldRow("Shade by", withReverse("shadeBy", shadeDd, display.shadeBy != null));
  if (readsOff) { shadeRow.classList.add("is-dimmed"); shadeDd.btn.disabled = true; }
  encSec.appendChild(shadeRow);
}

// Right sidebar for Tracks (layout order, visibility, labels)
// -----------------------------

// Reorder loaded Smart Tracks into blocks by the active grouping column.
// Within each group, preserve the previous relative order (load / drag order).
function clusterSmartTracksByGrouping() {
  const col = (typeof getColorFacetKey === "function") ? getColorFacetKey() : null;
  if (!col || typeof getSampleGroupValue !== "function") {
    if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
    return;
  }
  const smartIds = new Set(
    (state.smartTracks || []).map(t => t.id).filter(id => String(id).startsWith("smart-track-"))
  );
  if (!smartIds.size) {
    if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
    return;
  }

  const spec = typeof getGroupingColumnSpec === "function" ? getGroupingColumnSpec(col) : null;
  const groupOrder = (spec && Array.isArray(spec.values))
    ? spec.values.map(v => String(v.value))
    : [];

  const nonSmart = [];
  const byGroup = new Map(); // group -> [track] in prior relative order
  for (const track of state.tracks) {
    if (!smartIds.has(track.id)) {
      nonSmart.push(track);
      continue;
    }
    const sampleId = (typeof smartTrackSampleId === "function")
      ? smartTrackSampleId(track)
      : ((state.smartTracks || []).find(st => st.id === track.id) || {}).sampleId || track.label;
    const g = String(getSampleGroupValue(sampleId, col) || "(unlabeled)");
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(track);
  }

  const orderedGroups = [];
  // Prefer current layout order so sidebar group-rail drags stick across reloads.
  for (const track of state.tracks) {
    if (!smartIds.has(track.id)) continue;
    const sampleId = (typeof smartTrackSampleId === "function")
      ? smartTrackSampleId(track)
      : ((state.smartTracks || []).find(st => st.id === track.id) || {}).sampleId || track.label;
    const g = String(getSampleGroupValue(sampleId, col) || "(unlabeled)");
    if (byGroup.has(g) && orderedGroups.indexOf(g) < 0) orderedGroups.push(g);
  }
  for (const g of groupOrder) {
    if (byGroup.has(g) && orderedGroups.indexOf(g) < 0) orderedGroups.push(g);
  }
  for (const g of byGroup.keys()) {
    if (orderedGroups.indexOf(g) < 0) orderedGroups.push(g);
  }

  // Keep non-smart tracks in their relative order; splice smart tracks after flow
  // as a contiguous grouped block (matching createSmartTrack insertion).
  const flowIdx = nonSmart.findIndex(t => t.id === "flow" || String(t.id).startsWith("flow-"));
  const clusteredSmart = [];
  for (const g of orderedGroups) {
    clusteredSmart.push(...byGroup.get(g));
  }
  let next;
  if (flowIdx >= 0) {
    next = [
      ...nonSmart.slice(0, flowIdx + 1),
      ...clusteredSmart,
      ...nonSmart.slice(flowIdx + 1),
    ];
  } else {
    next = [...nonSmart, ...clusteredSmart];
  }
  state.tracks = next;

  // Align smartTracks array with layout order among smart ids
  if (Array.isArray(state.smartTracks) && state.smartTracks.length) {
    const smartMap = new Map(state.smartTracks.map(t => [t.id, t]));
    const orderedSmart = clusteredSmart.map(t => smartMap.get(t.id)).filter(Boolean);
    const seen = new Set(orderedSmart.map(t => t.id));
    for (const t of state.smartTracks) {
      if (!seen.has(t.id)) orderedSmart.push(t);
    }
    state.smartTracks = orderedSmart;
  }

  if (typeof updateTracksHeight === "function") updateTracksHeight();
  if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
  if (typeof renderAll === "function") renderAll();
}

if (typeof window !== "undefined") {
  window.clusterSmartTracksByGrouping = clusterSmartTracksByGrouping;
}

let openTgPopoverEl = null;

function closeTrackGroupPopover() {
  if (openTgPopoverEl) {
    openTgPopoverEl.remove();
    openTgPopoverEl = null;
  }
}

function openTrackGroupPopover(anchor, groupId) {
  closeTrackGroupPopover();
  const group = typeof getTrackGroup === "function" ? getTrackGroup(groupId) : null;
  if (!group || !anchor) return;

  const pop = document.createElement("div");
  pop.className = "tg-popover";
  pop.setAttribute("role", "dialog");

  const head = document.createElement("div");
  head.className = "tg-popover-head";
  const swatchBtn = document.createElement("button");
  swatchBtn.type = "button";
  swatchBtn.className = "tg-popover-swatch";
  swatchBtn.style.background = group.color;
  swatchBtn.title = "Change color";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "tg-popover-name";
  nameInput.value = group.name;
  nameInput.addEventListener("change", () => {
    if (typeof renameTrackGroup === "function") renameTrackGroup(group.id, nameInput.value);
    renderSmartTracksSidebar();
  });
  swatchBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    let picker = pop.querySelector(".tg-color-picker");
    if (picker) { picker.remove(); return; }
    picker = document.createElement("div");
    picker.className = "tg-color-picker";
    const palette = (window.__GS_TRACK_GROUP_PALETTE) || [
      "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9d97",
    ];
    palette.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tg-color-swatch";
      b.style.background = c;
      if (c.toLowerCase() === String(group.color).toLowerCase()) b.classList.add("is-active");
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (typeof recolorTrackGroup === "function") recolorTrackGroup(group.id, c);
        closeTrackGroupPopover();
        renderSmartTracksSidebar();
        if (typeof renderAll === "function") renderAll();
      });
      picker.appendChild(b);
    });
    pop.appendChild(picker);
  });
  head.append(swatchBtn, nameInput);

  const members = document.createElement("div");
  members.className = "tg-popover-members";
  (group.memberTrackIds || []).forEach((id) => {
    const t = (state.smartTracks || []).find((x) => x && x.id === id);
    const row = document.createElement("div");
    row.className = "tg-popover-member";
    const dot = document.createElement("i");
    dot.style.background = group.color;
    row.append(dot, document.createTextNode(t ? (t.label || id) : id));
    members.appendChild(row);
  });

  const foot = document.createElement("div");
  foot.className = "tg-popover-foot";
  const ungroupBtn = document.createElement("button");
  ungroupBtn.type = "button";
  ungroupBtn.className = "tg-popover-ungroup";
  ungroupBtn.textContent = "Ungroup";
  ungroupBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (typeof dissolveTrackGroup === "function") dissolveTrackGroup(group.id);
    closeTrackGroupPopover();
    renderSmartTracksSidebar();
    if (typeof renderAll === "function") renderAll();
  });
  const sharedBtn = document.createElement("button");
  sharedBtn.type = "button";
  sharedBtn.className = "tg-popover-shared";
  sharedBtn.textContent = "Shared settings";
  sharedBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const leadId = group.memberTrackIds[0];
    closeTrackGroupPopover();
    if (leadId && typeof toggleTrackConfig === "function") toggleTrackConfig(leadId);
  });
  foot.append(ungroupBtn, sharedBtn);

  pop.append(head, members, foot);
  document.body.appendChild(pop);
  openTgPopoverEl = pop;

  const rect = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8)}px`;
  pop.style.top = `${rect.bottom + 6}px`;

  setTimeout(() => {
    const onDoc = (ev) => {
      if (pop.contains(ev.target) || anchor.contains(ev.target)) return;
      closeTrackGroupPopover();
      document.removeEventListener("mousedown", onDoc, true);
    };
    document.addEventListener("mousedown", onDoc, true);
  }, 0);
}

function clearTrackGroupSelection() {
  state.trackGroupSelectMode = false;
  state.trackGroupSelectedIds = [];
}

function enterTrackGroupSelectMode(seedId) {
  state.trackGroupSelectMode = true;
  state.trackGroupSelectedIds = seedId ? [seedId] : (state.trackGroupSelectedIds || []);
}

function toggleTrackGroupSelected(trackId) {
  const set = new Set(state.trackGroupSelectedIds || []);
  if (set.has(trackId)) set.delete(trackId);
  else set.add(trackId);
  state.trackGroupSelectedIds = Array.from(set);
  if (!state.trackGroupSelectedIds.length) state.trackGroupSelectMode = false;
}

if (typeof document !== "undefined" && !window.__GS_tgSelectEscBound) {
  window.__GS_tgSelectEscBound = true;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!state || !state.trackGroupSelectMode) return;
    clearTrackGroupSelection();
    if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
  });
}

// Render Tracks list in right sidebar (all layout tracks, not just smart samples)
function renderSmartTracksSidebar() {
  // Fullscreen moves #genomeshader-root into the overlay modal. Prefer the
  // live root so we rebuild the visible list, not a leftover node.
  const scope = (typeof getCurrentRoot === "function" ? getCurrentRoot() : null) || document;
  const smartTracksList = (typeof byId === "function" ? byId(scope, "smartTracksList") : null)
    || document.getElementById('smartTracksList');
  if (!smartTracksList) return;
  
  smartTracksList.innerHTML = '';

  // Select / Cancel / Confirm sits in the Tracks header so it doesn't add a
  // second row above the list (and so the list never jumps at the 2-track threshold).
  const hasSmart = (state.smartTracks || []).some((t) => t && String(t.id).startsWith("smart-track-"));
  const selectedIds = (state.trackGroupSelectedIds || []).filter((id) =>
    (state.smartTracks || []).some((t) => t && t.id === id));
  state.trackGroupSelectedIds = selectedIds;
  const selectMode = !!state.trackGroupSelectMode;
  const canConfirm = selectMode && selectedIds.length >= 2;

  const pane = smartTracksList.closest("#tab-smart-tracks") || smartTracksList.parentElement;
  const header = pane && pane.querySelector(".sidebarHeader");
  if (header) {
    header.querySelectorAll(".tg-select-mode-btn").forEach((el) => el.remove());
  }
  if (hasSmart && header) {
    const selectToggle = document.createElement("button");
    selectToggle.type = "button";
    let modeClass = "tg-select-mode-btn";
    if (canConfirm) modeClass += " is-confirm";
    else if (selectMode) modeClass += " is-on";
    selectToggle.className = modeClass;
    if (canConfirm) {
      selectToggle.textContent = `Confirm · ${selectedIds.length}`;
      selectToggle.title = `Group ${selectedIds.length} selected tracks`;
    } else if (selectMode) {
      selectToggle.textContent = "Cancel";
      selectToggle.title = "Cancel track selection (Esc)";
    } else {
      selectToggle.textContent = "Select";
      selectToggle.title = "Select tracks to group (or ⌘/Ctrl-click a row)";
    }
    selectToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (canConfirm) {
        if (typeof createTrackGroupFromSelection === "function") {
          createTrackGroupFromSelection(selectedIds);
        }
        clearTrackGroupSelection();
        renderSmartTracksSidebar();
        if (typeof renderAll === "function") renderAll();
        return;
      }
      if (selectMode) clearTrackGroupSelection();
      else enterTrackGroupSelectMode(null);
      renderSmartTracksSidebar();
    });
    header.appendChild(selectToggle);
  }
  const applyTrackOrderFromDom = () => {
    const items = Array.from(smartTracksList.querySelectorAll('.smart-track-item:not(.smart-track-item-undo)'));
    const newOrder = items.map(item => item.dataset.trackId).filter(Boolean);
    if (newOrder.length === 0) return;

    const currentOrder = state.tracks.map(t => t.id);
    if (JSON.stringify(currentOrder) === JSON.stringify(newOrder)) {
      return;
    }

    const byId = new Map(state.tracks.map(t => [t.id, t]));
    const reorderedTracks = newOrder.map(id => byId.get(id)).filter(Boolean);
    const seen = new Set(reorderedTracks.map(t => t.id));
    for (const t of state.tracks) {
      if (!seen.has(t.id)) reorderedTracks.push(t);
    }
    state.tracks = reorderedTracks;

    // Keep smartTracks array order aligned with layout order among smart ids
    if (Array.isArray(state.smartTracks) && state.smartTracks.length) {
      const smartOrder = newOrder.filter(id => id.startsWith('smart-track-'));
      const smartMap = new Map(state.smartTracks.map(t => [t.id, t]));
      const orderedSmart = smartOrder.map(id => smartMap.get(id)).filter(Boolean);
      const smartSeen = new Set(orderedSmart.map(t => t.id));
      for (const t of state.smartTracks) {
        if (!smartSeen.has(t.id)) orderedSmart.push(t);
      }
      state.smartTracks = orderedSmart;
    }

    updateTracksHeight();
    renderAll();
    setTimeout(() => {
      renderSmartTracksSidebar();
    }, 0);
  };
  
  const tracksInOrder = state.tracks.slice();
  
  if (tracksInOrder.length === 0) {
    if (pendingUndo && pendingUndo.snapshot) {
      smartTracksList.appendChild(buildSmartTrackUndoRow(pendingUndo));
      return;
    }
    const emptyMsg = document.createElement('div');
    emptyMsg.style.padding = '9px 10px';
    emptyMsg.style.fontSize = '11px';
    emptyMsg.style.color = 'var(--muted)';
    emptyMsg.textContent = 'No tracks';
    smartTracksList.appendChild(emptyMsg);
    return;
  }
  
  // Remove existing event listeners if any (to avoid duplicates)
  const existingDropHandler = smartTracksList._dropHandler;
  if (existingDropHandler) {
    smartTracksList.removeEventListener('drop', existingDropHandler);
    smartTracksList.removeEventListener('dragover', smartTracksList._dragoverHandler);
  }
  
  // Add drop handler to the container to catch all drops
  const handleContainerDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Remove dragging class from all items
    document.querySelectorAll('.smart-track-item.dragging').forEach(item => {
      item.classList.remove('dragging');
    });

    applyTrackOrderFromDom();
  };
  
  const handleContainerDragover = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const draggingGroup = smartTracksList.querySelector('.smart-track-group-block.dragging-group');
    if (!draggingGroup) return;
    const afterElement = getDragAfterTopLevel(smartTracksList, e.clientY, draggingGroup);
    if (afterElement == null) {
      smartTracksList.appendChild(draggingGroup);
    } else {
      smartTracksList.insertBefore(draggingGroup, afterElement);
    }
  };
  
  // Store handlers to allow removal later
  smartTracksList._dropHandler = handleContainerDrop;
  smartTracksList._dragoverHandler = handleContainerDragover;
  
  // Add drop handler to container
  smartTracksList.addEventListener('dragover', handleContainerDragover);
  smartTracksList.addEventListener('drop', handleContainerDrop);

  let currentGroupKey = null;
  let currentGroupItems = null;
  const groupingCol = (typeof getColorFacetKey === "function") ? getColorFacetKey() : null;

  const closeGroupBlock = () => {
    currentGroupKey = null;
    currentGroupItems = null;
  };

  const ensureGroupBlock = (groupName, groupColor) => {
    if (currentGroupKey === groupName && currentGroupItems) return currentGroupItems;
    const block = document.createElement("div");
    block.className = "smart-track-group-block";
    block.dataset.groupValue = groupName;
    const rail = document.createElement("div");
    rail.className = "smart-track-group-rail";
    rail.draggable = true;
    rail.title = (groupingCol ? `${groupingCol}: ${groupName}` : groupName) + " — drag to reorder group";
    if (groupColor) rail.style.color = groupColor;
    const railLabel = document.createElement("span");
    railLabel.className = "smart-track-group-rail-label";
    railLabel.textContent = groupName;
    rail.appendChild(railLabel);
    const items = document.createElement("div");
    items.className = "smart-track-group-items";
    block.appendChild(rail);
    block.appendChild(items);

    rail.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "group:" + groupName);
      // Avoid individual items being treated as the drag source.
      block.classList.add("dragging-group");
      document.querySelectorAll(".smart-track-item.dragging").forEach((el) => {
        el.classList.remove("dragging");
      });
    });
    rail.addEventListener("dragend", (e) => {
      e.stopPropagation();
      block.classList.remove("dragging-group");
      applyTrackOrderFromDom();
    });

    smartTracksList.appendChild(block);
    currentGroupKey = groupName;
    currentGroupItems = items;
    return items;
  };
  
  // Click-away disarms an armed remove control.
  if (!smartTracksList._armedRemoveAwayBound) {
    smartTracksList._armedRemoveAwayBound = true;
    smartTracksList.addEventListener('mousedown', (e) => {
      if (!armedRemoveTrackId) return;
      if (e.target.closest('.smart-track-item-remove-armed, .smart-track-item-btn.remove')) return;
      clearArmedRemove();
      renderSmartTracksSidebar();
    });
  }

  const appendUndoToastIfNeeded = (appendParent, beforeIndex) => {
    if (!pendingUndo || !pendingUndo.snapshot) return;
    if (pendingUndo.insertIndex !== beforeIndex) return;
    appendParent.appendChild(buildSmartTrackUndoRow(pendingUndo));
  };

  tracksInOrder.forEach((track, trackIndex) => {
    const isSmart = track.id.startsWith('smart-track-');
    const smartMeta = isSmart
      ? (state.smartTracks || []).find(st => st.id === track.id)
      : null;
    const cfgSource = smartMeta || track;
    if (isSmart && smartMeta && !smartMeta.readDisplay) {
      smartMeta.readDisplay = cloneReadDisplayConfig(state.readDisplayDefaults || DEFAULT_READ_DISPLAY);
    }
    if (!track.readDisplay && cfgSource.readDisplay) track.readDisplay = cfgSource.readDisplay;
    const readsVisible = !!(cfgSource.readDisplay && cfgSource.readDisplay.visibility
      && cfgSource.readDisplay.visibility.reads);
    const isArmed = isSmart && armedRemoveTrackId === track.id;

    let appendParent = smartTracksList;
    if (isSmart && groupingCol && typeof getSampleGroupValue === "function") {
      const sampleId = (typeof smartTrackSampleId === "function")
        ? smartTrackSampleId(track)
        : ((smartMeta && smartMeta.sampleId) || track.sampleId || track.label);
      const g = String(getSampleGroupValue(sampleId, groupingCol) || "(unlabeled)");
      const color = (typeof getGroupColor === "function") ? getGroupColor(groupingCol, g) : null;
      appendParent = ensureGroupBlock(g, color);
    } else {
      closeGroupBlock();
    }

    appendUndoToastIfNeeded(appendParent, trackIndex);

    const item = document.createElement('div');
    item.className = 'smart-track-item';
    item.dataset.trackId = track.id;
    item.tabIndex = 0;
    item.draggable = true;
    const configOpen = state.expandedTrackConfigId === track.id;
    if (configOpen) item.classList.add('config-open');
    if (track.hidden === true) item.classList.add('is-hidden');
    if (isArmed) {
      item.classList.add('is-remove-armed');
      item.dataset.remove = 'armed';
    }

    if (isSmart) {
      if (typeof isSmartTrackExcludedByFacets === "function" && isSmartTrackExcludedByFacets(track)) {
        item.classList.add("group-filtered-out");
        item.title = "Hidden by active Groups filters";
      }
    }

    const header = document.createElement('div');
    header.className = 'smart-track-item-header';

    // --- nav: grip (or checkbox in select mode) + chevron ---
    const nav = document.createElement('div');
    nav.className = 'smart-track-item-nav';

    const selectMode = !!state.trackGroupSelectMode && isSmart;
    if (selectMode) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "tg-select-checkbox";
      cb.checked = (state.trackGroupSelectedIds || []).includes(track.id);
      cb.title = "Select for grouping";
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", (e) => {
        e.stopPropagation();
        toggleTrackGroupSelected(track.id);
        renderSmartTracksSidebar();
      });
      nav.appendChild(cb);
    } else {
      const grip = document.createElement('span');
      grip.className = 'smart-track-item-grip';
      grip.title = 'Drag to reorder or onto a row to link (Alt+↑/↓)';
      grip.setAttribute('aria-hidden', 'true');
      grip.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" focusable="false">'
        + '<path fill="currentColor" d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>';
      nav.appendChild(grip);
    }

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'smart-track-item-collapse-btn';
    collapseBtn.type = 'button';
    // ▾ expanded (reads visible), ▸ collapsed — synced via applyVisibilityShortcut
    collapseBtn.textContent = readsVisible ? "▾" : "▸";
    collapseBtn.title = readsVisible ? "Collapse reads" : "Expand reads";
    collapseBtn.setAttribute('aria-label', collapseBtn.title);
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isSmart) {
        applyVisibilityShortcut(smartMeta || track, readsVisible);
        if (smartMeta && track !== smartMeta) {
          track.collapsed = smartMeta.collapsed;
          track.readDisplay = smartMeta.readDisplay;
          track.hidden = smartMeta.hidden;
        }
      } else {
        track.collapsed = !track.collapsed;
      }
      updateTracksHeight();
      renderAll();
      renderSmartTracksSidebar();
    });

    nav.appendChild(collapseBtn);

    // --- name ---
    const nameWrap = document.createElement('div');
    nameWrap.className = 'smart-track-item-name';

    const label = document.createElement('div');
    label.className = 'smart-track-item-label';
    if (track.hidden === true) label.classList.add('is-dimmed');
    label.textContent = track.label;
    label.style.cursor = 'text';
    label.title = 'Click to rename';

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'smart-track-item-label-input';
    labelInput.value = track.label;
    labelInput.style.display = 'none';
    labelInput.style.fontSize = '12px';
    labelInput.style.fontWeight = '500';
    labelInput.style.color = 'var(--text)';
    labelInput.style.background = 'var(--panel)';
    labelInput.style.border = '1px solid var(--border2)';
    labelInput.style.borderRadius = '4px';
    labelInput.style.padding = '2px 4px';
    labelInput.style.width = '100%';
    labelInput.style.boxSizing = 'border-box';

    label.addEventListener('click', (e) => {
      e.stopPropagation();
      label.style.display = 'none';
      labelInput.style.display = 'block';
      labelInput.focus();
      labelInput.select();
    });

    const saveLabel = () => {
      const newLabel = labelInput.value.trim() || track.label;
      label.textContent = newLabel;
      label.style.display = '';
      labelInput.style.display = 'none';
      editTrackLabel(track.id, newLabel);
    };

    labelInput.addEventListener('blur', saveLabel);
    labelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveLabel();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        labelInput.value = track.label;
        label.style.display = '';
        labelInput.style.display = 'none';
      }
    });

    nameWrap.appendChild(label);
    nameWrap.appendChild(labelInput);

    // User track-group accent: right-edge hug (left hug is reserved for
    // data-driven Groups facet coloring on the main track pills).
    const tgMeta = isSmart ? (smartMeta || track) : null;
    const tg = (tgMeta && tgMeta.groupId && typeof getTrackGroup === "function")
      ? getTrackGroup(tgMeta.groupId) : null;
    if (tg) {
      item.classList.add("tg-grouped");
      item.style.setProperty("--tg-color", tg.color);
      const railBtn = document.createElement("button");
      railBtn.type = "button";
      railBtn.className = "tg-rail-btn";
      railBtn.title = `Group settings (${tg.name})`;
      railBtn.setAttribute("aria-label", `Group settings: ${tg.name}`);
      railBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openTrackGroupPopover(railBtn, tg.id);
      });
      item.appendChild(railBtn);
    }

    // --- actions: reload / resample / remove (smart only; hover/focus reveal) ---
    const actions = document.createElement('div');
    actions.className = 'smart-track-item-actions';

    if (isSmart) {
      if (isArmed) {
        const armed = document.createElement('div');
        armed.className = 'smart-track-item-remove-armed';
        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'smart-track-item-remove-confirm';
        confirmBtn.textContent = 'Remove?';
        confirmBtn.title = 'Confirm remove';
        confirmBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          confirmRemoveSmartTrack(track.id);
        });
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'smart-track-item-remove-cancel';
        cancelBtn.setAttribute('aria-label', 'Cancel remove');
        cancelBtn.textContent = '×';
        cancelBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          clearArmedRemove();
          renderSmartTracksSidebar();
        });
        armed.appendChild(confirmBtn);
        armed.appendChild(cancelBtn);
        actions.appendChild(armed);
      } else {
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'smart-track-item-btn refresh';
        refreshBtn.type = 'button';
        refreshBtn.title = 'Reload';
        refreshBtn.setAttribute('aria-label', 'Reload');
        refreshBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          reloadSmartTrack(track.id);
        });

        const shuffleBtn = document.createElement('button');
        shuffleBtn.className = 'smart-track-item-btn shuffle';
        shuffleBtn.type = 'button';
        shuffleBtn.title = 'Resample';
        shuffleBtn.setAttribute('aria-label', 'Resample');
        shuffleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          shuffleSmartTrack(track.id);
        });

        const removeBtn = document.createElement('button');
        removeBtn.className = 'smart-track-item-btn remove';
        removeBtn.type = 'button';
        removeBtn.title = 'Remove';
        removeBtn.setAttribute('aria-label', 'Remove');
        removeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
          + '<polyline points="3 6 5 6 21 6"></polyline>'
          + '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>'
          + '<path d="M10 11v6"></path><path d="M14 11v6"></path>'
          + '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>'
          + '</svg>';
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          armRemoveSmartTrack(track.id);
        });

        actions.appendChild(refreshBtn);
        actions.appendChild(shuffleBtn);
        actions.appendChild(removeBtn);
      }
    }

    // --- status: visibility dot + gear ---
    const status = document.createElement('div');
    status.className = 'smart-track-item-status';

    const visDot = document.createElement('button');
    visDot.type = 'button';
    visDot.className = 'smart-track-item-vis-dot' + (track.hidden === true ? ' is-hidden' : ' is-visible');
    visDot.title = track.hidden === true ? 'Show track' : 'Hide track';
    visDot.setAttribute('aria-label', visDot.title);
    visDot.setAttribute('aria-pressed', track.hidden === true ? 'false' : 'true');
    visDot.addEventListener('click', (e) => {
      e.stopPropagation();
      track.hidden = !(track.hidden === true);
      if (track.hidden) track._hiddenByEmptyVisibility = false;
      if (smartMeta) {
        smartMeta.hidden = track.hidden;
        if (smartMeta.hidden) smartMeta._hiddenByEmptyVisibility = false;
      }
      updateTracksHeight();
      renderAll();
      renderSmartTracksSidebar();
    });

    status.appendChild(visDot);

    if (!isArmed) {
      const gearBtn = document.createElement('button');
      gearBtn.className = 'smart-track-item-gear' + (configOpen ? ' active' : '');
      gearBtn.type = 'button';
      gearBtn.title = configOpen ? 'Hide track options' : 'Track options';
      gearBtn.setAttribute('aria-label', 'Track options');
      gearBtn.setAttribute('aria-expanded', configOpen ? 'true' : 'false');
      gearBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<circle cx="12" cy="12" r="3"></circle>'
        + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 1 1-2.83-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>'
        + '</svg>';
      gearBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        item.draggable = false;
      });
      gearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleTrackConfig(track.id);
      });
      status.appendChild(gearBtn);
    }

    header.appendChild(nav);
    header.appendChild(nameWrap);
    if (isSmart) header.appendChild(actions);
    header.appendChild(status);

    item.appendChild(header);

    if (configOpen && !isArmed) {
      const config = document.createElement('div');
      config.className = 'smart-track-item-config';
      config.addEventListener('pointerdown', (e) => e.stopPropagation());
      fillTrackConfigPanel(config, track);
      item.appendChild(config);
    }

    item.addEventListener('mousedown', (e) => {
      item.draggable = !e.target.closest(
        '.smart-track-item-config, .smart-track-item-gear, .smart-track-item-actions, .smart-track-item-status, button, input'
      );
    });

    item.addEventListener('keydown', (e) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSmartTrackInList(track.id, -1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSmartTrackInList(track.id, 1);
      }
    });

    // Cmd/Ctrl-click enters multi-select for track groups.
    item.addEventListener("click", (e) => {
      if (!isSmart) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!state.trackGroupSelectMode) enterTrackGroupSelectMode(track.id);
      else toggleTrackGroupSelected(track.id);
      renderSmartTracksSidebar();
    });

    item.addEventListener('dragstart', (e) => {
      if (state.trackGroupSelectMode) {
        e.preventDefault();
        return;
      }
      if (smartTracksList.querySelector('.smart-track-group-block.dragging-group')) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', track.id);
      item.classList.add('dragging');
      item.dataset.gsDragged = '1';
      smartTracksList.dataset.tgDragMode = '';
    });

    item.addEventListener('dragend', (e) => {
      item.classList.remove('dragging');
      smartTracksList.querySelectorAll('.tg-link-target').forEach((el) => {
        el.classList.remove('tg-link-target');
        const tip = el.querySelector('.tg-link-hint');
        if (tip) tip.remove();
      });
      const mode = smartTracksList.dataset.tgDragMode;
      const linkTargetId = smartTracksList.dataset.tgLinkTarget;
      delete smartTracksList.dataset.tgDragMode;
      delete smartTracksList.dataset.tgLinkTarget;
      if (mode === 'link' && linkTargetId && track.id) {
        const result = (typeof linkTracksByDrag === "function")
          ? linkTracksByDrag(track.id, linkTargetId)
          : { ok: false };
        if (result && result.ok === false && result.reason === "already_in_group") {
          const targetEl = smartTracksList.querySelector(`[data-track-id="${linkTargetId}"]`);
          if (targetEl) {
            const tip = document.createElement("span");
            tip.className = "tg-already-hint";
            tip.textContent = "already in a group";
            targetEl.appendChild(tip);
            setTimeout(() => tip.remove(), 1600);
          }
        }
        renderSmartTracksSidebar();
        if (typeof renderAll === "function") renderAll();
        return;
      }
      applyTrackOrderFromDom();
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (smartTracksList.querySelector('.smart-track-group-block.dragging-group')) return;
      const dragging = document.querySelector('.smart-track-item.dragging');
      if (!dragging || dragging === item) return;

      const rect = item.getBoundingClientRect();
      const yRel = (e.clientY - rect.top) / Math.max(1, rect.height);
      const ontoBody = yRel > 0.2 && yRel < 0.8
        && String(item.dataset.trackId || "").startsWith("smart-track-")
        && String(dragging.dataset.trackId || "").startsWith("smart-track-");

      smartTracksList.querySelectorAll('.tg-link-target').forEach((el) => {
        if (el !== item) {
          el.classList.remove('tg-link-target');
          const tip = el.querySelector('.tg-link-hint');
          if (tip) tip.remove();
        }
      });

      if (ontoBody) {
        smartTracksList.dataset.tgDragMode = 'link';
        smartTracksList.dataset.tgLinkTarget = item.dataset.trackId;
        item.classList.add('tg-link-target');
        if (!item.querySelector('.tg-link-hint')) {
          const hint = document.createElement('span');
          hint.className = 'tg-link-hint';
          hint.textContent = '⛓ link';
          item.appendChild(hint);
        }
        return; // do not reorder DOM while linking
      }

      smartTracksList.dataset.tgDragMode = 'reorder';
      delete smartTracksList.dataset.tgLinkTarget;
      item.classList.remove('tg-link-target');
      const tip = item.querySelector('.tg-link-hint');
      if (tip) tip.remove();

      const afterElement = getDragAfterElement(smartTracksList, e.clientY);
      if (afterElement == null) {
        const lastGroupItems = smartTracksList.querySelector('.smart-track-group-block:last-child .smart-track-group-items');
        (lastGroupItems || smartTracksList).appendChild(dragging);
      } else {
        afterElement.parentNode.insertBefore(dragging, afterElement);
      }
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    item.draggable = !selectMode;
    appendParent.appendChild(item);
  });

  // Undo toast at end of list when insertIndex == tracks.length
  if (pendingUndo && pendingUndo.snapshot && pendingUndo.insertIndex >= tracksInOrder.length) {
    smartTracksList.appendChild(buildSmartTrackUndoRow(pendingUndo));
  }
}

function buildSmartTrackUndoRow(undo) {
  const row = document.createElement('div');
  row.className = 'smart-track-item smart-track-item-undo';
  row.setAttribute('role', 'status');
  const label = document.createElement('div');
  label.className = 'smart-track-item-undo-label';
  label.textContent = (undo.snapshot.label || 'Track') + ' removed';
  const btns = document.createElement('div');
  btns.className = 'smart-track-item-undo-actions';
  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'smart-track-item-undo-btn';
  undoBtn.textContent = 'Undo';
  undoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    undoRemoveSmartTrack();
  });
  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'smart-track-item-undo-dismiss';
  dismissBtn.setAttribute('aria-label', 'Dismiss');
  dismissBtn.textContent = '×';
  dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearPendingUndo(true);
  });
  btns.appendChild(undoBtn);
  btns.appendChild(dismissBtn);
  const bar = document.createElement('div');
  bar.className = 'smart-track-item-undo-progress';
  const remaining = Math.max(0, (undo.expiresAt || 0) - Date.now());
  bar.style.animationDuration = (remaining / 1000) + 's';
  row.appendChild(label);
  row.appendChild(btns);
  row.appendChild(bar);
  return row;
}

// Helper function for drag and drop
function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.smart-track-item:not(.dragging):not(.smart-track-item-undo)')];
  
  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// Top-level reorder target for whole group blocks (and ungrouped track rows).
function getDragAfterTopLevel(container, y, draggingEl) {
  const children = [...container.children].filter((el) => {
    if (el === draggingEl) return false;
    return el.classList.contains('smart-track-group-block')
      || el.classList.contains('smart-track-item');
  });
  return children.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    }
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// Right sidebar collapse/expand
function getRightSidebarCollapsed() {
  const stored = gsLocalStorage.getItem("genomeshader.rightSidebarCollapsed");
  // Default to collapsed (true) if not set
  if (stored === null) {
    return true;
  }
  return stored === "true";
}
function setRightSidebarCollapsed(collapsed) {
  gsLocalStorage.setItem("genomeshader.rightSidebarCollapsed", String(collapsed));
  updateRightSidebarState();
}
function updateRightSidebarState() {
  const collapsed = getRightSidebarCollapsed();
  const app = document.querySelector('.app');
  if (!app) {
    return;
  }
  if (collapsed) {
    app.classList.add("sidebar-right-collapsed");
  } else {
    app.classList.remove("sidebar-right-collapsed");
  }
  // Reflow via the rAF-deduped scheduleRender so opening both panels at once
  // (e.g. double-click an allele) coalesces to one render, not a storm. The
  // debounced ResizeObserver still handles the transition tail.
  if (typeof scheduleRender === "function") scheduleRender();
  else requestAnimationFrame(() => { try { if (typeof renderAll === "function") renderAll(); } catch (e) {} });
}

// Right sidebar width (drag-to-resize). Stored in px; applied via the
// --sidebar-right-w CSS var on the container so the flex-basis rules honor it.
const RIGHT_SIDEBAR_MIN_W = 200;
function getRightSidebarWidth() {
  const v = parseInt(gsLocalStorage.getItem("genomeshader.rightSidebarWidth"), 10);
  return (isFinite(v) && v >= RIGHT_SIDEBAR_MIN_W) ? v : 240;
}
function applyRightSidebarWidth(px) {
  const rootEl = document.querySelector('[id^="genomeshader-root-"]') || document.documentElement;
  rootEl.style.setProperty("--sidebar-right-w", px + "px");
}

// Left sidebar width (drag-to-resize). Default is wide enough that settings
// labels ("Click chromosome to jump", …) sit on one line.
const LEFT_SIDEBAR_MIN_W = 240;
const LEFT_SIDEBAR_DEFAULT_W = 360;
function getLeftSidebarWidth() {
  const v = parseInt(gsLocalStorage.getItem("genomeshader.leftSidebarWidth"), 10);
  return (isFinite(v) && v >= LEFT_SIDEBAR_MIN_W) ? v : LEFT_SIDEBAR_DEFAULT_W;
}
function applyLeftSidebarWidth(px) {
  const rootEl = document.querySelector('[id^="genomeshader-root-"]') || document.documentElement;
  rootEl.style.setProperty("--sidebar-w", px + "px");
}
function setupLeftSidebarResize(sidebarLeft, app) {
  if (!sidebarLeft || sidebarLeft.querySelector(".sidebar-left-resize-handle")) return;
  applyLeftSidebarWidth(getLeftSidebarWidth());

  const handle = document.createElement("div");
  handle.className = "sidebar-left-resize-handle";
  handle.title = "Drag to resize panel";
  handle.style.cssText =
    "position:absolute;right:0;top:0;bottom:0;width:6px;cursor:col-resize;" +
    "z-index:150;pointer-events:auto;touch-action:none;";
  sidebarLeft.appendChild(handle);

  let startX = 0, startW = 0, dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const appW = app.getBoundingClientRect().width || 1200;
    const maxW = Math.max(LEFT_SIDEBAR_MIN_W, Math.min(720, appW * 0.6));
    // Dragging the right edge rightward widens the panel.
    let w = startW + (e.clientX - startX);
    w = Math.max(LEFT_SIDEBAR_MIN_W, Math.min(maxW, w));
    applyLeftSidebarWidth(w);
    requestAnimationFrame(() => { try { if (typeof renderAll === "function") renderAll(); } catch (err) {} });
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerup", onUp, true);
    try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
    const cur = getComputedStyle(sidebarLeft).width;
    const px = Math.round(parseFloat(cur));
    if (isFinite(px)) gsLocalStorage.setItem("genomeshader.leftSidebarWidth", String(px));
    requestAnimationFrame(() => { try { if (typeof renderAll === "function") renderAll(); } catch (err) {} });
  };
  handle.addEventListener("pointerdown", (e) => {
    if (typeof getSidebarCollapsed === "function" && getSidebarCollapsed()) return;
    e.preventDefault(); e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startW = sidebarLeft.getBoundingClientRect().width;
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
  }, true);
  handle.addEventListener("click", (e) => { e.stopPropagation(); }, true);
  handle.addEventListener("mousedown", (e) => { e.stopPropagation(); }, true);
}

function setupRightSidebarResize(sidebarRight, app) {
  if (sidebarRight.querySelector(".sidebar-right-resize-handle")) return;
  applyRightSidebarWidth(getRightSidebarWidth());

  const handle = document.createElement("div");
  handle.className = "sidebar-right-resize-handle";
  handle.title = "Drag to resize panel";
  // Inline the essentials so it works without a styles.css dependency; visual
  // accent (hover color) lives in styles.css.
  handle.style.cssText =
    "position:absolute;left:0;top:0;bottom:0;width:6px;cursor:col-resize;" +
    "z-index:150;pointer-events:auto;touch-action:none;";
  sidebarRight.appendChild(handle);

  let startX = 0, startW = 0, dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const appW = app.getBoundingClientRect().width || 1200;
    const maxW = Math.max(RIGHT_SIDEBAR_MIN_W, Math.min(720, appW * 0.6));
    // Dragging the left edge leftward widens the panel.
    let w = startW + (startX - e.clientX);
    w = Math.max(RIGHT_SIDEBAR_MIN_W, Math.min(maxW, w));
    applyRightSidebarWidth(w);
    requestAnimationFrame(() => { try { if (typeof renderAll === "function") renderAll(); } catch (err) {} });
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerup", onUp, true);
    try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
    const cur = getComputedStyle(sidebarRight).width;
    const px = Math.round(parseFloat(cur));
    if (isFinite(px)) gsLocalStorage.setItem("genomeshader.rightSidebarWidth", String(px));
    requestAnimationFrame(() => { try { if (typeof renderAll === "function") renderAll(); } catch (err) {} });
  };
  handle.addEventListener("pointerdown", (e) => {
    if (getRightSidebarCollapsed()) return;   // nothing to resize while collapsed
    e.preventDefault(); e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startW = sidebarRight.getBoundingClientRect().width;
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
  }, true);
  // Swallow the edge-click collapse handler so a resize drag never also toggles.
  handle.addEventListener("click", (e) => { e.stopPropagation(); }, true);
  handle.addEventListener("mousedown", (e) => { e.stopPropagation(); }, true);
}

// Initialize right sidebar (closed by default)
// Wait for DOM to be ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeRightSidebar);
  } else {
    initializeRightSidebar();
  }
}

// Tab switching for right sidebar
function getActiveTab() {
  const stored = gsLocalStorage.getItem("genomeshader.rightSidebarTab");
  if (!stored || stored === "track") return "smart-tracks";
  return stored;
}
function setActiveTab(tabName) {
  gsLocalStorage.setItem("genomeshader.rightSidebarTab", tabName);
  updateActiveTab();
}
function updateActiveTab() {
  const activeTab = getActiveTab();
  
  // Update tab panes
  const tabPanes = document.querySelectorAll('.tab-pane');
  tabPanes.forEach(pane => {
    if (pane.dataset.tab === activeTab) {
      pane.classList.add('active');
    } else {
      pane.classList.remove('active');
    }
  });
  
  // Update command strip icons (right rail only — left icons use data-left-tab)
  const icons = document.querySelectorAll('.sidebar-right-command-strip .command-strip-icon');
  icons.forEach(icon => {
    if (icon.dataset.tab === activeTab) {
      icon.classList.add('active');
    } else {
      icon.classList.remove('active');
    }
  });
}

function initializeRightSidebar() {
  const app = document.querySelector('.app');
  if (!app) {
    // Retry after a short delay if app isn't ready yet
    setTimeout(initializeRightSidebar, 100);
    return;
  }

  if (typeof initTrackGroups === "function") {
    try { initTrackGroups(); } catch (_) {}
  }
  
  // Initialize state (defaults to collapsed if not set)
  updateRightSidebarState();
  
  // Make right sidebar border clickable
  const sidebarRight = document.getElementById('sidebarRight');
  if (sidebarRight) {
    const handleRightSidebarToggle = (e) => {
      // Don't intercept clicks on form elements, command strip icons, or their containers
      const target = e.target;
      if (target.closest('input, button, select, label, .smart-track-item, .smart-track-item-gear, .smart-track-item-config, .sidebar-right-command-strip, .sidebar-close-btn, .sidebar-right-resize-handle')) {
        return;
      }
      
      const collapsed = getRightSidebarCollapsed();
      const rect = sidebarRight.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      
      // Check if click is within 8px of the left edge (or anywhere if collapsed)
      if (collapsed) {
        e.preventDefault();
        e.stopPropagation();
        setRightSidebarCollapsed(false);
      } else if (clickX <= 8) {
        e.preventDefault();
        e.stopPropagation();
        setRightSidebarCollapsed(true);
      }
    };
    
    sidebarRight.addEventListener("click", handleRightSidebarToggle, true);
    sidebarRight.addEventListener("pointerdown", handleRightSidebarToggle, true);
    sidebarRight.addEventListener("pointerup", handleRightSidebarToggle, true);
    sidebarRight.addEventListener("mousedown", handleRightSidebarToggle, true);

    sidebarRight.style.pointerEvents = "auto";

    // Collapse is handled by the protruding edge tab (.sidebar-right::before);
    // no separate close button needed.

    // Drag-to-resize handle on the panel's inner (left) edge. Width is driven by
    // the --sidebar-right-w CSS var on the container (the flex-basis rules read
    // it), so setting the var live resizes the panel and reflows the tracks.
    setupRightSidebarResize(sidebarRight, app);

    const sidebarLeft = document.getElementById("sidebarLeft");
    setupLeftSidebarResize(sidebarLeft, app);

    // Initialize tab switching
    // Scope to the right strip so left-panel icons (data-left-tab) aren't caught.
    const commandStripIcons = document.querySelectorAll('.sidebar-right-command-strip .command-strip-icon');
    commandStripIcons.forEach(icon => {
      icon.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tabName = icon.dataset.tab;
        if (!tabName) return;
        // Activity-bar behavior (mirrors the left rail): collapsed -> open to the
        // tab; open + already-active tab -> collapse; open + other tab -> switch.
        if (getRightSidebarCollapsed()) {
          setActiveTab(tabName);
          setRightSidebarCollapsed(false);
        } else if (getActiveTab() === tabName) {
          setRightSidebarCollapsed(true);
        } else {
          setActiveTab(tabName);
        }
      });
    });
    
    // Initialize active tab
    updateActiveTab();

    // Initial render
    renderSmartTracksSidebar();
  }
}

// ---------------------------------------------------------------------------
// Test seam: seed a Smart track with canned reads and paint it WITHOUT the
// ipywidgets comm (which the headless / real-GPU harness can't provide). Mirrors
// the exact path fetchReadsForSmartTrack takes on a real load — createSmartTrack,
// then set readsData / readsLayout / sampleId and renderSmartTrack — so a WebGPU
// pixel test exercises the real read + SNP draw. Same window.__GS_* seam pattern
// as window.__GS_processReadsData above; no production code calls it.
if (typeof window !== "undefined") {
  window.toggleTrackConfig = toggleTrackConfig;
  window.renderSmartTracksSidebar = renderSmartTracksSidebar;
  window.__GS_armRemoveSmartTrack = armRemoveSmartTrack;
  window.__GS_confirmRemoveSmartTrack = confirmRemoveSmartTrack;
  window.__GS_undoRemoveSmartTrack = undoRemoveSmartTrack;
  window.__GS_clearPendingUndo = clearPendingUndo;
  window.__GS_moveSmartTrackInList = moveSmartTrackInList;
  window.__GS_TEST_seedSmartTrack = async function (sampleId, rawReads, opts) {
    opts = opts || {};
    const track = createSmartTrack(opts.strategy || "best", opts.selectedAlleles || []);
    track.sampleId = sampleId;
    track.label = sampleId;
    // Default expanded (rows visible) unless opts.collapsed === true.
    applyVisibilityShortcut(track, opts.collapsed === true);
    track.readsData = rawReads;
    if (opts.showPairs != null) {
      track.readDisplay.alignments.paired = !!opts.showPairs;
      track.showPairs = !!opts.showPairs;
    }
    if (opts.readDisplay) {
      Object.assign(track.readDisplay, cloneReadDisplayConfig({
        ...track.readDisplay,
        ...opts.readDisplay,
      }));
      syncTrackCollapsedFromVisibility(track);
    }
    layoutSmartTrackReads(track);
    // initSmartTrackWebGPU (started by createSmartTrack) is async; wait for the
    // per-track renderer to come up before we paint.
    for (let i = 0; i < 80 && !state.smartTrackRenderers.has(track.id); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    updateTracksHeight();
    renderAll();
    if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
    await new Promise((r) => requestAnimationFrame(() => r()));
    try { renderSmartTrack(track.id); } catch (e) {}
    await new Promise((r) => requestAnimationFrame(() => r()));
    const rec = state.smartTrackRenderers.get(track.id) || {};
    return {
      trackId: track.id,
      rowCount: track.readsLayout ? track.readsLayout.rowCount : 0,
      readCount: track.readsLayout ? track.readsLayout.reads.length : 0,
      hasWebGPU: !!rec.webgpuCore,
    };
  };

  // Test seam: narrow the visible locus to `spanBp` bases (keeping startBp) and
  // re-render, so a pixel test can zoom in far enough that per-base SNP tiles
  // are wide enough to draw their base letter (#67). Returns the new window.
  window.__GS_TEST_setSpan = function (spanBp) {
    state.endBp = state.startBp + spanBp;
    renderAll();
    return { startBp: state.startBp, endBp: state.endBp };
  };

  // Test seam: switch orientation at runtime (mirrors the settings toggle:
  // setOrientation + renderAll) so a pixel test can exercise the vert<->horiz
  // switch path (#bug5: stale smart-canvas CSS box after a flip).
  window.__GS_TEST_setOrientation = function (o) {
    if (typeof setOrientation === "function") setOrientation(o);
    renderAll();
    return isVerticalMode();
  };

  // Test seam: run the REAL read-fetch path for a fresh track, so a test can mock
  // __GS_SEND to fail and assert the error handling (track removed + modal shown).
  // Resolves to the trackId whether the fetch succeeds or fails.
  window.__GS_TEST_loadReads = function (sampleId, strategy, selectedAlleles) {
    const s = strategy || "best_evidence";
    const track = createSmartTrack(s, selectedAlleles || new Set());
    return fetchReadsForSmartTrack(track.id, s, selectedAlleles || new Set(), sampleId)
      .then(() => track.id, () => track.id);
  };
}
