pub mod alignment;
pub mod env;
pub mod stage;
pub mod storage_gcs;
pub mod storage_local;

use stage::stage_data;
use storage_gcs::*;

use std::{collections::{HashSet, HashMap}, path::PathBuf};
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
    staged_data: HashMap<(String, u64, u64), PathBuf>
}

#[pymethods]
impl Session {
    #[new]
    fn new() -> Self {
        Session {
            reads_cohort: HashSet::new(),
            loci: HashSet::new(),
            staged_data: HashMap::new()
        }
    }

    fn attach_reads(&mut self, read_files: Vec<String>, cohort: String) -> PyResult<()> {
        for read_file in &read_files {
            if !read_file.ends_with(".bam") && !read_file.ends_with(".cram") {
                return Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("File '{}' is not a .bam or .cram file.", read_file)
                ));
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
        let parts: Vec<&str> = l_fmt.split(|c| c == ':' || c == '-')
                                    .collect();

        let chr = parts[0].to_string();

        if parts.len() == 2 {
            let start = match parts[1].parse::<u64>() {
                Ok(val) => val,
                Err(_) => {
                    return Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                        format!("Failed to parse start as u64 for locus '{}'.", locus)
                    ));
                }
            };

            Ok((chr, start - 1000, start + 1000))
        } else if parts.len() == 3 {
            let start = match parts[1].parse::<u64>() {
                Ok(val) => val,
                Err(_) => {
                    return Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                        format!("Failed to parse start as u64 for locus '{}'.", locus)
                    ));
                }
            };

            let stop = match parts[2].parse::<u64>() {
                Ok(val) => val,
                Err(_) => {
                    return Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                        format!("Failed to parse stop as u64 for locus '{}'.", locus)
                    ));
                }
            };

            Ok((chr, start, stop))
        } else {
            Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                format!("Locus format for '{}' is incorrect. It should be 'chr:start[-stop]'.", locus)
            ))
        }
    }

    fn attach_loci(&mut self, loci: Vec<String>) -> PyResult<()> {
        for locus in loci {
            match self.parse_locus(locus.to_owned()) {
                Ok(l_fmt) => { self.loci.insert(l_fmt); },
                Err(e) => return Err(e),
            }
        }

        Ok(())
    }

    fn stage(&mut self, use_cache: bool) -> PyResult<()> {
        let cache_path = std::env::temp_dir();

        match stage_data(&self.reads_cohort, &self.loci, &cache_path, use_cache) {
            Ok(staged_data) => { self.staged_data = staged_data; },
            Err(_) => {
                return Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("Failed to stage data.")
                ));
            }
        }

        Ok(())
    }

    fn get_locus(&self, locus: String) -> PyResult<PyDataFrame> {
        let l_fmt = self.parse_locus(locus.to_owned())?;

        if self.staged_data.contains_key(&l_fmt) {
            let filename = self.staged_data.get(&l_fmt).unwrap().to_owned();
            let file = std::fs::File::open(&filename).unwrap();

            let df = ParquetReader::new(file).finish().unwrap();

            Ok(PyDataFrame(df))
        } else {
            Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                format!("Locus '{}' is not staged.", locus)
            ))
        }
    }

    fn reset(&mut self) -> PyResult<()> {
        self.reads_cohort = HashSet::new();
        self.loci = HashSet::new();
        self.staged_data = HashMap::new();

        Ok(())
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
        if self.staged_data.len() <= 10 {
            for (l_fmt, p) in &self.staged_data {
                println!(" - {}:{}-{} : {:?}", l_fmt.0, l_fmt.1, l_fmt.2, p);
            }
        } else {
            println!(" - {} loci staged", self.staged_data.len());
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

/// A Python module implemented in Rust. The name of this function must match
/// the `lib.name` setting in the `Cargo.toml`, else Python will not be able to
/// import the module.
#[pymodule]
fn genomeshader(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(_gcs_list_files_of_type, m)?)?;
    m.add_function(wrap_pyfunction!(_init, m)?)?;
    m.add_function(wrap_pyfunction!(_version, m)?)?;

    Ok(())
}