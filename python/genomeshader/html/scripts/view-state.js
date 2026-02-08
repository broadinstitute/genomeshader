// Variant data: load from config or use demo data
// -----------------------------
let variants = [];
// Prefer variant_tracks (one entry per variant dataset); fall back to legacy variants_data
if (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_tracks && window.GENOMESHADER_CONFIG.variant_tracks.length > 0) {
  // Use first track's data for global `variants` (used by code that expects a single list)
  variants = window.GENOMESHADER_CONFIG.variant_tracks[0].variants_data || [];
  console.log(`Loaded ${window.GENOMESHADER_CONFIG.variant_tracks.length} variant track(s) from config`);
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

// Optimized function to get accumulated gap pixels up to a position
// Uses binary search on precomputed sorted list for O(log n) performance
// Filters by expanded insertions at runtime (since that's dynamic state)
function getAccumulatedGapPx(bp, expandedInsertions) {
  if (!insertionVariantsLookup || insertionVariantsLookup.length === 0) {
    // Fallback to linear search if lookup table not available
    let accumulatedGapPx = 0;
    for (const variant of variants) {
      if (variant.pos < bp && expandedInsertions.has(variant.id) && isInsertion(variant)) {
        if (variant.hasOwnProperty('insertionGapPx')) {
          accumulatedGapPx += variant.insertionGapPx;
        } else {
          const maxInsertLen = getMaxInsertionLength(variant);
          accumulatedGapPx += maxInsertLen * 8;
        }
      }
    }
    return accumulatedGapPx;
  }

  // Binary search to find all insertion variants before position bp
  let left = 0;
  let right = insertionVariantsLookup.length - 1;
  let lastIndex = -1;
  
  // Find the rightmost insertion variant with pos < bp
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (insertionVariantsLookup[mid].pos < bp) {
      lastIndex = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  
  // Sum gaps for all variants up to lastIndex that are expanded
  let accumulatedGapPx = 0;
  for (let i = 0; i <= lastIndex; i++) {
    const lookupVariant = insertionVariantsLookup[i];
    if (expandedInsertions.has(lookupVariant.id)) {
      accumulatedGapPx += lookupVariant.insertionGapPx;
    }
  }
  
  return accumulatedGapPx;
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
