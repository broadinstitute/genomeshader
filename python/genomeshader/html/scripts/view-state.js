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
