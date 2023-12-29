pub mod app;
use app::{model, update};

pub mod events;
use events::raw_window_event;

pub mod styles;

pub mod alignment;
use alignment::stage_data;

pub mod storage;
use storage::gcs_list_files_of_type;

use pyo3::prelude::*;
use std::thread;

#[pyfunction]
fn show() -> PyResult<()> {
    std::panic::catch_unwind(|| {
        nannou::app(model)
            .update(update)
            .loop_mode(nannou::LoopMode::Wait)
            .run();
    }).unwrap_or_else(|_| {
        eprintln!("The Rust application crashed");
    });

    Ok(())
}

/// A Python module implemented in Rust. The name of this function must match
/// the `lib.name` setting in the `Cargo.toml`, else Python will not be able to
/// import the module.
#[pymodule]
fn genomeshader(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(gcs_list_files_of_type, m)?)?;
    m.add_function(wrap_pyfunction!(stage_data, m)?)?;
    m.add_function(wrap_pyfunction!(show, m)?)?;

    Ok(())
}