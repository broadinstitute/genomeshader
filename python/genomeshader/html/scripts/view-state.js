// Variant data: load from config or use demo data
// -----------------------------
let variants = [];
let loadedVariantTracks = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_tracks) || [];

// Fallback for environments where comms are unavailable.
if (
  window.GENOMESHADER_CONFIG &&
  window.GENOMESHADER_CONFIG.variant_payload_url &&
  (!loadedVariantTracks || loadedVariantTracks.length === 0 || !loadedVariantTracks[0].variants_data)
) {
  try {
    const resp = await fetch(window.GENOMESHADER_CONFIG.variant_payload_url, { cache: "no-store" });
    if (resp.ok) {
      const payload = await resp.json();
      if (payload && Array.isArray(payload.variant_tracks)) {
        loadedVariantTracks = payload.variant_tracks;
        window.GENOMESHADER_CONFIG.variant_tracks = payload.variant_tracks;
      }
      if (payload && Array.isArray(payload.insertion_variants_lookup)) {
        window.GENOMESHADER_CONFIG.insertion_variants_lookup = payload.insertion_variants_lookup;
      }
      console.log(`Loaded variant payload from URL: ${window.GENOMESHADER_CONFIG.variant_payload_url}`);
    } else {
      console.warn(`Failed to fetch variant payload URL (${resp.status}):`, window.GENOMESHADER_CONFIG.variant_payload_url);
    }
  } catch (err) {
    console.warn("Failed to fetch variant payload URL:", err);
  }
}
// Prefer variant_tracks (one entry per variant dataset); fall back to legacy variants_data
if (loadedVariantTracks && loadedVariantTracks.length > 0) {
  // Use first track's data for global `variants` (used by code that expects a single list)
  variants = loadedVariantTracks[0].variants_data || [];
  console.log(`Loaded ${loadedVariantTracks.length} variant track(s) from config`);
} else if (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variants_data) {
  const data = window.GENOMESHADER_CONFIG.variants_data;
  if (Array.isArray(data) && data.length > 0) {
    variants = data;
    console.log(`Loaded ${variants.length} variants from config (legacy)`);
  } else {
    console.warn("Variants data is not in expected array format or is empty:", data);
    variants = [];
  }
} else {
  // Fall back to demo data if no config provided
  console.log("No variants_data / variant_tracks found in GENOMESHADER_CONFIG, using demo data");
  variants = [
    { id: "v1", pos: 100_120, alleles: ["ref","a1"], refAllele: "A", altAlleles: ["A" + "ATCGATCGATCGATCGATCGATCGATCGAT"] }, // insertion example (30 bp inserted: ATCGATCGATCGATCGATCGATCGATCGAT)
    { id: "v2", pos: 100_240, alleles: ["ref","a1"] },
    { id: "v3", pos: 100_410, alleles: ["ref","a1","a2"] },
    { id: "v4", pos: 100_610, alleles: ["ref","a1"] },
    { id: "v5", pos: 100_720, alleles: ["ref","a1"] },
    { id: "v6", pos: 100_780, alleles: ["ref","a1"] },
    { id: "v7", pos: 100_860, alleles: ["ref","a1"] },
    { id: "v8", pos: 100_895, alleles: ["ref","a1"] },
    { id: "v9", pos: 100_930, alleles: ["ref","a1"] },
  ];
}

// Helper to check if variant is an insertion
// Uses precomputed value from backend if available, otherwise computes it
function isInsertion(variant) {
  // Use precomputed value if available (performance optimization)
  if (variant.hasOwnProperty('isInsertion')) {
    return variant.isInsertion === true;
  }
  // Fallback to computation for backward compatibility
  if (!variant.refAllele || !variant.altAlleles) return false;
  const refLen = variant.refAllele.length;
  return variant.altAlleles.some(alt => alt.length > refLen);
}

function isDeletion(variant) {
  if (variant.hasOwnProperty('isDeletion')) {
    return variant.isDeletion === true;
  }
  if (!variant.refAllele || !variant.altAlleles) return false;
  const refLen = variant.refAllele.length;
  return variant.altAlleles.some(alt => alt.length < refLen);
}

// An indel = insertion or deletion (anything that changes length vs the ref).
function isIndel(variant) {
  return isInsertion(variant) || isDeletion(variant);
}

// Carrier-count phrase for allele labels/tooltips. The count is over the samples
// present in the variant data (the loaded/selected cohort), NOT the read tracks
// you've opened. A zero means none of those samples carry this allele — say so
// plainly instead of a bare "0 samples", which reads as a failed count.
function formatAlleleSampleCount(n) {
  n = Number(n) || 0;
  if (n === 0) return "no loaded samples carry this allele";
  return n + " sample" + (n === 1 ? "" : "s");
}
if (typeof window !== "undefined") window.__gsFormatAlleleSampleCount = formatAlleleSampleCount;

/**
 * Per-group sample-frequency rows for the Variants tab (and tests).
 *
 * Uses carrier/sample-count semantics already on the variant payload
 * (`alleleSampleCountsByGroup`), with group size N from the metadata column
 * spec. Returns [] when grouping isn't active or counts are missing.
 *
 * Each row: { group, color, n, N, freq, active }
 */
function buildGroupFrequencyRows(opts) {
  const col = (opts && (opts.colorFacetKey || opts.groupingVariable)) || null;
  const filter = opts && (opts.groupingFilter != null ? opts.groupingFilter : opts.colorFacetLevel);
  const alleleKeys = (opts && Array.isArray(opts.alleleKeys)) ? opts.alleleKeys : [];
  const byCol = opts && opts.alleleSampleCountsByGroup;
  const spec = opts && opts.columnSpec;
  if (!col || !byCol || !byCol[col] || !alleleKeys.length) return [];
  const byGroup = byCol[col];
  const order = (spec && Array.isArray(spec.values) && spec.values.length)
    ? spec.values.map((v) => ({
        group: String(v.value),
        color: v.color || null,
        N: Number(v.count) || 0,
      }))
    : Object.keys(byGroup).sort().map((g) => ({
        group: String(g),
        color: null,
        N: 0,
      }));

  // Prefer live metadata (+ active facet AND) for denominators so N matches the
  // filtered cohort after sample_filter refetch.
  let pool = null;
  if (typeof compositeSampleIds === "function") {
    pool = compositeSampleIds();
  }
  if (pool == null && typeof getSampleMetadataConfig === "function") {
    const meta = getSampleMetadataConfig();
    if (meta && meta.by_id) pool = Object.keys(meta.by_id);
  }

  const rows = [];
  for (const entry of order) {
    const bucket = byGroup[entry.group] || {};
    let n = 0;
    for (const key of alleleKeys) {
      n += Number(bucket[key] || 0);
    }
    let N = entry.N > 0 ? entry.N : Math.max(n, 0);
    if (pool && typeof getSampleGroupValue === "function") {
      let counted = 0;
      for (const sid of pool) {
        if (String(getSampleGroupValue(sid, col) || "(unlabeled)") === entry.group) counted++;
      }
      if (counted > 0 || pool.length > 0) N = counted;
    }
    const freq = N > 0 ? n / N : 0;
    rows.push({
      group: entry.group,
      color: entry.color,
      n,
      N,
      freq,
      active: filter != null && String(filter) === entry.group,
    });
  }
  return rows;
}
if (typeof window !== "undefined") window.__gsBuildGroupFrequencyRows = buildGroupFrequencyRows;

// Next Indel-marker expansion state on click. A position that is BOTH an
// insertion and a deletion cycles off -> ins -> del -> off so either can be
// inspected; pure insertions/deletions just toggle. Returns the target
// membership for the (expandedInsertions, expandedDeletions) sets.
function nextIndelExpansion(isIns, isDel, curIns, curDel) {
  if (isIns && isDel) {
    if (curIns) return { ins: false, del: true };   // ins -> del
    if (curDel) return { ins: false, del: false };  // del -> off
    return { ins: true, del: false };               // off -> ins
  }
  if (isIns) return { ins: !curIns, del: false };
  return { ins: false, del: !curDel };
}
if (typeof window !== "undefined") window.__gsNextIndelExpansion = nextIndelExpansion;

// Samples to actually load: unique, skipping any already loaded, capped at the
// requested count. One track per sample; never load a duplicate.
function gsSelectSamplesToLoad(selected, loadedSampleIds, numSamples) {
  const loaded = new Set(loadedSampleIds || []);
  const seen = new Set();
  const out = [];
  const cap = Math.max(0, Number(numSamples) || 0);
  for (const s of (selected || [])) {
    if (s == null || seen.has(s) || loaded.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

// Sample-count slider state from the selectable pool size: greyed (and pinned to
// 1) when there's at most one selectable sample, enabled at 2+.
function gsSampleSliderState(pool) {
  pool = Number(pool) || 0;
  return { disabled: pool <= 1, pinToOne: pool === 1 };
}

if (typeof window !== "undefined") {
  window.__gsSelectSamplesToLoad = gsSelectSamplesToLoad;
  window.__gsSampleSliderState = gsSampleSliderState;
}

// Height (px) of one repeated reference row drawn per expanded deletion.
const DELETION_ROW_H = 20;

// Expanded deletions overlapping the current view, sorted by start. Each entry
// carries the deleted ref span [loBp, hiBp] (1-based genomic, inclusive) so the
// reference track can repeat itself once per deletion (the vertical analogue of
// stacking multiple insertion rows in the variants track).
function getExpandedDeletionsInView() {
  const out = [];
  if (!state.expandedDeletions || !state.expandedDeletions.size) return out;
  if (typeof isDeletion !== "function") return out;
  const vcfg = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_tracks) || [];
  const vars = vcfg.length ? vcfg.flatMap(t => t.variants_data || [])
    : ((typeof variants !== "undefined" && Array.isArray(variants)) ? variants : []);
  const seen = new Set();
  for (const v of vars) {
    if (!v || v.pos == null || !isDeletion(v)) continue;
    if (!state.expandedDeletions.has(String(v.id))) continue;
    const key = String(v.id); if (seen.has(key)) continue; seen.add(key);
    const delLen = (typeof getMaxDeletionLength === "function") ? getMaxDeletionLength(v) : 0;
    if (!(delLen > 0)) continue;
    // Deleted ref bases are the ones after the anchor: [pos+1, pos+delLen].
    const loBp = Number(v.pos) + 1, hiBp = Number(v.pos) + delLen;
    if (hiBp < state.startBp || loBp > state.endBp) continue;  // off-view
    out.push({ v: v, delLen: delLen, loBp: loBp, hiBp: hiBp });
  }
  out.sort((a, b) => (a.loBp - b.loBp) || (a.hiBp - b.hiBp));
  return out;
}

// Longest deletion span (ref bases removed) for a variant.
function getMaxDeletionLength(variant) {
  if (variant.hasOwnProperty('maxDeletionLength')) {
    return variant.maxDeletionLength || 0;
  }
  if (!variant.refAllele || !variant.altAlleles) return 0;
  const refLen = variant.refAllele.length;
  return Math.max(0, ...variant.altAlleles.map(alt => Math.max(0, refLen - alt.length)));
}

// Get the longest insertion allele length for a variant
// Uses precomputed value from backend if available, otherwise computes it
function getMaxInsertionLength(variant) {
  // Use precomputed value if available (performance optimization)
  if (variant.hasOwnProperty('maxInsertionLength')) {
    return variant.maxInsertionLength || 0;
  }
  // Fallback to computation for backward compatibility
  if (!variant.refAllele || !variant.altAlleles) return 0;
  const refLen = variant.refAllele.length;
  return Math.max(...variant.altAlleles.map(alt => Math.max(0, alt.length - refLen)));
}

// Precomputed sorted list of insertion variants for efficient coordinate transformations
// Loaded from config if available
let insertionVariantsLookup = [];
if (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.insertion_variants_lookup) {
  insertionVariantsLookup = window.GENOMESHADER_CONFIG.insertion_variants_lookup;
  console.log(`Loaded ${insertionVariantsLookup.length} insertion variants for coordinate transformation lookup`);
}
const INSERTION_GAP_SAFETY_PX = 0.0; // Keep opened-gap geometry exact; locus painting uses identical bounds
const BASE_TILE_INSET_PX = 0.0; // Shared base tile inset for both Reference and alternate-allele painting
const INSERTION_GAP_EXPANSION_FACTOR = 1.10; // Open the reference/canonical gap slightly wider than painted allele

let insertionMaxLenById = null;
function getInsertionMaxLenById() {
  if (insertionMaxLenById) return insertionMaxLenById;
  insertionMaxLenById = new Map();
  const tracks = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_tracks) || [];
  for (const track of tracks) {
    const vdata = track.variants_data || [];
    for (const v of vdata) {
      const key = String(v.id);
      const maxLen = Number(v.maxInsertionLength);
      if (Number.isFinite(maxLen) && maxLen > 0) {
        const prev = insertionMaxLenById.get(key) || 0;
        if (maxLen > prev) insertionMaxLenById.set(key, maxLen);
      }
    }
  }
  for (const v of variants) {
    const key = String(v.id);
    const maxLen = Number(v.maxInsertionLength);
    if (Number.isFinite(maxLen) && maxLen > 0) {
      const prev = insertionMaxLenById.get(key) || 0;
      if (maxLen > prev) insertionMaxLenById.set(key, maxLen);
    }
  }
  return insertionMaxLenById;
}

function getInsertionPaintBpForVariant(variant) {
  if (!variant) return 0;
  const directLen = Number(variant.maxInsertionLength);
  const idMaxLen = getInsertionMaxLenById().get(String(variant.id));
  const maxLen = Math.max(
    Number.isFinite(directLen) ? directLen : 0,
    Number.isFinite(idMaxLen) ? idMaxLen : 0
  );
  if (maxLen > 0) return maxLen;
  if (variant.refAllele && Array.isArray(variant.altAlleles) && variant.altAlleles.length > 0) {
    const refLen = variant.refAllele.length;
    let best = 0;
    for (const alt of variant.altAlleles) {
      const altLen = (alt || "").length;
      if (altLen > refLen) best = Math.max(best, altLen - refLen);
    }
    if (best > 0) return best;
  }
  return 0;
}

function getInsertionPaintBpForLookupEntry(entry) {
  if (!entry) return 0;
  const entryMaxLen = Number(entry.maxInsertionLength);
  const idMaxLen = getInsertionMaxLenById().get(String(entry.id));
  const maxLen = Math.max(
    Number.isFinite(entryMaxLen) ? entryMaxLen : 0,
    Number.isFinite(idMaxLen) ? idMaxLen : 0
  );
  if (maxLen > 0) return maxLen;
  const precomputedGap = Number(entry.insertionGapPx);
  const pxPerBp = (state && Number.isFinite(state.pxPerBp) && state.pxPerBp > 0) ? state.pxPerBp : 1;
  return (Number.isFinite(precomputedGap) && precomputedGap > 0) ? (precomputedGap / pxPerBp) : 0;
}

function getInsertionGapBpForVariant(variant) {
  return getInsertionPaintBpForVariant(variant) * INSERTION_GAP_EXPANSION_FACTOR;
}

function getInsertionGapBpForLookupEntry(entry) {
  return getInsertionPaintBpForLookupEntry(entry) * INSERTION_GAP_EXPANSION_FACTOR;
}

function isInsertionPosWithinCurrentView(pos, tile) {
  const posNum = Number(pos);
  if (!Number.isFinite(posNum) || !state) return false;
  const t = (typeof gsActiveTile === "function") ? gsActiveTile(tile) : state;
  return posNum >= t.startBp && posNum <= t.endBp;
}

function getTotalExpandedInsertionGapBp(expandedInsertions, tile) {
  const t = (typeof gsActiveTile === "function") ? gsActiveTile(tile) : state;
  const expanded = expandedInsertions || (t && t.expandedInsertions) || (state && state.expandedInsertions);
  if (!expanded) return 0;
  // No expanded insertion (the usual case): nothing to sum. This runs once per
  // painted coordinate, so scanning the insertion list here dominated repaints.
  if (expanded.size === 0) return 0;

  if (insertionVariantsLookup && insertionVariantsLookup.length > 0) {
    let totalBp = 0;
    const countedIds = new Set();
    for (const entry of insertionVariantsLookup) {
      const id = String(entry.id);
      if (countedIds.has(id)) continue;
      if (!expanded.has(id)) continue;
      if (!isInsertionPosWithinCurrentView(entry.pos, t)) continue;
      countedIds.add(id);
      totalBp += getInsertionGapBpForLookupEntry(entry);
    }
    return totalBp;
  }

  let totalBp = 0;
  const countedIds = new Set();
  for (const variant of variants) {
    const id = String(variant.id);
    if (countedIds.has(id)) continue;
    if (expanded.has(id) && isInsertion(variant) && isInsertionPosWithinCurrentView(variant.pos, t)) {
      countedIds.add(id);
      totalBp += getInsertionGapBpForVariant(variant);
    }
  }
  return totalBp;
}

function getDisplayPxPerBp(tile) {
  const t = (typeof gsActiveTile === "function") ? gsActiveTile(tile) : state;
  const pxPerBp = (t && Number.isFinite(t.pxPerBp) && t.pxPerBp > 0) ? t.pxPerBp : 1;
  const span = (t && Number.isFinite(t.endBp - t.startBp)) ? (t.endBp - t.startBp) : 0;
  if (!(span > 0)) return pxPerBp;
  const expanded = (t && t.expandedInsertions instanceof Set) ? t.expandedInsertions : (state && state.expandedInsertions);
  const totalGapBp = getTotalExpandedInsertionGapBp(expanded, t);
  const effectiveSpan = span + totalGapBp;
  if (!(effectiveSpan > 0)) return pxPerBp;
  return pxPerBp * (span / effectiveSpan);
}

function getInsertionGapPxForVariant(variant) {
  return (getInsertionGapBpForVariant(variant) * getDisplayPxPerBp()) + INSERTION_GAP_SAFETY_PX;
}

function getInsertionGapPxForLookupEntry(entry) {
  return (getInsertionGapBpForLookupEntry(entry) * getDisplayPxPerBp()) + INSERTION_GAP_SAFETY_PX;
}

function getInsertionPaintPxForVariant(variant) {
  return getInsertionPaintBpForVariant(variant) * getDisplayPxPerBp();
}

function getInsertionPaintPxForLookupEntry(entry) {
  return getInsertionPaintBpForLookupEntry(entry) * getDisplayPxPerBp();
}

function getGapAfterBpPx(bp, expandedInsertions) {
  if (!expandedInsertions || expandedInsertions.size === 0) return 0;
  const bpNum = Number(bp);
  if (!Number.isFinite(bpNum)) return 0;
  if (!isInsertionPosWithinCurrentView(bpNum)) return 0;

  if (insertionVariantsLookup && insertionVariantsLookup.length > 0) {
    let left = 0;
    let right = insertionVariantsLookup.length - 1;
    let firstIndex = -1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const midPos = Number(insertionVariantsLookup[mid].pos);
      if (midPos >= bpNum) {
        if (midPos === bpNum) firstIndex = mid;
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }
    if (firstIndex === -1) return 0;
    let gapPx = 0;
    const countedIds = new Set();
    for (let i = firstIndex; i < insertionVariantsLookup.length; i++) {
      const entry = insertionVariantsLookup[i];
      if (Number(entry.pos) !== bpNum) break;
      const entryId = String(entry.id);
      if (countedIds.has(entryId)) continue;
      if (expandedInsertions.has(entryId)) {
        countedIds.add(entryId);
        gapPx += getInsertionGapPxForLookupEntry(entry);
      }
    }
    return gapPx;
  }

  let gapPx = 0;
  for (const variant of variants) {
    if (Number(variant.pos) !== bpNum) continue;
    if (expandedInsertions.has(String(variant.id)) && isInsertion(variant)) {
      gapPx += getInsertionGapPxForVariant(variant);
    }
  }
  return gapPx;
}

// Optimized function to get accumulated gap pixels up to a position
// Uses binary search on precomputed sorted list for O(log n) performance
// Filters by expanded insertions at runtime (since that's dynamic state)
function getAccumulatedGapPx(bp, expandedInsertions) {
  return getAccumulatedGapBp(bp, expandedInsertions) * getDisplayPxPerBp();
}

function getAccumulatedGapBp(bp, expandedInsertions, tile) {
  if (!expandedInsertions || expandedInsertions.size === 0) return 0;
  const t = (typeof gsActiveTile === "function") ? gsActiveTile(tile) : state;
  const viewStart = (t && Number.isFinite(t.startBp)) ? t.startBp : -Infinity;
  const bpNum = Number(bp);
  if (!Number.isFinite(bpNum)) return 0;

  if (!insertionVariantsLookup || insertionVariantsLookup.length === 0) {
    // Fallback to linear search if lookup table not available
    let accumulatedGapBp = 0;
    const countedIds = new Set();
    for (const variant of variants) {
      const id = String(variant.id);
      if (countedIds.has(id)) continue;
      const posNum = Number(variant.pos);
      if (!Number.isFinite(posNum)) continue;
      if (posNum < viewStart) continue;
      if (posNum < bpNum && expandedInsertions.has(id) && isInsertion(variant)) {
        countedIds.add(id);
        accumulatedGapBp += getInsertionGapBpForVariant(variant);
      }
    }
    return accumulatedGapBp;
  }

  // Binary search to find all insertion variants before position bp
  let left = 0;
  let right = insertionVariantsLookup.length - 1;
  let lastIndex = -1;
  
  // Find the rightmost insertion variant with pos < bp
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (insertionVariantsLookup[mid].pos < bpNum) {
      lastIndex = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  
  // Sum gaps for all variants up to lastIndex that are expanded
  let accumulatedGapBp = 0;
  const countedIds = new Set();
  for (let i = 0; i <= lastIndex; i++) {
    const lookupVariant = insertionVariantsLookup[i];
    const posNum = Number(lookupVariant.pos);
    if (!Number.isFinite(posNum)) continue;
    if (posNum < viewStart) continue;
    const lookupId = String(lookupVariant.id);
    if (countedIds.has(lookupId)) continue;
    if (expandedInsertions.has(lookupId)) {
      countedIds.add(lookupId);
      accumulatedGapBp += getInsertionGapBpForLookupEntry(lookupVariant);
    }
  }
  
  return accumulatedGapBp;
}

// Genes / repeats: Phase 2 shared envelope (genes_track / repeats_track).
function gsAnnotationFeatures(trackId) {
  const t = (state.annotationTracks || []).find(a => a && a.id === trackId);
  if (!t || !Array.isArray(t.series) || !t.series[0]) return [];
  return Array.isArray(t.series[0].features) ? t.series[0].features : [];
}

function gsSetAnnotationTrack(track) {
  if (!track || !track.id) return;
  if (!state.annotationTracks) state.annotationTracks = [];
  const i = state.annotationTracks.findIndex(a => a.id === track.id);
  if (i >= 0) state.annotationTracks[i] = track;
  else state.annotationTracks.push(track);
}

function gsApplyAnnotationTrackFromConfig(key, fallbackId, fallbackLabel, fallbackStyle) {
  const cfg = window.GENOMESHADER_CONFIG || {};
  const track = cfg[key];
  if (track && typeof track === "object" && track.id) {
    gsSetAnnotationTrack(track);
    return;
  }
  // Empty placeholder so consumers always find an entry
  gsSetAnnotationTrack({
    id: fallbackId,
    label: fallbackLabel,
    style: fallbackStyle,
    series: [{ name: fallbackId, features: [] }],
  });
}

gsApplyAnnotationTrackFromConfig("genes_track", "genes", "Genes", "gene");
gsApplyAnnotationTrackFromConfig("repeats_track", "repeats", "RepeatMasker", "interval");
console.log(`Loaded ${gsAnnotationFeatures("genes").length} gene models for genes track`);
console.log(`Loaded ${gsAnnotationFeatures("repeats").length} repeats for RepeatMasker track`);

// Per-contig annotation snapshots so multi-tile pan/focus does not blank the
// other column when viewport fetch overwrites the global genes/repeats/reference.
const _gsAnnoByContig = {
  genes: new Map(),
  repeats: new Map(),
  reference: new Map(),
  // data_bounds is the genomic origin of the reference string, so it must travel
  // with it: one global value made whichever tile's viewport load landed last
  // mis-index every other contig's sequence (its reference bases vanished).
  bounds: new Map(),
};
// ---------------------------------------------------------------------------
// Reference sequence, as SEGMENTS per contig
// ---------------------------------------------------------------------------
// One string per contig (replaced by every viewport response) could only ever hold
// the most recent window: variants counted as "covered" for an earlier window, no
// reference was refetched, and its bases were gone — and two tiles on the SAME
// contig (the breakpoint case) could never both have bases. Instead every loaded
// window is kept as a segment {start, seq} (sequence[i] is genomic position
// start + i), overlapping/adjacent segments merge, and each tile looks up the
// segment covering ITS window.
const _gsRefSegs = new Map();          // contig -> [{start, seq, t}] sorted, disjoint
let _gsRefTick = 0;
const GS_REF_MAX_CHARS_PER_CONTIG = 4000000;

function gsAddReferenceSegment(contig, start, seq) {
  if (!contig || typeof seq !== "string" || !seq.length || !Number.isFinite(start)) return;
  let segs = _gsRefSegs.get(contig);
  if (!segs) { segs = []; _gsRefSegs.set(contig, segs); }
  let ns = start, nseq = seq;
  const keep = [];
  for (const g of segs) {
    const gEnd = g.start + g.seq.length, nEnd = ns + nseq.length;
    if (g.start <= nEnd && ns <= gEnd) {            // overlap or adjacent: union them
      const head = g.start < ns ? g.seq.slice(0, ns - g.start) : "";
      const tail = gEnd > nEnd ? g.seq.slice(nEnd - g.start) : "";
      ns = Math.min(g.start, ns);
      nseq = head + nseq + tail;
    } else keep.push(g);
  }
  keep.push({ start: ns, seq: nseq, t: ++_gsRefTick });
  keep.sort((a, b) => a.start - b.start);
  // Bound memory: drop the least recently added segments that no open tile shows.
  let total = keep.reduce((n, g) => n + g.seq.length, 0);
  if (total > GS_REF_MAX_CHARS_PER_CONTIG) {
    const shown = (g) => (typeof state !== "undefined" && state.tiles || []).some((t) =>
      t && t.contig === contig && t.endBp >= g.start && t.startBp <= g.start + g.seq.length);
    for (const g of keep.slice().sort((a, b) => a.t - b.t)) {
      if (total <= GS_REF_MAX_CHARS_PER_CONTIG) break;
      if (shown(g)) continue;
      keep.splice(keep.indexOf(g), 1);
      total -= g.seq.length;
    }
  }
  _gsRefSegs.set(contig, keep);
}

/** The segment of `contig` covering most of [viewStart, viewEnd], or null. */
function gsReferenceFor(contig, viewStart, viewEnd) {
  const segs = _gsRefSegs.get(contig);
  if (!segs) return null;
  let best = null, bestOv = 0;
  for (const g of segs) {
    const ov = Math.min(g.start + g.seq.length, viewEnd + 1) - Math.max(g.start, viewStart);
    if (ov > bestOv) { bestOv = ov; best = g; }
  }
  return best;
}

/** Is [viewStart, viewEnd] fully inside one loaded reference segment? */
function gsReferenceCovers(contig, viewStart, viewEnd) {
  const g = gsReferenceFor(contig, viewStart, viewEnd);
  return !!g && g.start <= viewStart && g.start + g.seq.length >= viewEnd + 1;
}

(function _gsSeedAnnoByContig() {
  try {
    const cfg = window.GENOMESHADER_CONFIG || {};
    const m = String(cfg.region || "").match(/^([^:]+):/);
    const contig = m ? m[1] : (typeof state !== "undefined" && state.contig);
    if (!contig) return;
    if (cfg.genes_track) _gsAnnoByContig.genes.set(contig, cfg.genes_track);
    if (cfg.repeats_track) _gsAnnoByContig.repeats.set(contig, cfg.repeats_track);
    if (typeof cfg.reference_data === "string") {
      _gsAnnoByContig.reference.set(contig, cfg.reference_data);
    }
    if (cfg.data_bounds && typeof cfg.data_bounds.start === "number") {
      _gsAnnoByContig.bounds.set(contig, cfg.data_bounds);
    }
    if (typeof cfg.reference_data === "string" && cfg.data_bounds && typeof cfg.data_bounds.start === "number") {
      gsAddReferenceSegment(contig, cfg.data_bounds.start, cfg.reference_data);
    }
  } catch (_) {}
})();

function gsStoreAnnotationsForContig(contig, payload) {
  if (!contig || !payload) return;
  const cfg = window.GENOMESHADER_CONFIG || {};
  if (payload.genes_track && typeof payload.genes_track === "object") {
    _gsAnnoByContig.genes.set(contig, payload.genes_track);
  }
  if (payload.repeats_track && typeof payload.repeats_track === "object") {
    _gsAnnoByContig.repeats.set(contig, payload.repeats_track);
  }
  if (typeof payload.reference_data === "string") {
    _gsAnnoByContig.reference.set(contig, payload.reference_data);
  }
  if (payload.data_bounds && typeof payload.data_bounds.start === "number") {
    _gsAnnoByContig.bounds.set(contig, payload.data_bounds);
    if (typeof payload.reference_data === "string") {
      gsAddReferenceSegment(contig, payload.data_bounds.start, payload.reference_data);
    }
  }
  // Also accept direct cfg fields when seeding.
  if (payload === cfg) {
    if (cfg.genes_track) _gsAnnoByContig.genes.set(contig, cfg.genes_track);
    if (cfg.repeats_track) _gsAnnoByContig.repeats.set(contig, cfg.repeats_track);
    if (typeof cfg.reference_data === "string") {
      _gsAnnoByContig.reference.set(contig, cfg.reference_data);
    }
    if (cfg.data_bounds && typeof cfg.data_bounds.start === "number") {
      _gsAnnoByContig.bounds.set(contig, cfg.data_bounds);
    }
  }
}

/** Swap global annotation cfg to the snapshot for this contig (multi-tile paint). */
function gsRestoreAnnotationsForContig(contig) {
  if (!contig) return;
  const cfg = window.GENOMESHADER_CONFIG || {};
  const genes = _gsAnnoByContig.genes.get(contig);
  if (genes) {
    cfg.genes_track = genes;
    gsSetAnnotationTrack(genes);
  }
  const repeats = _gsAnnoByContig.repeats.get(contig);
  if (repeats) {
    cfg.repeats_track = repeats;
    gsSetAnnotationTrack(repeats);
  }
  const ref = _gsAnnoByContig.reference.get(contig);
  if (typeof ref === "string") {
    cfg.reference_data = ref;
    if (typeof referenceSequence !== "undefined") referenceSequence = ref;
  }
  // The sequence's origin/extent: always restored WITH the sequence (see above).
  const bounds = _gsAnnoByContig.bounds.get(contig);
  if (bounds) {
    cfg.data_bounds = bounds;
    if (typeof dataBounds !== "undefined") dataBounds = bounds;
  }
}

if (typeof window !== "undefined") {
  window.gsStoreAnnotationsForContig = gsStoreAnnotationsForContig;
  window.gsRestoreAnnotationsForContig = gsRestoreAnnotationsForContig;
}

// Reference sequence: load from config or use empty string as fallback
let referenceSequence = "";
if (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.reference_data) {
  const data = window.GENOMESHADER_CONFIG.reference_data;
  // Data should be a string containing the DNA sequence
  if (typeof data === 'string') {
    referenceSequence = data;
    console.log(`Loaded reference sequence of length ${referenceSequence.length} bases`);
  } else {
    console.warn("Reference data is not in expected string format:", data);
  }
} else {
  console.warn("No reference_data found in GENOMESHADER_CONFIG:", window.GENOMESHADER_CONFIG);
}

// ---------------------------------------------------------------------------
// Scale / render algorithmic cores (pure, headless-tested). Render wiring that
// consumes these is browser-verified separately (see planning/TODO.md).
// ---------------------------------------------------------------------------

// Virtualized read-track row window: which read rows are visible for a given
// scroll offset, so a viewport-sized canvas can draw only those rows (lifts the
// full-stack canvas size that forced the 300-read cap).
function computeVirtualRowWindow(scrollTop, viewportH, rowH, totalRows, overscan) {
  scrollTop = Math.max(0, scrollTop || 0);
  overscan = Math.max(0, overscan || 0);
  if (!(rowH > 0) || !(totalRows > 0)) return { startRow: 0, endRow: -1 };
  const startRow = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const endRow = Math.min(totalRows - 1, Math.floor((scrollTop + viewportH) / rowH) + overscan);
  return { startRow, endRow };
}

// Overscan region: pad a viewport bp-range by `factor` so a pan reveals
// already-drawn content instead of blank edges (pairs with viewport variant
// loading). Clamps start to >= 1.
function overscanRegion(startBp, endBp, factor) {
  startBp = Math.round(startBp); endBp = Math.round(endBp);
  const span = Math.max(0, endBp - startBp);
  const pad = Math.round(span * Math.max(0, factor || 0));
  return { start: Math.max(1, startBp - pad), end: endBp + pad };
}

// Standard-genetic-code translation of a reference window in a chosen frame.
// Returns [{index, aa}] where index is the 0-based offset of the codon's first
// base in `seq`. Codon track MVP core (render is additive, browser-verified).
const _GS_CODON_TABLE = {
  TTT:"F",TTC:"F",TTA:"L",TTG:"L",CTT:"L",CTC:"L",CTA:"L",CTG:"L",
  ATT:"I",ATC:"I",ATA:"I",ATG:"M",GTT:"V",GTC:"V",GTA:"V",GTG:"V",
  TCT:"S",TCC:"S",TCA:"S",TCG:"S",CCT:"P",CCC:"P",CCA:"P",CCG:"P",
  ACT:"T",ACC:"T",ACA:"T",ACG:"T",GCT:"A",GCC:"A",GCA:"A",GCG:"A",
  TAT:"Y",TAC:"Y",TAA:"*",TAG:"*",CAT:"H",CAC:"H",CAA:"Q",CAG:"Q",
  AAT:"N",AAC:"N",AAA:"K",AAG:"K",GAT:"D",GAC:"D",GAA:"E",GAG:"E",
  TGT:"C",TGC:"C",TGA:"*",TGG:"W",CGT:"R",CGC:"R",CGA:"R",CGG:"R",
  AGT:"S",AGC:"S",AGA:"R",AGG:"R",GGT:"G",GGC:"G",GGA:"G",GGG:"G",
};
function translateFrame(seq, frame) {
  if (typeof seq !== "string" || !seq) return [];
  frame = ((frame || 0) % 3 + 3) % 3;
  const s = seq.toUpperCase();
  const out = [];
  for (let i = frame; i + 3 <= s.length; i += 3) {
    out.push({ index: i, aa: _GS_CODON_TABLE[s.slice(i, i + 3)] || "X" });
  }
  return out;
}

if (typeof window !== "undefined") {
  window.__gsComputeVirtualRowWindow = computeVirtualRowWindow;
  window.__gsOverscanRegion = overscanRegion;
  window.__gsTranslateFrame = translateFrame;
}

// Viewport variant loading (P2) store core: keep a sparse set of loaded windows,
// evict ones far from the current center, and test coverage to decide whether a
// fetch is needed. Pure; the pan/zoom trigger + comm fetch are browser-wired.
function _gsRegionKey(r) { return `${r.contig}:${r.start}-${r.end}`; }

function gsWindowStoreUpdate(regions, newRegion, centerBp, keepSpan, protectKeys, maxRegions) {
  regions = Array.isArray(regions) ? regions.slice() : [];
  const nk = _gsRegionKey(newRegion);
  regions = regions.filter((r) => _gsRegionKey(r) !== nk);
  regions.push(newRegion);
  const kept = [], evicted = [];
  const protect = protectKeys instanceof Set ? protectKeys : null;
  for (const r of regions) {
    const key = _gsRegionKey(r);
    const mid = (Number(r.start) + Number(r.end)) / 2;
    // Never evict windows that cover an open multi-tile column, and never evict
    // a different contig solely because genomic coords are far apart — that was
    // wiping tile A's variants when opening a linked tile on another chromosome.
    if (protect && protect.has(key)) {
      kept.push(r);
      continue;
    }
    if (key !== nk && r.contig !== newRegion.contig) {
      kept.push(r);
      continue;
    }
    if (key !== nk && Math.abs(mid - centerBp) > keepSpan) evicted.push(r);
    else kept.push(r);
  }
  // Count cap (same contig, unprotected): the distance rule alone no longer bounds
  // memory now that zooming in keeps wide windows. Drop the FARTHEST beyond the cap.
  if (Number.isFinite(maxRegions) && maxRegions > 0) {
    const evictable = kept.filter((r) => {
      const key = _gsRegionKey(r);
      return key !== nk && r.contig === newRegion.contig && !(protect && protect.has(key));
    });
    const room = maxRegions - (kept.length - evictable.length);
    if (evictable.length > room) {
      evictable.sort((a, b) =>
        Math.abs((a.start + a.end) / 2 - centerBp) - Math.abs((b.start + b.end) / 2 - centerBp));
      for (const r of evictable.slice(Math.max(0, room))) {
        evicted.push(r);
        kept.splice(kept.indexOf(r), 1);
      }
    }
  }
  return { regions: kept, evicted };
}

// Is [start,end] on `contig` fully covered by a single loaded region? (If not,
// the caller fetches the window ± overscan.)
function gsRegionCovered(regions, contig, start, end) {
  if (!Array.isArray(regions)) return false;
  return regions.some((r) => r.contig === contig
    && Number(r.start) <= start && Number(r.end) >= end);
}

if (typeof window !== "undefined") {
  window.__gsWindowStoreUpdate = gsWindowStoreUpdate;
  window.__gsRegionCovered = gsRegionCovered;
}

// ---------------------------------------------------------------------------
// Viewport-driven variant loading (#71) + overscan (#41). Enabled by
// GENOMESHADER_CONFIG.viewport_variant_loading. On each pan/zoom settle we fetch
// variants for the visible window padded by an overscan margin (so a pan into
// the margin already has data — no blank edges), keep a bounded set of recently
// viewed windows, and evict far ones. This lets the browser page through a
// cohort far larger than fits in memory: everything renders from per-variant
// aggregates for the current window, independent of sample count. Variants
// render from GENOMESHADER_CONFIG.variant_tracks; we rebuild that from the kept
// windows (union, deduped by variant id). Uses the pure store cores above
// (overscanRegion / gsRegionCovered / gsWindowStoreUpdate).
const GS_VP_MIN_WINDOW_BP = 4000;        // smallest window a viewport fetch requests
const GS_VP_OVERSCAN = 0.5;      // fetch viewport ± 50% on each side
const GS_VP_MAX_SPAN_BP = 1000000; // above this span, skip loading individual variants (zoom gate)
// Settle window: only load variants after the view has been still (no scroll /
// zoom / pan) for this long. Every scroll/zoom re-arms the timer, so any motion
// before it elapses cancels the pending load — nothing fetches mid-motion.
const GS_VP_SETTLE_MS = 1000;
let _gsVpRegions = [];           // [{contig,start,end}] currently-loaded windows
const _gsVpData = new Map();     // regionKey -> variant_tracks[] for that window
let _gsVpInFlight = null;        // request key currently being fetched (dedupe)
let _gsVpTimer = null;
let _gsVpStatusInFlight = 0;     // # overlapping loads showing the busy status bar
let _gsFailureModalOpen = false; // one blocking failure modal at a time (no stacking)

// Frontend debug event log -> server debug file (via the debug_log comm), so the
// loader's decisions (why a scroll did/didn't fetch, timings, sizes) are visible
// when the user runs with debug=True. No-op unless config.debug. Also mirrors to
// the browser console for live inspection. Fire-and-forget; never throws.
function __GS_DEBUG(event, fields) {
  const cfg = window.GENOMESHADER_CONFIG;
  if (!cfg || !cfg.debug) return;
  try { console.debug("[gs]", event, fields || {}); } catch (e) {}
  try {
    if (typeof sendCommMessage === "function") {
      sendCommMessage("debug_log", { event: event, fields: fields || {} }, 5000)
        .catch(function () {});
    }
  } catch (e) {}
}
if (typeof window !== "undefined") window.__GS_DEBUG = __GS_DEBUG;

// Capture uncaught JS errors + promise rejections into the debug log, so a
// forensic read of the log shows a crash + where it happened (not just silence).
if (typeof window !== "undefined") {
  window.addEventListener("error", function (e) {
    __GS_DEBUG("js_error", {
      message: String(e && e.message || e),
      source: e && e.filename, line: e && e.lineno, col: e && e.colno,
      stack: e && e.error && e.error.stack ? String(e.error.stack).split("\n").slice(0, 4).join(" | ") : null,
    });
  });
  window.addEventListener("unhandledrejection", function (e) {
    const r = e && e.reason;
    __GS_DEBUG("js_unhandled_rejection", {
      reason: String(r && r.message || r),
      stack: r && r.stack ? String(r.stack).split("\n").slice(0, 4).join(" | ") : null,
    });
  });
}

// Serious load failures (variant/region fetch rejected — kernel dropped or 30s
// comm timeout) must be surfaced with a centered, blocking modal the user has to
// acknowledge, not a status flash that scrolls away. Single-instance so rapid
// panning that times out several windows doesn't stack a wall of dialogs.
function gsSeriousFailureModal(message, title) {
  if (_gsFailureModalOpen || typeof window.__GS_MODAL !== "function") return;
  _gsFailureModalOpen = true;
  window.__GS_MODAL(message, {
    title: title || "Load failed",
    onClose: function () { _gsFailureModalOpen = false; },
  });
}

function _gsVpKeepSpan() {
  // Keep windows whose center is within ~3 viewport spans of the current center —
  // but never less than a fixed floor: zooming IN must not evict the wide windows
  // that zooming back OUT will want (reloading is the worst case, not the default).
  return Math.max(Math.max(1, state.endBp - state.startBp) * 3, GS_VP_KEEP_FLOOR_BP);
}
const GS_VP_KEEP_FLOOR_BP = 500000;
const GS_VP_MAX_REGIONS = 8;             // windows kept per contig (LRU by distance)

function _gsVpRebuildTracks() {
  // Union the kept windows' variant_tracks into config, deduped by variant id
  // (overscan-overlapping windows share edge variants).
  const byTrack = new Map();
  for (const r of _gsVpRegions) {
    for (const t of (_gsVpData.get(_gsRegionKey(r)) || [])) {
      const key = t.name || t.id || "default";
      if (!byTrack.has(key)) byTrack.set(key, { meta: t, vs: new Map() });
      const slot = byTrack.get(key).vs;
      for (const v of (t.variants_data || [])) slot.set(String(v.id), v);
    }
  }
  const merged = [];
  for (const { meta, vs } of byTrack.values()) {
    merged.push({ ...meta, variants_data: [...vs.values()] });
  }
  window.GENOMESHADER_CONFIG.variant_tracks = merged;

  // Keep the module-level globals the coordinate/gap functions read in sync with
  // the paged data. The flow track renders straight from variant_tracks, but the
  // reference/ruler/genes tracks compute insertion-expansion gaps via
  // getGapAfterBpPx / getTotalExpandedInsertionGapBp, which read `variants` and
  // `insertionVariantsLookup`. _gsVpRebuildTracks runs on the FIRST (startup)
  // viewport load too, so if we don't refresh these the gap functions keep
  // matching against the stale seed lookup -> a freshly-expanded insertion's id
  // isn't found -> gap 0 -> only the flow appears to expand while the reference
  // and other coordinate tracks stay put.
  variants = (merged[0] && merged[0].variants_data) || [];
  const _lookup = [];
  for (const t of merged) {
    for (const v of (t.variants_data || [])) {
      if (v && v.isInsertion && Number(v.insertionGapPx) > 0) {
        _lookup.push({
          id: String(v.id),
          pos: Number(v.pos),
          maxInsertionLength: Number(v.maxInsertionLength) || 0,
          insertionGapPx: Number(v.insertionGapPx) || 0,
        });
      }
    }
  }
  _lookup.sort((a, b) => a.pos - b.pos);
  insertionVariantsLookup = _lookup;
  window.GENOMESHADER_CONFIG.insertion_variants_lookup = _lookup;
  insertionMaxLenById = null;  // invalidate cache -> rebuilt from fresh data
}

async function gsLoadVariantsForViewport(force) {
  const cfg = window.GENOMESHADER_CONFIG;
  __GS_DEBUG("vp_load_enter", { force: !!force,
    start: Math.floor(state.startBp), end: Math.ceil(state.endBp), contig: state.contig });
  if (!cfg || !cfg.viewport_variant_loading) {
    __GS_DEBUG("vp_skip", { reason: "disabled" });
    return;
  }
  if (typeof gsIsConnected === "function" && !gsIsConnected()) {
    __GS_DEBUG("vp_skip", { reason: "disconnected" });
    return;
  }
  const contig = state.contig;
  const vs = Math.floor(state.startBp), ve = Math.ceil(state.endBp);
  if (!contig || !(ve > vs)) {
    __GS_DEBUG("vp_skip", { reason: "bad_window", contig: contig, vs: vs, ve: ve });
    return;
  }
  // Zoom gate: above a max span, individual variants are too many/dense to draw
  // usefully (and expensive to fetch) — skip and nudge to zoom in. A binned
  // density track for wide windows (P3 LOD) is the richer answer, deferred.
  const maxSpan = Number(cfg.variant_max_span_bp) || GS_VP_MAX_SPAN_BP;
  if ((ve - vs) > maxSpan) {
    __GS_DEBUG("vp_skip", { reason: "zoom_gate", span: ve - vs, maxSpan: maxSpan });
    if (window.__GS_STATUS) window.__GS_STATUS(
      `Zoom in to load variants (window ${(ve - vs).toLocaleString()} bp > ${maxSpan.toLocaleString()} bp limit)`,
      { autoHide: 2500 });
    return;
  }
  if (!force && gsRegionCovered(_gsVpRegions, contig, vs, ve)) {
    __GS_DEBUG("vp_skip", { reason: "covered", contig: contig, vs: vs, ve: ve });
    return; // coverage skip
  }
  const win = overscanRegion(vs, ve, GS_VP_OVERSCAN);
  // Never fetch a tiny window. At base-level zoom the view (+50%) is ~100 bp, so
  // moving a few hundred bp left it uncovered until a kernel round trip finished
  // (seconds when the kernel is busy loading reads) and the reference bases blanked.
  // The reference and nearby variants are cheap: load a few kb around the view.
  if (win.end - win.start < GS_VP_MIN_WINDOW_BP) {
    const mid = (win.start + win.end) / 2;
    win.start = Math.floor(mid - GS_VP_MIN_WINDOW_BP / 2);
    win.end = Math.ceil(mid + GS_VP_MIN_WINDOW_BP / 2);
  }
  // Clamp to the contig so a pan near an end doesn't request off-contig coords.
  const chrLen = Number((cfg.chrom_lengths || {})[contig])
    || (typeof chrLengths !== "undefined" ? Number(chrLengths[contig]) : 0) || 0;
  win.start = Math.max(1, win.start);
  if (chrLen > 0) win.end = Math.min(win.end, chrLen);
  if (!(win.end > win.start)) return;
  // Dedup only the identical in-flight window. A single hung fetch (comm never
  // resolves) must NOT block loads for OTHER windows — serializing on any
  // in-flight request bricks all future loading when one request sticks.
  // Rapid panning may briefly overlap fetches; the transient "variant load
  // failed" self-heals on the next settle and is preferable to a hard stall.
  const facetSig = (typeof compositeSampleIds === "function" && compositeSampleIds())
    ? ("|" + compositeSampleIds().slice().sort().join(","))
    : "";
  const reqKey = `${contig}:${win.start}-${win.end}${facetSig}`;
  if (_gsVpInFlight === reqKey) return;
  _gsVpInFlight = reqKey;
  // Progress feedback: a cold window is read-bound (htslib decompress+parse of
  // the in-range VCF lines) and can take seconds at cohort scale (#78 measured
  // ~13s remote), so tell the user what's happening. Indeterminate — the server
  // doesn't stream progress. Counter so overlapping loads don't hide the bar
  // early (mirrors smart-tracks read-load status).
  _gsVpStatusInFlight++;
  if (window.__GS_STATUS) {
    window.__GS_STATUS(
      `Loading variants for ${contig}:${win.start.toLocaleString()}–${win.end.toLocaleString()}…`,
      { busy: true });
  }
  const _t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
  __GS_DEBUG("vp_fetch_start", { reqKey: reqKey });
  // Safety: if the Jupyter comm never resolves, clear the busy bar + in-flight
  // lock so later pans are not stuck forever on "Loading variants…".
  let _vpStatusOwned = true;
  let _vpSafetyTimer = setTimeout(() => {
    if (_gsVpInFlight !== reqKey) return;
    console.warn("viewport variant load timed out client-side:", reqKey);
    _gsVpInFlight = null;
    if (_vpStatusOwned) {
      _vpStatusOwned = false;
      _gsVpStatusInFlight = Math.max(0, _gsVpStatusInFlight - 1);
    }
    if (_gsVpStatusInFlight === 0 && window.__GS_STATUS) {
      window.__GS_STATUS("Variant load timed out — pan or retry", { autoHide: 4000 });
    }
  }, 120000);
  try {
    const fetchArgs = { contig, start: win.start, end: win.end };
    if (typeof compositeSampleIds === "function") {
      const sids = compositeSampleIds();
      if (sids != null) fetchArgs.sample_ids = sids;
    }
    const resp = await sendCommMessage("fetch_variants",
      fetchArgs, 300000);  // first cold remote open (downloads the index) can be minutes; the Rust reader cache makes every later window fast
    // A server-side failure comes back as a resolved *_error response (not a
    // rejection), so it would otherwise fall through silently — no variants, no
    // message ("scrolled and nothing happened"). Surface it like a rejection.
    if (resp && (resp.error || (resp.type && String(resp.type).endsWith("_error")))) {
      throw new Error(resp.error || "variant fetch failed", { cause: resp.hint });
    }
    if (resp && Array.isArray(resp.variant_tracks)) {
      const _nv = resp.variant_tracks.reduce(
        (a, t) => a + (t.variants_data ? t.variants_data.length : 0), 0);
      __GS_DEBUG("vp_fetch_ok", { reqKey: reqKey, n_variants: _nv,
        aggregate: !!resp.aggregate, cached: !!resp.cached,
        ms: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - _t0) });
      const region = { contig, start: win.start, end: win.end };
      _gsVpData.set(_gsRegionKey(region), resp.variant_tracks);
      // Protect any stored window that covers an open tile's locus.
      const protectKeys = new Set();
      try {
        for (const tile of (state.tiles || [])) {
          if (!tile || tile.blank) continue;
          for (const r of _gsVpRegions) {
            if (r.contig === tile.contig
                && Number(r.start) <= tile.startBp
                && Number(r.end) >= tile.endBp) {
              protectKeys.add(_gsRegionKey(r));
            }
          }
        }
      } catch (_) {}
      const upd = gsWindowStoreUpdate(
        _gsVpRegions, region, (vs + ve) / 2, _gsVpKeepSpan(), protectKeys, GS_VP_MAX_REGIONS);
      _gsVpRegions = upd.regions;
      for (const ev of upd.evicted) _gsVpData.delete(_gsRegionKey(ev));
      if (Array.isArray(resp.insertion_variants_lookup)) {
        cfg.insertion_variants_lookup = resp.insertion_variants_lookup;
      }
      // Keep reference / genes / ideogram / data_bounds in sync with the paged
      // window (they ride along with the variant payload now) so the reference
      // track updates as you pan and the out-of-data overlay tracks the loaded
      // region instead of the startup one.
      if (typeof resp.reference_data === "string") {
        cfg.reference_data = resp.reference_data; referenceSequence = resp.reference_data;
      }
      if (resp.genes_track && typeof resp.genes_track === "object") {
        cfg.genes_track = resp.genes_track;
        gsSetAnnotationTrack(resp.genes_track);
      }
      if (resp.repeats_track && typeof resp.repeats_track === "object") {
        cfg.repeats_track = resp.repeats_track;
        gsSetAnnotationTrack(resp.repeats_track);
      }
      if (typeof gsStoreAnnotationsForContig === "function") {
        gsStoreAnnotationsForContig(contig, resp);
      }
      if (Array.isArray(resp.ideogram_data)) cfg.ideogram_data = resp.ideogram_data;
      if (resp.data_bounds && typeof resp.data_bounds.start === "number") {
        cfg.data_bounds = resp.data_bounds; dataBounds = resp.data_bounds;
      }
      _gsVpRebuildTracks();
      if (typeof renderAll === "function") renderAll();
      if (window.__GS_STATUS && _gsVpStatusInFlight <= 1) {
        const nv = resp.variant_tracks.reduce(
          (a, t) => a + (t.variants_data ? t.variants_data.length : 0), 0);
        window.__GS_STATUS(`Loaded ${nv.toLocaleString()} variants`, { autoHide: 1800 });
      }
    }
  } catch (e) {
    if (e && e.gsDisconnected) return;      // user pressed Disconnect mid-load: not an error
    console.warn("viewport variant load failed:", e);
    __GS_DEBUG("vp_fetch_error", { reqKey: reqKey, error: String(e && e.message || e) });
    const hint = (e && e.cause) ? String(e.cause)
      : "The connection to the kernel may have dropped or the request timed out. "
        + "Try again, or re-run the cell.";
    gsSeriousFailureModal(
      "Failed to load variants for this region. " + hint, "Variant load failed");
  } finally {
    if (_vpSafetyTimer) clearTimeout(_vpSafetyTimer);
    if (_gsVpInFlight === reqKey) _gsVpInFlight = null;
    if (_vpStatusOwned) {
      _vpStatusOwned = false;
      _gsVpStatusInFlight = Math.max(0, _gsVpStatusInFlight - 1);
    }
    // Only clear the busy bar when the last overlapping load settles; a
    // success/failure message above (autoHide) supersedes it when shown.
    if (_gsVpStatusInFlight === 0 && window.__GS_STATUS) {
      const bar = document.getElementById("statusBar");
      if (bar && bar.classList.contains("indeterminate")) window.__GS_STATUS(false);
    }
  }
}

// Debounced trigger — called from the pan/zoom/scroll settle points. Each call
// re-arms the timer (clearTimeout), so continuous motion never fires a load; the
// fetch runs only once the view has been still for the settle window. Callers
// may pass an explicit delay (e.g. 0 for a deliberate region jump); the pan/
// zoom/scroll callers pass nothing and get GS_VP_SETTLE_MS (1s).
function gsScheduleViewportVariantLoad(delay) {
  if (_gsVpTimer) clearTimeout(_gsVpTimer);
  _gsVpTimer = setTimeout(() => {
    _gsVpTimer = null;
    gsLoadVariantsForViewport(false);
    if (typeof gsLoadDataTracksForViewport === "function") gsLoadDataTracksForViewport();
  }, delay == null ? GS_VP_SETTLE_MS : delay);
}

// Register the startup region's variants (shipped in config) with the viewport
// store so panning back doesn't refetch them, and dynamic paging works from the
// first frame. If the config shipped variant META only (comm-payload mode),
// there's nothing to seed — kick a fetch for the initial window instead.
function gsSeedInitialVariantWindow() {
  const cfg = window.GENOMESHADER_CONFIG || {};
  if (!cfg.viewport_variant_loading) return;
  const m = String(cfg.region || "").match(/^([^:]+):(\d+)-(\d+)$/);
  if (!m) return;
  const region = { contig: m[1], start: parseInt(m[2], 10), end: parseInt(m[3], 10) };
  const tracks = cfg.variant_tracks || [];
  const hasData = tracks.some((t) => (t.variants_data || []).length > 0);
  if (hasData) {
    _gsVpRegions = [region];
    _gsVpData.clear();
    _gsVpData.set(_gsRegionKey(region), tracks);
  } else if (typeof gsScheduleViewportVariantLoad === "function") {
    gsScheduleViewportVariantLoad(0);
  }
}

if (typeof window !== "undefined") {
  window.gsLoadVariantsForViewport = gsLoadVariantsForViewport;
  window.gsScheduleViewportVariantLoad = gsScheduleViewportVariantLoad;
  window.gsSeedInitialVariantWindow = gsSeedInitialVariantWindow;
  // Test introspection: which windows are loaded right now.
  window.__gsVpState = () => ({
    regions: _gsVpRegions.map((r) => ({ ...r })),
    windowKeys: [..._gsVpData.keys()],
  });
}

// ---------------------------------------------------------------------------
// Software-defined tracks (attach_data) — fetch features for the visible window
// ---------------------------------------------------------------------------
const _gsDataTrackInFlight = new Map(); // trackId -> reqKey

function fetchTrackData(trackId, contig, start, end) {
  if (typeof sendCommMessage !== "function") {
    return Promise.reject(new Error("sendCommMessage not available"));
  }
  return sendCommMessage("fetch_track_data", {
    track_id: trackId,
    contig: contig,
    start: Math.floor(start),
    end: Math.ceil(end),
    max_points: 2000,
  }, 120000);
}

function _gsApplyTrackDataResponse(resp) {
  if (!resp || !resp.track_id) return;
  const entry = (state.dataTracks || []).find(d => d.id === resp.track_id);
  if (!entry) return;
  // Replace features only — preserve local settings (y_scale, y_min/max, color).
  if (Array.isArray(resp.series)) {
    const prevByName = {};
    (entry.series || []).forEach(s => { if (s && s.name) prevByName[s.name] = s; });
    entry.series = resp.series.map(s => {
      const prev = prevByName[s.name];
      return {
        name: s.name,
        // Prefer local color override if the user set one on the series
        color: (prev && prev._userColor) ? prev.color : (s.color || (prev && prev.color) || entry.color),
        features: Array.isArray(s.features) ? s.features : [],
        _userColor: prev && prev._userColor,
      };
    });
  }
}

async function gsLoadDataTracksForViewport() {
  if (!Array.isArray(state.dataTracks) || !state.dataTracks.length) return;
  if (typeof sendCommMessage !== "function") return;
  if (typeof gsIsConnected === "function" && !gsIsConnected()) return;
  const contig = state.contig;
  const start = Math.floor(state.startBp);
  const end = Math.ceil(state.endBp);
  if (!(end > start) || !contig) return;

  const jobs = state.dataTracks.map(async (entry) => {
    const reqKey = `${entry.id}:${contig}:${start}-${end}`;
    if (_gsDataTrackInFlight.get(entry.id) === reqKey) return;
    _gsDataTrackInFlight.set(entry.id, reqKey);
    try {
      const resp = await fetchTrackData(entry.id, contig, start, end);
      if (resp && (resp.error || (resp.type && String(resp.type).endsWith("_error")))) {
        throw new Error(resp.error || "track data fetch failed");
      }
      if (_gsDataTrackInFlight.get(entry.id) !== reqKey) return; // stale
      _gsApplyTrackDataResponse(resp);
    } catch (e) {
      console.warn("data track fetch failed:", entry.id, e);
    } finally {
      if (_gsDataTrackInFlight.get(entry.id) === reqKey) {
        _gsDataTrackInFlight.delete(entry.id);
      }
    }
  });
  await Promise.all(jobs);
  if (typeof updateTracksHeight === "function") updateTracksHeight();
  if (typeof renderAll === "function") renderAll();
}

function gsEnsureDataTrackLayout(meta) {
  if (!meta || !meta.id) return;
  const existing = (state.dataTracks || []).find(d => d.id === meta.id);
  if (existing) {
    // Update metadata but keep local settings + series until next fetch
    existing.label = meta.label || existing.label;
    if (meta.style) existing.style = meta.style;
    if (existing.y_min == null && meta.y_min != null) existing.y_min = meta.y_min;
    if (existing.y_max == null && meta.y_max != null) existing.y_max = meta.y_max;
    if (existing.color == null && meta.color != null) existing.color = meta.color;
    if (Array.isArray(meta.series) && meta.series.length && !(existing.series && existing.series.length)) {
      existing.series = meta.series;
    }
  } else {
    if (!state.dataTracks) state.dataTracks = [];
    state.dataTracks.push({
      id: meta.id,
      label: meta.label || meta.id,
      style: meta.style || "line",
      color: meta.color,
      y_scale: meta.y_scale || "linear",
      y_min: (meta.y_min != null) ? meta.y_min : null,
      y_max: (meta.y_max != null) ? meta.y_max : null,
      series: Array.isArray(meta.series) ? meta.series : [],
      callable: !!meta.callable,
    });
  }
  if (!state.tracks.some(tr => tr.id === meta.id)) {
    const trackDef = {
      id: meta.id,
      label: meta.label || meta.id,
      collapsed: false,
      height: meta.height || 80,
      minHeight: meta.minHeight || 40,
    };
    const at = state.tracks.findIndex(tr => tr.id === "flow" || (typeof tr.id === "string" && tr.id.startsWith("flow-")));
    if (at >= 0) state.tracks.splice(at, 0, trackDef); else state.tracks.push(trackDef);
  } else {
    const tr = state.tracks.find(t => t.id === meta.id);
    if (tr && meta.label) tr.label = meta.label;
    if (tr && meta.height) tr.height = meta.height;
  }
}

function gsOnDataTracksChanged(tracks) {
  if (!Array.isArray(tracks)) return;
  const ids = new Set(tracks.map(t => t.id));
  // Remove tracks that are no longer attached
  state.dataTracks = (state.dataTracks || []).filter(d => ids.has(d.id));
  state.tracks = state.tracks.filter(tr => {
    if (typeof tr.id === "string" && tr.id.indexOf("data-") === 0) return ids.has(tr.id);
    return true;
  });
  for (const meta of tracks) gsEnsureDataTrackLayout(meta);
  if (typeof updateTracksHeight === "function") updateTracksHeight();
  gsLoadDataTracksForViewport().then(() => {
    if (typeof renderTrackControls === "function") renderTrackControls();
    if (typeof renderAll === "function") renderAll();
  });
}

// Live attach_data() after show() arrives as an unmatched custom message.
if (typeof document !== "undefined") {
  document.addEventListener("genomeshader_msg", function (ev) {
    const msg = ev && ev.detail;
    if (msg && msg.type === "data_tracks_changed") {
      gsOnDataTracksChanged(msg.tracks || []);
    }
  });
}

if (typeof window !== "undefined") {
  window.fetchTrackData = fetchTrackData;
  window.gsLoadDataTracksForViewport = gsLoadDataTracksForViewport;
  window.gsOnDataTracksChanged = gsOnDataTracksChanged;
}

// Kick an initial fetch for callable tracks (static ones may already have series).
setTimeout(function () {
  if (typeof gsLoadDataTracksForViewport === "function") {
    const need = (state.dataTracks || []).some(d => d.callable || !(d.series && d.series.length));
    if (need) gsLoadDataTracksForViewport();
  }
}, 0);

// ---------------------------------------------------------------------------
// Contig switcher (sidebar "Region" dropdown). Reference / genes / ideogram /
// repeats are per-window and baked into the initial config, so jumping to a
// contig needs the host: gsSwitchContig moves the view and asks for the new
// region's payload (`navigate` comm), then applies it. Without a comm it still
// moves the view and reloads variants via the viewport loader.
// ---------------------------------------------------------------------------
function gsContigList() {
  const cfg = window.GENOMESHADER_CONFIG || {};
  const lens = cfg.chrom_lengths && Object.keys(cfg.chrom_lengths).length
    ? cfg.chrom_lengths
    : (typeof chrLengths !== "undefined" ? chrLengths : {});
  return Object.keys(lens);
}

function gsPopulateContigSelect() {
  const sel = document.getElementById("contigSelect");
  if (!sel) return;
  const contigs = gsContigList();
  sel.innerHTML = "";
  for (const c of contigs) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    if (c === state.contig) opt.selected = true;
    sel.appendChild(opt);
  }
  if (!sel.__gsWired) {
    sel.__gsWired = true;
    sel.addEventListener("change", () => gsSwitchContig(sel.value));
  }
}

// Drop the previous contig's per-region data so it doesn't flash before the new
// region's payload arrives.
function gsResetRegionData() {
  const cfg = window.GENOMESHADER_CONFIG || (window.GENOMESHADER_CONFIG = {});
  referenceSequence = "";
  const emptyGenes = { id: "genes", label: "Genes", style: "gene",
    series: [{ name: "genes", features: [] }] };
  const emptyRepeats = { id: "repeats", label: "RepeatMasker", style: "interval",
    series: [{ name: "repeats", features: [] }] };
  gsSetAnnotationTrack(emptyGenes);
  gsSetAnnotationTrack(emptyRepeats);
  cfg.reference_data = "";
  cfg.genes_track = emptyGenes;
  cfg.repeats_track = emptyRepeats;
  _gsVpRegions = [];
  _gsVpData.clear();
  _gsVpRebuildTracks();
}

/** Facet change: drop cached variant windows and refetch with new sample_ids. */
function invalidateViewportForFacets() {
  _gsVpRegions = [];
  _gsVpData.clear();
  _gsVpInFlight = null;
  _gsVpRebuildTracks();
  if (typeof gsScheduleViewportVariantLoad === "function") {
    gsScheduleViewportVariantLoad(0);
  } else if (typeof gsLoadVariantsForViewport === "function") {
    try { gsLoadVariantsForViewport(true); } catch (e) { /* ignore */ }
  }
}
if (typeof window !== "undefined") {
  window.invalidateViewportForFacets = invalidateViewportForFacets;
}

function gsSwitchContig(contig) {
  if (!contig || contig === state.contig) return;
  const cfg = window.GENOMESHADER_CONFIG || {};
  const len = Number((cfg.chrom_lengths || {})[contig])
    || (typeof chrLengths !== "undefined" ? Number(chrLengths[contig]) : 0) || 0;
  const curSpan = Math.max(1, Math.floor(state.endBp - state.startBp)) || 1000;
  const span = len ? Math.min(curSpan, len) : curSpan;
  state.contig = contig;
  state.startBp = 1;
  state.endBp = 1 + span;
  if (typeof clampToChromosomeBounds === "function") clampToChromosomeBounds();
  if (typeof gsPullAliasesIntoFocused === "function") gsPullAliasesIntoFocused();
  gsResetRegionData();
  if (typeof updateDocumentTitle === "function") updateDocumentTitle();
  if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
  if (typeof renderAll === "function") renderAll();
  gsRequestNavigate(state.contig, Math.floor(state.startBp), Math.ceil(state.endBp));
}

// A single typed position expands this many bp on EACH side (IGV-style).
const GS_SINGLE_POS_PAD_BP = 100;

// Parse an IGV-style locus box value into { contig, start, end } (1-based
// inclusive) or { error }. Accepts "contig:start-end", "contig:pos", "start-end",
// "pos", or a bare "contig". Commas/whitespace are ignored. A bare position
// expands +/-GS_SINGLE_POS_PAD_BP. start/end are null for a contig-only value
// (caller picks the span). Does NOT clamp — caller clamps to the contig length.
function gsParseLocusInput(text, currentContig, contigLens) {
  const lens = contigLens || {};
  const s = String(text == null ? "" : text).trim();
  if (!s) return { error: "Enter a contig and/or position" };

  let contig = currentContig;
  let rangePart = "";
  const colon = s.lastIndexOf(":");
  if (colon >= 0) {
    const c = s.slice(0, colon).trim();
    if (c) contig = c;
    rangePart = s.slice(colon + 1).trim();
  } else if (Object.prototype.hasOwnProperty.call(lens, s)) {
    return { contig: s, start: null, end: null };   // bare known contig name
  } else {
    rangePart = s;                                    // bare range on current contig
  }

  const clean = rangePart.replace(/[,\s]/g, "");
  if (!clean) return { contig, start: null, end: null };  // "contig:" -> whole contig

  const m = clean.match(/^(\d+)(?:[-–](\d+))?$/);
  if (!m) return { error: `Could not parse position "${rangePart}"` };
  let start, end;
  if (m[2] !== undefined) {
    start = parseInt(m[1], 10);
    end = parseInt(m[2], 10);
    if (end < start) { const t = start; start = end; end = t; }
  } else {
    const p = parseInt(m[1], 10);
    start = p - GS_SINGLE_POS_PAD_BP;
    end = p + GS_SINGLE_POS_PAD_BP;
  }
  return { contig, start, end };
}

// Jump the view to a typed locus string. Returns true on a valid jump, false
// (with a transient status message) on bad input / unknown contig.
function gsGoToLocus(text) {
  const cfg = window.GENOMESHADER_CONFIG || {};
  const lens = (cfg.chrom_lengths && Object.keys(cfg.chrom_lengths).length)
    ? cfg.chrom_lengths
    : (typeof chrLengths !== "undefined" ? chrLengths : {});
  const parsed = gsParseLocusInput(text, state.contig, lens);
  if (parsed.error) {
    if (window.__GS_STATUS) window.__GS_STATUS(parsed.error, { autoHide: 4000 });
    return false;
  }
  const contig = parsed.contig;
  const haveLens = Object.keys(lens).length > 0;
  if (haveLens && !Object.prototype.hasOwnProperty.call(lens, contig)) {
    gsSeriousFailureModal(
      `The contig "${contig}" is not in the reference genome. `
      + `Pick a contig from the dropdown, or enter a coordinate on a contig that exists.`,
      "Contig not in reference");
    return false;
  }
  const len = Number(lens[contig]) || 0;

  let start = parsed.start;
  let end = parsed.end;
  if (start == null || end == null) {
    // Contig-only: land at the start keeping the current span.
    const span = Math.max(1, Math.floor(state.endBp - state.startBp)) || 1000;
    start = 1;
    end = 1 + (len ? Math.min(span, len) : span);
  }
  start = Math.max(1, Math.floor(start));
  end = Math.max(start + 1, Math.floor(end));
  if (len) {
    end = Math.min(end, len);
    if (start >= end) start = Math.max(1, end - 1);
  }

  const contigChanged = contig !== state.contig;
  state.contig = contig;
  state.startBp = start;
  state.endBp = end;
  if (typeof clampToChromosomeBounds === "function") clampToChromosomeBounds();
  if (typeof gsPullAliasesIntoFocused === "function") gsPullAliasesIntoFocused();
  // Committed: drop the staged box + dirty flag so the bar re-syncs to the view
  // and Go greys out again.
  state.__pendingLocus = null;
  state.__locusDirty = false;
  if (contigChanged) gsResetRegionData();
  if (typeof updateDocumentTitle === "function") updateDocumentTitle();
  if (typeof gsSyncLocusBar === "function") gsSyncLocusBar();
  if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
  if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
  if (typeof renderAll === "function") renderAll();
  gsRequestNavigate(state.contig, Math.floor(state.startBp), Math.ceil(state.endBp));
  return true;
}
if (typeof window !== "undefined") {
  window.gsParseLocusInput = gsParseLocusInput;
  window.gsGoToLocus = gsGoToLocus;
}

// Resolve a gene name / ID / transcript ID to a locus via the kernel and jump
// to the best match (with a little flanking padding). Needs a live comm.
async function gsResolveFeatureAndGo(query) {
  const q = (query || "").trim();
  if (!q) return false;
  if (typeof sendCommMessage !== "function") {
    if (window.__GS_STATUS) window.__GS_STATUS("Gene search needs a live kernel", { autoHide: 4000 });
    return false;
  }
  if (window.__GS_STATUS) window.__GS_STATUS(`Searching for "${q}"…`, { busy: true });
  try {
    const resp = await sendCommMessage("resolve_feature", { query: q });
    const matches = (resp && resp.matches) || [];
    if (!matches.length) {
      if (window.__GS_STATUS) window.__GS_STATUS(`No gene/feature matching "${q}"`, { autoHide: 4000 });
      return false;
    }
    const m = matches[0];
    const pad = Math.max(50, Math.round((m.end - m.start) * 0.1));
    const start = Math.max(1, m.start - pad);
    const end = m.end + pad;
    gsGoToLocus(`${m.contig}:${start}-${end}`);
    if (window.__GS_STATUS) {
      const extra = matches.length > 1 ? ` (+${matches.length - 1} other match${matches.length > 2 ? "es" : ""})` : "";
      window.__GS_STATUS(`Jumped to ${m.name}${extra}`, { autoHide: 3000 });
    }
    return true;
  } catch (e) {
    if (window.__GS_STATUS) {
      window.__GS_STATUS(e && e.gsDisconnected ? "Disconnected — gene search unavailable" : "Gene search failed",
        { autoHide: 4000 });
    }
    return false;
  }
}
if (typeof window !== "undefined") window.gsResolveFeatureAndGo = gsResolveFeatureAndGo;

// Click on the Chromosome (ideogram) overview to STAGE a jump there — opt-in via
// the "Click chromosome to jump" setting. Maps the click across the WHOLE contig
// (the ideogram is a full-chromosome overview), recenters the current span on it,
// and stages that as a pending target: draws a differently-coloured rectangle
// over the clicked area, fills the locus bar, and enables Go. It does NOT jump —
// Go (or Enter) commits it. `e` is a pointerup event on #locusIdeogram.
function gsMaybeChromClickStage(e) {
  if (!state.chromClickJump) return false;
  if ((state.gestureMovedPx || 0) > 4) return false;         // was a drag/pan
  if (e && e.button !== undefined && e.button !== 0) return false;
  const rect = state.__ideogramHitRect;
  if (!rect || !(rect.w > 0) || !(rect.h > 0) || !(rect.len > 0)) return false;
  if (rect.contig !== state.contig) return false;
  const svg = (typeof locusIdeogramSvg !== "undefined" && locusIdeogramSvg)
    || document.getElementById("locusIdeogram");
  if (!svg) return false;
  const r = svg.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return false;
  const sx = r.width / (rect.svgW || r.width);
  const sy = r.height / (rect.svgH || r.height);
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  const hx = rect.x * sx, hy = rect.y * sy, hw = rect.w * sx, hh = rect.h * sy;
  if (px < hx || px > hx + hw || py < hy || py > hy + hh) {
    return false;                                            // click wasn't on the ideogram band
  }
  const frac = (px - hx) / hw;
  const pos = Math.max(1, Math.round(frac * rect.len));
  const span = Math.max(1, Math.floor(state.endBp - state.startBp)) || 1000;
  let start = Math.max(1, Math.round(pos - span / 2));
  let end = start + span;
  if (rect.len) { end = Math.min(end, rect.len); if (start >= end) start = Math.max(1, end - 1); }

  // Stage it (no navigation). The ideogram renderer draws the pending box.
  state.__pendingLocus = { contig: rect.contig, start, end };
  const sel = document.getElementById("locusContigSelect");
  const posEl = document.getElementById("locusPosInput");
  if (sel) sel.value = rect.contig;
  if (posEl) posEl.value = `${start.toLocaleString()}-${end.toLocaleString()}`;
  gsMarkLocusDirty(true);
  if (typeof renderAll === "function") renderAll();
  return true;
}
if (typeof window !== "undefined") window.gsMaybeChromClickStage = gsMaybeChromClickStage;

// Enable Go only when the bar holds an uncommitted change ("dirty"): a new
// contig picked, an edited position, or a staged chromosome-click box.
function gsUpdateGoButton() {
  const go = document.getElementById("locusGoBtn");
  if (go) go.disabled = !state.__locusDirty;
}
function gsMarkLocusDirty(v) {
  state.__locusDirty = (v !== false);
  gsUpdateGoButton();
}

// Reflect the current view into the top locus bar fields. Held back while the
// user is mid-edit (focused) or has a staged-but-uncommitted change (dirty), so
// pan/zoom doesn't stomp what they're about to Go to. Called after any
// navigation/pan/zoom.
function gsSyncLocusBar() {
  const sel = document.getElementById("locusContigSelect");
  const pos = document.getElementById("locusPosInput");
  if (state.__locusDirty) { gsUpdateGoButton(); return; }
  if (sel && sel.value !== state.contig) {
    // Repopulate lazily if the contig isn't an option yet.
    if (!Array.from(sel.options).some(o => o.value === state.contig)) {
      gsInitLocusBar();
    }
    sel.value = state.contig;
  }
  if (pos && document.activeElement !== pos) {
    const s = Math.max(1, Math.floor(state.startBp));
    const e = Math.max(s, Math.ceil(state.endBp));
    pos.value = `${s.toLocaleString()}-${e.toLocaleString()}`;
  }
  gsUpdateGoButton();
}

let _hoverLocusRaf = 0;
function gsViewMidpointBp() {
  const s = Math.max(1, Math.floor(state.startBp));
  const e = Math.max(s, Math.ceil(state.endBp));
  return Math.round((s + e) / 2);
}

function gsPaintLocusReadout() {
  const readout = document.getElementById("locusReadout");
  if (!readout) return;
  if (state.__hoverContig !== state.contig) {
    state.__hoverFromMouse = false;
    state.__hoverBp = null;
    state.__hoverClient = null;
    state.__hoverContig = state.contig;
  }
  const h = state.__hoverClient;
  if (h) {
    const bp = h.source === "ideogram"
      ? gsIdeogramBpAtClient(h.x)
      : gsViewBpAtClient(h.x, h.y);
    if (bp != null) {
      state.__hoverBp = bp;
      state.__hoverFromMouse = true;
    }
  }
  const bp = (state.__hoverFromMouse && Number.isFinite(state.__hoverBp))
    ? state.__hoverBp
    : gsViewMidpointBp();
  readout.textContent = `${state.contig}:${Math.round(bp).toLocaleString()}`;
  readout.title = state.__hoverFromMouse ? "Position under cursor" : "View midpoint";
}

function gsApplyHoverLocus(bp, clientX, clientY, source) {
  state.__hoverBp = bp;
  state.__hoverFromMouse = true;
  state.__hoverContig = state.contig;
  state.__hoverClient = { x: clientX, y: clientY, source: source || "view" };
  if (_hoverLocusRaf) return;
  _hoverLocusRaf = requestAnimationFrame(() => {
    _hoverLocusRaf = 0;
    gsPaintLocusReadout();
  });
}

function gsClearHoverLocus() {
  // Keep the last coordinate; drop the live client so pan/zoom doesn't keep
  // remapping a stale screen x after the pointer has left.
  if (!state.__hoverClient) return;
  state.__hoverClient = null;
  if (_hoverLocusRaf) {
    cancelAnimationFrame(_hoverLocusRaf);
    _hoverLocusRaf = 0;
  }
  gsPaintLocusReadout();
}

function gsViewBpAtClient(clientX, clientY) {
  const rectSource = (typeof tracksContainer !== "undefined" && tracksContainer)
    || (typeof tracksSvg !== "undefined" && tracksSvg)
    || document.getElementById("tracksContainer")
    || document.getElementById("tracksSvg");
  if (!rectSource) return null;
  const rect = rectSource.getBoundingClientRect();
  let bp;
  if (typeof isVerticalMode === "function" && isVerticalMode()) {
    const H = (typeof tracksHeightPx === "function") ? tracksHeightPx() : rect.height;
    bp = bpFromYGenome(clientY - rect.top, H);
  } else {
    const W = (typeof tracksWidthPx === "function") ? tracksWidthPx() : rect.width;
    bp = bpFromXGenome(clientX - rect.left, W);
  }
  if (!Number.isFinite(bp)) return null;
  const chrLen = (typeof getChromosomeLength === "function") ? getChromosomeLength() : 0;
  const lo = Math.max(1, Math.floor(state.startBp));
  const hi = chrLen ? Math.min(chrLen, Math.ceil(state.endBp)) : Math.ceil(state.endBp);
  return Math.max(lo, Math.min(hi, Math.round(bp)));
}

function gsIdeogramBpAtClient(clientX) {
  const hit = state.__ideogramHitRect;
  const svg = (typeof locusIdeogramSvg !== "undefined" && locusIdeogramSvg)
    || document.getElementById("locusIdeogram");
  if (!hit || !svg || !(hit.w > 0) || !(hit.len > 0)) return null;
  const r = svg.getBoundingClientRect();
  if (!(r.width > 0)) return null;
  const sx = r.width / (hit.svgW || r.width);
  const px = clientX - r.left;
  const hx = hit.x * sx, hw = hit.w * sx;
  if (!(hw > 0)) return null;
  const frac = Math.max(0, Math.min(1, (px - hx) / hw));
  return Math.max(1, Math.min(hit.len, Math.round(frac * hit.len)));
}

function gsUpdateHoverLocusFromEvent(e, source) {
  if (!e) return;
  const src = source || "view";
  const bp = src === "ideogram"
    ? gsIdeogramBpAtClient(e.clientX)
    : gsViewBpAtClient(e.clientX, e.clientY);
  if (bp == null) return;
  gsApplyHoverLocus(bp, e.clientX, e.clientY, src);
}

// Populate + wire the top locus bar. Idempotent (safe to call again).
function gsInitLocusBar() {
  const sel = document.getElementById("locusContigSelect");
  const pos = document.getElementById("locusPosInput");
  const go = document.getElementById("locusGoBtn");
  const ideo = (typeof locusIdeogramSvg !== "undefined" && locusIdeogramSvg)
    || document.getElementById("locusIdeogram");
  if (ideo && !ideo.__gsWired) {
    ideo.__gsWired = true;
    ideo.addEventListener("pointermove", (e) => {
      if (typeof gsUpdateHoverLocusFromEvent === "function") gsUpdateHoverLocusFromEvent(e, "ideogram");
    });
    ideo.addEventListener("pointerleave", (e) => {
      const mainEl = document.getElementById("main");
      if (mainEl && e.relatedTarget && (mainEl === e.relatedTarget || mainEl.contains(e.relatedTarget))) return;
      if (typeof gsClearHoverLocus === "function") gsClearHoverLocus();
    });
    ideo.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      state.gestureMovedPx = 0;
      if (typeof gsMaybeChromClickStage === "function") gsMaybeChromClickStage(e);
    });
  }
  if (sel) {
    const contigs = gsContigList();
    // Rebuild options only when the contig list actually changed — this can run
    // per render, and clobbering the <select> every frame would reset a staged
    // (uncommitted) contig pick back to the current view.
    const cur = Array.from(sel.options).map(o => o.value);
    const same = cur.length === contigs.length && cur.every((v, i) => v === contigs[i]);
    if (!same) {
      sel.innerHTML = "";
      for (const c of contigs) {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c;
        sel.appendChild(opt);
      }
    }
    // Never override a staged (dirty) selection; otherwise reflect the view.
    if (!state.__locusDirty) sel.value = state.contig;
    if (!sel.__gsWired) {
      sel.__gsWired = true;
      // Picking a contig does NOT jump — it stages the change (Go commits it).
      // Clear the position box (blank -> whole contig at the current span on Go)
      // and any staged chromosome-click box (it belongs to the old contig).
      sel.addEventListener("change", () => {
        if (pos) pos.value = "";
        const hadPending = !!state.__pendingLocus;
        state.__pendingLocus = null;
        gsMarkLocusDirty(true);
        // Only re-render to clear a stale pending box; a bare contig pick needs
        // no redraw (and re-rendering here re-syncs the bar off the OLD contig).
        if (hadPending && typeof renderAll === "function") renderAll();
      });
    }
  }
  const submit = () => {
    if (!sel) return;
    const p = pos ? pos.value.trim() : "";
    // Gene / transcript search: a position box holding letters that isn't a
    // plain coordinate range ("12,345" or "12345-67890") is treated as a
    // feature query and resolved to a locus by the kernel.
    if (p && /[A-Za-z]/.test(p) && !/^\s*[\d,]+\s*(-\s*[\d,]+\s*)?$/.test(p)) {
      gsResolveFeatureAndGo(p);
      return;
    }
    gsGoToLocus(p ? `${sel.value}:${p}` : sel.value);
  };
  if (go && !go.__gsWired) {
    go.__gsWired = true;
    go.addEventListener("click", () => { if (!go.disabled) submit(); });
  }
  if (pos && !pos.__gsWired) {
    pos.__gsWired = true;
    // Typing new coordinates stages them (enables Go) and drops any staged
    // chromosome-click box, since the user is now specifying via text.
    pos.addEventListener("input", () => {
      if (state.__pendingLocus) {
        state.__pendingLocus = null;
        if (typeof renderAll === "function") renderAll();
      }
      gsMarkLocusDirty(true);
    });
    pos.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });
  }
  const lockBtn = document.getElementById("locusLockBtn");
  if (lockBtn && !lockBtn.__gsWired) {
    lockBtn.__gsWired = true;
    lockBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      gsSetViewLock(!(state.lockView === true));
    });
  }
  const connectBtn = document.getElementById("locusConnectBtn");
  if (connectBtn && !connectBtn.__gsWired) {
    connectBtn.__gsWired = true;
    connectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (typeof gsSetConnected === "function") gsSetConnected(!gsIsConnected());
    });
  }
  gsUpdateConnectButton();
  gsSyncViewLockButton();
  gsUpdateGoButton();
  gsSyncLocusBar();
}

/** Reflect the connection state on the locus-bar toggle (is-active = disconnected). */
function gsUpdateConnectButton() {
  const off = typeof gsIsConnected === "function" ? !gsIsConnected() : false;
  const label = off ? "Connect — resume loading data" : "Disconnect — stop loading data";
  const btn = document.getElementById("locusConnectBtn");
  if (btn) {
    btn.classList.toggle("is-active", off);
    btn.setAttribute("aria-pressed", off ? "true" : "false");
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }
}
if (typeof window !== "undefined") window.gsUpdateConnectButton = gsUpdateConnectButton;

function gsSyncViewLockButton() {
  const on = state.lockView === true;
  const label = on ? "Unlock viewport" : "Lock viewport";
  const btn = document.getElementById("locusLockBtn");
  if (btn) {
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }
  const lab = document.getElementById("lockViewportLabel");
  if (lab) lab.textContent = label;
}

function gsSetViewLock(locked) {
  state.lockView = locked === true;
  gsSyncViewLockButton();
}
if (typeof window !== "undefined") {
  window.gsMarkLocusDirty = gsMarkLocusDirty;
  window.gsUpdateGoButton = gsUpdateGoButton;
  window.gsPaintLocusReadout = gsPaintLocusReadout;
  window.gsUpdateHoverLocusFromEvent = gsUpdateHoverLocusFromEvent;
  window.gsClearHoverLocus = gsClearHoverLocus;
  window.gsSetViewLock = gsSetViewLock;
  window.gsSyncViewLockButton = gsSyncViewLockButton;
}
if (typeof window !== "undefined") {
  window.gsInitLocusBar = gsInitLocusBar;
  window.gsSyncLocusBar = gsSyncLocusBar;
}

async function gsRequestNavigate(contig, start, end) {
  if (typeof gsIsConnected === "function" && !gsIsConnected()) {
    // Offline: the view moves locally and shows whatever is cached; nothing is requested.
    if (window.__GS_STATUS) window.__GS_STATUS("Disconnected — showing cached data only", { autoHide: 2500 });
    return;
  }
  if (typeof sendCommMessage !== "function") {
    if (typeof gsScheduleViewportVariantLoad === "function") gsScheduleViewportVariantLoad(0);
    return;
  }
  if (window.__GS_STATUS) {
    window.__GS_STATUS(
      `Loading ${contig}:${start.toLocaleString()}–${end.toLocaleString()}…`, { busy: true });
  }
  try {
    // A region JUMP builds more than a pan (reference + genes + repeats +
    // ideogram + a cold variant decode for a brand-new window), so the old 30s
    // budget reliably timed out on large-cohort / cold regions. Give it a
    // generous, config-overridable budget — a jump is an explicit user action, so
    // waiting beats a hard "failed to load". (Speed itself is a separate backend
    // concern: aggregate decode is already used; deferring UCSC genes/repeats off
    // the jump hot path + parallel decode are the next levers.)
    const navTimeout = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.navigate_timeout_ms) || 120000;
    const resp = await sendCommMessage("navigate", { contig, start, end }, navTimeout);
    if (resp) gsApplyNavigatePayload(resp);
    if (window.__GS_STATUS) window.__GS_STATUS(false);
  } catch (e) {
    if (e && e.gsDisconnected) { if (window.__GS_STATUS) window.__GS_STATUS(false); return; }
    console.warn("navigate failed:", e);
    if (typeof gsScheduleViewportVariantLoad === "function") gsScheduleViewportVariantLoad(0);
    gsSeriousFailureModal(
      "Failed to load this region. The connection to the kernel may have dropped "
      + "or the request timed out. Try again, or re-run the cell.",
      "Region load failed");
  }
}

// Apply a host `navigate` response: reference / genes / repeats / ideogram /
// variants for the new window. Reassigns the module render inputs (same closure)
// + config, then re-renders.
function gsApplyNavigatePayload(p) {
  if (!p) return;
  const cfg = window.GENOMESHADER_CONFIG || (window.GENOMESHADER_CONFIG = {});
  if (typeof p.contig === "string") state.contig = p.contig;
  if (typeof p.start === "number") state.startBp = p.start;
  if (typeof p.end === "number") state.endBp = p.end;
  if (typeof p.reference_data === "string") {
    cfg.reference_data = p.reference_data;
    referenceSequence = p.reference_data;
  }
  if (p.genes_track && typeof p.genes_track === "object") {
    cfg.genes_track = p.genes_track;
    gsSetAnnotationTrack(p.genes_track);
  }
  if (p.repeats_track && typeof p.repeats_track === "object") {
    cfg.repeats_track = p.repeats_track;
    gsSetAnnotationTrack(p.repeats_track);
  }
  if (Array.isArray(p.ideogram_data)) cfg.ideogram_data = p.ideogram_data;
  if (typeof p.start === "number" && typeof p.end === "number") {
    cfg.data_bounds = { start: p.start, end: p.end };
    dataBounds = { start: p.start, end: p.end };
  }
  // Snapshot what this jump delivered for ITS contig. Multi-tile painting restores
  // each tile's reference / genes / repeats / bounds from these per-contig snapshots
  // (gsRestoreAnnotationsForContig); a jump that only updated the globals left the
  // tile's older snapshot in place, so the next paint swapped stale data back in
  // and the tile lost its reference bases and annotations. The bounds are stored
  // only together with a reference sequence (they are that sequence's origin).
  {
    const contig = (typeof p.contig === "string" && p.contig) ? p.contig : state.contig;
    const snap = { genes_track: p.genes_track, repeats_track: p.repeats_track };
    if (typeof p.reference_data === "string") {
      snap.reference_data = p.reference_data;
      if (typeof p.start === "number" && typeof p.end === "number") snap.data_bounds = { start: p.start, end: p.end };
    }
    gsStoreAnnotationsForContig(contig, snap);
  }
  if (Array.isArray(p.insertion_variants_lookup)) {
    cfg.insertion_variants_lookup = p.insertion_variants_lookup;
  }
  if (p.variants_deferred) {
    // Fast jump: the backend returned reference/genes only. Clear stale variants
    // (old region's coords) and let the viewport loader fetch this window's
    // variants asynchronously — its own long budget + progress bar means a cold
    // cohort-scale decode never times out the jump.
    _gsVpRegions = [];
    _gsVpData.clear();
    _gsVpRebuildTracks();
    if (typeof gsScheduleViewportVariantLoad === "function") gsScheduleViewportVariantLoad(0);
  } else if (Array.isArray(p.variant_tracks)) {
    // Seed the viewport store with the new window so later pans union/evict off it.
    const region = { contig: state.contig, start: Math.floor(state.startBp), end: Math.ceil(state.endBp) };
    _gsVpRegions = [region];
    _gsVpData.clear();
    _gsVpData.set(_gsRegionKey(region), p.variant_tracks);
    _gsVpRebuildTracks();
  }
  // Large-window guard (backend skipped variants + reference for a very wide
  // jump so it never pulls the whole VCF). Tell the user to zoom in.
  if (p.too_wide_for_variants) {
    const capMb = (Number(p.variant_max_span_bp || 0) / 1e6);
    const capTxt = capMb >= 1 ? `${capMb.toLocaleString()} Mb` : `${Number(p.variant_max_span_bp || 0).toLocaleString()} bp`;
    if (window.__GS_STATUS) {
      window.__GS_STATUS(
        `Region too wide to load variants (> ${capTxt}). Zoom in to see variants.`,
        { autoHide: 7000 });
    }
  }
  if (typeof gsSyncLocusBar === "function") gsSyncLocusBar();
  if (typeof updateDocumentTitle === "function") updateDocumentTitle();
  if (typeof renderAll === "function") renderAll();
  if (typeof gsLoadDataTracksForViewport === "function") gsLoadDataTracksForViewport();
}

if (typeof window !== "undefined") {
  window.gsSwitchContig = gsSwitchContig;
  window.__GS_TEST_requestNavigate = (contig, start, end) => gsRequestNavigate(contig, start, end);
  window.gsPopulateContigSelect = gsPopulateContigSelect;
  window.gsAnnotationFeatures = gsAnnotationFeatures;
  window.gsSetAnnotationTrack = gsSetAnnotationTrack;
  window.gsApplyNavigatePayload = gsApplyNavigatePayload;
}
