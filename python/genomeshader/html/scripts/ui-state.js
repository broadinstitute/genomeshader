// ViewState
// -----------------------------
// A variant/allele point-marker sits at the CENTER of its base cell, matching
// the reference base tile and the read SNP tile (both span [pos, pos+1], so
// their letter/center is at pos+0.5). xGenomeCanonical(pos) is the cell's LEFT
// edge, so variant markers must map (pos + this) to land on the base — otherwise
// they're half a base off the reads/reference (invisible when zoomed out, a full
// tick-width off when zoomed to tens of bp). Reads/tiles keep the raw pos.
const VARIANT_BASE_CENTER_OFFSET_BP = 0.5;

const state = {
  contig: "chr1",
  startBp: 100_000,
  endBp:   100_900,
  pxPerBp: 1,

  // Render overscan (0 = off, identical to the view window). During a live pan
  // these become >0 so the tracks render a window WIDER than the viewport and
  // the pan layers are widened + offset by renderPadPx — translating them then
  // reveals pre-painted content instead of a blank leading edge. Reset on
  // settle. renderPadPx = renderPadBp * pxPerBp keeps zoom consistent.
  renderPadBp: 0,
  renderPadPx: 0,

  firstVariantIndex: 0,
  K: 8,
  hoveredVariantIndex: null, // index of hovered variant, or null
  hoveredVariantId: null,    // id of hovered variant (for multi-track ruler/flow), or null
  expandedInsertions: new Set(), // Set of variant IDs that have expanded insertions
  expandedDeletions: new Set(),  // Set of deletion variant IDs whose deleted ref bases are shown (shaded)
  hoveredRepeatTooltip: null, // { text, x, y } or null
  hoveredVariantLabelTooltip: null, // { text, x, y } or null
  // Vertical mode: horizontal scroll offset (px) across the side-by-side track
  // columns, so many expanded sample tracks that exceed the viewport width can
  // be scrolled into view. 0 in horizontal mode / at rest.
  vertScrollX: 0,
  locusVariantElements: new Map(), // Map of variant index -> { lineEl, circleEl } for Locus track

  // interaction
  dragging: false,
  lastX: 0,
  lastY: 0,
  // Locus-bar padlock + Settings "Lock viewport": freeze pan and zoom.
  // Go / contig jumps still work. Default off (unlocked).
  lockView: false,
  // Multi-tile: pointer-enter focuses the column under the mouse. Default on.
  focusFollowsMouse: true,

  // touch pinch
  pointers: new Map(),     // pointerId -> {x,y}
  pinchStartDist: null,
  pinchStartSpan: null,
  pinchAnchorBp: null,

  // Track id whose inline config drawer is open in the Tracks list. Null = none.
  expandedTrackConfigId: null,

  // track management (flow tracks are injected from config.variant_tracks when present)
  tracks: [
    { id: "genes", label: "Genes", collapsed: false, height: 50, minHeight: 30 },
    { id: "repeats", label: "RepeatMasker", collapsed: false, height: 40, minHeight: 30 },
    { id: "reference", label: "Reference", collapsed: false, height: 96, minHeight: 72 },
    // Indel lollipops now overlay the top of the Variants/Haplotypes track (the
    // standalone Indel/ruler track was merged in); a bit taller for the strip.
    { id: "flow", label: "Variants/Haplotypes", collapsed: false, height: 172, minHeight: 132 }
  ],
  trackDragState: null,  // { trackId, startX, startY, offsetX, offsetY }
  trackResizeState: null, // { trackId, startX, startY, startHeight }
  
  // variant layout mode: "equidistant" or "genomic"
  variantLayoutMode: null, // will be initialized from localStorage
  // aggregate low-frequency alleles in flow nodes/ribbons
  aggregateRareAlleles: false,
  aggregateRareAllelesCutoffPct: 2.0,
  
  // allele order for each variant node: Map<trackId::variantId, string[]>
  variantAlleleOrder: new Map(),
  
  // drag state for allele reordering
  alleleDragState: null, // { trackId, variantId, alleleIndex, label, startX, startY, offsetX, offsetY, dropIndex }
  
  // hovered allele node: { trackId, variantId, alleleIndex } or null
  hoveredAlleleNode: null,
  hoveredAlleleNodeTooltip: null, // { text, x, y } when hovering an allele node

  // pinned allele labels: Set of keys from makeAlleleSelectionKey()
  pinnedAlleleLabels: new Set(),
  
  // pinned variant labels: Set of variant IDs (strings)
  pinnedVariantLabels: new Set(),
  
  // selected alleles for multi-select: Set of keys from makeAlleleSelectionKey()
  selectedAlleles: new Set(),
  
  // sample selection state
  sampleSelection: {
    strategy: 'best_evidence',
    numSamples: 1,
    combineMode: 'AND', // 'AND' or 'OR'
    evidenceFilter: null, // attach_reads label or null (All) — Sample Search only
    candidateSamples: [], // Will be populated when selection changes
    allSampleIds: [], // All available sample IDs (populated from data)
    resolvedSamples: [], // Strategy-resolved IDs shown as "on" in Preview / Load
  },
  
  // Smart tracks state
  smartTracks: [], // Array of Smart track instances
  smartTrackRenderers: new Map(), // Map<trackId, { webgpuCore, instancedRenderer, canvas, webgpuCanvas, container }>
  // User-defined track groups (shared settings). Distinct from sample-facet blocks.
  trackGroups: [], // [{ id, name, color, memberTrackIds }]
  trackGroupSelectMode: false,
  trackGroupSelectedIds: [], // track ids selected in multi-select mode
  _viewCoverageMax: null, // cached per-frame max depth across smart tracks (View scale)

  // Groups tab: metadata facets only. Each entry: { key, level }.
  // level null = All (unrestricted on that facet). AND across non-null levels.
  activeFacets: [],
  // Metadata column used for flow/ribbon/track color; null → flat palette.
  colorFacetKey: null,

  // allele context menu state: { x, y, visible } or null
  alleleContextMenu: null,

  // Software-defined tracks from attach_data() (Phase 1). Parallel to
  // state.ucscTracks — layout lives in state.tracks; feature data here.
  // Entry: { id, label, style, color, y_scale, y_min, y_max, series, ... }
  dataTracks: [],

  // Built-in annotation tracks (genes / repeats) — Phase 2 shared envelope.
  // Layout ids stay "genes" / "repeats"; features live here.
  annotationTracks: [],

  // Multi-locus tiles. Seeded by tiles.js from the singleton contig/window.
  // Contig/startBp/endBp/pxPerBp above mirror the focused tile (compat aliases).
  tiles: null,
  focusedTileId: null,
};

// Initialize variant layout mode
const storedVariantMode = getStoredVariantLayoutMode();
state.variantLayoutMode = storedVariantMode ?? "genomic";
if (typeof getStoredLockAlleles === "function") {
  state.lockAlleles = getStoredLockAlleles();
  if (typeof lockAllelesToggle !== "undefined" && lockAllelesToggle) {
    lockAllelesToggle.checked = state.lockAlleles === true;
  }
}
if (typeof getStoredChromClickJump === "function") {
  state.chromClickJump = getStoredChromClickJump();
  if (typeof chromClickJumpToggle !== "undefined" && chromClickJumpToggle) {
    chromClickJumpToggle.checked = state.chromClickJump === true;
  }
}
if (typeof getStoredFocusFollowsMouse === "function") {
  state.focusFollowsMouse = getStoredFocusFollowsMouse();
  if (typeof focusFollowsMouseToggle !== "undefined" && focusFollowsMouseToggle) {
    focusFollowsMouseToggle.checked = state.focusFollowsMouse === true;
  }
}
if (typeof getStoredAggregateRareAlleles === "function") {
  state.aggregateRareAlleles = getStoredAggregateRareAlleles();
}
if (typeof getStoredAggregateRareAllelesCutoff === "function") {
  state.aggregateRareAllelesCutoffPct = getStoredAggregateRareAllelesCutoff();
}
// Initialize label after DOM is ready
setTimeout(() => updateVariantLayoutModeLabel(), 0);
setTimeout(() => {
  if (typeof updateAggregateRareAllelesControls === "function") {
    updateAggregateRareAllelesControls();
  }
}, 0);
setTimeout(() => {
  if (typeof initSampleGroupingUI === "function") initSampleGroupingUI();
}, 0);

// Chromosome lengths for bounds checking
const chrLengths = {
  "chr1": 248_956_422,
  "chr2": 242_193_529,
  "chr3": 198_295_559,
  "chr4": 190_214_555,
  "chr5": 181_538_259,
  "chr6": 170_805_979,
  "chr7": 159_345_973,
  "chr8": 145_138_636,
  "chr9": 138_394_717,
  "chr10": 133_797_422,
  "chr11": 135_086_622,
  "chr12": 133_275_309,
  "chr13": 114_364_328,
  "chr14": 107_043_718,
  "chr15": 101_991_189,
  "chr16": 90_338_345,
  "chr17": 83_257_441,
  "chr18": 80_373_285,
  "chr19": 58_617_616,
  "chr20": 64_444_167,
  "chr21": 46_709_983,
  "chr22": 50_818_468,
  "chrX": 156_040_895,
  "chrY": 57_227_415
};

// Overlay genome-specific contig lengths from the render config (e.g. PlasmoDB
// Pf3D7). Absent for UCSC genomes, which keep the human defaults above.
if (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.chrom_lengths) {
  Object.assign(chrLengths, window.GENOMESHADER_CONFIG.chrom_lengths);
}

// Helper function to get chromosome length for current contig
function getChromosomeLength() {
  return chrLengths[state.contig]
    || chrLengths[window.GENOMESHADER_CONFIG?.region?.split(":")[0]]
    || 248_956_422;
}

// Helper function to clamp startBp and endBp to chromosome boundaries
function clampToChromosomeBounds() {
  const chrLength = getChromosomeLength();
  const span = state.endBp - state.startBp;
  
  // Clamp startBp to [0, chrLength - span]
  state.startBp = Math.max(0, Math.min(state.startBp, chrLength - span));
  
  // Ensure endBp doesn't exceed chromosome length
  state.endBp = Math.min(state.startBp + span, chrLength);
  
  // If span is larger than chromosome, center it
  if (span > chrLength) {
    state.startBp = 0;
    state.endBp = chrLength;
  }
}

// Function to update document title with current locus
function updateDocumentTitle() {
  const s = Math.max(1, Math.floor(state.startBp));
  const e = Math.max(s, Math.ceil(state.endBp));
  const startFormatted = s.toLocaleString();
  const endFormatted = e.toLocaleString();
  document.title = `Genomeshader (${state.contig}:${startFormatted}-${endFormatted})`;
}

// Initialize state from GENOMESHADER_CONFIG if available
let dataBounds = null;
if (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.region) {
  const region = window.GENOMESHADER_CONFIG.region;
  // Parse region string format: "chr1:100000-200000"
  const match = region.match(/^([^:]+):(\d+)-(\d+)$/);
  if (match) {
    state.contig = match[1];
    state.startBp = parseInt(match[2], 10);
    state.endBp = parseInt(match[3], 10);
  }
  
  // Store data bounds if available (where actual read data exists)
  if (window.GENOMESHADER_CONFIG.data_bounds) {
    dataBounds = {
      start: window.GENOMESHADER_CONFIG.data_bounds.start,
      end: window.GENOMESHADER_CONFIG.data_bounds.end
    };
  }
  
  // Update document title with initial locus
  updateDocumentTitle();
}

// Drop the RepeatMasker track when no repeats were supplied — an empty track
// just wastes vertical space.
(function _gsDropEmptyRepeatsTrack() {
  const cfg = window.GENOMESHADER_CONFIG || {};
  const rt = cfg.repeats_track;
  const feats = rt && Array.isArray(rt.series) && rt.series[0]
    ? (rt.series[0].features || [])
    : [];
  if (!feats.length) {
    state.tracks = state.tracks.filter(t => t.id !== "repeats");
  }
})();

// Replace single "flow" track with one track per variant dataset when config.variant_tracks is provided
if (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_tracks && window.GENOMESHADER_CONFIG.variant_tracks.length > 0) {
  const variantTracksConfig = window.GENOMESHADER_CONFIG.variant_tracks;
  state.tracks = state.tracks.filter(t => t.id !== "flow");
  variantTracksConfig.forEach(t => {
    state.tracks.push({
      id: t.id,
      label: t.label,
      collapsed: false,
      height: 150,
      minHeight: 100
    });
  });
}

// Software-defined tracks (attach_data): inject layout rows before flow, seed
// state.dataTracks from config (static tracks may already include series).
(function _gsInitDataTracks() {
  const cfgTracks = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.data_tracks) || [];
  if (!Array.isArray(cfgTracks) || !cfgTracks.length) return;
  state.dataTracks = cfgTracks.map(t => ({
    id: t.id,
    label: t.label || t.id,
    style: t.style || "line",
    color: t.color,
    y_scale: t.y_scale || "linear",
    y_min: (t.y_min != null) ? t.y_min : null,
    y_max: (t.y_max != null) ? t.y_max : null,
    series: Array.isArray(t.series) ? t.series : [],
    callable: !!t.callable,
  }));
  for (const t of state.dataTracks) {
    if (state.tracks.some(tr => tr.id === t.id)) continue;
    const trackDef = {
      id: t.id,
      label: t.label,
      collapsed: false,
      height: (window.GENOMESHADER_CONFIG.data_tracks.find(d => d.id === t.id) || {}).height || 80,
      minHeight: (window.GENOMESHADER_CONFIG.data_tracks.find(d => d.id === t.id) || {}).minHeight || 40,
    };
    const at = state.tracks.findIndex(tr => tr.id === "flow" || (typeof tr.id === "string" && tr.id.startsWith("flow-")));
    if (at >= 0) state.tracks.splice(at, 0, trackDef); else state.tracks.push(trackDef);
  }
})();

const main = byId(root, "main");
// Mutable so multi-locus tiles can rebind to each tile's canvas stack.
let tracksSvg = byId(root, "tracksSvg");
let tracksContainer = byId(root, "tracksContainer");
const locusIdeogramSvg = byId(root, "locusIdeogram");
let flow = byId(root, "flow");
let flowCanvas = byId(root, "flowCanvas");
let flowOverlay = byId(root, "flowOverlay");
const hud = byId(root, "hud");
const tooltip = byId(root, "tooltip");
let tracksWebGPU = byId(root, "tracksWebGPU");
let flowWebGPU = byId(root, "flowWebGPU");
let flowIndelOverlay = byId(root, "flowIndelOverlay");

// Initialize WebGPU infrastructure
let webgpuCore = null;
let instancedRenderer = GS_NULL_RENDERER;
let flowWebGPUCore = null;
let flowInstancedRenderer = GS_NULL_RENDERER;
let flowRibbonRenderer = GS_NULL_RENDERER;
let webgpuSupported = false;
let repeatHitTestData = []; // For tooltip hit testing

// Cache for ribbon transition data (keyed by variant pair IDs)
// This avoids recalculating transitions on every pan/zoom
const ribbonTransitionCache = new Map();
const MAX_CACHE_SIZE = 1000; // Limit cache size to prevent unbounded growth
if (typeof window !== "undefined") {
  window.ribbonTransitionCache = ribbonTransitionCache;
}
let cachedVisibleVariantIds = null; // Track which variants were used for cache
let cachedViewportRange = null; // Track the viewport range used for cache (with padding)

// Selection/order key helpers (track-aware; with legacy parsing fallback).
function makeVariantOrderKey(trackId, variantId) {
  return `${String(trackId || "")}::${String(variantId)}`;
}

function makeAlleleSelectionKey(trackId, variantId, alleleIndex) {
  const t = encodeURIComponent(String(trackId || ""));
  const v = encodeURIComponent(String(variantId));
  return `t=${t};v=${v};a=${Number(alleleIndex)}`;
}

function parseAlleleSelectionKey(key) {
  if (typeof key !== "string") return null;

  // New track-aware format.
  if (key.startsWith("t=") && key.includes(";v=") && key.includes(";a=")) {
    const fields = key.split(";");
    const tField = fields.find(f => f.startsWith("t="));
    const vField = fields.find(f => f.startsWith("v="));
    const aField = fields.find(f => f.startsWith("a="));
    if (!vField || !aField) return null;
    const alleleIndex = parseInt(aField.slice(2), 10);
    if (!Number.isFinite(alleleIndex)) return null;
    return {
      trackId: tField ? decodeURIComponent(tField.slice(2)) : "",
      variantId: decodeURIComponent(vField.slice(2)),
      alleleIndex
    };
  }

  // Legacy format: "variantId:alleleIndex"
  const idx = key.lastIndexOf(":");
  if (idx <= 0) return null;
  const variantId = key.slice(0, idx);
  const alleleIndex = parseInt(key.slice(idx + 1), 10);
  if (!Number.isFinite(alleleIndex)) return null;
  return { trackId: "", variantId, alleleIndex };
}

window.makeVariantOrderKey = makeVariantOrderKey;
window.makeAlleleSelectionKey = makeAlleleSelectionKey;
window.parseAlleleSelectionKey = parseAlleleSelectionKey;

// Expanded variant window with padding to reduce cache invalidation during pan/zoom
// Returns variants within viewport + padding (e.g., 30% on each side)
function expandedVariantWindow(paddingFraction = 0.3) {
  const span = state.endBp - state.startBp;
  const padding = span * paddingFraction;
  const expandedStart = Math.max(0, state.startBp - padding);
  const expandedEnd = state.endBp + padding;
  return variants.filter(v => v.pos >= expandedStart && v.pos <= expandedEnd);
}

// WebGPU is required. There is no Canvas2D/SVG fallback: without it we say so.
let _gpuRequiredShown = false;
function gsShowWebGpuRequired(error) {
  if (_gpuRequiredShown) return;
  _gpuRequiredShown = true;
  const reason = (error && error.message) ? error.message : String(error || "WebGPU is unavailable");
  console.error("GenomeShader requires WebGPU:", reason);
  try {
    const host = root && root.nodeType === 1 ? root : document.body;
    const box = document.createElement("div");
    box.className = "gs-webgpu-required";
    box.setAttribute("role", "alert");
    box.style.cssText = "position:absolute;inset:0;z-index:100000;display:flex;align-items:center;"
      + "justify-content:center;padding:24px;background:rgba(18,20,26,.94);color:#f2f4f8;"
      + "font:14px/1.5 system-ui,sans-serif;text-align:center;";
    const inner = document.createElement("div");
    inner.style.cssText = "max-width:460px;";
    const h = document.createElement("div");
    h.style.cssText = "font-size:18px;font-weight:600;margin-bottom:8px;";
    h.textContent = "GenomeShader needs WebGPU";
    const p = document.createElement("div");
    p.textContent = "This viewer draws with WebGPU and has no fallback. Use a current Chrome, Edge or "
      + "Safari with hardware acceleration enabled, then reload.";
    const r = document.createElement("div");
    r.style.cssText = "margin-top:10px;font-size:12px;opacity:.7;";
    r.textContent = reason;
    inner.append(h, p, r);
    box.appendChild(inner);
    host.appendChild(box);
  } catch (_) {}
}

// GPU record (context + instanced renderer, plus ribbons for flow canvases) per
// canvas element. Every tile owns its own tracks/flow canvases; all of them draw
// on the one shared device with the one shared set of pipelines.
const _gpuByCanvas = new WeakMap();

function gsCanvasGpu(canvas, withRibbons) {
  if (!canvas) return null;
  let rec = _gpuByCanvas.get(canvas);
  if (rec) return rec;
  const shared = gsGpuShared();
  if (!shared.device) return null;   // not ready yet — initWebGPU repaints once it is
  const core = new WebGPUCore();
  core.attach(canvas);
  rec = {
    core,
    renderer: new InstancedRenderer(core),
    ribbons: withRibbons ? new BezierRibbonRenderer(core, { segments: 44 }) : null,
  };
  _gpuByCanvas.set(canvas, rec);
  return rec;
}

function gsDisposeCanvasGpu(canvas) {
  const rec = canvas ? _gpuByCanvas.get(canvas) : null;
  if (!rec) return;
  try { rec.renderer.dispose(); } catch (_) {}
  try { rec.core.dispose(); } catch (_) {}
  _gpuByCanvas.delete(canvas);
}

/**
 * Point the GPU aliases (webgpuCore, instancedRenderer, flow*) at whichever
 * tile's canvases `tracksWebGPU` / `flowWebGPU` currently reference, exactly as
 * gsBindTileDom re-points the DOM aliases. Single- and multi-tile paint through
 * the same objects this way.
 */
function gsBindTileGpu() {
  const t = gsCanvasGpu(tracksWebGPU, false);
  const f = gsCanvasGpu(flowWebGPU, true);
  webgpuCore = t ? t.core : null;
  instancedRenderer = t ? t.renderer : GS_NULL_RENDERER;
  flowWebGPUCore = f ? f.core : null;
  flowInstancedRenderer = f ? f.renderer : GS_NULL_RENDERER;
  flowRibbonRenderer = f ? f.ribbons : GS_NULL_RENDERER;
}

async function initWebGPU() {
  // The shared device is requested once, immediately (see gsGpuReady in
  // webgpu-core.js). Every canvas — main, flow, and each smart track in each
  // tile — awaits this same promise, so none can be built "too early" and lose
  // GPU rendering.
  try {
    await gsGpuReady();
  } catch (error) {
    gsShowWebGpuRequired(error);
    return false;
  }
  webgpuSupported = true;

  try {
    gsBindTileGpu();
    // After a device loss the canvases are re-attached to the recovered device;
    // repaint everything from the (unchanged) data.
    if (!window.__gsGpuRestoreHooked) {
      window.__gsGpuRestoreHooked = true;
      gsGpuShared().onRestored(() => { if (typeof window.renderAll === "function") window.renderAll(); });
    }
    return true;
  } catch (error) {
    gsShowWebGpuRequired(error);
    return false;
  }
}

function scheduleInitialWebGPURender() {
  let attempts = 0;
  const maxAttempts = 30;

  const tryRender = () => {
    attempts += 1;
    if (typeof window.renderAll === "function") {
      // Render once now and once on the next frame to handle first-layout settle.
      window.renderAll();
      // Viewport-driven variant loading (#71): fetch the opening window ± overscan
      // (forced — nothing loaded yet). No-op unless enabled in config.
      if (typeof window.gsLoadVariantsForViewport === "function") {
        window.gsLoadVariantsForViewport(true);
      }
      requestAnimationFrame(() => {
        if (typeof window.renderAll === "function") {
          window.renderAll();
        }
      });
      return;
    }

    if (attempts < maxAttempts) {
      setTimeout(tryRender, 50);
    }
  };

  tryRender();
}

// Ask for the shared GPU device right away (it does not need the DOM); canvases
// attach to it as their elements get dimensions.
try { gsGpuReady().catch(() => {}); } catch (_) {}
// Initialize the main canvases after a short delay to ensure DOM is ready
setTimeout(() => {
  initWebGPU()
    .then((ok) => {
      if (ok) scheduleInitialWebGPURender();
    })
    .catch(err => {
      console.error("WebGPU initialization error:", err);
    });
}, 100);

// Initialize orientation state after DOM elements are available
updateOrientationState();

// Width measurements are cached for the duration of ONE renderAll pass. A paint
// maps thousands of coordinates (every repeat, gene exon, read element) through
// tracksWidthPx(); measuring the DOM for each forces a synchronous layout after
// the previous DOM write. Outside a pass (hover, interaction) nothing is cached.
// Layout-changing steps inside a pass call gsMeasureInvalidate().
let _gsMeasureScope = false;
const _gsWidthCache = new Map();
function _gsMeasureClear() { _gsWidthCache.clear(); if (typeof _gsWrapViewCache !== "undefined") _gsWrapViewCache.clear(); }
function gsMeasureBegin() { _gsMeasureScope = true; _gsMeasureClear(); }
function gsMeasureEnd() { _gsMeasureScope = false; _gsMeasureClear(); }
function gsMeasureInvalidate() { _gsMeasureClear(); }
function _gsElWidth(el) {
  if (!_gsMeasureScope) return el.getBoundingClientRect().width;
  let w = _gsWidthCache.get(el);
  if (w === undefined) { w = el.getBoundingClientRect().width; _gsWidthCache.set(el, w); }
  return w;
}

function rectW(el) { 
  if (!el) return 0;
  const w = _gsElWidth(el);
  return isNaN(w) || w <= 0 ? 0 : w;
}
function rectH(el) { 
  if (!el) return 0;
  const h = el.getBoundingClientRect().height;
  return isNaN(h) || h <= 0 ? 0 : h;
}

function tracksWidthPx() { 
  if (tracksContainer) {
    const w = _gsElWidth(tracksContainer);
    if (!isNaN(w) && w > 0) {
      return w;
    }
  }
  if (!tracksSvg) return 0;
  const w = _gsElWidth(tracksSvg);
  return isNaN(w) || w <= 0 ? 0 : w;
}
function flowWidthPx() {
  // The flow shares the horizontal genome axis with every other track, so it
  // must map bp -> x using the SAME width as the ruler/reference/genes
  // (tracksWidthPx). Reading the flow element's own width instead lets any DOM
  // width difference — e.g. a scrollbar in JupyterLab or fullscreen — desync the
  // flow from the Indel track. In vertical mode the flow width is the cross
  // (allele) axis, so keep the element's own width there.
  if (typeof isVerticalMode === "function" && isVerticalMode()) return rectW(flow);
  const tw = (typeof tracksWidthPx === "function") ? tracksWidthPx() : 0;
  return tw > 0 ? tw : rectW(flow);
}
function flowHeightPx()  { return rectH(flow); }

// --- Render window (overscan-aware). At rest renderPadBp/Px are 0, so these are
// identical to the view window / element widths — a strict no-op. During a live
// pan they widen so tracks draw beyond the viewport (see state.renderPadBp).
function renderStartBp(tile) {
  const t = (typeof gsActiveTile === "function") ? gsActiveTile(tile) : state;
  return t.startBp - (t.renderPadBp || state.renderPadBp || 0);
}
function renderEndBp(tile) {
  const t = (typeof gsActiveTile === "function") ? gsActiveTile(tile) : state;
  return t.endBp + (t.renderPadBp || state.renderPadBp || 0);
}
function renderWidthPx()      { return tracksWidthPx()  + 2 * (state.renderPadPx || 0); }
function renderHeightPx()     { return tracksHeightPx() + 2 * (state.renderPadPx || 0); }
function renderFlowWidthPx()  { return flowWidthPx()    + 2 * (state.renderPadPx || 0); }
function renderFlowHeightPx() { return flowHeightPx()   + 2 * (state.renderPadPx || 0); }

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function updateDerived() {
  // Keep focused-tile aliases current before deriving pxPerBp.
  if (typeof gsPullAliasesIntoFocused === "function") {
    try { gsPullAliasesIntoFocused(); } catch (_) {}
  }
  const span = state.endBp - state.startBp;
  if (span <= 0 || isNaN(span)) {
    // Invalid span, keep previous pxPerBp or use default
    if (!state.pxPerBp || state.pxPerBp <= 0 || isNaN(state.pxPerBp)) {
      state.pxPerBp = 1;
    }
    if (typeof gsPullAliasesIntoFocused === "function") {
      try { gsPullAliasesIntoFocused(); } catch (_) {}
    }
    return;
  }
  if (isVerticalMode()) {
    const h = tracksHeightPx();
    if (h > 0 && !isNaN(h)) {
      state.pxPerBp = h / span;
    } else if (!state.pxPerBp || state.pxPerBp <= 0 || isNaN(state.pxPerBp)) {
      state.pxPerBp = 1;
    }
  } else {
    // Multi-tile: prefer the focused tile's width when set.
    let w = tracksWidthPx();
    if (typeof gsFocusedTile === "function") {
      const ft = gsFocusedTile();
      if (ft && Number.isFinite(ft.widthPx) && ft.widthPx > 0) w = ft.widthPx;
    }
    if (w > 0 && !isNaN(w)) {
      state.pxPerBp = w / span;
    } else if (!state.pxPerBp || state.pxPerBp <= 0 || isNaN(state.pxPerBp)) {
      state.pxPerBp = 1;
    }
  }
  // Final guard
  if (isNaN(state.pxPerBp) || state.pxPerBp <= 0) {
    state.pxPerBp = 1;
  }
  if (typeof gsPullAliasesIntoFocused === "function") {
    try { gsPullAliasesIntoFocused(); } catch (_) {}
  }
}

/**
 * Derive pxPerBp for the tile currently selected via gsWithTile / aliases,
 * using the bound tracksContainer width. Does not touch focusedTileId.
 */
function updateDerivedForBoundTile(tile) {
  const t = tile || ((typeof gsActiveTile === "function") ? gsActiveTile() : null);
  if (!t || t.blank) return;
  const span = (t.endBp || 0) - (t.startBp || 0);
  if (span <= 0 || isNaN(span)) {
    if (!t.pxPerBp || t.pxPerBp <= 0) t.pxPerBp = 1;
    state.pxPerBp = t.pxPerBp;
    return;
  }
  let w = tracksWidthPx();
  if (Number.isFinite(t.widthPx) && t.widthPx > 0) w = t.widthPx;
  if (w > 0 && !isNaN(w)) {
    t.pxPerBp = w / span;
  } else if (!t.pxPerBp || t.pxPerBp <= 0 || isNaN(t.pxPerBp)) {
    t.pxPerBp = 1;
  }
  state.pxPerBp = t.pxPerBp;
}

// Calculate total insertion gap width for expanded insertions (in pixels)
// Uses precomputed insertionGapPx from backend if available for performance
function getTotalInsertionGapWidth() {
  const totalGapBp = (typeof getTotalExpandedInsertionGapBp === "function")
    ? getTotalExpandedInsertionGapBp(state.expandedInsertions)
    : 0;
  const pxPerBpDisplay = (typeof getDisplayPxPerBp === "function")
    ? getDisplayPxPerBp()
    : (Number.isFinite(state.pxPerBp) && state.pxPerBp > 0 ? state.pxPerBp : 1);
  return totalGapBp * pxPerBpDisplay;
}

// IMPORTANT: canonical genome-x mapping for the right pane (tracks/canvases)
// Accounts for expanded insertion gaps. Optional `tile` selects an independent
// genomic window (multi-locus tiles); omit to use the active/focused tile.
function xGenomeCanonical(bp, W, tile) {
  // Guard against invalid inputs
  if (!W || W <= 0 || isNaN(W) || isNaN(bp)) {
    return 16; // Return leftPad as safe default
  }
  const t = (typeof gsActiveTile === "function") ? gsActiveTile(tile) : state;
  const leftPad = 16, rightPad = 16;
  const innerW = Math.max(0, W - leftPad - rightPad);
  if (innerW <= 0) {
    return leftPad;
  }
  const rStart = renderStartBp(t), rEnd = renderEndBp(t);
  const span = rEnd - rStart;
  if (span <= 0 || isNaN(span)) {
    return leftPad;
  }
  const expanded = (t.expandedInsertions instanceof Set) ? t.expandedInsertions : state.expandedInsertions;
  const totalGapBp = (typeof getTotalExpandedInsertionGapBp === "function")
    ? getTotalExpandedInsertionGapBp(expanded, t)
    : 0;
  if (isNaN(totalGapBp)) {
    return leftPad;
  }
  const effectiveSpan = span + totalGapBp;
  if (effectiveSpan <= 0 || isNaN(effectiveSpan)) {
    return leftPad;
  }
  
  // Calculate x position, accounting for insertion gaps before this position
  // Uses optimized binary search lookup if available for O(log n) performance
  const pxPerBp = (Number.isFinite(t.pxPerBp) && t.pxPerBp > 0) ? t.pxPerBp : (state.pxPerBp || 1);
  const accumulatedGapBp = (typeof getAccumulatedGapBp === "function")
    ? getAccumulatedGapBp(bp, expanded, t)
    : (getAccumulatedGapPx(bp, expanded) / pxPerBp);
  
  const bpOffset = bp - rStart;
  if (isNaN(accumulatedGapBp) || isNaN(bpOffset)) {
    return leftPad;
  }
  let normalizedPos = (bpOffset + accumulatedGapBp) / effectiveSpan;
  if (t.reversed) {
    normalizedPos = 1 - normalizedPos;
  }
  if (isNaN(normalizedPos)) {
    return leftPad;
  }
  
  const result = leftPad + normalizedPos * innerW;
  return isNaN(result) ? leftPad : Math.max(leftPad, Math.min(leftPad + innerW, result));
}

function xGenome(bp, tile) {
  return xGenomeCanonical(bp, renderWidthPx(), tile);
}

function bpFromXGenome(xPx, W, tile) {
  const t = (typeof gsActiveTile === "function") ? gsActiveTile(tile) : state;
  const leftPad = 16, rightPad = 16;
  const innerW = W - leftPad - rightPad;
  const span = t.endBp - t.startBp;
  const expanded = (t.expandedInsertions instanceof Set) ? t.expandedInsertions : state.expandedInsertions;
  const totalGapBp = (typeof getTotalExpandedInsertionGapBp === "function")
    ? getTotalExpandedInsertionGapBp(expanded, t)
    : 0;
  const effectiveSpan = span + totalGapBp;
  let tNorm = (xPx - leftPad) / innerW;
  if (t.reversed) tNorm = 1 - tNorm;
  
  // Reverse calculation accounting for gaps - iterative refinement
  // Uses optimized binary search lookup for O(log n) performance per iteration
  const pxPerBp = (Number.isFinite(t.pxPerBp) && t.pxPerBp > 0) ? t.pxPerBp : (state.pxPerBp || 1);
  let bpEstimate = t.startBp + tNorm * effectiveSpan;
  for (let iter = 0; iter < 5; iter++) {
    const accumulatedGapBp = (typeof getAccumulatedGapBp === "function")
      ? getAccumulatedGapBp(bpEstimate, expanded, t)
      : (getAccumulatedGapPx(bpEstimate, expanded) / pxPerBp);
    bpEstimate = t.startBp + (tNorm * effectiveSpan) - accumulatedGapBp;
  }
  
  return bpEstimate;
}

// Vertical mode coordinate mapping (genomic axis vertical: bottom=start, top=end)
function yGenomeCanonical(bp, H, tile) {
  // Guard against invalid inputs
  if (!H || H <= 0 || isNaN(H) || isNaN(bp)) {
    return 16; // Return topPad as safe default
  }
  const t = (typeof gsActiveTile === "function") ? gsActiveTile(tile) : state;
  const topPad = 16, bottomPad = 16;
  const innerH = Math.max(0, H - topPad - bottomPad);
  if (innerH <= 0) {
    return topPad;
  }
  const rStart = renderStartBp(t), rEnd = renderEndBp(t);
  const span = rEnd - rStart;
  if (span <= 0 || isNaN(span)) {
    return topPad;
  }
  const expanded = (t.expandedInsertions instanceof Set) ? t.expandedInsertions : state.expandedInsertions;
  const totalGapBp = (typeof getTotalExpandedInsertionGapBp === "function")
    ? getTotalExpandedInsertionGapBp(expanded, t)
    : 0;
  if (isNaN(totalGapBp)) {
    return topPad;
  }
  const effectiveSpan = span + totalGapBp;
  if (effectiveSpan <= 0 || isNaN(effectiveSpan)) {
    return topPad;
  }
  
  // Calculate y position, accounting for insertion gaps before this position
  // Uses optimized binary search lookup if available for O(log n) performance
  const pxPerBp = (Number.isFinite(t.pxPerBp) && t.pxPerBp > 0) ? t.pxPerBp : (state.pxPerBp || 1);
  const accumulatedGapBp = (typeof getAccumulatedGapBp === "function")
    ? getAccumulatedGapBp(bp, expanded, t)
    : (getAccumulatedGapPx(bp, expanded) / pxPerBp);
  
  const bpOffset = bp - rStart;
  if (isNaN(accumulatedGapBp) || isNaN(bpOffset)) {
    return topPad;
  }
  let normalizedPos = (bpOffset + accumulatedGapBp) / effectiveSpan;
  if (t.reversed) {
    normalizedPos = 1 - normalizedPos;
  }
  if (isNaN(normalizedPos)) {
    return topPad;
  }
  
  // Invert: bottom (H - bottomPad) = start, top (topPad) = end
  const result = H - bottomPad - normalizedPos * innerH;
  return isNaN(result) ? topPad : Math.max(topPad, Math.min(H - bottomPad, result));
}

function yGenome(bp, tile) {
  return yGenomeCanonical(bp, renderHeightPx(), tile);
}

function tracksHeightPx() {
  if (tracksContainer) {
    const h = tracksContainer.getBoundingClientRect().height;
    if (!isNaN(h) && h > 0) {
      return h;
    }
  }
  if (!tracksSvg) return 0;
  const h = tracksSvg.getBoundingClientRect().height;
  return isNaN(h) || h <= 0 ? 0 : h;
}

function bpFromYGenome(yPx, H, tile) {
  const v = (typeof gsActiveTile === "function") ? gsActiveTile(tile) : state;
  const topPad = 16, bottomPad = 16;
  const innerH = H - topPad - bottomPad;
  const span = v.endBp - v.startBp;
  const expanded = (v.expandedInsertions instanceof Set) ? v.expandedInsertions : state.expandedInsertions;
  const totalGapBp = (typeof getTotalExpandedInsertionGapBp === "function")
    ? getTotalExpandedInsertionGapBp(expanded, v)
    : 0;
  const effectiveSpan = span + totalGapBp;
  
  // Invert: yPx is from top, but we want position from bottom
  let normalizedPos = (H - bottomPad - yPx) / innerH;
  if (v.reversed) normalizedPos = 1 - normalizedPos;
  const tNorm = Math.max(0, Math.min(1, normalizedPos));
  
  // Reverse calculation accounting for gaps - iterative refinement
  // Uses optimized binary search lookup for O(log n) performance per iteration
  const pxPerBp = (Number.isFinite(v.pxPerBp) && v.pxPerBp > 0) ? v.pxPerBp : (state.pxPerBp || 1);
  let bpEstimate = v.startBp + tNorm * effectiveSpan;
  for (let iter = 0; iter < 5; iter++) {
    const accumulatedGapBp = (typeof getAccumulatedGapBp === "function")
      ? getAccumulatedGapBp(bpEstimate, expanded, v)
      : (getAccumulatedGapPx(bpEstimate, expanded) / pxPerBp);
    bpEstimate = v.startBp + (tNorm * effectiveSpan) - accumulatedGapBp;
  }
  
  return bpEstimate;
}

function xColumn(i, totalColumns) {
  const W = flowWidthPx();
  if (!W || W <= 0 || isNaN(W) || isNaN(i)) {
    return 60;
  }
  const margin = 60;
  const innerW = Math.max(10, W - 2*margin);
  const numCols = totalColumns !== undefined ? totalColumns : state.K;
  if (numCols <= 1) return margin;
  const result = margin + (i / (numCols - 1)) * innerW;
  return isNaN(result) ? margin : result;
}
function yColumn(i, totalColumns) {
  const H = flowHeightPx();
  if (!H || H <= 0 || isNaN(H) || isNaN(i)) {
    return 60;
  }
  const margin = 60;
  const innerH = Math.max(10, H - 2*margin);
  const numCols = totalColumns !== undefined ? totalColumns : state.K;
  if (numCols <= 1) return margin;
  // Invert: index 0 (earliest variant) should be at bottom (higher Y), 
  // last index (latest variant) should be at top (lower Y)
  const result = margin + innerH - (i / (numCols - 1)) * innerH;
  return isNaN(result) ? margin : result;
}
