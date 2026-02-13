pub mod alignment;
pub mod env;
pub mod stage;
pub mod storage_gcs;
pub mod storage_local;
pub mod variants;

use stage::stage_data;
use stage::fetch_reads_from_first_bam;
use stage::fetch_reads_from_bam_urls;
use storage_gcs::*;

use std::{ collections::{ HashSet, HashMap }, path::PathBuf };

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
    /// Each element is a group of variant files (one track). attach_variants adds a new group.
    variant_file_groups: Vec<Vec<String>>,
}

#[pymethods]
impl Session {
    #[new]
    fn new() -> Self {
        Session {
            reads_cohort: HashSet::new(),
            loci: HashSet::new(),
            staged_tree: HashMap::new(),
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
        let parts: Vec<&str> = l_fmt.split(|c| (c == ':' || c == '-')).collect();

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
        let cache_path = std::env::temp_dir();

        match stage_data(&self.reads_cohort, &self.loci, &cache_path, use_cache) {
            Ok(staged_data) => {
                for (locus, path) in &staged_data {
                    if !self.staged_tree.contains_key(&locus.0) {
                        self.staged_tree.insert(locus.0.clone(), iset::IntervalMap::new());
                    }

                    let map = self.staged_tree.get_mut(&locus.0).unwrap();
                    map.entry(locus.1..locus.2).or_insert(path.clone());
                }
            }
            Err(_) => {
                return Err(
                    PyErr::new::<pyo3::exceptions::PyValueError, _>(
                        format!("Failed to stage data.")
                    )
                );
            }
        }

        Ok(())
    }

    fn get_locus(&self, locus: String) -> PyResult<PyDataFrame> {
        let l_fmt = self.parse_locus(locus.clone())?;

        if let Some(subtree) = self.staged_tree.get(&l_fmt.0) {
            for (range, filename) in subtree.iter(l_fmt.1..l_fmt.2) {
                let file_r = std::fs::File::open(&filename).unwrap();
                let df = ParquetReader::new(file_r)
                    .finish()
                    .unwrap()
                    .lazy()
                    .filter(
                        col("reference_start")
                            .gt(lit(range.start))
                            .and(col("reference_start"))
                            .lt(lit(range.end))
                            .or(
                                col("reference_end")
                                    .gt(lit(range.start))
                                    .and(col("reference_end"))
                                    .lt(lit(range.end))
                            )
                    )
                    .collect()
                    .unwrap();

                return Ok(PyDataFrame(df));
            }
        }

        Err(
            PyErr::new::<pyo3::exceptions::PyValueError, _>(
                format!("Locus '{}' is not staged.", locus)
            )
        )
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
    fn get_locus_variants(&self, locus: String) -> PyResult<PyDataFrame> {
        let l_fmt = self.parse_locus(locus.clone())?;

        if self.variant_file_groups.is_empty() {
            return Err(
                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("No variant files attached. Use attach_variants() first.")
                )
            );
        }

        let mut combined_df: Option<DataFrame> = None;

        for (group_index, file_list) in self.variant_file_groups.iter().enumerate() {
            let mut group_df: Option<DataFrame> = None;
            for variant_file in file_list {
                match variants::extract_variants(variant_file, &l_fmt.0, &l_fmt.1, &l_fmt.2) {
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
                df.with_column(
                    Series::new("variant_track_id", track_ids)
                ).map_err(|e| {
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
            Some(df) => Ok(PyDataFrame(df)),
            None => Err(
                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("Failed to extract variants from any attached files for locus '{}'.", locus)
                )
            )
        }
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
    fn fetch_reads_for_locus(&self, locus: String, bam_urls: Vec<String>) -> PyResult<PyDataFrame> {
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

        let cohort = String::from("all");
        let cache_path = std::env::temp_dir();

        match fetch_reads_from_bam_urls(&reads_urls, &cohort, &l_fmt.0, &l_fmt.1, &l_fmt.2, &cache_path) {
            Ok(df) => Ok(PyDataFrame(df)),
            Err(e) => Err(
                PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("Failed to fetch reads for locus '{}': {}", locus, e)
                )
            )
        }
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
fn _init() -> PyResult<Session> {
    Ok(Session::new())
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
