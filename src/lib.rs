pub mod app;
pub mod events;
pub mod styles;
pub mod alignment;
pub mod storage;

use app::{model, update};
use events::raw_window_event;
use alignment::stage_data;
use storage::{gcs_list_files_of_type, gcs_authorize_data_access};

use pyo3::prelude::*;
use std::collections::HashSet;
use lazy_static::lazy_static;

lazy_static! {
    pub static ref DATA: String = initialize_data();
}

pub fn initialize_data() -> String { "Testing".to_string() }

pub fn use_data(data: &String) {
    println!("Hidden data: {}", *data);
}

#[pyclass]
pub struct Session {
    bams: HashSet<String>,
    loci: HashSet<(String, u64, u64)>,
}

#[pymethods]
impl Session {
    #[new]
    fn new() -> Self {
        Session {
            bams: HashSet::new(),
            loci: HashSet::new(),
        }
    }

    fn attach_bams(&mut self, bams: Vec<String>) {
        self.bams = bams.into_iter().collect();
    }

    fn attach_loci(&mut self, loci: Vec<String>) -> PyResult<()> {
        for locus in loci {
            let l_fmt = locus.replace(",", "");
            let parts: Vec<&str> = l_fmt.split(|c| c == ':' || c == '-')
                                        .collect();

            let chr = parts[0].to_string();
            let start = match parts[1].parse::<u64>() {
                Ok(val) => val,
                Err(_) => {
                    return Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                        format!("Failed to parse start as u64 for locus '{}'.", locus)
                    ));
                }
            };

            if parts.len() == 2 {
                self.loci.insert((chr, start - 1000, start + 1000));
            } else if parts.len() == 3 {
                let stop = match parts[2].parse::<u64>() {
                    Ok(val) => val,
                    Err(_) => {
                        return Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                            format!("Failed to parse stop as u64 for locus '{}'.", locus)
                        ));
                    }
                };

                self.loci.insert((chr, start, stop));
            } else {
                return Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                    format!("Locus format for '{}' is incorrect. It should be 'chr:start[-stop]'.", locus)
                ));
            }
        }
        Ok(())
    }

    fn stage(&mut self) -> PyResult<()> {
        let cache_path = std::env::temp_dir();

        println!("cache_path: {:?}", cache_path);

        gcs_authorize_data_access();
        stage_data(cache_path, &self.bams, &self.loci)
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
}

#[pyfunction]
fn init() -> PyResult<Session> {
    Ok(Session::new())
}

#[pyfunction]
fn show() {
    nannou::app(model)
        .update(update)
        .loop_mode(nannou::LoopMode::Wait)
        .run();
}

/// A Python module implemented in Rust. The name of this function must match
/// the `lib.name` setting in the `Cargo.toml`, else Python will not be able to
/// import the module.
#[pymodule]
fn genomeshader(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(gcs_list_files_of_type, m)?)?;

    m.add_function(wrap_pyfunction!(init, m)?)?;
    m.add_function(wrap_pyfunction!(show, m)?)?;

    Ok(())
}