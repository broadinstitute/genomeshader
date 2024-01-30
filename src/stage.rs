use std::collections::{HashSet, HashMap};
use std::env;
use std::path::PathBuf;
use std::sync::Mutex;
use url::Url;

use backoff::ExponentialBackoff;
use polars::prelude::*;
use rayon::prelude::*;
use rust_htslib::bam::IndexedReader;

use crate::alignment::extract_reads;
use crate::env::{gcs_authorize_data_access, local_guess_curl_ca_bundle};

fn open_bam(reads_url: &Url, cache_path: &PathBuf) -> IndexedReader {
    env::set_current_dir(cache_path).unwrap();

    println!("1 GCS_OAUTH_TOKEN: {:?}", std::env::var("GCS_OAUTH_TOKEN"));
    println!("1 CURL_CA_BUNDLE: {:?}", std::env::var("CURL_CA_BUNDLE"));

    let bam = match IndexedReader::from_url(reads_url) {
        Ok(bam) => bam,
        Err(_) => {
            gcs_authorize_data_access();

            println!("2 GCS_OAUTH_TOKEN: {:?}", std::env::var("GCS_OAUTH_TOKEN"));
            println!("2 CURL_CA_BUNDLE: {:?}", std::env::var("CURL_CA_BUNDLE"));

            match IndexedReader::from_url(reads_url) {
                Ok(bam) => bam,
                Err(_) => {
                    local_guess_curl_ca_bundle();

                    println!("3 GCS_OAUTH_TOKEN: {:?}", std::env::var("GCS_OAUTH_TOKEN"));
                    println!("3 CURL_CA_BUNDLE: {:?}", std::env::var("CURL_CA_BUNDLE"));

                    IndexedReader::from_url(reads_url).unwrap()
                }
            }
        }
    };

    bam
}

fn stage_data_from_one_file(reads_url: &Url, cohort: &String, loci: &HashSet<(String, u64, u64)>, cache_path: &PathBuf, use_cache: bool) -> Result<DataFrame, Box<dyn std::error::Error>> {
    let mut bam = open_bam(reads_url, cache_path);
    let mut outer_df = DataFrame::default();

    for (chr, start, stop) in loci.iter() {
        let df = extract_reads(&mut bam, reads_url, cohort, chr, start, stop)?;
        let _ = outer_df.vstack_mut(&df);
    }

    outer_df.align_chunks();

    Ok(outer_df)
}

fn stage_data_from_all_files(reads_cohort: &HashSet<(Url, String)>, loci: &HashSet<(String, u64, u64)>, cache_path: &PathBuf, use_cache: bool) -> Result<Mutex<Vec<DataFrame>>, Box<dyn std::error::Error>> {
    let dfs = Mutex::new(Vec::new());

    reads_cohort
        .par_iter()
        .for_each(|(reads, cohort)| {
            let op = || {
                let df = stage_data_from_one_file(reads, cohort, loci, cache_path, use_cache)?;
                Ok(df)
            };

            match backoff::retry(ExponentialBackoff::default(), op) {
                Ok(df) => { dfs.lock().unwrap().push(df); },
                Err(e) => { eprintln!("Error: {}", e); }
            }
        }
    );

    Ok(dfs)
}

fn write_to_disk(dfs: Mutex<Vec<DataFrame>>, cache_path: &PathBuf) -> Result<HashMap<(String, u64, u64), PathBuf>, Box<dyn std::error::Error>> {
    let mut outer_df = DataFrame::default();
    for df in dfs.lock().unwrap().iter() {
        outer_df.vstack_mut(&df).unwrap();
    }

    let mut locus_to_file = HashMap::new();

    let groups = outer_df.group_by(["chunk"]).unwrap();
    while let Ok(mut group) = groups.groups() {
        let l_fmt = group.column("chunk").unwrap().str().unwrap().get(0).unwrap().to_string();
        let parts: Vec<&str> = l_fmt.split(|c| c == ':' || c == '-').collect();

        let chr = parts[0].to_string();
        let start = parts[1].parse::<u64>().unwrap();
        let stop = parts[2].parse::<u64>().unwrap();

        let filename = cache_path.join(format!("{}_{}_{}.parquet", chr, start, stop));
        let file = std::fs::File::create(&filename).unwrap();
        let writer = ParquetWriter::new(file);

        let _ = writer.finish(&mut group);

        locus_to_file.insert((chr, start, stop), filename);
    }

    Ok(locus_to_file)
}

fn locus_should_be_fetched(chr: &String, start: &u64, stop: &u64, reads_paths: &HashSet<(String, String)>, cache_path: &PathBuf) -> bool {
    let filename = cache_path.join(format!("{}_{}_{}.parquet", chr, start, stop));
    if !filename.exists() {
        return true
    } else {
        let file_r = std::fs::File::open(&filename).unwrap();
        let df = ParquetReader::new(file_r).finish().unwrap();

        let bam_path_series: HashSet<String> = df.column("bam_path").unwrap().str().unwrap().into_iter().map(|s| s.unwrap().to_string()).collect();
        let bam_path_values: HashSet<String> = reads_paths.iter().map(|s| s.0.to_string()).collect();
        let intersection = bam_path_series.intersection(&bam_path_values);
        if bam_path_series.len() != intersection.count() {
            return true
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

pub fn stage_data(reads_cohort: &HashSet<(Url, String)>, loci: &HashSet<(String, u64, u64)>, cache_path: &PathBuf, use_cache: bool) -> Result<HashMap<(String, u64, u64), PathBuf>, Box<dyn std::error::Error>> {
    let dfs = stage_data_from_all_files(reads_cohort, loci, cache_path, use_cache)?;
    let locus_to_file = write_to_disk(dfs, cache_path)?;

    Ok(locus_to_file)
}