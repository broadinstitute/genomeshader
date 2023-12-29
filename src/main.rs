pub mod app;
use app::{model, update};

pub mod events;
use events::raw_window_event;

pub mod styles;

fn main() {
    nannou::app(model).update(update).loop_mode(nannou::LoopMode::Wait).run();
}