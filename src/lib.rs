pub mod app;
pub mod events;
pub mod styles;
pub mod alignment;
pub mod storage;
pub mod layout;

use app::{model, update, exit};
use events::raw_window_event;
use alignment::stage_data;
use storage::gcs_list_files_of_type;
use layout::*;

use std::{collections::{HashSet, HashMap}, path::PathBuf, cell::RefCell};

use polars::prelude::*;
use pyo3::prelude::*;
use pyo3_polars::PyDataFrame;

use eframe::egui;

// Needed to pass some data into our Nannou app.
// thread_local!(static GLOBAL_DATA: RefCell<PathBuf> = RefCell::new(PathBuf::new()));
thread_local!(static GLOBAL_DATA: RefCell<PyDataFrame> = RefCell::new(PyDataFrame(DataFrame::default())));

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

    fn display_locus(&self, locus: String) -> PyResult<()> {
        match self.get_staged_locus(locus) {
            Ok(df) => { return self.display(df) },
            Err(e) => return Err(e),
        }
    }

    fn display(&self, df: PyDataFrame) -> PyResult<()> {
        // This hack is required because there doesn't seem to be a
        // convenient way of passing arbitrary variables from the
        // current scope into a Nannou app.
        GLOBAL_DATA.with(|pydf| {
            *pydf.borrow_mut() = df;
        });

        nannou::app(model)
            .update(update)
            .loop_mode(nannou::LoopMode::Wait)
            .exit(exit)
            .run();

        println!("Done!");

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

        println!("Staging:");
        for (l_fmt, p) in &self.staged_data {
            println!(" - {}:{}-{} : {:?}", l_fmt.0, l_fmt.1, l_fmt.2, p);
        }
    }
}

#[pyfunction]
fn init() -> PyResult<Session> {
    Ok(Session::new())
}

#[pyfunction]
pub fn old_window() -> PyResult<()> {
    let options = eframe::NativeOptions {
        initial_window_size: Some(egui::vec2(320.0, 240.0)),
        ..Default::default()
    };

    let mut name = "Arthur".to_owned();
    let mut age = 42;

    let r = eframe::run_simple_native("My egui App", options, move |ctx, _frame| {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("My egui Application");
            ui.horizontal(|ui| {
                let name_label = ui.label("Your name: ");
                ui.text_edit_singleline(&mut name)
                    .labelled_by(name_label.id);
            });
            ui.add(egui::Slider::new(&mut age, 0..=120).text("age"));
            if ui.button("Click each year").clicked() {
                age += 1;
            }
            ui.label(format!("Hello '{name}', age {age}"));
        });
    });

    Ok(())
}

use winit::{
    event::{Event, WindowEvent},
    event_loop::{EventLoop, ControlFlow},
    window::WindowBuilder,
};

#[pyfunction]
pub fn new_window() -> PyResult<()> {
    let event_loop = EventLoop::new();

    let window = WindowBuilder::new()
        .with_title("A fantastic window!")
        .with_inner_size(winit::dpi::LogicalSize::new(128.0, 128.0))
        .build(&event_loop)
        .unwrap();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        println!("{:?}", event);

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                window_id,
            } if window_id == window.id() => *control_flow = ControlFlow::Exit,
            Event::MainEventsCleared => {
                window.request_redraw();
            }
            _ => (),
        }
    });

    Ok(())
}

/// A Python module implemented in Rust. The name of this function must match
/// the `lib.name` setting in the `Cargo.toml`, else Python will not be able to
/// import the module.
#[pymodule]
fn genomeshader(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(gcs_list_files_of_type, m)?)?;
    m.add_function(wrap_pyfunction!(init, m)?)?;
    m.add_function(wrap_pyfunction!(old_window, m)?)?;
    m.add_function(wrap_pyfunction!(new_window, m)?)?;

    Ok(())
}