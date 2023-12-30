use std::collections::{HashSet, HashMap};
use std::env;
use std::path::PathBuf;
use std::sync::Mutex;

use rayon::iter::{ParallelIterator, IntoParallelRefIterator};
use indicatif::ParallelProgressIterator;

use polars::prelude::*;

use pyo3::{prelude::*, exceptions};
use pyo3_polars::PyDataFrame;

use rust_htslib::bam::record::{Aux, Cigar};
use rust_htslib::bam::{Read, IndexedReader, self, ext::BamRecordExtensions};

use crate::storage::gcs_authorize_data_access;

#[derive(Debug, PartialEq)]
enum ElementType {
    READ,
    DIFF,
    INSERTION,
    DELETION,
    SOFTCLIP
}

impl ElementType {
    fn to_u8(&self) -> u8 {
        match self {
            ElementType::READ => 0,
            ElementType::DIFF => 1,
            ElementType::INSERTION => 2,
            ElementType::DELETION => 3,
            ElementType::SOFTCLIP => 4,
        }
    }
}

fn extract_reads(bam_path: &String, chr: String, start: u64, stop: u64) -> DataFrame {
    let url = if bam_path.starts_with("file://") || bam_path.starts_with("gs://") {
        url::Url::parse(bam_path).unwrap()
    } else {
        url::Url::from_file_path(bam_path).unwrap()
    };

    let temp_dir = env::temp_dir();
    env::set_current_dir(&temp_dir).unwrap();

    let mut bam = IndexedReader::from_url(&url).unwrap();
    let header = bam::Header::from_template(bam.header());

    let mut rg_sm_map = HashMap::new();
    for (key, records) in header.to_hashmap() {
        for record in records {
            if record.contains_key("ID") && record.contains_key("SM") {
                rg_sm_map.insert(record["ID"].to_owned(), record["SM"].to_owned());
            }
        }
    }

    // let mut read_nums = Vec::new();
    let mut reference_contigs = Vec::new();
    let mut reference_starts = Vec::new();
    let mut reference_ends = Vec::new();
    let mut is_forwards = Vec::new();
    let mut query_names = Vec::new();
    let mut read_groups = Vec::new();
    let mut sample_names = Vec::new();
    let mut element_types = Vec::new();
    let mut sequence = Vec::new();

    bam.fetch((chr.as_bytes(), start, stop));
    for (i, r) in bam.records().enumerate() {
        let record = r.unwrap();

        reference_contigs.push(chr.to_owned());
        reference_starts.push(record.reference_start() as u32 + 1);
        reference_ends.push(record.reference_end() as u32);
        is_forwards.push(!record.is_reverse());
        query_names.push(String::from_utf8_lossy(record.qname()).into_owned());
        
        if let Ok(Aux::String(rg)) = record.aux(b"RG") {
            read_groups.push(rg.to_owned());
            sample_names.push(rg_sm_map.get(rg).unwrap().to_owned());
        } else {
            read_groups.push("unknown".to_string());
            sample_names.push("unknown".to_string());
        }

        element_types.push(ElementType::READ);
        sequence.push(String::from_utf8_lossy(&[]).into_owned());

        let mut ref_pos: u32 = record.reference_start() as u32 + 1;
        let mut read_pos: u32 = 1;
        for (idx, c) in record.cigar().iter().enumerate() {
            match c {
                Cigar::Match(len) => {
                    // Handle Match case (consumes query, ref)
                    ref_pos += len;
                    read_pos += len;
                },
                Cigar::Ins(len) => {
                    // Handle Insertion case (consumes query)
                    let start = read_pos as usize - 1;
                    let end = (read_pos + (*len)) as usize - 1;
                    let cigar_seq = &record.seq().as_bytes()[start..end];

                    reference_contigs.push(chr.to_owned());
                    reference_starts.push(ref_pos - 1);
                    reference_ends.push(ref_pos);
                    is_forwards.push(!record.is_reverse());
                    query_names.push(String::from_utf8_lossy(record.qname()).into_owned());

                    if let Ok(Aux::String(rg)) = record.aux(b"RG") {
                        read_groups.push(rg.to_owned());
                        sample_names.push(rg_sm_map.get(rg).unwrap().to_owned());
                    } else {
                        read_groups.push("unknown".to_string());
                        sample_names.push("unknown".to_string());
                    }

                    element_types.push(ElementType::INSERTION);
                    sequence.push(String::from_utf8_lossy(cigar_seq).into_owned());

                    read_pos += len;
                },
                Cigar::Del(len) => {
                    // Handle Deletion case (consumes ref)
                    reference_contigs.push(chr.to_owned());
                    reference_starts.push(ref_pos);
                    reference_ends.push(ref_pos + (*len));
                    is_forwards.push(!record.is_reverse());
                    query_names.push(String::from_utf8_lossy(record.qname()).into_owned());

                    if let Ok(Aux::String(rg)) = record.aux(b"RG") {
                        read_groups.push(rg.to_owned());
                        sample_names.push(rg_sm_map.get(rg).unwrap().to_owned());
                    } else {
                        read_groups.push("unknown".to_string());
                        sample_names.push("unknown".to_string());
                    }

                    element_types.push(ElementType::DELETION);
                    sequence.push(String::from_utf8_lossy(&[]).into_owned());

                    ref_pos += len;
                },
                Cigar::Equal(len) => {
                    // Handle Equal case (consumes query, ref)
                    ref_pos += len;
                    read_pos += len;
                },
                Cigar::Diff(len) => {
                    // Handle Difference case (consumes query, ref)
                    let cigar_seq: &[u8] = &[record.seq()[(read_pos - 1) as usize]];

                    reference_contigs.push(chr.to_owned());
                    reference_starts.push(ref_pos);
                    reference_ends.push(ref_pos + 1);
                    is_forwards.push(!record.is_reverse());
                    query_names.push(String::from_utf8_lossy(record.qname()).into_owned());

                    if let Ok(Aux::String(rg)) = record.aux(b"RG") {
                        read_groups.push(rg.to_owned());
                        sample_names.push(rg_sm_map.get(rg).unwrap().to_owned());
                    } else {
                        read_groups.push("unknown".to_string());
                        sample_names.push("unknown".to_string());
                    }

                    element_types.push(ElementType::DIFF);
                    sequence.push(String::from_utf8_lossy(cigar_seq).into_owned());

                    ref_pos += len;
                    read_pos += len;
                },
                Cigar::RefSkip(len) => {
                    // Handle Reference Skip case (consumes ref)
                    ref_pos += len;
                },
                Cigar::SoftClip(len) => {
                    // Handle Soft Clip case (consumes query)
                    let mut adj_ref_pos = if idx == 0 { ref_pos - len } else { ref_pos };

                    for i in 0..*len {
                        let cigar_seq: &[u8] = &[record.seq()[(read_pos - 1) as usize]];

                        reference_contigs.push(chr.to_owned());
                        reference_starts.push(adj_ref_pos);
                        reference_ends.push(adj_ref_pos + 1);
                        is_forwards.push(!record.is_reverse());
                        query_names.push(String::from_utf8_lossy(record.qname()).into_owned());

                        if let Ok(Aux::String(rg)) = record.aux(b"RG") {
                            read_groups.push(rg.to_owned());
                            sample_names.push(rg_sm_map.get(rg).unwrap().to_owned());
                        } else {
                            read_groups.push("unknown".to_string());
                            sample_names.push("unknown".to_string());
                        }

                        element_types.push(ElementType::SOFTCLIP);
                        sequence.push(String::from_utf8_lossy(cigar_seq).into_owned());

                        read_pos += 1;
                        adj_ref_pos += 1;
                    }
                },
                Cigar::HardClip(len) => {
                    // Handle Hard Clip case (consumes nothing)
                },
                Cigar::Pad(len) => {
                    // Handle Padding case (consumes nothing)
                },
            }
        }
    }

    let element_types: Vec<u8> = element_types.iter().map(|e| e.to_u8()).collect();

    let df = DataFrame::new(vec![
        // Series::new("read_num", read_nums),
        Series::new("reference_contig", reference_contigs),
        Series::new("reference_start", reference_starts),
        Series::new("reference_end", reference_ends),
        Series::new("is_forward", is_forwards),
        Series::new("query_name", query_names),
        Series::new("read_group", read_groups),
        Series::new("sample_name", sample_names),
        Series::new("element_type", element_types),
        Series::new("sequence", sequence)
    ]).unwrap();

    df
}

pub fn stage_data(cache_path: PathBuf, bam_paths: &HashSet<String>, loci: &HashSet<(String, u64, u64)>) -> Result<HashMap<(String, u64, u64), PathBuf>, Box<dyn std::error::Error>> {
    gcs_authorize_data_access();

    loci.par_iter()
        .progress_count(loci.len() as u64)
        .for_each(|l| {
            let dfs = Mutex::new(Vec::new());

            let (chr, start, stop) = l;
            bam_paths.par_iter()
                .for_each(|f| {
                    let df = extract_reads(f, chr.to_string(), *start, *stop);
                    dfs.lock().unwrap().push(df);
                });

            let mut outer_df = DataFrame::default();
            for df in dfs.lock().unwrap().iter() {
                outer_df.vstack_mut(&df).unwrap();
            }

            let filename = cache_path.join(format!("{}_{}_{}.parquet", chr, start, stop));
            let file = std::fs::File::create(&filename).unwrap();
            ParquetWriter::new(&file).finish(&mut outer_df).unwrap();
        });

    let mut locus_to_file = HashMap::new();
    for l in loci {
        let (chr, start, stop) = l;
        let filename = cache_path.join(format!("{}_{}_{}.parquet", chr, start, stop));

        locus_to_file.insert((chr.to_owned(), *start, *stop), filename);
    }

    Ok(locus_to_file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_reads_manual() {
        let cwd = std::env::current_dir().unwrap();
        let test_read = String::from("src/tests/test_read.bam");
        let bam_path = cwd.join(&test_read).to_str().unwrap().to_string();

        let chr = String::from("chr2");
        let start = 66409693;
        let stop = 66410667;

        let act_df = extract_reads(&bam_path, chr, start, stop);

        let exp_df = DataFrame::new(vec![
            Series::new("reference_contig", vec!["chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2", "chr2"]),
            Series::new("reference_start", vec![66409755, 66409752, 66409753, 66409754, 66409772, 66409778, 66409828, 66409987, 66410077, 66410118, 66410532, 66410603, 66410604, 66410605]),
            Series::new("reference_end", vec![66410602, 66409753, 66409754, 66409755, 66409773, 66409779, 66409829, 66410056, 66410078, 66410119, 66410533, 66410604, 66410605, 66410606]),
            Series::new("is_forward", vec![false, false, false, false, false, false, false, false, false, false, false, false, false, false]),
            Series::new("query_name", vec!["1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1"]),
            Series::new("read_group", vec!["test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test"]),
            Series::new("sample_name", vec!["test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test"]),
            Series::new("element_type", vec![0, 4, 4, 4, 1, 1, 1, 3, 2, 1, 1, 4, 4, 4]),
            Series::new("sequence", vec!["", "G", "A", "C", "G", "C", "A", "", "TGATGCGCGCCATATAGCGATATATGACTATA", "C", "G", "C", "T", "G"])
        ]).unwrap();

        assert_eq!(exp_df, act_df);
    }
}