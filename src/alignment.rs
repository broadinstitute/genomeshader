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
    REFSKIP,
}

impl ElementType {
    pub fn to_u8(&self) -> u8 {
        match self {
            ElementType::READ => 0,
            ElementType::DIFF => 1,
            ElementType::INSERTION => 2,
            ElementType::DELETION => 3,
            ElementType::SOFTCLIP => 4,
            ElementType::REFSKIP => 5,
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
///
/// Extract_reads walks MD in lockstep with CIGAR (`MdWalker`) so intron skips
/// don't shift coordinates; this helper is the contiguous-ref case used in tests.
#[cfg(test)]
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

/// Walk an MD tag in lockstep with CIGAR so intron skips (`N`) don't shift
/// mismatch coordinates. MD does not encode `N`; a naive walk from POS treats
/// the exons as contiguous and places post-splice SNPs in the intron.
struct MdWalker<'a> {
    bytes: &'a [u8],
    i: usize,
    pending_matches: u32,
}

impl<'a> MdWalker<'a> {
    fn new(md: &'a str) -> Self {
        Self { bytes: md.as_bytes(), i: 0, pending_matches: 0 }
    }

    /// Genomic (1-based) mismatch positions inside a CIGAR `M`/`=`/`X` run.
    fn mismatches_in_match_run(&mut self, ref_pos: u32, len: u32) -> Vec<u32> {
        let mut out = Vec::new();
        let mut consumed = 0u32;
        while consumed < len {
            if self.pending_matches > 0 {
                let take = self.pending_matches.min(len - consumed);
                self.pending_matches -= take;
                consumed += take;
                continue;
            }
            if self.i >= self.bytes.len() {
                break;
            }
            let c = self.bytes[self.i];
            if c.is_ascii_digit() {
                let mut n: u32 = 0;
                while self.i < self.bytes.len() && self.bytes[self.i].is_ascii_digit() {
                    n = n.saturating_mul(10).saturating_add((self.bytes[self.i] - b'0') as u32);
                    self.i += 1;
                }
                self.pending_matches = n;
            } else if c == b'^' {
                self.skip_deletion();
            } else if c.is_ascii_alphabetic() {
                out.push(ref_pos + consumed);
                consumed += 1;
                self.i += 1;
            } else {
                self.i += 1;
            }
        }
        out
    }

    fn skip_deletion(&mut self) {
        if self.i < self.bytes.len() && self.bytes[self.i] == b'^' {
            self.i += 1;
        }
        while self.i < self.bytes.len() && self.bytes[self.i].is_ascii_alphabetic() {
            self.i += 1;
        }
    }
}

#[cfg(test)]
mod md_tests {
    use super::{md_mismatch_positions, ref_mismatches_in_run, MdWalker};

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

    #[test]
    fn md_walker_skips_introns() {
        // 10M + 5N + 10M with MD "10A9": mismatch is the first base of exon 2
        // (genomic 116), not the first intron base (111).
        let mut w = MdWalker::new("10A9");
        assert_eq!(w.mismatches_in_match_run(101, 10), Vec::<u32>::new());
        assert_eq!(w.mismatches_in_match_run(116, 10), vec![116]);
    }
}

pub fn get_rg_to_sm_mapping(bam: &IndexedReader) -> HashMap<String, String> {
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
    let mut is_paireds = Vec::new();
    let mut is_primaries = Vec::new();
    let mut is_secondaries = Vec::new();
    let mut is_supplementaries = Vec::new();
    let mut mapping_qualities = Vec::new();
    let mut insert_sizes = Vec::new();
    let mut clip_lengths = Vec::new();
    let mut mean_base_qualities = Vec::new();

    let mut mask = HashMap::new();

    let rg_sm_map = get_rg_to_sm_mapping(bam);

    let _ = bam.fetch(((*chr).as_bytes(), *start, *stop));
    for (_, r) in bam.records().enumerate() {
        let record = r?;
        let mapping_quality = record.mapq();
        let insert_size = record.insert_size();
        let clip_length: u32 = record.cigar().iter().map(|c| match c {
            Cigar::SoftClip(len) | Cigar::HardClip(len) => *len,
            _ => 0,
        }).sum();
        let mean_base_quality = if record.qual().is_empty() {
            0.0
        } else {
            record.qual().iter().map(|q| f32::from(*q)).sum::<f32>()
                / record.qual().len() as f32
        };

        let hap = match record.aux(b"HP") {
            // BAM packs small integers into the narrowest aux type. PacBio
            // haplotags (`HP:i:1`) are almost always i8 after samtools write.
            Ok(Aux::I8(val)) => i32::from(val),
            Ok(Aux::U8(val)) => i32::from(val),
            Ok(Aux::I16(val)) => i32::from(val),
            Ok(Aux::U16(val)) => i32::from(val),
            Ok(Aux::I32(val)) => val,
            Ok(Aux::U32(val)) => val as i32,
            _ => 0,
        };

        // Mismatch (SNP) positions from the MD tag, so ordinary M-CIGAR reads show
        // SNPs (not just =/X extended-CIGAR reads). Walk MD in lockstep with CIGAR
        // so N intron skips don't shift later mismatch coordinates. read_has_md
        // drives the "SNPs unavailable" warning when a BAM lacks MD.
        let md_owned: Option<String> = match record.aux(b"MD") {
            Ok(Aux::String(s)) => Some(s.to_owned()),
            _ => None,
        };
        let read_has_md = md_owned.is_some();
        let mut md_walker = md_owned.as_deref().map(MdWalker::new);
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
                    let md_mm: Vec<u32> = match md_walker.as_mut() {
                        Some(w) => w.mismatches_in_match_run(ref_pos, *len),
                        None => Vec::new(),
                    };
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

                    if let Some(w) = md_walker.as_mut() {
                        w.skip_deletion();
                    }

                    ref_pos += len;
                }
                Cigar::Equal(len) => {
                    // Handle Equal case (consumes query, ref)
                    if let Some(w) = md_walker.as_mut() {
                        let _ = w.mismatches_in_match_run(ref_pos, *len);
                    }
                    ref_pos += len;
                    read_pos += len;
                }
                Cigar::Diff(len) => {
                    // Handle Difference case (consumes query, ref)
                    if let Some(w) = md_walker.as_mut() {
                        let _ = w.mismatches_in_match_run(ref_pos, *len);
                    }
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
                    // Intron / reference skip (CIGAR N). Consumes ref, not query.
                    // Emitted so the viewer can split the read body and draw a
                    // splice connector instead of filling the intron.
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

                    element_types.push(ElementType::REFSKIP);
                    sequence.push(String::from_utf8_lossy(&[]).into_owned());
                    has_md.push(read_has_md);

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

        // Pairing flags are per-alignment; copy onto every CIGAR element row
        // of this record so the column lengths stay aligned.
        let paired = record.is_paired();
        let secondary = record.is_secondary();
        let supplementary = record.is_supplementary();
        let primary = !secondary && !supplementary;
        while is_paireds.len() < query_names.len() {
            is_paireds.push(paired);
            is_primaries.push(primary);
            is_secondaries.push(secondary);
            is_supplementaries.push(supplementary);
            mapping_qualities.push(mapping_quality);
            insert_sizes.push(insert_size);
            clip_lengths.push(clip_length);
            mean_base_qualities.push(mean_base_quality);
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
            Series::new("is_paired", is_paireds),
            Series::new("is_primary", is_primaries),
            Series::new("is_secondary", is_secondaries),
            Series::new("is_supplementary", is_supplementaries),
            Series::new("mapping_quality", mapping_qualities),
            Series::new("insert_size", insert_sizes),
            Series::new("clip_length", clip_lengths),
            Series::new("mean_base_quality", mean_base_qualities),
            Series::new("column_width", column_width)
        ]
    ).unwrap();

    Ok(df)
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use rust_htslib::bam::record::{Aux, CigarString};
    use std::sync::atomic::{AtomicU64, Ordering};

    // Unique path per call — shared fixed names race when cargo runs tests in parallel
    // (CI: BamNotIndexable when two writers truncate the same BAM mid-index).
    fn unique_temp_bam(stem: &str) -> std::path::PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "{}_{}_{}.bam",
            stem,
            std::process::id(),
            seq
        ))
    }

    // Write a tiny single-read BAM (no MD tag) to a temp path, index it, and
    // return (path, url). Read: pos 100 (0-based) => 1-based 101, CIGAR 2S8M.
    // Query SEQ = "TT" softclip + "ACATAGGT" aligned. Against reference
    // "ACGTACGT" @ 101, the aligned run mismatches ref at 103 (G->A) and
    // 106 (C->G); the 2bp soft-clip must NOT shift those coords.
    fn write_no_md_bam() -> (std::path::PathBuf, Url) {
        let mut header = bam::Header::new();
        header.push_record(
            bam::header::HeaderRecord::new(b"HD")
                .push_tag(b"VN", &"1.6")
                .push_tag(b"SO", &"coordinate"),
        );
        let mut sq = bam::header::HeaderRecord::new(b"SQ");
        sq.push_tag(b"SN", &"testchr");
        sq.push_tag(b"LN", &1000);
        header.push_record(&sq);

        let bam_path = unique_temp_bam("gs_refsnp_integration_test");
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
        let mq = df.column("mapping_quality").unwrap().u8().unwrap();
        let insert = df.column("insert_size").unwrap().i64().unwrap();
        let clips = df.column("clip_length").unwrap().u32().unwrap();
        let mean_bq = df.column("mean_base_quality").unwrap().f32().unwrap();
        for i in 0..df.height() {
            if et.get(i) == Some(0u8) {
                assert_eq!(hm.get(i), Some(true), "READ row should be SNP-displayable");
                assert_eq!(mq.get(i), Some(60));
                assert_eq!(insert.get(i), Some(0));
                assert_eq!(clips.get(i), Some(2));
                assert_eq!(mean_bq.get(i), Some(30.0));
                let secondary = df.column("is_secondary").unwrap().bool().unwrap();
                let supplementary = df.column("is_supplementary").unwrap().bool().unwrap();
                assert_eq!(secondary.get(i), Some(false));
                assert_eq!(supplementary.get(i), Some(false));
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

    #[test]
    fn extract_reads_decodes_hp_packed_as_u8() {
        // samtools packs `HP:i:1` as BAM type C (uint8). Matching only Aux::I32
        // silently dropped haplotags on every real HiFi BAM.
        let mut header = bam::Header::new();
        header.push_record(
            bam::header::HeaderRecord::new(b"HD")
                .push_tag(b"VN", &"1.6")
                .push_tag(b"SO", &"coordinate"),
        );
        let mut sq = bam::header::HeaderRecord::new(b"SQ");
        sq.push_tag(b"SN", &"testchr");
        sq.push_tag(b"LN", &1000);
        header.push_record(&sq);
        let bam_path = unique_temp_bam("gs_hp_u8_test");
        {
            let mut w = bam::Writer::from_path(&bam_path, &header, bam::Format::Bam).unwrap();
            let mut rec = bam::Record::new();
            let cigar = CigarString(vec![Cigar::Match(4)]);
            rec.set(b"hp2", Some(&cigar), b"ACGT", &[30u8; 4]);
            rec.set_tid(0);
            rec.set_pos(100);
            rec.set_mapq(60);
            rec.set_mtid(-1);
            rec.set_mpos(-1);
            rec.push_aux(b"HP", Aux::U8(2)).unwrap();
            w.write(&rec).unwrap();
        }
        bam::index::build(&bam_path, None, bam::index::Type::Bai, 1).unwrap();
        let url = Url::from_file_path(&bam_path).unwrap();
        let mut bam = IndexedReader::from_path(url.to_file_path().unwrap()).unwrap();
        let df = extract_reads(
            &mut bam, &url, &"all".to_string(), &"testchr".to_string(),
            &100u64, &110u64, None, 0,
        ).unwrap();
        let et = df.column("element_type").unwrap().u8().unwrap();
        let hap = df.column("haplotype").unwrap().i32().unwrap();
        let mut n = 0;
        for i in 0..df.height() {
            if et.get(i) == Some(0u8) {
                assert_eq!(hap.get(i), Some(2));
                n += 1;
            }
        }
        assert!(n >= 1);
    }

    #[test]
    fn extract_reads_emits_pairing_flags() {
        let mut header = bam::Header::new();
        header.push_record(
            bam::header::HeaderRecord::new(b"HD")
                .push_tag(b"VN", &"1.6")
                .push_tag(b"SO", &"coordinate"),
        );
        let mut sq = bam::header::HeaderRecord::new(b"SQ");
        sq.push_tag(b"SN", &"testchr");
        sq.push_tag(b"LN", &1000);
        header.push_record(&sq);
        let bam_path = unique_temp_bam("gs_pair_flags_test");
        {
            let mut w = bam::Writer::from_path(&bam_path, &header, bam::Format::Bam).unwrap();
            let cigar10 = CigarString(vec![Cigar::Match(10)]);

            let mut r1 = bam::Record::new();
            r1.set(b"pe", Some(&cigar10), b"ACGTACGTAC", &[30u8; 10]);
            r1.set_tid(0);
            r1.set_pos(100);
            r1.set_mapq(60);
            r1.set_mtid(0);
            r1.set_mpos(300);
            r1.set_paired();
            r1.set_first_in_template();
            w.write(&r1).unwrap();

            // Coordinate-sorted: 100, 150, 200, 300.
            let mut se = bam::Record::new();
            se.set(b"se", Some(&cigar10), b"CCCCCCCCCC", &[30u8; 10]);
            se.set_tid(0);
            se.set_pos(150);
            se.set_mapq(60);
            se.set_mtid(-1);
            se.set_mpos(-1);
            w.write(&se).unwrap();

            let mut supp = bam::Record::new();
            supp.set(b"pe", Some(&cigar10), b"GGGGGGGGGG", &[30u8; 10]);
            supp.set_tid(0);
            supp.set_pos(200);
            supp.set_mapq(60);
            supp.set_mtid(0);
            supp.set_mpos(100);
            supp.set_paired();
            supp.set_supplementary();
            w.write(&supp).unwrap();

            let mut r2 = bam::Record::new();
            r2.set(b"pe", Some(&cigar10), b"TGCATGCATG", &[30u8; 10]);
            r2.set_tid(0);
            r2.set_pos(300);
            r2.set_mapq(60);
            r2.set_mtid(0);
            r2.set_mpos(100);
            r2.set_paired();
            r2.set_last_in_template();
            r2.set_reverse();
            w.write(&r2).unwrap();
        }
        bam::index::build(&bam_path, None, bam::index::Type::Bai, 1).unwrap();
        let url = Url::from_file_path(&bam_path).unwrap();
        let mut bam = IndexedReader::from_path(url.to_file_path().unwrap()).unwrap();
        let df = extract_reads(
            &mut bam, &url, &"all".to_string(), &"testchr".to_string(),
            &100u64, &400u64, None, 0,
        ).unwrap();

        let et = df.column("element_type").unwrap().u8().unwrap();
        let qn = df.column("query_name").unwrap();
        let paired = df.column("is_paired").unwrap().bool().unwrap();
        let primary = df.column("is_primary").unwrap().bool().unwrap();
        let rs = df.column("reference_start").unwrap().u32().unwrap();

        let mut seen = Vec::new();
        for i in 0..df.height() {
            if et.get(i) != Some(0u8) {
                continue;
            }
            let name = match qn.get(i).unwrap() {
                AnyValue::String(s) => s.to_string(),
                AnyValue::StringOwned(s) => s.to_string(),
                _ => String::new(),
            };
            seen.push((
                name,
                rs.get(i).unwrap(),
                paired.get(i).unwrap(),
                primary.get(i).unwrap(),
            ));
        }
        seen.sort_by_key(|t| t.1);
        assert_eq!(
            seen,
            vec![
                ("pe".to_string(), 101u32, true, true),
                ("se".to_string(), 151u32, false, true),
                ("pe".to_string(), 201u32, true, false),
                ("pe".to_string(), 301u32, true, true),
            ]
        );
        assert_eq!(df.height(), paired.len());
        assert_eq!(df.height(), primary.len());
    }

    #[test]
    fn extract_reads_emits_refskip() {
        let mut header = bam::Header::new();
        header.push_record(
            bam::header::HeaderRecord::new(b"HD")
                .push_tag(b"VN", &"1.6")
                .push_tag(b"SO", &"coordinate"),
        );
        let mut sq = bam::header::HeaderRecord::new(b"SQ");
        sq.push_tag(b"SN", &"testchr");
        sq.push_tag(b"LN", &1000);
        header.push_record(&sq);
        let bam_path = unique_temp_bam("gs_refskip_test");
        {
            let mut w = bam::Writer::from_path(&bam_path, &header, bam::Format::Bam).unwrap();
            let mut rec = bam::Record::new();
            // 10M 5N 10M at 0-based 100 => exons 101-110 and 116-125, intron 111-115.
            let cigar = CigarString(vec![Cigar::Match(10), Cigar::RefSkip(5), Cigar::Match(10)]);
            rec.set(b"spl", Some(&cigar), b"ACGTACGTACAGTACGTACA", &[30u8; 20]);
            rec.set_tid(0);
            rec.set_pos(100);
            rec.set_mapq(60);
            rec.set_mtid(-1);
            rec.set_mpos(-1);
            rec.push_aux(b"MD", Aux::String("10A9")).unwrap();
            w.write(&rec).unwrap();
        }
        bam::index::build(&bam_path, None, bam::index::Type::Bai, 1).unwrap();
        let url = Url::from_file_path(&bam_path).unwrap();
        let mut bam = IndexedReader::from_path(url.to_file_path().unwrap()).unwrap();
        let df = extract_reads(
            &mut bam, &url, &"all".to_string(), &"testchr".to_string(),
            &100u64, &130u64, None, 0,
        ).unwrap();

        let et = df.column("element_type").unwrap().u8().unwrap();
        let rs = df.column("reference_start").unwrap().u32().unwrap();
        let re = df.column("reference_end").unwrap().u32().unwrap();

        let mut skips = Vec::new();
        let mut diffs = Vec::new();
        let mut reads = Vec::new();
        for i in 0..df.height() {
            match et.get(i) {
                Some(0u8) => reads.push((rs.get(i).unwrap(), re.get(i).unwrap())),
                Some(1u8) => diffs.push(rs.get(i).unwrap()),
                Some(5u8) => skips.push((rs.get(i).unwrap(), re.get(i).unwrap())),
                _ => {}
            }
        }
        assert_eq!(reads, vec![(101u32, 125u32)]);
        assert_eq!(skips, vec![(111u32, 116u32)]);
        // MD "10A9" mismatch is the first base of exon 2, not the intron.
        assert_eq!(diffs, vec![116u32]);
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
