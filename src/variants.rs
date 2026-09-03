use anyhow::Result;
use std::collections::HashMap;

use polars::prelude::*;
use url::Url;

use rust_htslib::bcf::{
    header::{HeaderRecord, TagType},
    record::{GenotypeAllele, Numeric},
    IndexedReader,
    Read,
};
use rust_htslib::tbx;

use crate::env::{ gcs_authorize_data_access, local_guess_curl_ca_bundle };

/// Open a tabix (.tbi) index by URL with the same GCS-auth / CA-bundle retry
/// ladder as `open_url_with_fallbacks`.
fn open_tbx_with_fallbacks(url: &Url) -> Result<tbx::Reader> {
    match tbx::Reader::from_url(url) {
        Ok(r) => Ok(r),
        Err(_) => {
            gcs_authorize_data_access();
            match tbx::Reader::from_url(url) {
                Ok(r) => Ok(r),
                Err(_) => {
                    local_guess_curl_ca_bundle();
                    Ok(tbx::Reader::from_url(url)?)
                }
            }
        }
    }
}

/// Contigs that actually carry records in this variant file, read from its
/// tabix (.tbi) index. Cheap — reads the index, not the (potentially
/// 20k-sample) VCF header — and, unlike the header's `##contig` lines, lists
/// only sequences that have data. Powers per-contig query routing so a locus
/// opens only the file(s) that contain the contig, instead of every file in a
/// one-VCF-per-contig callset. Errs for files without a readable tabix index
/// (e.g. `.bcf`/`.csi`, or an explicit-index open); the caller then
/// always-queries those, so routing never drops data.
pub fn vcf_index_contigs(bcf_path: &str, index_path: Option<&str>) -> Result<Vec<String>> {
    // Explicit-index opens use htslib's `data##idx##index` composite, which the
    // tabix reader doesn't accept — let the caller always-query those.
    if index_path.is_some() {
        anyhow::bail!("explicit index: contig routing not derived via tabix");
    }
    let reader = if bcf_path.contains("://") {
        open_tbx_with_fallbacks(&Url::parse(bcf_path)?)?
    } else {
        tbx::Reader::from_path(bcf_path)?
    };
    Ok(reader.seqnames())
}

/// Open a URL with the same GCS-auth / CA-bundle retry ladder as the reads
/// path (see stage::open_bam).
fn open_url_with_fallbacks(url: &Url) -> Result<IndexedReader> {
    match IndexedReader::from_url(url) {
        Ok(r) => Ok(r),
        Err(_) => {
            gcs_authorize_data_access();
            match IndexedReader::from_url(url) {
                Ok(r) => Ok(r),
                Err(_) => {
                    local_guess_curl_ca_bundle();
                    Ok(IndexedReader::from_url(url)?)
                }
            }
        }
    }
}

/// Open a VCF/BCF for indexed (region-seekable) access. Remote gs:// URLs go
/// through from_url; local paths use from_path. Requires an index (.tbi/.csi).
///
/// When `index_path` is given, the file's index is not assumed adjacent — the
/// pair is handed to htslib via its `data##idx##index` convention. That path
/// must be opened through from_url (from_path rejects the composite via its
/// existence check), so local data is expressed as a file:// URL. Both data
/// and index may independently be local or gs://.
fn open_indexed_bcf(bcf_path: &str, index_path: Option<&str>) -> Result<IndexedReader> {
    let is_remote = bcf_path.contains("://");

    let index_path = match index_path {
        // No explicit index: preserve the plain adjacent-index open.
        None => {
            return if is_remote {
                open_url_with_fallbacks(&Url::parse(bcf_path)?)
            } else {
                Ok(IndexedReader::from_path(bcf_path)?)
            };
        }
        Some(idx) => idx,
    };

    // Explicit index -> build htslib's data##idx##index composite as a URL.
    let data_ref = if is_remote {
        bcf_path.to_string()
    } else {
        format!("file://{}", std::fs::canonicalize(bcf_path)?.to_string_lossy())
    };
    let index_ref = if index_path.contains("://") || is_remote {
        // remote index, or a local index paired with remote data: pass as-is
        // (htslib accepts a bare local path for the index side).
        index_path.to_string()
    } else {
        std::fs::canonicalize(index_path)?.to_string_lossy().to_string()
    };

    let composite = format!("{}##idx##{}", data_ref, index_ref);
    open_url_with_fallbacks(&Url::parse(&composite)?)
}

fn is_vector_end_i32(v: i32) -> bool {
    v == i32::MIN + 1
}

fn is_vector_end_f32(v: f32) -> bool {
    v.to_bits() == 0x7F80_0002
}

fn extract_filter_value(
    header: &rust_htslib::bcf::header::HeaderView,
    record: &rust_htslib::bcf::record::Record,
) -> String {
    let filters: Vec<String> = record
        .filters()
        .map(|fid| String::from_utf8_lossy(&header.id_to_name(fid)).to_string())
        .collect();
    if filters.is_empty() {
        "PASS".to_string()
    } else {
        filters.join(";")
    }
}

fn extract_info_value(
    header: &rust_htslib::bcf::header::HeaderView,
    record: &rust_htslib::bcf::record::Record,
    info_tags: &[String],
) -> String {
    let mut info_entries: Vec<String> = Vec::new();

    for tag in info_tags {
        let tag_bytes = tag.as_bytes();
        let tag_type = match header.info_type(tag_bytes) {
            Ok((ty, _)) => ty,
            Err(_) => continue,
        };

        match tag_type {
            TagType::Flag => {
                if record.info(tag_bytes).flag().unwrap_or(false) {
                    info_entries.push(tag.clone());
                }
            }
            TagType::Integer => {
                let val = match record.info(tag_bytes).integer() {
                    Ok(Some(v)) => v,
                    _ => continue,
                };
                let values: Vec<String> = val
                    .iter()
                    .take_while(|x| !is_vector_end_i32(**x))
                    .filter(|x| !x.is_missing())
                    .map(|x| x.to_string())
                    .collect();
                if !values.is_empty() {
                    info_entries.push(format!("{}={}", tag, values.join(",")));
                }
            }
            TagType::Float => {
                let val = match record.info(tag_bytes).float() {
                    Ok(Some(v)) => v,
                    _ => continue,
                };
                let values: Vec<String> = val
                    .iter()
                    .take_while(|x| !is_vector_end_f32(**x))
                    .filter(|x| !x.is_missing())
                    .map(|x| x.to_string())
                    .collect();
                if !values.is_empty() {
                    info_entries.push(format!("{}={}", tag, values.join(",")));
                }
            }
            TagType::String => {
                let val = match record.info(tag_bytes).string() {
                    Ok(Some(v)) => v,
                    _ => continue,
                };
                let values: Vec<String> = val
                    .iter()
                    .map(|x| String::from_utf8_lossy(x).to_string())
                    .filter(|x| !x.is_empty() && x != ".")
                    .collect();
                if !values.is_empty() {
                    info_entries.push(format!("{}={}", tag, values.join(",")));
                }
            }
        }
    }

    if info_entries.is_empty() {
        ".".to_string()
    } else {
        info_entries.join(";")
    }
}

/// Read the sample names from a VCF/BCF header (indexed open, region-agnostic).
pub fn vcf_sample_names(bcf_path: &str, index_path: Option<&str>) -> Result<Vec<String>> {
    let reader = open_indexed_bcf(bcf_path, index_path)?;
    Ok(reader
        .header()
        .samples()
        .iter()
        .map(|s| String::from_utf8_lossy(s).to_string())
        .collect())
}

pub fn extract_variants(
    bcf_path: &str,
    index_path: Option<&str>,
    samples: Option<&[String]>,
    chr: &String,
    start: &u64,
    stop: &u64
) -> Result<DataFrame> {
    // Open for indexed access so only the requested region is read off disk /
    // streamed from GCS — the callset may be a terabyte split per contig.
    let mut reader = open_indexed_bcf(bcf_path, index_path)?;

    // Get header to extract sample names
    let header = reader.header().clone();
    let sample_names: Vec<String> = header
        .samples()
        .iter()
        .map(|s| String::from_utf8_lossy(s).to_string())
        .collect();

    // Optional post-read sample subset. The region read is small, so the wall
    // is the per-(variant,sample) payload sent to the browser, not the decode;
    // filtering emitted rows here collapses a 20k-sample joint callset to the
    // requested handful without htslib set_samples (which the synced IndexedReader
    // doesn't expose).
    // ponytail: post-read filter; if wide-region decode CPU ever dominates,
    // switch to bcf_sr_set_samples (needs a patched rust-htslib).
    let sample_filter: Option<std::collections::HashSet<&str>> =
        samples.map(|s| s.iter().map(|x| x.as_str()).collect());
    let info_tags: Vec<String> = header
        .header_records()
        .iter()
        .filter_map(|rec| match rec {
            HeaderRecord::Info { values, .. } => values.get("ID").cloned(),
            _ => None,
        })
        .collect();
    
    let mut chromosomes = Vec::new();
    let mut positions = Vec::new();
    let mut ref_alleles = Vec::new();
    let mut alt_alleles = Vec::new();
    let mut sample_names_vec = Vec::new();
    let mut genotypes = Vec::new();
    let mut alt_indices = Vec::new();
    let mut variant_ids = Vec::new();
    let mut vcf_ids = Vec::new();
    let mut filter_statuses = Vec::new();
    let mut info_values = Vec::new();
    
    // Track unique variants (position + allele combination)
    let mut variant_map: HashMap<(u64, String, String), u32> = HashMap::new();
    let mut next_variant_id: u32 = 0;

    // Seek to the region via the index. name2rid errors when the contig isn't
    // in this file (e.g. a per-contig split) — treat that as "no variants here"
    // and fall through to an empty (correctly-typed) DataFrame. fetch is
    // 0-based half-open; our start/stop are 1-based inclusive.
    if let Ok(rid) = header.name2rid(chr.as_bytes()) {
        reader.fetch(rid, start.saturating_sub(1), Some(*stop))?;

        for record_result in reader.records() {
            let record: rust_htslib::bcf::record::Record = record_result?;

            let pos = record.pos() as u64 + 1; // Convert to 1-based

            // fetch overlaps can nudge past the window edges; keep the guard.
            if pos < *start || pos > *stop {
                continue;
            }

        // Get VCF ID from record (ID field)
        let vcf_id_bytes = record.id();
        let vcf_id_str = if vcf_id_bytes.is_empty() || (vcf_id_bytes.len() == 1 && vcf_id_bytes[0] == b'.') {
            None // No ID or just "." means missing
        } else {
            Some(String::from_utf8_lossy(&vcf_id_bytes).to_string())
        };
        let filter_value = extract_filter_value(&header, &record);
        let info_value = extract_info_value(&header, &record, &info_tags);
        
        // Get reference and alternate alleles
        let alleles = record.alleles();
        let ref_allele: String = String::from_utf8_lossy(alleles[0]).to_string();
        let alt_alleles_list: Vec<String> = alleles[1..]
            .iter()
            .map(|a| String::from_utf8_lossy(a).to_string())
            .collect();
        
        // Process each alternate allele as a separate variant
        for (alt_idx, alt_allele) in alt_alleles_list.iter().enumerate() {
            let alt_allele_str: String = alt_allele.clone();
            
            // Get or create variant ID
            let variant_id = *variant_map
                .entry((pos, ref_allele.clone(), alt_allele_str.clone()))
                .or_insert_with(|| {
                    let id = next_variant_id;
                    next_variant_id += 1;
                    id
                });
            
            // Get genotypes for all samples
            let genotypes_array = record.genotypes()?;
            
            for (sample_idx, sample_name) in sample_names.iter().enumerate() {
                // Skip samples outside the requested subset, if any.
                if let Some(filter) = &sample_filter {
                    if !filter.contains(sample_name.as_str()) {
                        continue;
                    }
                }

                // Get genotype (GT field) for this sample
                let gt = genotypes_array.get(sample_idx);
                
                // Format genotype as string: "0|1" (phased) or "0/1" (unphased)
                let gt_str = if gt.len() >= 2 {
                    let a1 = match gt[0] {
                        GenotypeAllele::Unphased(idx) | GenotypeAllele::Phased(idx) => idx.to_string(),
                        GenotypeAllele::UnphasedMissing | GenotypeAllele::PhasedMissing => ".".to_string(),
                    };
                    let a2 = match gt[1] {
                        GenotypeAllele::Unphased(idx) | GenotypeAllele::Phased(idx) => idx.to_string(),
                        GenotypeAllele::UnphasedMissing | GenotypeAllele::PhasedMissing => ".".to_string(),
                    };
                    let sep = match (&gt[0], &gt[1]) {
                        (GenotypeAllele::Phased(_) | GenotypeAllele::PhasedMissing, GenotypeAllele::Phased(_) | GenotypeAllele::PhasedMissing) => "|",
                        _ => "/",
                    };
                    format!("{}{}{}", a1, sep, a2)
                } else if gt.len() == 1 {
                    match gt[0] {
                        GenotypeAllele::Unphased(idx) | GenotypeAllele::Phased(idx) => idx.to_string(),
                        GenotypeAllele::UnphasedMissing | GenotypeAllele::PhasedMissing => "./.".to_string(),
                    }
                } else {
                    "./.".to_string()
                };
                
                // For Tube Map visualization, we need ALL samples and ALL genotype states
                // Include this sample regardless of whether it has the alternate allele
                chromosomes.push(chr.clone());
                positions.push(pos);
                ref_alleles.push(ref_allele.clone());
                alt_alleles.push(alt_allele_str.clone());
                sample_names_vec.push(sample_name.clone());
                genotypes.push(gt_str);
                alt_indices.push((alt_idx + 1) as i32);
                variant_ids.push(variant_id);
                vcf_ids.push(vcf_id_str.clone());
                filter_statuses.push(filter_value.clone());
                info_values.push(info_value.clone());
            }
        }
        }
    }

    let df = DataFrame::new(
        vec![
            Series::new("chromosome", chromosomes),
            Series::new("position", positions),
            Series::new("ref_allele", ref_alleles),
            Series::new("alt_allele", alt_alleles),
            Series::new("sample_name", sample_names_vec),
            Series::new("genotype", genotypes),
            Series::new("alt_index", alt_indices),
            Series::new("variant_id", variant_ids),
            Series::new("vcf_id", vcf_ids),
            Series::new("filter_status", filter_statuses),
            Series::new("info_fields", info_values),
        ]
    )?;
    
    Ok(df)
}

/// Aggregate variant extractor for LARGE cohorts (≥100k–1M samples). Emits ONE
/// row per (variant, alt) with per-allele SAMPLE counts computed during decode —
/// O(samples) counters, never the O(variants×samples) long-format that OOMs at
/// 1M. No per-sample genotypes cross the boundary (the browser only needs
/// aggregates; carriers come from `fetch_carriers`). Counts match the sample-set
/// semantics of the Python builder: a het 0/1 counts toward BOTH ref and its alt.
///
/// Columns: chromosome, position, ref_allele, alt_allele, alt_index, variant_id,
/// vcf_id, filter_status, info_fields, n_ref, n_alt, n_missing, n_samples.
pub fn extract_variant_aggregates(
    bcf_path: &str,
    index_path: Option<&str>,
    chr: &String,
    start: &u64,
    stop: &u64,
) -> Result<DataFrame> {
    let mut reader = open_indexed_bcf(bcf_path, index_path)?;
    let header = reader.header().clone();
    let n_samples = header.sample_count() as usize;
    let info_tags: Vec<String> = header
        .header_records()
        .iter()
        .filter_map(|rec| match rec {
            HeaderRecord::Info { values, .. } => values.get("ID").cloned(),
            _ => None,
        })
        .collect();

    let mut chromosomes = Vec::new();
    let mut positions = Vec::new();
    let mut ref_alleles = Vec::new();
    let mut alt_alleles = Vec::new();
    let mut alt_indices = Vec::new();
    let mut variant_ids = Vec::new();
    let mut vcf_ids = Vec::new();
    let mut filter_statuses = Vec::new();
    let mut info_values = Vec::new();
    let mut n_refs = Vec::new();
    let mut n_alts = Vec::new();
    let mut n_missings = Vec::new();
    let mut n_sampless = Vec::new();

    let mut variant_map: HashMap<(u64, String, String), u32> = HashMap::new();
    let mut next_variant_id: u32 = 0;

    if let Ok(rid) = header.name2rid(chr.as_bytes()) {
        reader.fetch(rid, start.saturating_sub(1), Some(*stop))?;
        for record_result in reader.records() {
            let record = record_result?;
            let pos = record.pos() as u64 + 1;
            if pos < *start || pos > *stop {
                continue;
            }
            let vcf_id_bytes = record.id();
            let vcf_id_str = if vcf_id_bytes.is_empty()
                || (vcf_id_bytes.len() == 1 && vcf_id_bytes[0] == b'.')
            {
                None
            } else {
                Some(String::from_utf8_lossy(&vcf_id_bytes).to_string())
            };
            let filter_value = extract_filter_value(&header, &record);
            let info_value = extract_info_value(&header, &record, &info_tags);

            let alleles = record.alleles();
            let ref_allele: String = String::from_utf8_lossy(alleles[0]).to_string();
            let n_alts_here = alleles.len().saturating_sub(1);

            // One decode of genotypes per record; tally per-allele SAMPLE counts.
            // present[k] += 1 once per sample that carries allele index k; missing
            // += 1 for any sample with a missing call.
            // Tally per-allele SAMPLE counts by scanning the RAW GT integer
            // buffer, not the Genotype API. `record.genotypes()` + `.get(i)`
            // constructs a `Genotype(Vec<GenotypeAllele>)` PER SAMPLE — a heap
            // allocation per sample per variant, the dominant decode cost at
            // 20k+ samples. `format(b"GT").integer()` gives one shared buffer of
            // per-sample i32 slices; we decode htslib's GT encoding inline:
            //   allele index = (v >> 1) - 1   (-1 => missing);
            //   v == i32::MIN (bcf_int32_vector_end) pads shorter ploidy -> stop.
            // Output is bit-identical to the Genotype-API loop (guarded by
            // aggregates_match_longformat_recompute).
            let gt_fmt = record.format(b"GT");
            let gts = gt_fmt.integer()?;
            let mut present = vec![0u32; n_alts_here + 1]; // index 0..=n_alts
            let mut missing = 0u32;
            let mut seen_alt = vec![false; n_alts_here + 1]; // scratch, hoisted
            for sample_idx in 0..n_samples {
                let slice = gts[sample_idx];
                let mut seen_ref = false;
                let mut seen_missing = false;
                for s in seen_alt.iter_mut() {
                    *s = false;
                }
                for &v in slice {
                    if v == i32::MIN {
                        break; // vector end: rest of this sample's slot is padding
                    }
                    let a = (v >> 1) - 1;
                    if a < 0 {
                        seen_missing = true;
                    } else if a == 0 {
                        seen_ref = true;
                    } else if (a as usize) <= n_alts_here {
                        seen_alt[a as usize] = true;
                    }
                }
                if seen_ref {
                    present[0] += 1;
                }
                for k in 1..=n_alts_here {
                    if seen_alt[k] {
                        present[k] += 1;
                    }
                }
                if seen_missing {
                    missing += 1;
                }
            }

            for (alt_idx, alt_allele) in alleles[1..].iter().enumerate() {
                let alt_allele_str = String::from_utf8_lossy(alt_allele).to_string();
                let variant_id = *variant_map
                    .entry((pos, ref_allele.clone(), alt_allele_str.clone()))
                    .or_insert_with(|| {
                        let id = next_variant_id;
                        next_variant_id += 1;
                        id
                    });
                chromosomes.push(chr.clone());
                positions.push(pos);
                ref_alleles.push(ref_allele.clone());
                alt_alleles.push(alt_allele_str);
                alt_indices.push((alt_idx + 1) as i32);
                variant_ids.push(variant_id);
                vcf_ids.push(vcf_id_str.clone());
                filter_statuses.push(filter_value.clone());
                info_values.push(info_value.clone());
                n_refs.push(present[0]);
                n_alts.push(present[alt_idx + 1]);
                n_missings.push(missing);
                n_sampless.push(n_samples as u32);
            }
        }
    }

    Ok(DataFrame::new(vec![
        Series::new("chromosome", chromosomes),
        Series::new("position", positions),
        Series::new("ref_allele", ref_alleles),
        Series::new("alt_allele", alt_alleles),
        Series::new("alt_index", alt_indices),
        Series::new("variant_id", variant_ids),
        Series::new("vcf_id", vcf_ids),
        Series::new("filter_status", filter_statuses),
        Series::new("info_fields", info_values),
        Series::new("n_ref", n_refs),
        Series::new("n_alt", n_alts),
        Series::new("n_missing", n_missings),
        Series::new("n_samples", n_sampless),
    ])?)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Committed fixture: chr1 variants at 100/200/300/400, samples S1+S2,
    // bgzipped + tabix-indexed (tests/fixtures/tiny.vcf.gz{,.tbi}).
    fn fixture() -> String {
        format!("{}/tests/fixtures/tiny.vcf.gz", env!("CARGO_MANIFEST_DIR"))
    }

    fn positions(df: &DataFrame) -> Vec<u64> {
        df.column("position").unwrap().u64().unwrap()
            .into_no_null_iter().collect()
    }

    #[test]
    fn aggregates_match_longformat_recompute() {
        // extract_variant_aggregates must produce the same per-allele SAMPLE
        // counts (ref/alt/missing) that you'd get by tallying the long-format
        // rows — proving the O(samples)-counter aggregation is correct.
        let (chr, s, e) = ("chr1".to_string(), 1u64, 1000u64);
        let long = extract_variants(&fixture(), None, None, &chr, &s, &e).unwrap();
        let agg = extract_variant_aggregates(&fixture(), None, &chr, &s, &e).unwrap();

        let pos = long.column("position").unwrap().u64().unwrap();
        let alt = long.column("alt_allele").unwrap().str().unwrap();
        let gt = long.column("genotype").unwrap().str().unwrap();
        let ai = long.column("alt_index").unwrap().i32().unwrap();
        use std::collections::HashMap;
        let mut nref: HashMap<(u64, String), u32> = HashMap::new();
        let mut nalt: HashMap<(u64, String), u32> = HashMap::new();
        let mut nmiss: HashMap<(u64, String), u32> = HashMap::new();
        for i in 0..long.height() {
            let key = (pos.get(i).unwrap(), alt.get(i).unwrap().to_string());
            let g = gt.get(i).unwrap();
            let this_ai = ai.get(i).unwrap();
            let (mut r, mut a, mut m) = (false, false, false);
            for t in g.split(|c| c == '/' || c == '|') {
                let t = t.trim();
                if t == "." || t.is_empty() {
                    m = true;
                } else if let Ok(k) = t.parse::<i32>() {
                    if k == 0 { r = true; } else if k == this_ai { a = true; }
                }
            }
            if r { *nref.entry(key.clone()).or_insert(0) += 1; }
            if a { *nalt.entry(key.clone()).or_insert(0) += 1; }
            if m { *nmiss.entry(key).or_insert(0) += 1; }
        }

        let apos = agg.column("position").unwrap().u64().unwrap();
        let aalt = agg.column("alt_allele").unwrap().str().unwrap();
        let arefc = agg.column("n_ref").unwrap().u32().unwrap();
        let aaltc = agg.column("n_alt").unwrap().u32().unwrap();
        let amissc = agg.column("n_missing").unwrap().u32().unwrap();
        assert_eq!(agg.height(), 4, "4 biallelic variants in the fixture");
        for i in 0..agg.height() {
            let key = (apos.get(i).unwrap(), aalt.get(i).unwrap().to_string());
            assert_eq!(arefc.get(i).unwrap(), *nref.get(&key).unwrap_or(&0), "n_ref {:?}", key);
            assert_eq!(aaltc.get(i).unwrap(), *nalt.get(&key).unwrap_or(&0), "n_alt {:?}", key);
            assert_eq!(amissc.get(i).unwrap(), *nmiss.get(&key).unwrap_or(&0), "n_missing {:?}", key);
        }
    }

    #[test]
    fn region_seek_returns_only_in_window_variants() {
        // Window 150..=350 covers positions 200 and 300 only. Two variants x
        // two samples = 4 rows; 100 and 400 must be excluded by the index seek.
        let df = extract_variants(&fixture(), None, None, &"chr1".to_string(), &150, &350).unwrap();
        assert_eq!(df.height(), 4, "expected 2 variants x 2 samples");
        let mut uniq: Vec<u64> = positions(&df);
        uniq.sort_unstable();
        uniq.dedup();
        assert_eq!(uniq, vec![200, 300]);
        assert!(positions(&df).iter().all(|p| (150..=350).contains(p)));
    }

    #[test]
    fn full_span_returns_all_variants() {
        // Sanity: a window covering everything yields all 4 variants (8 rows),
        // proving the region seek doesn't silently drop in-range records.
        let df = extract_variants(&fixture(), None, None, &"chr1".to_string(), &1, &1000).unwrap();
        assert_eq!(df.height(), 8);
    }

    #[test]
    fn absent_contig_is_empty_not_error() {
        // name2rid fails for a contig not in this (per-contig split) file; the
        // reader must return an empty, correctly-typed frame rather than panic.
        let df = extract_variants(&fixture(), None, None, &"chrZ".to_string(), &1, &1000).unwrap();
        assert_eq!(df.height(), 0);
        assert_eq!(df.get_column_names().len(), 11);
    }

    #[test]
    fn index_contigs_lists_data_sequences() {
        // Contig routing reads the sequences that actually have records from the
        // tabix index (not the header's ##contig lines). The fixture holds chr1.
        let contigs = vcf_index_contigs(&fixture(), None).unwrap();
        assert!(contigs.contains(&"chr1".to_string()), "got {contigs:?}");
        // An explicit index isn't derivable via the tabix reader -> Err, so the
        // caller always-queries that file.
        assert!(vcf_index_contigs(&fixture(), Some("x.tbi")).is_err());
    }

    #[test]
    fn explicit_index_with_nondefault_name() {
        // Index not adjacent-named: copy it to a custom filename and pass it
        // explicitly. Must region-seek identically to the adjacent-index case.
        let custom = std::env::temp_dir()
            .join(format!(
                "genomeshader-renamed-index-{}-{}.tbi",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
            ))
            .to_string_lossy().to_string();
        std::fs::copy(format!("{}/tests/fixtures/tiny.vcf.gz.tbi", env!("CARGO_MANIFEST_DIR")),
                      &custom).unwrap();
        let df = extract_variants(&fixture(), Some(&custom), None, &"chr1".to_string(), &150, &350).unwrap();
        let _ = std::fs::remove_file(&custom);
        assert_eq!(df.height(), 4);
        let mut uniq = positions(&df);
        uniq.sort_unstable();
        uniq.dedup();
        assert_eq!(uniq, vec![200, 300]);
    }

    #[test]
    fn sample_subset_emits_only_requested() {
        // Full span has 4 variants x 2 samples = 8 rows. Restrict to S1 -> 4
        // rows, all sample_name == "S1".
        let only_s1 = vec!["S1".to_string()];
        let df = extract_variants(&fixture(), None, Some(&only_s1),
                                  &"chr1".to_string(), &1, &1000).unwrap();
        assert_eq!(df.height(), 4);
        let names: Vec<String> = df.column("sample_name").unwrap().str().unwrap()
            .into_no_null_iter().map(String::from).collect();
        assert!(names.iter().all(|n| n == "S1"), "got {:?}", names);
    }

    #[test]
    fn vcf_sample_names_reads_header() {
        assert_eq!(vcf_sample_names(&fixture(), None).unwrap(),
                   vec!["S1".to_string(), "S2".to_string()]);
    }
}
