use anyhow::Result;
use std::collections::HashMap;
use url::Url;

use polars::prelude::*;

use rust_htslib::bam::record::{ Aux, Cigar };
use rust_htslib::bam::{ self, Read, IndexedReader, ext::BamRecordExtensions };

#[derive(Debug, PartialEq)]
pub enum ElementType {
    READ,
    DIFF,
    INSERTION,
    DELETION,
    SOFTCLIP,
}

impl ElementType {
    pub fn to_u8(&self) -> u8 {
        match self {
            ElementType::READ => 0,
            ElementType::DIFF => 1,
            ElementType::INSERTION => 2,
            ElementType::DELETION => 3,
            ElementType::SOFTCLIP => 4,
        }
    }
}

/// Reference positions (1-based) of single-base mismatches (SNPs) encoded in an
/// MD tag, walked from `ref_start` (1-based, matching `ref_pos`). In an MD tag a
/// number = that many matched bases, a letter = one mismatch (the letter is the
/// REFERENCE base; the read base differs), and `^SEQ` = a deletion of those ref
/// bases. Insertions/soft-clips don't appear in MD (they don't consume the
/// reference), so the walk stays aligned with `ref_pos`. This lets us surface
/// SNPs for ordinary `M`-CIGAR reads, not just the rare `=`/`X` extended CIGAR.
fn md_mismatch_positions(md: &str, ref_start: u32) -> Vec<u32> {
    let mut out = Vec::new();
    let b = md.as_bytes();
    let mut refp = ref_start;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_digit() {
            let mut n: u32 = 0;
            while i < b.len() && b[i].is_ascii_digit() {
                n = n.saturating_mul(10).saturating_add((b[i] - b'0') as u32);
                i += 1;
            }
            refp = refp.saturating_add(n);
        } else if c == b'^' {
            i += 1; // deletion: skip the ^ and the deleted ref bases
            while i < b.len() && b[i].is_ascii_alphabetic() {
                refp = refp.saturating_add(1);
                i += 1;
            }
        } else if c.is_ascii_alphabetic() {
            out.push(refp); // a mismatch at this ref position
            refp = refp.saturating_add(1);
            i += 1;
        } else {
            i += 1; // ignore anything unexpected
        }
    }
    out
}

/// Reference-based SNP calls for one `M` CIGAR run when the read has no MD tag.
/// Compares read query bases to the staged reference and returns, per mismatch,
/// `(genomic_pos_1based, read_base_uppercased)`. Coordinates are all 1-based to
/// match `ref_pos`/`read_pos` in `extract_reads`. Positions whose reference base
/// isn't covered by `ref_seq`, or where either base is `N`, are skipped.
///
/// - `read_bases`: the full query sequence (`record.seq().as_bytes()`), 0-indexed.
/// - `run_read_start`/`run_ref_start`: 1-based query/genomic pos of the run's 1st base.
/// - `ref_seq_start`: 1-based genomic pos of `ref_seq[0]`.
fn ref_mismatches_in_run(
    read_bases: &[u8],
    run_read_start: u32,
    run_ref_start: u32,
    run_len: u32,
    ref_seq: &[u8],
    ref_seq_start: u32,
) -> Vec<(u32, u8)> {
    let mut out = Vec::new();
    for k in 0..run_len {
        let gpos = run_ref_start + k; // 1-based genomic position
        let refidx = (gpos as i64) - (ref_seq_start as i64);
        let ridx = (run_read_start as usize - 1) + k as usize;
        if refidx < 0 || (refidx as usize) >= ref_seq.len() || ridx >= read_bases.len() {
            continue;
        }
        let read_b = read_bases[ridx].to_ascii_uppercase();
        let ref_b = ref_seq[refidx as usize].to_ascii_uppercase();
        if read_b != ref_b && ref_b != b'N' && read_b != b'N' {
            out.push((gpos, read_b));
        }
    }
    out
}

#[cfg(test)]
mod md_tests {
    use super::{md_mismatch_positions, ref_mismatches_in_run};

    #[test]
    fn parses_matches_mismatches_and_deletions() {
        // "10A5" -> mismatch after 10 matches, starting at ref 100 -> pos 110.
        assert_eq!(md_mismatch_positions("10A5", 100), vec![110]);
        // Two mismatches: "3C0T4" -> pos 103 (C), then 104 (T, 0 matches between).
        assert_eq!(md_mismatch_positions("3C0T4", 100), vec![103, 104]);
        // Deletion consumes ref but is not a mismatch: "5^AC5G3" -> G at 5+2+5=112.
        assert_eq!(md_mismatch_positions("5^AC5G3", 100), vec![112]);
        // All match -> none.
        assert_eq!(md_mismatch_positions("150", 100), Vec::<u32>::new());
    }

    #[test]
    fn ref_diff_finds_snps_with_correct_coords() {
        // Reference "ACGTACGT" starting at genomic pos 100 => pos 100..=107.
        let refseq = b"ACGTACGT";
        // Read aligned at genomic 100 (read_pos 1), full 8bp M run, one mismatch:
        // read[2]='A' vs ref[2]='G' at genomic 102.
        let read = b"ACATACGT";
        assert_eq!(
            ref_mismatches_in_run(read, 1, 100, 8, refseq, 100),
            vec![(102u32, b'A')]
        );
        // Soft-clip offset: run starts at query base 4 (run_read_start=4) and
        // genomic 100. ridx 3,4,5,6 = A,T,T,G vs ref A,C,G,T => mismatches at
        // 101(T), 102(T), 103(G); the leading A@100 matches.
        let read2 = b"NNNATTGT";
        assert_eq!(
            ref_mismatches_in_run(read2, 4, 100, 4, refseq, 100),
            vec![(101u32, b'T'), (102u32, b'T'), (103u32, b'G')]
        );
        // N in reference or read is never a SNP.
        assert_eq!(
            ref_mismatches_in_run(b"AN", 1, 100, 2, b"AC", 100),
            Vec::<(u32, u8)>::new()
        );
        // Out-of-window positions are skipped (ref shorter than run).
        assert_eq!(
            ref_mismatches_in_run(b"TT", 1, 100, 2, b"A", 100),
            vec![(100u32, b'T')]
        );
    }
}

fn get_rg_to_sm_mapping(bam: &IndexedReader) -> HashMap<String, String> {
    let header = bam::Header::from_template(bam.header());

    let rg_sm_map: HashMap<String, String> = header
        .to_hashmap()
        .into_iter()
        .flat_map(|(_, records)| records)
        .filter(|record| record.contains_key("ID") && record.contains_key("SM"))
        .map(|record| (record["ID"].to_owned(), record["SM"].to_owned()))
        .collect();

    rg_sm_map
}

fn layout(df_in: &DataFrame) -> HashMap<u32, usize> {
    let df = df_in.sort(&["sample_name", "query_name", "reference_start"], false, true).unwrap();

    let sample_names = df.column("sample_name").unwrap().str().unwrap();
    let reference_starts = df.column("reference_start").unwrap().u32().unwrap();
    let reference_ends = df.column("reference_end").unwrap().u32().unwrap();
    let element_types = df.column("element_type").unwrap().u8().unwrap();
    let sequence = df.column("sequence").unwrap().str().unwrap();

    let mut cur_sample_name = "";
    let mut cur_sample_index: i32 = -1;
    let mut mask = HashMap::new();

    for i in 0..reference_starts.len() {
        let sample_name = sample_names.get(i).unwrap();
        if cur_sample_name != sample_name {
            cur_sample_name = sample_name;
            cur_sample_index += 1;

            let cur_sample_name_series = Series::new("", vec![cur_sample_name; df.height()]);
            let mask = df
                .filter(&df["sample_name"].equal(&cur_sample_name_series).unwrap())
                .unwrap();
        }

        if cur_sample_index >= 0 {
            let reference_start = reference_starts.get(i).unwrap();
            let reference_end = reference_ends.get(i).unwrap();
            let element_type = element_types.get(i).unwrap();
            let sequence = sequence.get(i).unwrap();
            let sequence_length = if element_type == 3 {
                (reference_end - reference_start) as usize
            } else {
                sequence.len()
            };

            if element_type > 0 {
                mask.entry(reference_start)
                    .and_modify(|e| {
                        *e = std::cmp::max(*e, sequence_length);
                    })
                    .or_insert(sequence_length);
            }
        }
    }

    for (key, value) in &mask {
        println!("{}: {}", key, value);
    }

    mask
}

pub fn extract_reads(
    bam: &mut IndexedReader,
    reads_url: &Url,
    cohort: &String,
    chr: &String,
    start: &u64,
    stop: &u64,
    ref_seq: Option<&[u8]>,   // reference bases covering [ref_seq_start, ...], uppercased
    ref_seq_start: u32        // 1-based genomic position of ref_seq[0]
) -> Result<DataFrame> {
    let mut chunks = Vec::new();
    let mut cohorts = Vec::new();
    let mut bam_paths = Vec::new();
    let mut reference_contigs = Vec::new();
    let mut reference_starts = Vec::new();
    let mut reference_ends = Vec::new();
    let mut is_forwards = Vec::new();
    let mut query_names = Vec::new();
    let mut haplotypes = Vec::new();
    let mut read_groups = Vec::new();
    let mut sample_names = Vec::new();
    let mut element_types = Vec::new();
    let mut sequence = Vec::new();
    let mut has_md = Vec::new();  // per-element: did this read carry an MD tag (=> SNPs computable)?

    let mut mask = HashMap::new();

    let rg_sm_map = get_rg_to_sm_mapping(bam);

    let _ = bam.fetch(((*chr).as_bytes(), *start, *stop));
    for (_, r) in bam.records().enumerate() {
        let record = r?;

        let hap = match record.aux(b"HP") {
            Ok(Aux::I32(val)) => val,
            _ => 0,
        };

        // Mismatch (SNP) positions from the MD tag, so ordinary M-CIGAR reads show
        // SNPs (not just =/X extended-CIGAR reads). read_has_md drives the "SNPs
        // unavailable" warning when a BAM lacks MD.
        let read_has_md;
        let md_mm: Vec<u32> = match record.aux(b"MD") {
            Ok(Aux::String(s)) => {
                read_has_md = true;
                md_mismatch_positions(s, (record.reference_start() as u32) + 1)
            }
            _ => { read_has_md = false; Vec::new() }
        };
        // "SNPs displayable" for this read: true if it carries MD, or if a
        // staged reference was supplied to diff M-run bases against.
        let snps_displayable = read_has_md || ref_seq.is_some();

        reference_contigs.push(chr.to_owned());
        reference_starts.push((record.reference_start() as u32) + 1);
        reference_ends.push(record.reference_end() as u32);
        is_forwards.push(!record.is_reverse());
        query_names.push(String::from_utf8_lossy(record.qname()).into_owned());
        haplotypes.push(hap);

        if let Ok(Aux::String(rg)) = record.aux(b"RG") {
            read_groups.push(rg.to_owned());
            sample_names.push(rg_sm_map.get(rg).unwrap().to_owned());
        } else {
            read_groups.push("unknown".to_string());
            sample_names.push("unknown".to_string());
        }

        element_types.push(ElementType::READ);
        sequence.push(String::from_utf8_lossy(&[]).into_owned());
        has_md.push(snps_displayable);

        let mut ref_pos: u32 = (record.reference_start() as u32) + 1;
        let mut read_pos: u32 = 1;
        for (idx, c) in record.cigar().iter().enumerate() {
            match c {
                Cigar::Match(len) => {
                    // Handle Match case (consumes query, ref). M merges match+
                    // mismatch, so emit a DIFF per MD-tag mismatch inside this run.
                    for &mpos in &md_mm {
                        if mpos >= ref_pos && mpos < ref_pos + len {
                            let ridx = (read_pos as usize - 1) + (mpos - ref_pos) as usize;
                            if ridx < record.seq().len() {
                                let cigar_seq: &[u8] = &[record.seq()[ridx]];
                                reference_contigs.push(chr.to_owned());
                                reference_starts.push(mpos);
                                reference_ends.push(mpos + 1);
                                is_forwards.push(!record.is_reverse());
                                query_names.push(String::from_utf8_lossy(record.qname()).into_owned());
                                haplotypes.push(hap);
                                if let Ok(Aux::String(rg)) = record.aux(b"RG") {
                                    read_groups.push(rg.to_owned());
                                    sample_names.push(rg_sm_map.get(rg).unwrap().to_owned());
                                } else {
                                    read_groups.push("unknown".to_string());
                                    sample_names.push("unknown".to_string());
                                }
                                element_types.push(ElementType::DIFF);
                                sequence.push(String::from_utf8_lossy(cigar_seq).into_owned());
                                has_md.push(read_has_md);
                                mask.entry(mpos).and_modify(|e| { *e = std::cmp::max(*e, 1); }).or_insert(1);
                            }
                        }
                    }
                    // No MD tag => diff read bases against the staged reference
                    // to still surface SNPs (many BAMs ship without MD).
                    if !read_has_md {
                        if let Some(rseq) = ref_seq {
                            let read_bytes = record.seq().as_bytes();
                            for (mpos, read_b) in
                                ref_mismatches_in_run(&read_bytes, read_pos, ref_pos, *len, rseq, ref_seq_start)
                            {
                                let cigar_seq: &[u8] = &[read_b];
                                reference_contigs.push(chr.to_owned());
                                reference_starts.push(mpos);
                                reference_ends.push(mpos + 1);
                                is_forwards.push(!record.is_reverse());
                                query_names.push(String::from_utf8_lossy(record.qname()).into_owned());
                                haplotypes.push(hap);
                                if let Ok(Aux::String(rg)) = record.aux(b"RG") {
                                    read_groups.push(rg.to_owned());
                                    sample_names.push(rg_sm_map.get(rg).unwrap().to_owned());
                                } else {
                                    read_groups.push("unknown".to_string());
                                    sample_names.push("unknown".to_string());
                                }
                                element_types.push(ElementType::DIFF);
                                sequence.push(String::from_utf8_lossy(cigar_seq).into_owned());
                                // Reference-derived SNP is displayable => mark true so
                                // the "SNPs unavailable" warning isn't raised.
                                has_md.push(true);
                                mask.entry(mpos).and_modify(|e| { *e = std::cmp::max(*e, 1); }).or_insert(1);
                            }
                        }
                    }
                    ref_pos += len;
                    read_pos += len;
                }
                Cigar::Ins(len) => {
                    // Handle Insertion case (consumes query)
                    let cigar_start = (read_pos as usize) - 1;
                    let cigar_end = ((read_pos + *len) as usize) - 1;
                    let cigar_seq = &record.seq().as_bytes()[cigar_start..cigar_end];

                    reference_contigs.push(chr.to_owned());
                    reference_starts.push(ref_pos - 1);
                    reference_ends.push(ref_pos);
                    is_forwards.push(!record.is_reverse());
                    query_names.push(String::from_utf8_lossy(record.qname()).into_owned());
                    haplotypes.push(hap);

                    if let Ok(Aux::String(rg)) = record.aux(b"RG") {
                        read_groups.push(rg.to_owned());
                        sample_names.push(rg_sm_map.get(rg).unwrap().to_owned());
                    } else {
                        read_groups.push("unknown".to_string());
                        sample_names.push("unknown".to_string());
                    }

                    element_types.push(ElementType::INSERTION);
                    sequence.push(String::from_utf8_lossy(cigar_seq).into_owned());
                    has_md.push(read_has_md);

                    mask.entry(ref_pos - 1)
                        .and_modify(|e| {
                            *e = std::cmp::max(*e, cigar_seq.len());
                        })
                        .or_insert(cigar_seq.len());

                    read_pos += len;
                }
                Cigar::Del(len) => {
                    // Handle Deletion case (consumes ref)
                    reference_contigs.push(chr.to_owned());
                    reference_starts.push(ref_pos);
                    reference_ends.push(ref_pos + *len);
                    is_forwards.push(!record.is_reverse());
                    query_names.push(String::from_utf8_lossy(record.qname()).into_owned());
                    haplotypes.push(hap);

                    if let Ok(Aux::String(rg)) = record.aux(b"RG") {
                        read_groups.push(rg.to_owned());
                        sample_names.push(rg_sm_map.get(rg).unwrap().to_owned());
                    } else {
                        read_groups.push("unknown".to_string());
                        sample_names.push("unknown".to_string());
                    }

                    element_types.push(ElementType::DELETION);
                    sequence.push(String::from_utf8_lossy(&[]).into_owned());
                    has_md.push(read_has_md);

                    mask.entry(ref_pos)
                        .and_modify(|e| {
                            *e = std::cmp::max(*e, *len as usize);
                        })
                        .or_insert(*len as usize);

                    ref_pos += len;
                }
                Cigar::Equal(len) => {
                    // Handle Equal case (consumes query, ref)
                    ref_pos += len;
                    read_pos += len;
                }
                Cigar::Diff(len) => {
                    // Handle Difference case (consumes query, ref)
                    let cigar_seq: &[u8] = &[record.seq()[(read_pos - 1) as usize]];

                    reference_contigs.push(chr.to_owned());
                    reference_starts.push(ref_pos);
                    reference_ends.push(ref_pos + 1);
                    is_forwards.push(!record.is_reverse());
                    query_names.push(String::from_utf8_lossy(record.qname()).into_owned());
                    haplotypes.push(hap);

                    if let Ok(Aux::String(rg)) = record.aux(b"RG") {
                        read_groups.push(rg.to_owned());
                        sample_names.push(rg_sm_map.get(rg).unwrap().to_owned());
                    } else {
                        read_groups.push("unknown".to_string());
                        sample_names.push("unknown".to_string());
                    }

                    element_types.push(ElementType::DIFF);
                    sequence.push(String::from_utf8_lossy(cigar_seq).into_owned());
                    has_md.push(read_has_md);

                    mask.entry(ref_pos)
                        .and_modify(|e| {
                            *e = std::cmp::max(*e, 1);
                        })
                        .or_insert(1);

                    ref_pos += len;
                    read_pos += len;
                }
                Cigar::RefSkip(len) => {
                    // Handle Reference Skip case (consumes ref)
                    ref_pos += len;
                }
                Cigar::SoftClip(len) => {
                    // Handle Soft Clip case (consumes query)
                    let mut adj_ref_pos = if idx == 0 { ref_pos - len } else { ref_pos };

                    for _ in 0..*len {
                        let cigar_seq: &[u8] = &[record.seq()[(read_pos - 1) as usize]];

                        reference_contigs.push(chr.to_owned());
                        reference_starts.push(adj_ref_pos);
                        reference_ends.push(adj_ref_pos + 1);
                        is_forwards.push(!record.is_reverse());
                        query_names.push(String::from_utf8_lossy(record.qname()).into_owned());
                        haplotypes.push(hap);

                        if let Ok(Aux::String(rg)) = record.aux(b"RG") {
                            read_groups.push(rg.to_owned());
                            sample_names.push(rg_sm_map.get(rg).unwrap().to_owned());
                        } else {
                            read_groups.push("unknown".to_string());
                            sample_names.push("unknown".to_string());
                        }

                        element_types.push(ElementType::SOFTCLIP);
                        sequence.push(String::from_utf8_lossy(cigar_seq).into_owned());
                        has_md.push(read_has_md);

                        mask.entry(ref_pos)
                            .and_modify(|e| {
                                *e = std::cmp::max(*e, cigar_seq.len());
                            })
                            .or_insert(cigar_seq.len());

                        read_pos += 1;
                        adj_ref_pos += 1;
                    }
                }
                Cigar::HardClip(_) => {
                    // Handle Hard Clip case (consumes nothing)
                }
                Cigar::Pad(_) => {
                    // Handle Padding case (consumes nothing)
                }
            }
        }
    }

    let mut column_width = Vec::new();
    for ref_start in &reference_starts {
        chunks.push(format!("{}:{}-{}", chr, start, stop));
        cohorts.push(cohort.to_owned());
        bam_paths.push(reads_url.to_string());
        column_width.push(*mask.get(ref_start).unwrap_or(&1) as u32);
    }

    let element_types: Vec<u8> = element_types
        .iter()
        .map(|e| e.to_u8())
        .collect();

    let df = DataFrame::new(
        vec![
            Series::new("chunk", chunks),
            Series::new("cohort", cohorts),
            Series::new("bam_path", bam_paths),
            Series::new("reference_contig", reference_contigs),
            Series::new("reference_start", reference_starts),
            Series::new("reference_end", reference_ends),
            Series::new("is_forward", is_forwards),
            Series::new("query_name", query_names),
            Series::new("haplotype", haplotypes),
            Series::new("read_group", read_groups),
            Series::new("sample_name", sample_names),
            Series::new("element_type", element_types),
            Series::new("sequence", sequence),
            Series::new("has_md", has_md),
            Series::new("column_width", column_width)
        ]
    ).unwrap();

    Ok(df)
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use rust_htslib::bam::record::CigarString;

    // Write a tiny single-read BAM (no MD tag) to a temp path, index it, and
    // return (path, url). Read: pos 100 (0-based) => 1-based 101, CIGAR 2S8M.
    // Query SEQ = "TT" softclip + "ACATAGGT" aligned. Against reference
    // "ACGTACGT" @ 101, the aligned run mismatches ref at 103 (G->A) and
    // 106 (C->G); the 2bp soft-clip must NOT shift those coords.
    fn write_no_md_bam() -> (std::path::PathBuf, Url) {
        let mut header = bam::Header::new();
        let mut sq = bam::header::HeaderRecord::new(b"SQ");
        sq.push_tag(b"SN", &"testchr");
        sq.push_tag(b"LN", &1000);
        header.push_record(&sq);

        let bam_path = std::env::temp_dir().join("gs_refsnp_integration_test.bam");
        {
            let mut w = bam::Writer::from_path(&bam_path, &header, bam::Format::Bam).unwrap();
            let mut rec = bam::Record::new();
            let cigar = CigarString(vec![Cigar::SoftClip(2), Cigar::Match(8)]);
            rec.set(b"read1", Some(&cigar), b"TTACATAGGT", &[30u8; 10]);
            rec.set_tid(0);
            rec.set_pos(100);
            rec.set_mapq(60);
            rec.set_mtid(-1);
            rec.set_mpos(-1);
            // Deliberately no MD aux tag.
            w.write(&rec).unwrap();
        }
        bam::index::build(&bam_path, None, bam::index::Type::Bai, 1).unwrap();
        let url = Url::from_file_path(&bam_path).unwrap();
        (bam_path, url)
    }

    // Pull (reference_start, base) for every DIFF (element_type==1) row.
    fn diffs(df: &DataFrame) -> Vec<(u32, String)> {
        let et = df.column("element_type").unwrap().u8().unwrap();
        let rs = df.column("reference_start").unwrap().u32().unwrap();
        let sq = df.column("sequence").unwrap();
        let mut out = Vec::new();
        for i in 0..df.height() {
            if et.get(i) == Some(1u8) {
                let base = match sq.get(i).unwrap() {
                    AnyValue::String(s) => s.to_string(),
                    AnyValue::StringOwned(s) => s.to_string(),
                    _ => String::new(),
                };
                out.push((rs.get(i).unwrap(), base));
            }
        }
        out.sort();
        out
    }

    #[test]
    fn extract_reads_calls_snps_from_reference_when_no_md() {
        let (_p, url) = write_no_md_bam();
        let mut bam = IndexedReader::from_path(url.to_file_path().unwrap()).unwrap();
        let cohort = String::from("all");
        let chr = String::from("testchr");

        // Reference window "ACGTACGT" whose first base is 1-based pos 101.
        let refseq = b"ACGTACGT";
        let df = extract_reads(&mut bam, &url, &cohort, &chr, &100u64, &110u64, Some(refseq), 101)
            .unwrap();

        // Exactly the two mismatches, at the right genomic coords with the read base.
        assert_eq!(diffs(&df), vec![(103u32, "A".to_string()), (106u32, "G".to_string())]);

        // READ element is flagged SNP-displayable (reference was supplied).
        let et = df.column("element_type").unwrap().u8().unwrap();
        let hm = df.column("has_md").unwrap().bool().unwrap();
        for i in 0..df.height() {
            if et.get(i) == Some(0u8) {
                assert_eq!(hm.get(i), Some(true), "READ row should be SNP-displayable");
            }
        }
    }

    #[test]
    fn extract_reads_emits_no_snps_without_md_or_reference() {
        let (_p, url) = write_no_md_bam();
        let mut bam = IndexedReader::from_path(url.to_file_path().unwrap()).unwrap();
        let cohort = String::from("all");
        let chr = String::from("testchr");

        // No MD tag and no reference => no SNP calls (indels/softclips still emitted).
        let df = extract_reads(&mut bam, &url, &cohort, &chr, &100u64, &110u64, None, 0).unwrap();
        assert_eq!(diffs(&df), Vec::<(u32, String)>::new());
    }
}

// #[cfg(test)]
// mod tests {
//     use crate::storage::gcs_authorize_data_access;

//     use super::*;

//     #[test]
//     fn test_extract_reads_manual() {
//         let cwd = std::env::current_dir().unwrap();
//         let test_read = String::from("src/tests/test_read.bam");
//         let bam_path = cwd.join(&test_read).to_str().unwrap().to_string();
//         let bam_url = Url::parse(&bam_path).unwrap();

//         let cohort = String::from("all");
//         let chr = String::from("chr2");
//         let start = 66409693;
//         let stop = 66410667;

//         let act_df = extract_reads(&bam_url, &cohort, chr, start, stop);

//         let exp_df = DataFrame::new(vec![
//             Series::new("bam_path", vec![bam_path.to_owned(), bam_path.to_owned(), bam_path.to_owned(), bam_path.to_owned(), bam_path.to_owned(), bam_path.to_owned(), bam_path.to_owned(), bam_path.to_owned(), bam_path.to_owned(), bam_path.to_owned(), bam_path.to_owned(), bam_path.to_owned(), bam_path.to_owned(), bam_path.to_owned()]),
//             Series::new("reference_contig", vec!["chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2"]),
//             Series::new("reference_start", vec![66409755, 66409752, 66409753, 66409754, 66409772, 66409778, 66409828, 66409987, 66410077, 66410118, 66410532, 66410603, 66410604, 66410605]),
//             Series::new("reference_end", vec![66410602, 66409753, 66409754, 66409755, 66409773, 66409779, 66409829, 66410056, 66410078, 66410119, 66410533, 66410604, 66410605, 66410606]),
//             Series::new("is_forward", vec![false, false, false, false, false, false, false, false, false, false, false, false, false, false]),
//             Series::new("query_name", vec!["1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1"]),
//             Series::new("read_group", vec!["test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test"]),
//             Series::new("sample_name", vec!["test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test"]),
//             Series::new("element_type", vec![0, 4, 4, 4, 1, 1, 1, 3, 2, 1, 1, 4, 4, 4]),
//             Series::new("sequence", vec!["", "G", "A", "C", "G", "C", "A", "", "TGATGCGCGCCATATAGCGATATATGACTATA", "C", "G", "C", "T", "G"]),
//             Series::new("column_width", vec!["", "G", "A", "C", "G", "C", "A", "", "TGATGCGCGCCATATAGCGATATATGACTATA", "C", "G", "C", "T", "G"])
//         ]).unwrap();

//         assert_eq!(exp_df, act_df);
//     }

//     #[test]
//     fn test_stage_data() {
//         let cache_path = std::env::temp_dir();

//         let cohort = "all".to_string();
//         let bam_paths: HashSet<(Url, String)> = [
//             (Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84175_231021_212604_s2/reads/ccs/aligned/m84175_231021_212604_s2.bam").unwrap(), cohort.to_owned()),
//             (Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84175_231021_215710_s3/reads/ccs/aligned/m84175_231021_215710_s3.bam").unwrap(), cohort.to_owned()),
//             (Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84175_231021_222816_s4/reads/ccs/aligned/m84175_231021_222816_s4.bam").unwrap(), cohort.to_owned())]
//             .iter().cloned().collect();

//         let chr: String = "chr15".to_string();
//         let start: u64 = 23960193;
//         let stop: u64 = 23963918;

//         let mut loci = HashSet::new();
//         loci.insert((chr, start, stop));

//         let r = stage_data(cache_path, &bam_paths, &loci, false);
//     }

//     // #[test]
//     // fn test_locus_should_be_fetched() {
//     //     let bam_paths: HashSet<_> = [
//     //         "gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84175_231021_212604_s2/reads/ccs/aligned/m84175_231021_212604_s2.bam".to_string(),
//     //         "gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84175_231021_215710_s3/reads/ccs/aligned/m84175_231021_215710_s3.bam".to_string(),
//     //         "gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84175_231021_222816_s4/reads/ccs/aligned/m84175_231021_222816_s4.bam".to_string()]
//     //         .iter().cloned().collect();

//     //     let chr: String = "chr15".to_string();
//     //     let start: u64 = 23960193;
//     //     let stop: u64 = 23963918;

//     //     let cache_path = std::env::temp_dir();
//     //     let result = locus_should_be_fetched(&cache_path, &chr, &start, &stop, &bam_paths);
//     // }
// }
