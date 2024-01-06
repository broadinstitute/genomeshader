use std::collections::HashSet;
use rayon::prelude::*; 

use egui::{Pos2, Vec2, vec2};
use nannou::{prelude::*, glam};
use nannou_egui::*;
use polars::prelude::*;

use crate::{raw_window_event, compute_rects_and_colors, compute_transform, draw_rects};
use crate::styles::{colors, sizes};
use crate::GLOBAL_DATA;

const KB_IN_GB: u64 = 1048576;

pub struct Settings {
    pub pan: Vec2,
    pub rotate: bool,
    pub stretch: f32,
    pub zoom: f32,

    pub show_settings: bool,

    pub show_popup: bool,
    pub pos_popup: Pos2,

    pub changed: bool
}

pub struct Model {
    pub settings: Settings,
    pub egui: Egui,
    pub rects: Vec<(f32, f32, f32, f32, Rgb<u8>)>,
    pub transform: glam::Mat4,
    pub draw: Draw,
}

pub fn model(app: &App) -> Model {
    // Create window
    let window_id = app
        .new_window()
        .title("GenomeShader")
        .size(sizes::GS_UI_APP_WIDTH, sizes::GS_UI_APP_HEIGHT)
        .view(view)
        .raw_event(raw_window_event)
        .build()
        .unwrap();

    let window = app.window(window_id).unwrap();
    let egui = Egui::from_window(&window);
    let settings = Settings {
        pan: vec2(0.0, 0.0),
        rotate: true,
        stretch: 1.0,
        zoom: 1.0,
        show_settings: false,
        show_popup: false,
        pos_popup: Pos2::new(0.0, 0.0),
        changed: false
    };

    let rects = compute_rects_and_colors();
    let transform = compute_transform(&settings);
    let draw = draw_rects(&app, &transform, &rects);

    Model {
        egui,
        settings,
        rects,
        transform,
        draw
    }
}

pub fn view(app: &App, model: &Model, frame: Frame) {
    let transform = compute_transform(&model.settings);
    let draw = draw_rects(app, &transform, &model.rects);

    draw.to_frame(app, &frame).unwrap();

    // Now we're done! The commands we added will be submitted after `view` completes.
    model.egui.draw_to_frame(&frame).unwrap();
}

pub fn update(app: &App, model: &mut Model, update: Update) {
    let egui = &mut model.egui;
    let settings = &mut model.settings;

    egui.set_elapsed_time(update.since_start);
    let ctx = egui.begin_frame();

    egui::TopBottomPanel::bottom("footer").show(&ctx, |ui| {
        let mem_info = sys_info::mem_info().unwrap();

        ui.label(format!("[RAM] {:.1}/{:.1}", ((mem_info.total - mem_info.avail) / KB_IN_GB) as f64, mem_info.total as f64 / KB_IN_GB as f64));
    });

    match app.mouse.buttons.right().if_down() {
        Some(mouse_pos) => {
            if !settings.show_popup {
                settings.show_popup = true;
                settings.pos_popup = Pos2::new(
                    mouse_pos.x + (app.window_rect().w()/2.0),
                    (app.window_rect().h()/2.0) - mouse_pos.y
                );
            }
        },
        None => {},
    }

    if settings.show_popup {
        egui::Area::new("menu")
            .fixed_pos(settings.pos_popup)
            .show(&ctx, |ui| {
            if ui.button("Close").clicked() {
                settings.show_popup = false;
            };
        });
    }

    if settings.show_settings {
        egui::Window::new("Settings").show(&ctx, |ui| {
            // Pan X slider
            ui.label("Pan X:");
            ui.add(egui::Slider::new(&mut settings.pan.x, -1000000.0..=1000000.0));

            // Pan Y slider
            ui.label("Pan Y:");
            ui.add(egui::Slider::new(&mut settings.pan.y, -1000000.0..=1000000.0));

            if ui.button("reset").clicked() {
                settings.pan.x = 0.0;
                settings.pan.y = 0.0;
                settings.rotate = true;
                settings.zoom = 1.0;
            }
        });
    }
}

pub fn exit(app: &App, model: Model) {
    println!("Exit!");
}