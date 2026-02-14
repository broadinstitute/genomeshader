pub mod alignment;
pub mod env;
pub mod stage;
pub mod storage_gcs;
pub mod storage_local;
pub mod variants;

use stage::fetch_reads_from_bam_urls;
use storage_gcs::*;

use std::{
    collections::{ hash_map::DefaultHasher, HashMap, HashSet },
    hash::{ Hash, Hasher },
    path::PathBuf,
};

use iset::*;
use url::Url;
use polars::prelude::*;
use pyo3::prelude::*;
use pyo3_polars::PyDataFrame;

// Needed to pass some data into our Nannou app.
// use std::cell::RefCell;
// thread_local!(static GLOBAL_DATA: RefCell<PyDataFrame> = RefCell::new(PyDataFrame(DataFrame::default())));

#[pyclass]
pub struct Session {
    reads_cohort: HashSet<(Url, String)>,
    loci: HashSet<(String, u64, u64)>,
    staged_tree: HashMap<String, IntervalMap<u64, PathBuf>>,
    cache_base_uri: Option<String>,
    /// Each element is a group of variant files (one track). attach_variants adds a new group.
    variant_file_groups: Vec<Vec<String>>,
}

impl Session {
    fn filter_reads_df(
        &self,
        df: DataFrame,
        start: u64,
        stop: u64,
        bam_paths: &[String],
    ) -> PyResult<DataFrame> {
        let expr = col("reference_start")
            .lt(lit(stop as u32))
            .and(col("reference_end").gt(lit(start as u32)));

        let locus_filtered = df.lazy().filter(expr).collect().map_err(|e| {
            PyErr::new::<pyo3::exceptions::PyValueError, _>(
                format!("Failed to filter cached locus data: {}", e)
            )
        })?;

        if bam_paths.is_empty() {
            return Ok(locus_filtered);
        }

        let bam_set: HashSet<&str> = bam_paths.iter().map(|s| s.as_str()).collect();
        let bam_col = locus_filtered
            .column("bam_path")
            .map_err(|e| {
                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("Missing bam_path column in cached data: {}", e)
                )
            })?
            .str()
            .map_err(|e| {
                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("Invalid bam_path column in cached data: {}", e)
                )
            })?;

        let mask_values: Vec<bool> = bam_col
            .into_iter()
            .map(|v| v.map(|bam| bam_set.contains(bam)).unwrap_or(false))
            .collect();
        let mask = BooleanChunked::from_slice("bam_mask", &mask_values);

        locus_filtered.filter(&mask).map_err(|e| {
            PyErr::new::<pyo3::exceptions::PyValueError, _>(
                format!("Failed to filter cached bam paths: {}", e)
            )
        })
    }

    fn read_parquet_df(&self, path: &PathBuf) -> PyResult<DataFrame> {
        let file_r = std::fs::File::open(path).map_err(|e| {
            PyErr::new::<pyo3::exceptions::PyValueError, _>(
                format!("Failed to open cache file '{}': {}", path.display(), e)
            )
        })?;

        ParquetReader::new(file_r).finish().map_err(|e| {
            PyErr::new::<pyo3::exceptions::PyValueError, _>(
                format!("Failed to read cache file '{}': {}", path.display(), e)
            )
        })
    }

    fn read_parquet_uri(&self, uri: &str) -> PyResult<DataFrame> {
        LazyFrame::scan_parquet(uri, Default::default())
            .map_err(|e| {
                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("Failed to open parquet uri '{}': {}", uri, e)
                )
            })?
            .collect()
            .map_err(|e| {
                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("Failed to collect parquet uri '{}': {}", uri, e)
                )
            })
    }

    fn write_parquet_df(&self, path: &PathBuf, mut df: DataFrame) -> PyResult<()> {
        let file_w = std::fs::File::create(path).map_err(|e| {
            PyErr::new::<pyo3::exceptions::PyValueError, _>(
                format!("Failed to create cache file '{}': {}", path.display(), e)
            )
        })?;

        ParquetWriter::new(file_w).finish(&mut df).map_err(|e| {
            PyErr::new::<pyo3::exceptions::PyValueError, _>(
                format!("Failed to write cache file '{}': {}", path.display(), e)
            )
        })?;

        Ok(())
    }

    fn write_parquet_uri(&self, uri: &str, df: DataFrame) -> PyResult<()> {
        df.lazy()
            .sink_parquet_cloud(uri.to_string(), None, ParquetWriteOptions::default())
            .map_err(|e| {
                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("Failed to write parquet uri '{}': {}", uri, e)
                )
            })
    }

    fn find_covering_variant_staged_file(
        &self,
        chr: &str,
        start: u64,
        stop: u64
    ) -> Option<(u64, u64, PathBuf)> {
        let subtree = self.staged_tree.get(chr)?;
        for (range, filename) in subtree.iter(start..stop) {
            if range.start <= start && range.end >= stop {
                return Some((range.start, range.end, filename.clone()));
            }
        }
        None
    }

    fn request_cache_file(
        &self,
        cache_path: &PathBuf,
        chr: &str,
        start: u64,
        stop: u64,
        bam_paths: &[String],
    ) -> PathBuf {
        let mut ordered = bam_paths.to_vec();
        ordered.sort();

        let mut hasher = DefaultHasher::new();
        for bam in &ordered {
            bam.hash(&mut hasher);
        }
        let bam_hash = hasher.finish();

        cache_path.join(format!("{}_{}_{}_{}.parquet", chr, start, stop, bam_hash))
    }

    fn gcs_cache_uri_for_variant_stage(
        &self,
        chr: &str,
        start: u64,
        stop: u64,
        dataset_hash: u64,
    ) -> Option<String> {
        let base = self.cache_base_uri.as_ref()?;
        Some(format!(
            "{}/cache/variants/staged/{}/{}_{}_{}.parquet",
            base.trim_end_matches('/'),
            dataset_hash,
            chr,
            start,
            stop
        ))
    }

    fn gcs_cache_uri_for_reads_request(
        &self,
        chr: &str,
        start: u64,
        stop: u64,
        bam_paths: &[String],
    ) -> Option<String> {
        let base = self.cache_base_uri.as_ref()?;
        let mut ordered = bam_paths.to_vec();
        ordered.sort();

        let mut hasher = DefaultHasher::new();
        for bam in &ordered {
            bam.hash(&mut hasher);
        }
        let bam_hash = hasher.finish();

        Some(format!(
            "{}/cache/requests/{}_{}_{}_{}.parquet",
            base.trim_end_matches('/'),
            chr,
            start,
            stop,
            bam_hash
        ))
    }

    fn gcs_cache_uri_for_variant_request(
        &self,
        chr: &str,
        start: u64,
        stop: u64,
        dataset_hash: u64,
    ) -> Option<String> {
        let base = self.cache_base_uri.as_ref()?;
        Some(format!(
            "{}/cache/variants/requests/{}/{}_{}_{}.parquet",
            base.trim_end_matches('/'),
            dataset_hash,
            chr,
            start,
            stop
        ))
    }

    fn variant_dataset_hash(&self) -> u64 {
        let mut hasher = DefaultHasher::new();
        for (group_idx, files) in self.variant_file_groups.iter().enumerate() {
            group_idx.hash(&mut hasher);
            for file in files {
                file.hash(&mut hasher);
            }
        }
        hasher.finish()
    }

    fn filter_variant_df(&self, df: DataFrame, start: u64, stop: u64) -> PyResult<DataFrame> {
        df.lazy()
            .filter(
                col("position")
                    .gt_eq(lit(start))
                    .and(col("position").lt_eq(lit(stop))),
            )
            .collect()
            .map_err(|e| {
                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("Failed to filter cached variant data: {}", e)
                )
            })
    }

    fn compute_variants_for_locus(
        &self,
        chr: &String,
        start: &u64,
        stop: &u64,
        locus_label: &str,
    ) -> PyResult<DataFrame> {
        let mut combined_df: Option<DataFrame> = None;

        for (group_index, file_list) in self.variant_file_groups.iter().enumerate() {
            let mut group_df: Option<DataFrame> = None;
            for variant_file in file_list {
                match variants::extract_variants(variant_file, chr, start, stop) {
                    Ok(df) => {
                        if let Some(existing) = group_df {
                            group_df = Some(
                                existing
                                    .vstack(&df)
                                    .map_err(|e| {
                                        PyErr::new::<pyo3::exceptions::PyValueError, _>(
                                            format!("Failed to combine variant dataframes: {}", e)
                                        )
                                    })?
                            );
                        } else {
                            group_df = Some(df);
                        }
                    }
                    Err(e) => {
                        eprintln!("Warning: Failed to extract variants from {}: {}", variant_file, e);
                    }
                }
            }

            if let Some(mut df) = group_df {
                let n = df.height();
                let track_ids: Vec<u32> = (0..n).map(|_| group_index as u32).collect();
                df.with_column(Series::new("variant_track_id", track_ids))
                    .map_err(|e| {
                        PyErr::new::<pyo3::exceptions::PyValueError, _>(
                            format!("Failed to add variant_track_id: {}", e)
                        )
                    })?;

                if let Some(existing_df) = combined_df {
                    combined_df = Some(
                        existing_df
                            .vstack(&df)
                            .map_err(|e| {
                                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                                    format!("Failed to combine variant dataframes: {}", e)
                                )
                            })?
                    );
                } else {
                    combined_df = Some(df);
                }
            }
        }

        match combined_df {
            Some(df) => Ok(df),
            None => Err(
                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("Failed to extract variants from any attached files for locus '{}'.", locus_label)
                )
            )
        }
    }

    fn try_download_gcs_cache(&self, remote_uri: &str, local_path: &PathBuf) {
        if local_path.exists() {
            return;
        }

        if let Err(err) = gcs_download_file_to(remote_uri, local_path) {
            eprintln!(
                "Warning: Failed to download cached file '{}' to '{}': {}",
                remote_uri,
                local_path.display(),
                err
            );
        }
    }

    fn try_upload_gcs_cache(&self, local_path: &PathBuf, remote_uri: &str) {
        if !local_path.exists() {
            return;
        }

        if let Err(err) = gcs_upload_file(local_path, remote_uri) {
            eprintln!(
                "Warning: Failed to upload cached file '{}' to '{}': {}",
                local_path.display(),
                remote_uri,
                err
            );
        }
    }

    fn get_reads_with_cache(
        &self,
        chr: &str,
        start: u64,
        stop: u64,
        reads_urls: &[Url],
        bam_paths: &[String],
    ) -> PyResult<DataFrame> {
        let cache_path = std::env::temp_dir();

        let request_cache = self.request_cache_file(&cache_path, chr, start, stop, bam_paths);
        if request_cache.exists() {
            let cached_df = self.read_parquet_df(&request_cache)?;
            return self.filter_reads_df(cached_df, start, stop, bam_paths);
        }

        if let Some(remote_uri) = self.gcs_cache_uri_for_reads_request(chr, start, stop, bam_paths) {
            self.try_download_gcs_cache(&remote_uri, &request_cache);
            if request_cache.exists() {
                let cached_df = self.read_parquet_df(&request_cache)?;
                return self.filter_reads_df(cached_df, start, stop, bam_paths);
            }
        }

        let cohort = String::from("all");
        let fetched = fetch_reads_from_bam_urls(
            &reads_urls.to_vec(),
            &cohort,
            &chr.to_string(),
            &start,
            &stop,
            &cache_path,
        )
        .map_err(|e| {
            PyErr::new::<pyo3::exceptions::PyValueError, _>(
                format!(
                    "Failed to fetch reads for locus '{}:{}-{}': {}",
                    chr, start, stop, e
                )
            )
        })?;

        self.write_parquet_df(&request_cache, fetched.clone())?;
        if let Some(remote_uri) = self.gcs_cache_uri_for_reads_request(chr, start, stop, bam_paths) {
            self.try_upload_gcs_cache(&request_cache, &remote_uri);
        }
        Ok(fetched)
    }
}

#[pymethods]
impl Session {
    #[new]
    fn new(cache_base_uri: Option<String>) -> Self {
        Session {
            reads_cohort: HashSet::new(),
            loci: HashSet::new(),
            staged_tree: HashMap::new(),
            cache_base_uri,
            variant_file_groups: Vec::new(),
        }
    }

    fn attach_reads(&mut self, read_files: Vec<String>, cohort: String) -> PyResult<()> {
        for read_file in &read_files {
            if !read_file.ends_with(".bam") && !read_file.ends_with(".cram") {
                return Err(
                    PyErr::new::<pyo3::exceptions::PyValueError, _>(
                        format!("File '{}' is not a .bam or .cram file.", read_file)
                    )
                );
            }

            let read_url = if read_file.starts_with("file://") || read_file.starts_with("gs://") {
                Url::parse(&read_file).unwrap()
            } else {
                Url::from_file_path(&read_file).unwrap()
            };

            self.reads_cohort.insert((read_url, cohort.to_owned()));
        }

        Ok(())
    }

    fn parse_locus(&self, locus: String) -> PyResult<(String, u64, u64)> {
        let l_fmt = locus.replace(",", "");
        let parts: Vec<&str> = l_fmt.split(|c| c == ':' || c == '-').collect();

        let chr = parts[0].to_string();

        if parts.len() == 2 {
            let start = match parts[1].parse::<u64>() {
                Ok(val) => val,
                Err(_) => {
                    return Err(
                        PyErr::new::<pyo3::exceptions::PyValueError, _>(
                            format!("Failed to parse start as u64 for locus '{}'.", locus)
                        )
                    );
                }
            };

            Ok((chr, start - 1000, start + 1000))
        } else if parts.len() == 3 {
            let start = match parts[1].parse::<u64>() {
                Ok(val) => val,
                Err(_) => {
                    return Err(
                        PyErr::new::<pyo3::exceptions::PyValueError, _>(
                            format!("Failed to parse start as u64 for locus '{}'.", locus)
                        )
                    );
                }
            };

            let stop = match parts[2].parse::<u64>() {
                Ok(val) => val,
                Err(_) => {
                    return Err(
                        PyErr::new::<pyo3::exceptions::PyValueError, _>(
                            format!("Failed to parse stop as u64 for locus '{}'.", locus)
                        )
                    );
                }
            };

            Ok((chr, start, stop))
        } else {
            Err(
                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("Locus format for '{}' is incorrect. It should be 'chr:start[-stop]'.", locus)
                )
            )
        }
    }

    fn attach_loci(&mut self, loci: Vec<String>) -> PyResult<()> {
        for locus in loci {
            match self.parse_locus(locus.to_owned()) {
                Ok(l_fmt) => {
                    self.loci.insert(l_fmt);
                }
                Err(e) => {
                    return Err(e);
                }
            }
        }

        Ok(())
    }

    fn stage(&mut self, use_cache: bool) -> PyResult<()> {
        let dataset_hash = self.variant_dataset_hash();

        for (chr, start, stop) in &self.loci {
            let Some(remote_uri) =
                self.gcs_cache_uri_for_variant_stage(chr, *start, *stop, dataset_hash)
            else {
                return Err(
                    PyErr::new::<pyo3::exceptions::PyValueError, _>(
                        "No cache base URI configured for variant staging."
                    )
                );
            };

            if !(use_cache && self.read_parquet_uri(&remote_uri).is_ok()) {
                let locus_label = format!("{}:{}-{}", chr, start, stop);
                let df = self.compute_variants_for_locus(chr, start, stop, &locus_label)?;
                if let Err(err) = self.write_parquet_uri(&remote_uri, df) {
                    return Err(
                        PyErr::new::<pyo3::exceptions::PyValueError, _>(
                            format!("Failed to write staged variants cache to '{}': {}", remote_uri, err)
                        )
                    );
                }
            }

            if !self.staged_tree.contains_key(chr) {
                self.staged_tree.insert(chr.clone(), iset::IntervalMap::new());
            }
            let map = self.staged_tree.get_mut(chr).unwrap();
            map.entry(*start..*stop).or_insert(PathBuf::from(remote_uri));
        }

        Ok(())
    }

    fn get_locus(&mut self, locus: String) -> PyResult<PyDataFrame> {
        let l_fmt = self.parse_locus(locus.clone())?;
        let reads_urls: Vec<Url> = self
            .reads_cohort
            .iter()
            .map(|(url, _)| url.clone())
            .collect();
        let bam_paths: Vec<String> = reads_urls.iter().map(|u| u.to_string()).collect();

        if reads_urls.is_empty() {
            return Err(
                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    "No reads are attached. Use attach_reads() before get_locus()."
                )
            );
        }

        let df = self.get_reads_with_cache(&l_fmt.0, l_fmt.1, l_fmt.2, &reads_urls, &bam_paths)?;
        Ok(PyDataFrame(df))
    }

    /// Append a new variant track (group of files). Each call adds a separate track.
    fn attach_variants(&mut self, variant_files: Vec<String>) -> PyResult<()> {
        for variant_file in &variant_files {
            if !variant_file.ends_with(".bcf") && !variant_file.ends_with(".vcf") && !variant_file.ends_with(".vcf.gz") {
                return Err(
                    PyErr::new::<pyo3::exceptions::PyValueError, _>(
                        format!("File '{}' is not a .bcf, .vcf, or .vcf.gz file.", variant_file)
                    )
                );
            }
        }
        self.variant_file_groups.push(variant_files);
        Ok(())
    }

    /// Returns variant data for the locus. DataFrame includes column "variant_track_id" (0, 1, ...)
    /// so the caller can split rows by track.
    fn get_locus_variants(&mut self, locus: String) -> PyResult<PyDataFrame> {
        let l_fmt = self.parse_locus(locus.clone())?;

        if self.variant_file_groups.is_empty() {
            return Err(
                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("No variant files attached. Use attach_variants() first.")
                )
            );
        }

        let dataset_hash = self.variant_dataset_hash();

        if let Some((staged_start, staged_stop, _staged_marker)) =
            self.find_covering_variant_staged_file(&l_fmt.0, l_fmt.1, l_fmt.2)
        {
            if let Some(remote_uri) = self.gcs_cache_uri_for_variant_stage(
                &l_fmt.0,
                staged_start,
                staged_stop,
                dataset_hash,
            ) {
                if let Ok(staged_df) = self.read_parquet_uri(&remote_uri) {
                    let filtered = self.filter_variant_df(staged_df, l_fmt.1, l_fmt.2)?;
                    return Ok(PyDataFrame(filtered));
                }
            }
        }

        if let Some(remote_uri) =
            self.gcs_cache_uri_for_variant_request(&l_fmt.0, l_fmt.1, l_fmt.2, dataset_hash)
        {
            if let Ok(cached_df) = self.read_parquet_uri(&remote_uri) {
                return Ok(PyDataFrame(cached_df));
            }
        }

        let df = self.compute_variants_for_locus(&l_fmt.0, &l_fmt.1, &l_fmt.2, &locus)?;
        if let Some(remote_uri) =
            self.gcs_cache_uri_for_variant_request(&l_fmt.0, l_fmt.1, l_fmt.2, dataset_hash)
        {
            if let Err(err) = self.write_parquet_uri(&remote_uri, df.clone()) {
                eprintln!(
                    "Warning: Failed to write variant request cache to '{}': {}",
                    remote_uri, err
                );
            }
        }

        if !self.staged_tree.contains_key(&l_fmt.0) {
            self.staged_tree
                .insert(l_fmt.0.clone(), iset::IntervalMap::new());
        }
        let remote_for_tree =
            self.gcs_cache_uri_for_variant_request(&l_fmt.0, l_fmt.1, l_fmt.2, dataset_hash);
        let map = self.staged_tree.get_mut(&l_fmt.0).unwrap();
        if let Some(remote_uri) = remote_for_tree {
            map.entry(l_fmt.1..l_fmt.2)
                .or_insert(PathBuf::from(remote_uri));
        }

        Ok(PyDataFrame(df))
    }

    fn reset(&mut self) -> PyResult<()> {
        self.reads_cohort = HashSet::new();
        self.loci = HashSet::new();
        self.staged_tree = HashMap::new();
        self.variant_file_groups = Vec::new();

        Ok(())
    }

    /// Fetch reads from specified BAM/CRAM files for a given locus.
    /// This is used for on-demand loading via Jupyter comms.
    /// 
    /// Args:
    ///     locus: The genomic locus (e.g., "chr1:1000-2000")
    ///     bam_urls: List of BAM/CRAM file URLs to load from
    fn fetch_reads_for_locus(&mut self, locus: String, bam_urls: Vec<String>) -> PyResult<PyDataFrame> {
        let l_fmt = self.parse_locus(locus.clone())?;

        if bam_urls.is_empty() {
            return Err(
                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    "No BAM file URLs provided. Cannot fetch reads without BAM files."
                )
            );
        }

        // Parse URLs
        let mut reads_urls = Vec::new();
        for bam_url_str in &bam_urls {
            let read_url = if bam_url_str.starts_with("file://") || bam_url_str.starts_with("gs://") || bam_url_str.starts_with("s3://") || bam_url_str.starts_with("http") {
                match Url::parse(bam_url_str) {
                    Ok(url) => url,
                    Err(e) => {
                        return Err(
                            PyErr::new::<pyo3::exceptions::PyValueError, _>(
                                format!("Invalid BAM URL '{}': {}", bam_url_str, e)
                            )
                        );
                    }
                }
            } else {
                match Url::from_file_path(bam_url_str) {
                    Ok(url) => url,
                    Err(_) => {
                        return Err(
                            PyErr::new::<pyo3::exceptions::PyValueError, _>(
                                format!("Invalid BAM file path '{}'", bam_url_str)
                            )
                        );
                    }
                }
            };
            reads_urls.push(read_url);
        }

        let bam_paths: Vec<String> = reads_urls.iter().map(|u| u.to_string()).collect();
        let df = self.get_reads_with_cache(&l_fmt.0, l_fmt.1, l_fmt.2, &reads_urls, &bam_paths)?;
        Ok(PyDataFrame(df))
    }

    /// Get the list of attached read files
    fn get_attached_reads(&self) -> PyResult<Vec<String>> {
        let reads: Vec<String> = self.reads_cohort
            .iter()
            .map(|(url, _)| url.to_string())
            .collect();
        Ok(reads)
    }

    fn print(&self) {
        println!("Reads:");
        if self.reads_cohort.len() <= 10 {
            for (reads, cohort) in &self.reads_cohort {
                println!(" - {} ({})", reads, cohort);
            }
        } else {
            let mut cohort_counts = HashMap::new();
            for (_, cohort) in &self.reads_cohort {
                *cohort_counts.entry(cohort).or_insert(0) += 1;
            }

            for (cohort, count) in cohort_counts {
                println!(" - {}: {} files", cohort, count);
            }
        }

        println!("Loci:");
        if self.loci.len() <= 10 {
            for locus in &self.loci {
                println!(" - {:?}", locus);
            }
        } else {
            println!(" - {} loci", self.loci.len());
        }

        println!("Staging:");
        for (chr, subtree) in &self.staged_tree {
            for (range, path) in subtree.unsorted_iter() {
                let file_size = match path.metadata() {
                    Ok(metadata) => { humansize::format_size(metadata.len(), humansize::DECIMAL) }
                    Err(_) => "0 B".to_string(),
                };
                println!(" - {}:{}-{} {:?} ({})", chr, range.start, range.end, path, file_size);
            }
        }
    }
}

#[pyfunction]
fn _init(cache_base_uri: Option<String>) -> PyResult<Session> {
    Ok(Session::new(cache_base_uri))
}

#[pyfunction]
fn _version() -> PyResult<String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

#[pyfunction]
fn _extract_variants(
    bcf_path: String,
    chr: String,
    start: u64,
    stop: u64
) -> PyResult<PyDataFrame> {
    match variants::extract_variants(&bcf_path, &chr, &start, &stop) {
        Ok(df) => Ok(PyDataFrame(df)),
        Err(e) => Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
            format!("Failed to extract variants: {}", e)
        ))
    }
}

/// A Python module implemented in Rust. The name of this function must match
/// the `lib.name` setting in the `Cargo.toml`, else Python will not be able to
/// import the module.
#[pymodule]
fn genomeshader(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(_gcs_download_file, m)?)?;
    m.add_function(wrap_pyfunction!(_gcs_list_files_of_type, m)?)?;
    m.add_function(wrap_pyfunction!(_init, m)?)?;
    m.add_function(wrap_pyfunction!(_version, m)?)?;
    m.add_function(wrap_pyfunction!(_extract_variants, m)?)?;

    Ok(())
}
