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
    stop: &u64
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

    let mut mask = HashMap::new();

    let rg_sm_map = get_rg_to_sm_mapping(bam);

    let _ = bam.fetch(((*chr).as_bytes(), *start, *stop));
    for (_, r) in bam.records().enumerate() {
        let record = r?;

        let hap = match record.aux(b"HP") {
            Ok(Aux::I32(val)) => val,
            _ => 0,
        };

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

        let mut ref_pos: u32 = (record.reference_start() as u32) + 1;
        let mut read_pos: u32 = 1;
        for (idx, c) in record.cigar().iter().enumerate() {
            match c {
                Cigar::Match(len) => {
                    // Handle Match case (consumes query, ref)
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
            Series::new("column_width", column_width)
        ]
    ).unwrap();

    Ok(df)
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
