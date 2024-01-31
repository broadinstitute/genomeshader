use std::collections::{HashSet, HashMap};
use std::env;
use std::error::Error;
use std::path::PathBuf;
use url::Url;

use backoff::ExponentialBackoff;
use gag::Gag;
use polars::prelude::*;
use rayon::prelude::*;
use rust_htslib::bam::IndexedReader;

use crate::alignment::extract_reads;
use crate::env::{gcs_authorize_data_access, local_guess_curl_ca_bundle};

fn open_bam(reads_url: &Url, cache_path: &PathBuf) -> Result<IndexedReader, Box<dyn Error>> {
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

fn stage_data_from_one_file(reads_url: &Url, cohort: &String, loci: &HashSet<(String, u64, u64)>, cache_path: &PathBuf, use_cache: bool) -> Result<DataFrame, Box<dyn Error>> {
    let mut bam = open_bam(reads_url, cache_path)?;
    let mut outer_df = DataFrame::default();

    for (chr, start, stop) in loci.iter() {
        let df = extract_reads(&mut bam, reads_url, cohort, chr, start, stop)?;
        let _ = outer_df.vstack_mut(&df);
    }

    outer_df.align_chunks();

    Ok(outer_df)
}

fn stage_data_from_all_files(reads_cohort: &HashSet<(Url, String)>, loci: &HashSet<(String, u64, u64)>, cache_path: &PathBuf, use_cache: bool) -> Result<Vec<DataFrame>, Box<dyn Error>> {
    let dfs: Vec<_> = reads_cohort
        .par_iter()
        .map(|(reads, cohort)| {
            let op = || {
                let df = stage_data_from_one_file(reads, cohort, loci, cache_path, use_cache)?;
                Ok(df)
            };

            match backoff::retry(ExponentialBackoff::default(), op) {
                Ok(df) => {
                    df
                },
                Err(e) => {
                    panic!("Error: {}", e);
                }
            }
        })
        .collect();

    Ok(dfs)
}

fn write_to_disk(dfs: Vec<DataFrame>, cache_path: &PathBuf) -> Result<HashMap<(String, u64, u64), PathBuf>, Box<dyn Error>> {
    let mut outer_df = DataFrame::default();
    for df in dfs {
        outer_df.vstack_mut(&df).unwrap();
    }

    let mut locus_to_file = HashMap::new();

    let groups = outer_df.group_by(["chunk"]).unwrap();
    for group in groups.groups() {
        let l_fmt = group.column("chunk").unwrap().str().unwrap().get(0).unwrap().to_string();
        let parts: Vec<&str> = l_fmt.split(|c| c == ':' || c == '-').collect();

        let chr = parts[0].to_string();
        let start = parts[1].parse::<u64>().unwrap();
        let stop = parts[2].parse::<u64>().unwrap();

        let mut subset_df = outer_df.clone()
                                               .lazy()
                                               .filter(col("chunk").eq(lit(l_fmt)))
                                               .drop(["chunk"])
                                               .collect()?;

        let filename = cache_path.join(format!("{}_{}_{}.parquet", chr, start, stop));
        let file = std::fs::File::create(&filename).unwrap();
        let writer = ParquetWriter::new(file);

        let _ = writer.finish(&mut subset_df);
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

pub fn stage_data(reads_cohort: &HashSet<(Url, String)>, loci: &HashSet<(String, u64, u64)>, cache_path: &PathBuf, use_cache: bool) -> Result<HashMap<(String, u64, u64), PathBuf>, Box<dyn Error>> {
    // Disable stderr from trying to open an IndexedReader a few times, so
    // that the Jupyter notebook user doesn't get confused by intermediate
    // error messages that are nothing to worry about. The gag will end
    // automatically when it goes out of scope at the end of the function.
    let stderr_gag = Gag::stderr().unwrap();

    let dfs = stage_data_from_all_files(reads_cohort, loci, cache_path, use_cache)?;
    let locus_to_file = write_to_disk(dfs, cache_path)?;

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
        let reads_url = Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230907_210011_s2/reads/ccs/aligned/m84060_230907_210011_s2.bam").unwrap();
        let cache_path = std::env::temp_dir();

        let bam = open_bam(&reads_url, &cache_path);

        assert!(bam.is_ok(), "Failed to open bam file");
    }

    #[test]
    fn test_stage_data_from_one_file() {
        let reads_url = Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230907_210011_s2/reads/ccs/aligned/m84060_230907_210011_s2.bam").unwrap();
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
        let reads_url = Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230907_210011_s2/reads/ccs/aligned/m84060_230907_210011_s2.bam").unwrap();
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
        let reads_url_1 = Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230907_210011_s2/reads/ccs/aligned/m84060_230907_210011_s2.bam").unwrap();
        let reads_url_2 = Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230901_211947_s1/reads/ccs/aligned/m84043_230901_211947_s1.bam").unwrap();
        let cohort = String::from("test_cohort_1");
        let loci = HashSet::from([("chr15".to_string(), 23960193, 23963918)]);
        let cache_path = std::env::temp_dir();
        let use_cache = false;
        let reads_cohort = HashSet::from([(reads_url_1, cohort.to_owned()), (reads_url_2, cohort.to_owned())]);

        let result = stage_data(&reads_cohort, &loci, &cache_path, use_cache);

        println!("{:?}", result);

        assert!(result.is_ok(), "Failed to stage data from all files");
    }

    #[test]
    fn test_convert_to_pydataframe() {
        let reads_urls = [
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230907_210011_s2/reads/ccs/aligned/m84060_230907_210011_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230901_211947_s1/reads/ccs/aligned/m84043_230901_211947_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230906_201655_s1/reads/ccs/aligned/m84043_230906_201655_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230911_201403_s4/reads/ccs/aligned/m84060_230911_201403_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230829_203026_s1/reads/ccs/aligned/m84056_230829_203026_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230907_202641_s1/reads/ccs/aligned/m84043_230907_202641_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230906_212009_s3/reads/ccs/aligned/m84056_230906_212009_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230911_193237_s1/reads/ccs/aligned/m84063_230911_193237_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230907_213037_s3/reads/ccs/aligned/m84056_230907_213037_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230907_213117_s3/reads/ccs/aligned/m84060_230907_213117_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230911_184019_s1/reads/ccs/aligned/m84056_230911_184019_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230829_210144_s2/reads/ccs/aligned/m84060_230829_210144_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230906_201842_s1/reads/ccs/aligned/m84056_230906_201842_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230829_220357_s4/reads/ccs/aligned/m84060_230829_220357_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230909_164146_s1/reads/ccs/aligned/m84056_230909_164146_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230828_202039_s1/reads/ccs/aligned/m84056_230828_202039_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230829_220344_s4/reads/ccs/aligned/m84056_230829_220344_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230906_215238_s3/reads/ccs/aligned/m84063_230906_215238_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230907_212853_s3/reads/ccs/aligned/m84043_230907_212853_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230909_174409_s2/reads/ccs/aligned/m84063_230909_174409_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230909_174319_s3/reads/ccs/aligned/m84060_230909_174319_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230909_164235_s4/reads/ccs/aligned/m84063_230909_164235_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230909_181515_s3/reads/ccs/aligned/m84063_230909_181515_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230907_210055_s1/reads/ccs/aligned/m84063_230907_210055_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230907_202825_s1/reads/ccs/aligned/m84056_230907_202825_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230911_191037_s2/reads/ccs/aligned/m84043_230911_191037_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230911_194257_s3/reads/ccs/aligned/m84060_230911_194257_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230828_205059_s2/reads/ccs/aligned/m84056_230828_205059_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230911_184131_s1/reads/ccs/aligned/m84060_230911_184131_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230906_201922_s1/reads/ccs/aligned/m84060_230906_201922_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230907_220223_s4/reads/ccs/aligned/m84060_230907_220223_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230909_174313_s3/reads/ccs/aligned/m84056_230909_174313_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230828_215311_s4/reads/ccs/aligned/m84056_230828_215311_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230901_215053_s2/reads/ccs/aligned/m84043_230901_215053_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230906_204902_s2/reads/ccs/aligned/m84056_230906_204902_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230909_171213_s2/reads/ccs/aligned/m84060_230909_171213_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230906_204717_s2/reads/ccs/aligned/m84043_230906_204717_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230909_164149_s1/reads/ccs/aligned/m84060_230909_164149_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230906_212132_s2/reads/ccs/aligned/m84063_230906_212132_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230828_202101_s1/reads/ccs/aligned/m84060_230828_202101_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230906_205026_s1/reads/ccs/aligned/m84063_230906_205026_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230906_215115_s4/reads/ccs/aligned/m84056_230906_215115_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230911_200343_s2/reads/ccs/aligned/m84063_230911_200343_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230907_220143_s4/reads/ccs/aligned/m84056_230907_220143_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230907_215959_s4/reads/ccs/aligned/m84043_230907_215959_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230911_201249_s4/reads/ccs/aligned/m84043_230911_201249_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230907_202949_s4/reads/ccs/aligned/m84063_230907_202949_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230911_194146_s3/reads/ccs/aligned/m84056_230911_194146_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230829_210132_s2/reads/ccs/aligned/m84056_230829_210132_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230911_190209_s4/reads/ccs/aligned/m84063_230911_190209_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230906_215200_s4/reads/ccs/aligned/m84060_230906_215200_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230909_171303_s1/reads/ccs/aligned/m84063_230909_171303_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230907_220307_s3/reads/ccs/aligned/m84063_230907_220307_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230911_191040_s2/reads/ccs/aligned/m84056_230911_191040_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230906_212054_s3/reads/ccs/aligned/m84060_230906_212054_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230907_202905_s1/reads/ccs/aligned/m84060_230907_202905_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230829_203038_s1/reads/ccs/aligned/m84060_230829_203038_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230829_213238_s3/reads/ccs/aligned/m84056_230829_213238_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230828_205127_s2/reads/ccs/aligned/m84060_230828_205127_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230909_171207_s2/reads/ccs/aligned/m84056_230909_171207_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230906_201957_s4/reads/ccs/aligned/m84063_230906_201957_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230828_212233_s3/reads/ccs/aligned/m84060_230828_212233_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230829_213250_s3/reads/ccs/aligned/m84060_230829_213250_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230909_181419_s4/reads/ccs/aligned/m84056_230909_181419_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230901_222159_s3/reads/ccs/aligned/m84043_230901_222159_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230911_201252_s4/reads/ccs/aligned/m84056_230911_201252_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230911_191151_s2/reads/ccs/aligned/m84060_230911_191151_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230901_225305_s4/reads/ccs/aligned/m84043_230901_225305_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230911_203449_s3/reads/ccs/aligned/m84063_230911_203449_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84063_230907_213201_s2/reads/ccs/aligned/m84063_230907_213201_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230907_205931_s2/reads/ccs/aligned/m84056_230907_205931_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230828_215339_s4/reads/ccs/aligned/m84060_230828_215339_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230911_184014_s1/reads/ccs/aligned/m84043_230911_184014_s1.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84056_230828_212205_s3/reads/ccs/aligned/m84056_230828_212205_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230907_205747_s2/reads/ccs/aligned/m84043_230907_205747_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230906_214929_s4/reads/ccs/aligned/m84043_230906_214929_s4.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230906_204947_s2/reads/ccs/aligned/m84060_230906_204947_s2.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84043_230911_194143_s3/reads/ccs/aligned/m84043_230911_194143_s3.bam").unwrap(),
            Url::parse("gs://fc-8c3900db-633f-477f-96b3-fb31ae265c44/results/PBFlowcell/m84060_230909_181425_s4/reads/ccs/aligned/m84060_230909_181425_s4.bam").unwrap(),
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