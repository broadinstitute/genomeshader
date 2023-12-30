pub mod app;
pub mod events;
pub mod styles;
pub mod alignment;
pub mod storage;

use app::{model, update};
use events::raw_window_event;
use alignment::stage_data;
use storage::gcs_list_files_of_type;

use pyo3::prelude::*;
use std::{collections::{HashSet, HashMap}, path::PathBuf, cell::RefCell};

// Needed to pass some data into our Nannou app.
thread_local!(static GLOBAL_DATA: RefCell<PathBuf> = RefCell::new(PathBuf::new()));

#[pyclass]
pub struct Session {
    bams: HashSet<String>,
    loci: HashSet<(String, u64, u64)>,
    staged_data: HashMap<(String, u64, u64), PathBuf>
}

#[pymethods]
impl Session {
    #[new]
    fn new() -> Self {
        Session {
            bams: HashSet::new(),
            loci: HashSet::new(),
            staged_data: HashMap::new()
        }
    }

    fn attach_bams(&mut self, bams: Vec<String>) {
        self.bams = bams.into_iter().collect();
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

    fn stage(&mut self) -> PyResult<()> {
        let cache_path = std::env::temp_dir();

        match stage_data(cache_path, &self.bams, &self.loci) {
            Ok(staged_data) => { self.staged_data = staged_data; },
            Err(e) => {
                return Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("Failed to stage data.")
                ));
            }
        }

        Ok(())
    }

    fn print(&self) {
        println!("BAMs:");
        for bam in &self.bams {
            println!(" - {}", bam);
        }

        println!("Loci:");
        for locus in &self.loci {
            println!(" - {:?}", locus);
        }
    }

    fn show(&self, locus: String) -> PyResult<()> {
        let l_fmt = self.parse_locus(locus.to_owned())?;

        if self.staged_data.contains_key(&l_fmt) {
            let p = self.staged_data.get(&l_fmt).unwrap().to_owned();

            // This is a hack required because there doesn't seem to be a
            // convenient way of passing arbitrary variables from the
            // current scope into our Nannou app.
            GLOBAL_DATA.with(|path| {
                *path.borrow_mut() = p;
            });

            nannou::app(model)
                .update(update)
                .loop_mode(nannou::LoopMode::Wait)
                .run();
        } else {
            return Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                format!("Locus '{}' is not staged.", locus)
            ));
        }

        Ok(())
    }
}

#[pyfunction]
fn init() -> PyResult<Session> {
    Ok(Session::new())
}

/// A Python module implemented in Rust. The name of this function must match
/// the `lib.name` setting in the `Cargo.toml`, else Python will not be able to
/// import the module.
#[pymodule]
fn genomeshader(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(gcs_list_files_of_type, m)?)?;
    m.add_function(wrap_pyfunction!(init, m)?)?;

    Ok(())
}