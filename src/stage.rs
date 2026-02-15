use anyhow::Result;
use std::collections::{ HashSet, HashMap };
use std::env;
use std::path::PathBuf;
use url::Url;

use backoff::ExponentialBackoff;
use gag::Gag;
use polars::prelude::*;
use rayon::prelude::*;
use rust_htslib::bam::IndexedReader;

use crate::alignment::extract_reads;
use crate::env::{ gcs_authorize_data_access, local_guess_curl_ca_bundle };

pub fn open_bam(reads_url: &Url, cache_path: &PathBuf) -> Result<IndexedReader> {
    env::set_current_dir(cache_path).unwrap();

    let bam = match IndexedReader::from_url(reads_url) {
        Ok(bam) => bam,
        Err(_) => {
            gcs_authorize_data_access();

            match IndexedReader::from_url(reads_url) {
                Ok(bam) => bam,
                Err(_) => {
                    local_guess_curl_ca_bundle();

                    IndexedReader::from_url(reads_url)?
                }
            }
        }
    };

    Ok(bam)
}

fn stage_data_from_one_file(
    reads_url: &Url,
    cohort: &String,
    loci: &HashSet<(String, u64, u64)>,
    cache_path: &PathBuf
) -> Result<DataFrame> {
    let mut bam = open_bam(reads_url, cache_path)?;
    let mut outer_df = DataFrame::default();

    for (chr, start, stop) in loci.iter() {
        let df = extract_reads(&mut bam, reads_url, cohort, chr, start, stop)?;
        let _ = outer_df.vstack_mut(&df);
    }

    outer_df.align_chunks();

    Ok(outer_df)
}

fn stage_data_from_all_files(
    reads_cohort: &HashSet<(Url, String)>,
    loci: &HashSet<(String, u64, u64)>,
    cache_path: &PathBuf
) -> Result<Vec<DataFrame>> {
    let dfs: Vec<_> = reads_cohort
        .par_iter()
        .map(|(reads_url, cohort)| {
            let op = || {
                let df = stage_data_from_one_file(reads_url, cohort, loci, cache_path)?;
                Ok(df)
            };

            match backoff::retry(ExponentialBackoff::default(), op) {
                Ok(df) => { df }
                Err(e) => {
                    panic!("Error: {}", e);
                }
            }
        })
        .collect();

    Ok(dfs)
}

fn write_to_disk(
    dfs: Vec<DataFrame>,
    cache_path: &PathBuf
) -> Result<HashMap<(String, u64, u64), PathBuf>> {
    let mut outer_df = DataFrame::default();
    for df in dfs {
        outer_df.vstack_mut(&df).unwrap();
    }

    let mut locus_to_file = HashMap::new();

    if outer_df.height() == 0 {
        return Ok(locus_to_file);
    }

    let chunk_values: Vec<String> = outer_df
        .column("chunk")?
        .str()?
        .into_iter()
        .flatten()
        .map(|s| s.to_string())
        .collect();

    let unique_chunks: HashSet<String> = chunk_values.into_iter().collect();

    for chunk in unique_chunks {
        let parts: Vec<&str> = chunk.split(|c| c == ':' || c == '-').collect();
        if parts.len() != 3 {
            continue;
        }

        let chr = parts[0].to_string();
        let start = match parts[1].parse::<u64>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let stop = match parts[2].parse::<u64>() {
            Ok(v) => v,
            Err(_) => continue,
        };

        let mut subset_df = outer_df
            .clone()
            .lazy()
            .filter(col("chunk").eq(lit(chunk.clone())))
            .collect()?
            .drop("chunk")?;

        let filename = cache_path.join(format!("{}_{}_{}.parquet", chr, start, stop));
        let file = std::fs::File::create(&filename)?;
        let writer = ParquetWriter::new(file);
        let _ = writer.finish(&mut subset_df);
        locus_to_file.insert((chr, start, stop), filename);
    }

    Ok(locus_to_file)
}

fn locus_should_be_fetched(
    chr: &String,
    start: &u64,
    stop: &u64,
    reads_paths: &HashSet<(String, String)>,
    cache_path: &PathBuf
) -> bool {
    let filename = cache_path.join(format!("{}_{}_{}.parquet", chr, start, stop));
    if !filename.exists() {
        return true;
    } else {
        let file_r = std::fs::File::open(&filename).unwrap();
        let df = ParquetReader::new(file_r).finish().unwrap();

        let bam_path_series: HashSet<String> = df
            .column("bam_path")
            .unwrap()
            .str()
            .unwrap()
            .into_iter()
            .map(|s| s.unwrap().to_string())
            .collect();
        let bam_path_values: HashSet<String> = reads_paths
            .iter()
            .map(|s| s.0.to_string())
            .collect();
        let intersection = bam_path_series.intersection(&bam_path_values);
        if bam_path_series.len() != intersection.count() {
            return true;
        }

        // let local_time = local_get_file_update_time(&filename).unwrap();
        // for bam_path in bam_path_values {
        //     let remote_time = gcs_get_file_update_time(&bam_path).unwrap();

        //     if remote_time > local_time {
        //         println!("Newer!");
        //         return true
        //     }
        // }
    }

    false
}

/// Fetch reads from a single BAM file for a given locus.
/// This is a lightweight function for on-demand loading.
pub fn fetch_reads_from_first_bam(
    reads_url: &Url,
    cohort: &String,
    chr: &String,
    start: &u64,
    stop: &u64,
    cache_path: &PathBuf
) -> Result<DataFrame> {
    // Disable stderr from trying to open an IndexedReader
    let _stderr_gag = Gag::stderr().unwrap();
    
    let mut bam = open_bam(reads_url, cache_path)?;
    let df = extract_reads(&mut bam, reads_url, cohort, chr, start, stop)?;
    
    Ok(df)
}

/// Fetch reads from multiple BAM/CRAM files for a given locus.
/// Merges results from all specified files.
pub fn fetch_reads_from_bam_urls(
    reads_urls: &Vec<Url>,
    cohort: &String,
    chr: &String,
    start: &u64,
    stop: &u64,
    cache_path: &PathBuf
) -> Result<DataFrame> {
    let _stderr_gag = Gag::stderr().unwrap();
    
    if reads_urls.is_empty() {
        return Ok(DataFrame::default());
    }

    // Parallelize per-BAM fetch while preserving deterministic merge order.
    let mut indexed_dfs: Vec<(usize, DataFrame)> = reads_urls
        .par_iter()
        .enumerate()
        .filter_map(|(idx, reads_url)| {
            match open_bam(reads_url, cache_path) {
                Ok(mut bam) => {
                    match extract_reads(&mut bam, reads_url, cohort, chr, start, stop) {
                        Ok(df) if df.height() > 0 => Some((idx, df)),
                        Ok(_) => None,
                        Err(e) => {
                            eprintln!("Warning: Failed to extract reads from {}: {}", reads_url, e);
                            None
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Warning: Failed to open BAM file {}: {}", reads_url, e);
                    None
                }
            }
        })
        .collect();

    indexed_dfs.sort_by_key(|(idx, _)| *idx);
    let all_dfs: Vec<DataFrame> = indexed_dfs.into_iter().map(|(_, df)| df).collect();

    if all_dfs.is_empty() {
        // Return empty DataFrame with correct schema
        return Ok(DataFrame::default());
    }

    // Merge all DataFrames
    let mut result = all_dfs[0].clone();
    for df in all_dfs.iter().skip(1) {
        let _ = result.vstack_mut(df);
    }

    result.align_chunks();
    Ok(result)
}

pub fn stage_data(
    reads_cohort: &HashSet<(Url, String)>,
    loci: &HashSet<(String, u64, u64)>,
    cache_path: &PathBuf,
    use_cache: bool
) -> Result<HashMap<(String, u64, u64), PathBuf>> {
    // Disable stderr from trying to open an IndexedReader a few times, so
    // that the Jupyter notebook user doesn't get confused by intermediate
    // error messages that are nothing to worry about. The gag will end
    // automatically when it goes out of scope at the end of the function.
    let _stderr_gag = Gag::stderr().unwrap();

    let reads_paths: HashSet<(String, String)> = reads_cohort
        .iter()
        .map(|(url, cohort)| (url.to_string(), cohort.to_string()))
        .collect();

    let mut loci_to_fetch: HashSet<(String, u64, u64)> = HashSet::new();
    let mut locus_to_file: HashMap<(String, u64, u64), PathBuf> = HashMap::new();

    for (chr, start, stop) in loci {
        let should_fetch = if use_cache {
            locus_should_be_fetched(chr, start, stop, &reads_paths, cache_path)
        } else {
            true
        };

        if should_fetch {
            loci_to_fetch.insert((chr.to_string(), *start, *stop));
        } else {
            let filename = cache_path.join(format!("{}_{}_{}.parquet", chr, start, stop));
            locus_to_file.insert((chr.to_string(), *start, *stop), filename);
        }
    }

    if !loci_to_fetch.is_empty() {
        let dfs = stage_data_from_all_files(reads_cohort, &loci_to_fetch, cache_path)?;
        let written = write_to_disk(dfs, cache_path)?;
        locus_to_file.extend(written);
    }

    Ok(locus_to_file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pyo3_polars::PyDataFrame;
    use url::Url;
    use std::collections::HashSet;

    #[test]
    fn test_open_bam() {
        let reads_url = Url::parse(
            "gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230907_210011_s2/reads/ccs/aligned/m84060_230907_210011_s2.bam"
        ).unwrap();
        let cache_path = std::env::temp_dir();

        let bam = open_bam(&reads_url, &cache_path);

        assert!(bam.is_ok(), "Failed to open bam file");
    }

    #[test]
    fn test_stage_data_from_one_file() {
        let reads_url = Url::parse(
            "gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230907_210011_s2/reads/ccs/aligned/m84060_230907_210011_s2.bam"
        ).unwrap();
        let cohort = String::from("test_cohort");
        let loci = HashSet::from([("chr15".to_string(), 23960193, 23963918)]);
        let cache_path = std::env::temp_dir();
        let use_cache = false;

        let result = stage_data_from_one_file(&reads_url, &cohort, &loci, &cache_path, use_cache);

        assert!(result.is_ok(), "Failed to stage data from one file");

        println!("{:?}", result.unwrap());
    }

    #[test]
    fn test_stage_data() {
        let reads_url = Url::parse(
            "gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230907_210011_s2/reads/ccs/aligned/m84060_230907_210011_s2.bam"
        ).unwrap();
        let cohort = String::from("test_cohort_1");
        let loci = HashSet::from([("chr15".to_string(), 23960193, 23963918)]);
        let cache_path = std::env::temp_dir();
        let use_cache = false;
        let reads_cohort = HashSet::from([(reads_url, cohort)]);

        let result = stage_data(&reads_cohort, &loci, &cache_path, use_cache);

        assert!(result.is_ok(), "Failed to stage data from file");

        println!("{:?}", result.unwrap());
    }

    #[test]
    fn test_stage_multiple_data() {
        let reads_url_1 = Url::parse(
            "gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230907_210011_s2/reads/ccs/aligned/m84060_230907_210011_s2.bam"
        ).unwrap();
        let reads_url_2 = Url::parse(
            "gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230901_211947_s1/reads/ccs/aligned/m84043_230901_211947_s1.bam"
        ).unwrap();
        let cohort = String::from("test_cohort_1");
        let loci = HashSet::from([("chr15".to_string(), 23960193, 23963918)]);
        let cache_path = std::env::temp_dir();
        let use_cache = false;
        let reads_cohort = HashSet::from([
            (reads_url_1, cohort.to_owned()),
            (reads_url_2, cohort.to_owned()),
        ]);

        let result = stage_data(&reads_cohort, &loci, &cache_path, use_cache);

        println!("{:?}", result);

        assert!(result.is_ok(), "Failed to stage data from all files");
    }

    #[test]
    fn test_convert_to_pydataframe() {
        let reads_urls = [
            Url::parse(
                "gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230907_210011_s2/reads/ccs/aligned/m84060_230907_210011_s2.bam"
            ).unwrap(),
            Url::parse(
                "gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230901_211947_s1/reads/ccs/aligned/m84043_230901_211947_s1.bam"
            ).unwrap(),
            Url::parse(
                "gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230906_201655_s1/reads/ccs/aligned/m84043_230906_201655_s1.bam"
            ).unwrap(),
            Url::parse(
                "gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230911_201403_s4/reads/ccs/aligned/m84060_230911_201403_s4.bam"
            ).unwrap(),
            Url::parse(
                "gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230829_203026_s1/reads/ccs/aligned/m84056_230829_203026_s1.bam"
            ).unwrap(),
        ];
        let cohort = String::from("test_cohort_1");
        let loci = HashSet::from([("chr15".to_string(), 23960193, 23963918)]);
        let cache_path = std::env::temp_dir();
        let use_cache = false;

        let mut reads_cohort = HashSet::new();
        for reads_url in reads_urls {
            reads_cohort.insert((reads_url, cohort.to_owned()));
        }

        let result = stage_data(&reads_cohort, &loci, &cache_path, use_cache);

        for (_, filename) in result.unwrap() {
            let file = std::fs::File::open(&filename).unwrap();
            let df = ParquetReader::new(file).finish().unwrap();

            let pydf = PyDataFrame(df);

            println!("{:?}", pydf);
        }

        // println!("{:?}", result);
        // assert!(result.is_ok(), "Failed to stage data from all files");
    }
}
