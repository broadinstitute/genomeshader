pub mod alignment;
pub mod storage;

use alignment::stage_data;
use storage::*;

use std::{collections::{HashSet, HashMap}, path::PathBuf, cell::RefCell};

use polars::prelude::*;
use pyo3::prelude::*;
use pyo3_polars::PyDataFrame;

// Needed to pass some data into our Nannou app.
// thread_local!(static GLOBAL_DATA: RefCell<PyDataFrame> = RefCell::new(PyDataFrame(DataFrame::default())));

#[pyclass]
pub struct Session {
    reads: HashSet<String>,
    loci: HashSet<(String, u64, u64)>,
    staged_data: HashMap<(String, u64, u64), PathBuf>
}

#[pymethods]
impl Session {
    #[new]
    fn new() -> Self {
        Session {
            reads: HashSet::new(),
            loci: HashSet::new(),
            staged_data: HashMap::new()
        }
    }

    fn attach_reads(&mut self, reads: Vec<String>) -> PyResult<()> {
        for read in &reads {
            if !read.ends_with(".bam") && !read.ends_with(".cram") {
                return Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("File '{}' is not a .bam or .cram file.", read)
                ));
            }
        }

        for read in reads {
            self.reads.insert(read);
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

        gcs_authorize_data_access();
        match stage_data(cache_path, &self.reads, &self.loci, use_cache) {
            Ok(staged_data) => { self.staged_data = staged_data; },
            Err(_) => {
                return Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("Failed to stage data.")
                ));
            }
        }

        Ok(())
    }

    fn get_staged_locus(&self, locus: String) -> PyResult<PyDataFrame> {
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
        self.reads = HashSet::new();
        self.loci = HashSet::new();
        self.staged_data = HashMap::new();

        Ok(())
    }

    fn print(&self) {
        println!("Reads:");
        for reads in &self.reads {
            println!(" - {}", reads);
        }

        println!("Loci:");
        for locus in &self.loci {
            println!(" - {:?}", locus);
        }

        println!("Staging:");
        for (l_fmt, p) in &self.staged_data {
            println!(" - {}:{}-{} : {:?}", l_fmt.0, l_fmt.1, l_fmt.2, p);
        }
    }

    fn version(&self) -> PyResult<String> {
        Ok(env!("CARGO_PKG_VERSION").to_string())
    }
}

#[pyfunction]
fn _init() -> PyResult<Session> {
    Ok(Session::new())
}

/// A Python module implemented in Rust. The name of this function must match
/// the `lib.name` setting in the `Cargo.toml`, else Python will not be able to
/// import the module.
#[pymodule]
fn genomeshader(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(_gcs_list_files_of_type, m)?)?;
    m.add_function(wrap_pyfunction!(_init, m)?)?;

    Ok(())
}