// Variant data: load from config or use demo data
// -----------------------------
let variants = [];
let loadedVariantTracks = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_tracks) || [];

function decodeBase64ToUint8Array(base64Text) {
  const binary = atob(base64Text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function maybeDecompressPayload(bytes, compression) {
  if (compression === "none" || !compression) {
    return bytes;
  }
  if (compression !== "gzip") {
    throw new Error(`Unsupported payload compression '${compression}'`);
  }
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Browser does not support DecompressionStream for gzip payloads");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const decompressed = await new Response(stream).arrayBuffer();
  return new Uint8Array(decompressed);
}

async function fetchVariantPayloadViaChunkedComms() {
  const supportsCompression = typeof DecompressionStream !== "undefined";
  const initResp = await sendCommMessage(
    "fetch_variant_payload_init",
    {
      view_id: window.GENOMESHADER_VIEW_ID,
      chunk_chars: 240000,
      accept_compression: supportsCompression,
    },
    120000
  );

  // Backward-compatible fallback: old backend may still return full payload directly.
  if (initResp && initResp.type === "fetch_variant_payload_response" && initResp.payload) {
    return initResp.payload;
  }
  if (!initResp || initResp.type !== "fetch_variant_payload_init_response") {
    if (initResp && initResp.type === "fetch_variant_payload_error") {
      throw new Error(initResp.error || "fetch_variant_payload_init failed");
    }
    throw new Error("Unexpected response to fetch_variant_payload_init");
  }

  const payloadToken = initResp.payload_token;
  const totalChunks = Number(initResp.total_chunks || 0);
  const compression = initResp.compression || "none";
  const payloadJsonBytes = Number(initResp.payload_json_bytes || 0);
  const payloadTransferBytes = Number(initResp.payload_transfer_bytes || 0);
  if (!payloadToken || !Number.isFinite(totalChunks) || totalChunks <= 0) {
    throw new Error("Invalid chunked payload metadata");
  }
  console.info("Genomeshader: variant payload transfer", {
    total_chunks: totalChunks,
    compression,
    payload_json_mb: payloadJsonBytes > 0 ? (payloadJsonBytes / (1024 * 1024)).toFixed(2) : "unknown",
    payload_transfer_mb: payloadTransferBytes > 0 ? (payloadTransferBytes / (1024 * 1024)).toFixed(2) : "unknown",
  });

  const parts = new Array(totalChunks);
  for (let i = 0; i < totalChunks; i++) {
    const chunkResp = await sendCommMessage(
      "fetch_variant_payload_chunk",
      {
        payload_token: payloadToken,
        chunk_index: i,
      },
      120000
    );
    if (!chunkResp || chunkResp.type !== "fetch_variant_payload_chunk_response") {
      if (chunkResp && chunkResp.type === "fetch_variant_payload_error") {
        throw new Error(chunkResp.error || `Chunk request failed at index ${i}`);
      }
      throw new Error(`Unexpected chunk response at index ${i}`);
    }
    parts[i] = chunkResp.chunk || "";
    if ((i + 1) % 20 === 0 || i + 1 === totalChunks) {
      console.info(`Genomeshader: received variant payload chunk ${i + 1}/${totalChunks}`);
    }
  }

  const b64 = parts.join("");
  const encodedBytes = decodeBase64ToUint8Array(b64);
  const payloadBytes = await maybeDecompressPayload(encodedBytes, compression);
  const payloadText = new TextDecoder("utf-8").decode(payloadBytes);
  return JSON.parse(payloadText);
}

// Prefer loading heavy variant payload via Jupyter comms (works in Terra).
if (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_payload_via_comm) {
  try {
    const payload = await fetchVariantPayloadViaChunkedComms();
    if (payload) {
      if (payload && Array.isArray(payload.variant_tracks)) {
        loadedVariantTracks = payload.variant_tracks;
        window.GENOMESHADER_CONFIG.variant_tracks = payload.variant_tracks;
      }
      if (payload && Array.isArray(payload.insertion_variants_lookup)) {
        window.GENOMESHADER_CONFIG.insertion_variants_lookup = payload.insertion_variants_lookup;
      }
      console.log("Loaded variant payload via Jupyter comms");
    }
  } catch (err) {
    console.warn("Failed to fetch variant payload via chunked comms, retrying legacy path:", err);
    try {
      const legacyResp = await sendCommMessage(
        "fetch_variant_payload",
        { view_id: window.GENOMESHADER_VIEW_ID },
        120000
      );
      if (legacyResp && legacyResp.type === "fetch_variant_payload_response" && legacyResp.payload) {
        const payload = legacyResp.payload;
        if (Array.isArray(payload.variant_tracks)) {
          loadedVariantTracks = payload.variant_tracks;
          window.GENOMESHADER_CONFIG.variant_tracks = payload.variant_tracks;
        }
        if (Array.isArray(payload.insertion_variants_lookup)) {
          window.GENOMESHADER_CONFIG.insertion_variants_lookup = payload.insertion_variants_lookup;
        }
        console.log("Loaded variant payload via legacy Jupyter comms");
      } else if (legacyResp && legacyResp.type === "fetch_variant_payload_error") {
        console.warn("Legacy variant payload fetch failed:", legacyResp.error);
      }
    } catch (legacyErr) {
      console.warn("Failed to fetch variant payload via legacy comms:", legacyErr);
    }
  }
}

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

function isInsertionPosWithinCurrentView(pos) {
  const posNum = Number(pos);
  if (!Number.isFinite(posNum) || !state) return false;
  return posNum >= state.startBp && posNum <= state.endBp;
}

function getTotalExpandedInsertionGapBp(expandedInsertions) {
  const expanded = expandedInsertions || (state && state.expandedInsertions);
  if (!expanded) return 0;

  if (insertionVariantsLookup && insertionVariantsLookup.length > 0) {
    let totalBp = 0;
    const countedIds = new Set();
    for (const entry of insertionVariantsLookup) {
      const id = String(entry.id);
      if (countedIds.has(id)) continue;
      if (!expanded.has(id)) continue;
      if (!isInsertionPosWithinCurrentView(entry.pos)) continue;
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
    if (expanded.has(id) && isInsertion(variant) && isInsertionPosWithinCurrentView(variant.pos)) {
      countedIds.add(id);
      totalBp += getInsertionGapBpForVariant(variant);
    }
  }
  return totalBp;
}

function getDisplayPxPerBp() {
  const pxPerBp = (state && Number.isFinite(state.pxPerBp) && state.pxPerBp > 0) ? state.pxPerBp : 1;
  const span = (state && Number.isFinite(state.endBp - state.startBp)) ? (state.endBp - state.startBp) : 0;
  if (!(span > 0)) return pxPerBp;
  const totalGapBp = getTotalExpandedInsertionGapBp(state && state.expandedInsertions);
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
  if (!expandedInsertions) return 0;
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

function getAccumulatedGapBp(bp, expandedInsertions) {
  if (!expandedInsertions) return 0;
  const viewStart = (state && Number.isFinite(state.startBp)) ? state.startBp : -Infinity;
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

// Genes: load from config or use empty array as fallback
// Note: transcripts_data now contains gene models (exon union) instead of individual transcripts
let transcripts = [];
if (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.transcripts_data) {
  const data = window.GENOMESHADER_CONFIG.transcripts_data;
  // Data should already be an array of gene model objects
  if (Array.isArray(data)) {
    transcripts = data;
    console.log(`Loaded ${transcripts.length} gene models for genes track`);
  } else {
    console.warn("Gene models data is not in expected array format:", data);
  }
} else {
  console.warn("No transcripts_data found in GENOMESHADER_CONFIG:", window.GENOMESHADER_CONFIG);
}

// RepeatMasker: load from config or use empty array as fallback
let repeats = [];
if (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.repeats_data) {
  const data = window.GENOMESHADER_CONFIG.repeats_data;
  // Data should already be an array of repeat objects with start, end, cls
  if (Array.isArray(data)) {
    repeats = data;
    console.log(`Loaded ${repeats.length} repeats for RepeatMasker track`);
  } else {
    console.warn("Repeats data is not in expected array format:", data);
  }
} else {
  console.warn("No repeats_data found in GENOMESHADER_CONFIG:", window.GENOMESHADER_CONFIG);
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

function gsWindowStoreUpdate(regions, newRegion, centerBp, keepSpan) {
  regions = Array.isArray(regions) ? regions.slice() : [];
  const nk = _gsRegionKey(newRegion);
  regions = regions.filter((r) => _gsRegionKey(r) !== nk);
  regions.push(newRegion);
  const kept = [], evicted = [];
  for (const r of regions) {
    const mid = (Number(r.start) + Number(r.end)) / 2;
    if (_gsRegionKey(r) !== nk && Math.abs(mid - centerBp) > keepSpan) evicted.push(r);
    else kept.push(r);
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
const GS_VP_OVERSCAN = 0.5;      // fetch viewport ± 50% on each side
const GS_VP_MAX_SPAN_BP = 1000000; // above this span, skip loading individual variants (zoom gate)
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
  // Keep windows whose center is within ~3 viewport spans of the current center.
  return Math.max(1, state.endBp - state.startBp) * 3;
}

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
  const reqKey = `${contig}:${win.start}-${win.end}`;
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
  try {
    const resp = await sendCommMessage("fetch_variants",
      { contig, start: win.start, end: win.end }, 300000);  // first cold remote open (downloads the index) can be minutes; the Rust reader cache makes every later window fast
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
      const upd = gsWindowStoreUpdate(_gsVpRegions, region, (vs + ve) / 2, _gsVpKeepSpan());
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
      if (Array.isArray(resp.transcripts_data)) {
        cfg.transcripts_data = resp.transcripts_data; transcripts = resp.transcripts_data;
      }
      if (Array.isArray(resp.repeats_data)) {
        cfg.repeats_data = resp.repeats_data; repeats = resp.repeats_data;
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
    console.warn("viewport variant load failed:", e);
    __GS_DEBUG("vp_fetch_error", { reqKey: reqKey, error: String(e && e.message || e) });
    const hint = (e && e.cause) ? String(e.cause)
      : "The connection to the kernel may have dropped or the request timed out. "
        + "Try again, or re-run the cell.";
    gsSeriousFailureModal(
      "Failed to load variants for this region. " + hint, "Variant load failed");
  } finally {
    if (_gsVpInFlight === reqKey) _gsVpInFlight = null;
    _gsVpStatusInFlight = Math.max(0, _gsVpStatusInFlight - 1);
    // Only clear the busy bar when the last overlapping load settles; a
    // success/failure message above (autoHide) supersedes it when shown.
    if (_gsVpStatusInFlight === 0 && window.__GS_STATUS) {
      const bar = document.getElementById("statusBar");
      if (bar && bar.classList.contains("indeterminate")) window.__GS_STATUS(false);
    }
  }
}

// Debounced trigger — called from the pan/zoom settle points.
function gsScheduleViewportVariantLoad(delay) {
  if (_gsVpTimer) clearTimeout(_gsVpTimer);
  _gsVpTimer = setTimeout(() => { _gsVpTimer = null; gsLoadVariantsForViewport(false); },
    delay == null ? 150 : delay);
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
  transcripts = [];
  repeats = [];
  cfg.reference_data = "";
  cfg.transcripts_data = [];
  cfg.repeats_data = [];
  _gsVpRegions = [];
  _gsVpData.clear();
  _gsVpRebuildTracks();
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
  gsResetRegionData();
  if (typeof updateDocumentTitle === "function") updateDocumentTitle();
  if (typeof renderAll === "function") renderAll();
  gsRequestNavigate(state.contig, Math.floor(state.startBp), Math.ceil(state.endBp));
}

async function gsRequestNavigate(contig, start, end) {
  if (typeof sendCommMessage !== "function") {
    if (typeof gsScheduleViewportVariantLoad === "function") gsScheduleViewportVariantLoad(0);
    return;
  }
  if (window.__GS_STATUS) {
    window.__GS_STATUS(
      `Loading ${contig}:${start.toLocaleString()}–${end.toLocaleString()}…`, { busy: true });
  }
  try {
    const resp = await sendCommMessage("navigate", { contig, start, end }, 30000);
    if (resp) gsApplyNavigatePayload(resp);
    if (window.__GS_STATUS) window.__GS_STATUS(false);
  } catch (e) {
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
  if (Array.isArray(p.transcripts_data)) {
    cfg.transcripts_data = p.transcripts_data;
    transcripts = p.transcripts_data;
  }
  if (Array.isArray(p.repeats_data)) {
    cfg.repeats_data = p.repeats_data;
    repeats = p.repeats_data;
  }
  if (Array.isArray(p.ideogram_data)) cfg.ideogram_data = p.ideogram_data;
  if (typeof p.start === "number" && typeof p.end === "number") {
    cfg.data_bounds = { start: p.start, end: p.end };
    dataBounds = { start: p.start, end: p.end };
  }
  if (Array.isArray(p.insertion_variants_lookup)) {
    cfg.insertion_variants_lookup = p.insertion_variants_lookup;
  }
  if (Array.isArray(p.variant_tracks)) {
    // Seed the viewport store with the new window so later pans union/evict off it.
    const region = { contig: state.contig, start: Math.floor(state.startBp), end: Math.ceil(state.endBp) };
    _gsVpRegions = [region];
    _gsVpData.clear();
    _gsVpData.set(_gsRegionKey(region), p.variant_tracks);
    _gsVpRebuildTracks();
  }
  if (typeof updateDocumentTitle === "function") updateDocumentTitle();
  if (typeof renderAll === "function") renderAll();
}

if (typeof window !== "undefined") {
  window.gsSwitchContig = gsSwitchContig;
  window.gsPopulateContigSelect = gsPopulateContigSelect;
  window.gsApplyNavigatePayload = gsApplyNavigatePayload;
}
