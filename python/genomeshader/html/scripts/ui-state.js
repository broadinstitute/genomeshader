// ViewState
// -----------------------------
const state = {
  contig: "chr1",
  startBp: 100_000,
  endBp:   100_900,
  pxPerBp: 1,

  firstVariantIndex: 0,
  K: 8,
  hoveredVariantIndex: null, // index of hovered variant, or null
  expandedInsertions: new Set(), // Set of variant IDs that have expanded insertions
  hoveredRepeatTooltip: null, // { text, x, y } or null
  hoveredVariantLabelTooltip: null, // { text, x, y } or null
  locusVariantElements: new Map(), // Map of variant index -> { lineEl, circleEl } for Locus track

  // interaction
  dragging: false,
  lastX: 0,
  lastY: 0,

  // touch pinch
  pointers: new Map(),     // pointerId -> {x,y}
  pinchStartDist: null,
  pinchStartSpan: null,
  pinchAnchorBp: null,

  // track management
  tracks: [
    { id: "ideogram", label: "Chromosome", collapsed: false, height: 38, minHeight: 20 },
    { id: "genes", label: "Genes", collapsed: false, height: 50, minHeight: 30 },
    { id: "repeats", label: "RepeatMasker", collapsed: false, height: 40, minHeight: 30 },
    { id: "reference", label: "Reference", collapsed: false, height: 40, minHeight: 30 },
    { id: "ruler", label: "Locus", collapsed: false, height: 68, minHeight: 40 },
    { id: "flow", label: "Variants/Haplotypes", collapsed: false, height: 130, minHeight: 100 }
  ],
  trackDragState: null,  // { trackId, startX, startY, offsetX, offsetY }
  trackResizeState: null, // { trackId, startX, startY, startHeight }
  
  // variant layout mode: "equidistant" or "genomic"
  variantLayoutMode: null, // will be initialized from localStorage
  
  // allele order for each variant: Map<variantId, string[]> where array is ['.', '(N bp) refAllele', '(N bp) altAllele1', ...]
  variantAlleleOrder: new Map(),
  
  // drag state for allele reordering
  alleleDragState: null, // { variantId, alleleIndex, label, startX, startY, offsetX, offsetY, dropIndex }
  
  // hovered allele node: { variantId, alleleIndex } or null
  hoveredAlleleNode: null,
  
  // pinned allele labels: Set of strings like "variantId:alleleIndex"
  pinnedAlleleLabels: new Set(),
  
  // pinned variant labels: Set of variant IDs (strings)
  pinnedVariantLabels: new Set(),
  
  // selected alleles for multi-select: Set of strings like "variantId:alleleIndex"
  selectedAlleles: new Set(),
  
  // sample selection state
  sampleSelection: {
    strategy: 'random',
    numSamples: 1,
    combineMode: 'AND', // 'AND' or 'OR'
    candidateSamples: [], // Will be populated when selection changes
    allSampleIds: [] // All available sample IDs (populated from data)
  },
  
  // Smart tracks state
  smartTracks: [], // Array of Smart track instances
  smartTrackRenderers: new Map(), // Map<trackId, { webgpuCore, instancedRenderer, canvas, webgpuCanvas, container }>
  
  // allele context menu state: { x, y, visible } or null
  alleleContextMenu: null
};

// Initialize variant layout mode
const storedVariantMode = getStoredVariantLayoutMode();
state.variantLayoutMode = storedVariantMode ?? "equidistant";
// Initialize label after DOM is ready
setTimeout(() => updateVariantLayoutModeLabel(), 0);

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

// Helper function to get chromosome length for current contig
function getChromosomeLength() {
  return chrLengths[state.contig] || 248_956_422;
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
  const startFormatted = Math.floor(state.startBp).toLocaleString();
  const endFormatted = Math.floor(state.endBp).toLocaleString();
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

const main = byId(root, "main");
const tracksSvg = byId(root, "tracksSvg");
const tracksContainer = byId(root, "tracksContainer");
const flow = byId(root, "flow");
const flowCanvas = byId(root, "flowCanvas");
const flowOverlay = byId(root, "flowOverlay");
const hud = byId(root, "hud");
const tooltip = byId(root, "tooltip");
const tracksWebGPU = byId(root, "tracksWebGPU");
const flowWebGPU = byId(root, "flowWebGPU");

// Initialize WebGPU infrastructure
let webgpuCore = null;
let instancedRenderer = null;
let flowWebGPUCore = null;
let flowInstancedRenderer = null;
let flowRibbonRenderer = null;
let webgpuSupported = false;
let repeatHitTestData = []; // For tooltip hit testing

// Cache for ribbon transition data (keyed by variant pair IDs)
// This avoids recalculating transitions on every pan/zoom
const ribbonTransitionCache = new Map();
const MAX_CACHE_SIZE = 1000; // Limit cache size to prevent unbounded growth
let cachedVisibleVariantIds = null; // Track which variants were used for cache
let cachedViewportRange = null; // Track the viewport range used for cache (with padding)

// Expanded variant window with padding to reduce cache invalidation during pan/zoom
// Returns variants within viewport + padding (e.g., 30% on each side)
function expandedVariantWindow(paddingFraction = 0.3) {
  const span = state.endBp - state.startBp;
  const padding = span * paddingFraction;
  const expandedStart = Math.max(0, state.startBp - padding);
  const expandedEnd = state.endBp + padding;
  return variants.filter(v => v.pos >= expandedStart && v.pos <= expandedEnd);
}

async function initWebGPU() {
  if (!navigator.gpu) {
    console.warn("WebGPU not supported, falling back to SVG rendering");
    if (tracksWebGPU) tracksWebGPU.style.display = 'none';
    return false;
  }

  // Wait for canvas to have dimensions
  if (!tracksWebGPU) {
    return false;
  }
  
  const checkDimensions = () => {
    const rect = tracksWebGPU.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  
  // Wait up to 2 seconds for dimensions
  for (let i = 0; i < 40; i++) {
    if (checkDimensions()) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  if (!checkDimensions()) {
    if (tracksWebGPU) tracksWebGPU.style.display = 'none';
    return false;
  }

  try {
    webgpuCore = new WebGPUCore();
    await webgpuCore.init(tracksWebGPU);
    instancedRenderer = new InstancedRenderer(webgpuCore);

    // Flow WebGPU (separate canvas)
    if (flowWebGPU) {
      flowWebGPUCore = new WebGPUCore();
      await flowWebGPUCore.init(flowWebGPU);
      flowInstancedRenderer = new InstancedRenderer(flowWebGPUCore);
      flowRibbonRenderer = new BezierRibbonRenderer(flowWebGPUCore, { segments: 44 });
    }

    webgpuSupported = true;
    return true;
  } catch (error) {
    console.warn("Failed to initialize WebGPU:", error);
    if (tracksWebGPU) tracksWebGPU.style.display = 'none';
    return false;
  }
}

// Initialize WebGPU after a short delay to ensure DOM is ready
setTimeout(() => {
  initWebGPU().catch(err => {
    console.error("WebGPU initialization error:", err);
  });
}, 100);

// Initialize orientation state after DOM elements are available
updateOrientationState();

function rectW(el) { 
  if (!el) return 0;
  const w = el.getBoundingClientRect().width;
  return isNaN(w) || w <= 0 ? 0 : w;
}
function rectH(el) { 
  if (!el) return 0;
  const h = el.getBoundingClientRect().height;
  return isNaN(h) || h <= 0 ? 0 : h;
}

function tracksWidthPx() { 
  if (tracksContainer) {
    const w = tracksContainer.getBoundingClientRect().width;
    if (!isNaN(w) && w > 0) {
      return w;
    }
  }
  if (!tracksSvg) return 0;
  const w = tracksSvg.getBoundingClientRect().width;
  return isNaN(w) || w <= 0 ? 0 : w;
}
function flowWidthPx()   { return rectW(flow); }
function flowHeightPx()  { return rectH(flow); }

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function updateDerived() {
  const span = state.endBp - state.startBp;
  if (span <= 0 || isNaN(span)) {
    // Invalid span, keep previous pxPerBp or use default
    if (!state.pxPerBp || state.pxPerBp <= 0 || isNaN(state.pxPerBp)) {
      state.pxPerBp = 1;
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
    const w = tracksWidthPx();
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
}

// Calculate total insertion gap width for expanded insertions (in pixels)
// Uses precomputed insertionGapPx from backend if available for performance
function getTotalInsertionGapWidth() {
  let totalGap = 0;
  for (const variant of variants) {
    if (state.expandedInsertions.has(variant.id) && isInsertion(variant)) {
      // Use precomputed gap width if available (performance optimization)
      if (variant.hasOwnProperty('insertionGapPx')) {
        totalGap += variant.insertionGapPx;
      } else {
        // Fallback to computation for backward compatibility
        const maxInsertLen = getMaxInsertionLength(variant);
        totalGap += maxInsertLen * 8;
      }
    }
  }
  return totalGap;
}

// IMPORTANT: canonical genome-x mapping for the right pane (tracks/canvases)
// Accounts for expanded insertion gaps
function xGenomeCanonical(bp, W) {
  // Guard against invalid inputs
  if (!W || W <= 0 || isNaN(W) || isNaN(bp)) {
    return 16; // Return leftPad as safe default
  }
  const leftPad = 16, rightPad = 16;
  const innerW = Math.max(0, W - leftPad - rightPad);
  if (innerW <= 0) {
    return leftPad;
  }
  const span = state.endBp - state.startBp;
  if (span <= 0 || isNaN(span)) {
    return leftPad;
  }
  // Guard against invalid pxPerBp
  if (!state.pxPerBp || state.pxPerBp <= 0 || isNaN(state.pxPerBp)) {
    return leftPad;
  }
  const totalGapPx = getTotalInsertionGapWidth();
  const totalGapBp = totalGapPx / state.pxPerBp;
  if (isNaN(totalGapBp)) {
    return leftPad;
  }
  const effectiveSpan = span + totalGapBp;
  if (effectiveSpan <= 0 || isNaN(effectiveSpan)) {
    return leftPad;
  }
  
  // Calculate x position, accounting for insertion gaps before this position
  // Uses optimized binary search lookup if available for O(log n) performance
  const accumulatedGapPx = getAccumulatedGapPx(bp, state.expandedInsertions);
  
  const bpOffset = bp - state.startBp;
  const accumulatedGapBp = accumulatedGapPx / state.pxPerBp;
  if (isNaN(accumulatedGapBp) || isNaN(bpOffset)) {
    return leftPad;
  }
  const normalizedPos = (bpOffset + accumulatedGapBp) / effectiveSpan;
  if (isNaN(normalizedPos)) {
    return leftPad;
  }
  
  const result = leftPad + normalizedPos * innerW;
  return isNaN(result) ? leftPad : Math.max(leftPad, Math.min(leftPad + innerW, result));
}

function xGenome(bp) {
  return xGenomeCanonical(bp, tracksWidthPx());
}

function bpFromXGenome(xPx, W) {
  const leftPad = 16, rightPad = 16;
  const innerW = W - leftPad - rightPad;
  const span = state.endBp - state.startBp;
  const totalGapPx = getTotalInsertionGapWidth();
  const totalGapBp = totalGapPx / state.pxPerBp;
  const effectiveSpan = span + totalGapBp;
  const t = (xPx - leftPad) / innerW;
  
  // Reverse calculation accounting for gaps - iterative refinement
  // Uses optimized binary search lookup for O(log n) performance per iteration
  let bpEstimate = state.startBp + t * effectiveSpan;
  for (let iter = 0; iter < 5; iter++) {
    const accumulatedGapPx = getAccumulatedGapPx(bpEstimate, state.expandedInsertions);
    const accumulatedGapBp = accumulatedGapPx / state.pxPerBp;
    bpEstimate = state.startBp + (t * effectiveSpan) - accumulatedGapBp;
  }
  
  return bpEstimate;
}

// Vertical mode coordinate mapping (genomic axis vertical: bottom=start, top=end)
function yGenomeCanonical(bp, H) {
  // Guard against invalid inputs
  if (!H || H <= 0 || isNaN(H) || isNaN(bp)) {
    return 16; // Return topPad as safe default
  }
  const topPad = 16, bottomPad = 16;
  const innerH = Math.max(0, H - topPad - bottomPad);
  if (innerH <= 0) {
    return topPad;
  }
  const span = state.endBp - state.startBp;
  if (span <= 0 || isNaN(span)) {
    return topPad;
  }
  // Guard against invalid pxPerBp
  if (!state.pxPerBp || state.pxPerBp <= 0 || isNaN(state.pxPerBp)) {
    return topPad;
  }
  const totalGapPx = getTotalInsertionGapWidth();
  const totalGapBp = totalGapPx / state.pxPerBp;
  if (isNaN(totalGapBp)) {
    return topPad;
  }
  const effectiveSpan = span + totalGapBp;
  if (effectiveSpan <= 0 || isNaN(effectiveSpan)) {
    return topPad;
  }
  
  // Calculate y position, accounting for insertion gaps before this position
  // Uses optimized binary search lookup if available for O(log n) performance
  const accumulatedGapPx = getAccumulatedGapPx(bp, state.expandedInsertions);
  
  const bpOffset = bp - state.startBp;
  const accumulatedGapBp = accumulatedGapPx / state.pxPerBp;
  if (isNaN(accumulatedGapBp) || isNaN(bpOffset)) {
    return topPad;
  }
  const normalizedPos = (bpOffset + accumulatedGapBp) / effectiveSpan;
  if (isNaN(normalizedPos)) {
    return topPad;
  }
  
  // Invert: bottom (H - bottomPad) = start, top (topPad) = end
  const result = H - bottomPad - normalizedPos * innerH;
  return isNaN(result) ? topPad : Math.max(topPad, Math.min(H - bottomPad, result));
}

function yGenome(bp) {
  return yGenomeCanonical(bp, tracksHeightPx());
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

function bpFromYGenome(yPx, H) {
  const topPad = 16, bottomPad = 16;
  const innerH = H - topPad - bottomPad;
  const span = state.endBp - state.startBp;
  const totalGapPx = getTotalInsertionGapWidth();
  const totalGapBp = totalGapPx / state.pxPerBp;
  const effectiveSpan = span + totalGapBp;
  
  // Invert: yPx is from top, but we want position from bottom
  const normalizedPos = (H - bottomPad - yPx) / innerH;
  const t = Math.max(0, Math.min(1, normalizedPos));
  
  // Reverse calculation accounting for gaps - iterative refinement
  // Uses optimized binary search lookup for O(log n) performance per iteration
  let bpEstimate = state.startBp + t * effectiveSpan;
  for (let iter = 0; iter < 5; iter++) {
    const accumulatedGapPx = getAccumulatedGapPx(bpEstimate, state.expandedInsertions);
    const accumulatedGapBp = accumulatedGapPx / state.pxPerBp;
    bpEstimate = state.startBp + (t * effectiveSpan) - accumulatedGapBp;
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
