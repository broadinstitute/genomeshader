use std::collections::HashSet;
use rayon::prelude::*; 

use egui::{Pos2, Vec2, vec2};
use nannou::{prelude::*, glam};
use nannou_egui::*;
use polars::prelude::*;

use crate::{raw_window_event, layout};
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
}

pub struct Model {
    pub settings: Settings,
    pub egui: Egui,
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

    Model {
        egui,
        settings: Settings {
            pan: vec2(0.0, 0.0),
            rotate: true,
            stretch: 1.0,
            zoom: 1.0,
            show_settings: false,
            show_popup: false,
            pos_popup: Pos2::new(0.0, 0.0)
        },
    }
}

pub fn view(app: &App, model: &Model, frame: Frame) {
    let settings = &model.settings;

    GLOBAL_DATA.with(|data| {
        let of = &data.borrow().0;

        let df = of.sort(
            &["sample_name", "query_name", "reference_start"],
            false,
            true
        ).unwrap();

        let mut prev_sample_name = df.column("sample_name").unwrap().get(0).unwrap().to_string();
        let mut y0s = vec![0 as u32];
        let mut y0: u32 = 0;

        for sample_name in df.column("sample_name").unwrap().iter() {
            let sample_name = sample_name.to_string();

            if prev_sample_name != sample_name {
                y0 += 1;
                prev_sample_name = sample_name;
            }

            y0s.push(y0);
        }

        let sample_names = df.column("sample_name").unwrap().utf8().unwrap();
        let reference_starts = df.column("reference_start").unwrap().u32().unwrap();
        let reference_ends = df.column("reference_end").unwrap().u32().unwrap();
        let element_types = df.column("element_type").unwrap().u8().unwrap();
        let sequence = df.column("sequence").unwrap().utf8().unwrap();
        let column_widths = df.column("column_width").unwrap().u32().unwrap();

        let reference_start_min = df.column("reference_start").unwrap().u32().unwrap().min().unwrap();
        let reference_end_max = df.column("reference_end").unwrap().u32().unwrap().max().unwrap();
        let num_samples = df.column("sample_name").unwrap().utf8().unwrap().into_iter().collect::<HashSet<_>>().len();

        let transform = glam::Mat4::from_scale_rotation_translation(
            glam::Vec3::new(settings.zoom, settings.zoom, 1.0),
            if settings.rotate {
                glam::Quat::IDENTITY
            } else {
                glam::Quat::from_rotation_z(std::f32::consts::FRAC_PI_2)
            },
            glam::Vec3::new(settings.pan.x, settings.pan.y, 0.0)
        );

        let draw = app
            .draw()
            // .scale_x(sizes::GS_UI_APP_WIDTH as f32 / ((reference_end_max - reference_start_min) as f32))
            .transform(transform);

        draw.background().color(colors::GS_UI_BACKGROUND);

        let rects: Vec<_> = (0..reference_starts.len()).into_par_iter().map(|i| {
            let width = column_widths.get(i).unwrap() as f32;
            let height = sizes::GS_UI_TRACK_HEIGHT;
            let x = reference_starts.get(i).unwrap() as f32 + (width/2.0) - (reference_start_min as f32);
            let y = *y0s.get(i).unwrap() as f32 * sizes::GS_UI_TRACK_SPACING;
            let seq = sequence.get(i).unwrap();

            let color = match element_types.get(i).unwrap() {
                // 0 => if *y0s.get(i).unwrap() % 2 == 0 { colors::GS_UI_TRACK_EVEN } else { colors::GS_UI_TRACK_ODD },
                1 => match seq {
                    "A" => colors::GS_UI_ELEMENT_DIFF_A,
                    "C" => colors::GS_UI_ELEMENT_DIFF_C,
                    "G" => colors::GS_UI_ELEMENT_DIFF_G,
                    "T" => colors::GS_UI_ELEMENT_DIFF_T,
                    _ => WHITE,
                },
                2 => colors::GS_UI_ELEMENT_INSERTION,
                3 => colors::GS_UI_ELEMENT_DELETION,
                _ => WHITE // unknown
            };

            (x, y, width, height, color)
        }).collect();

        for (x, y, width, height, color) in rects {
            draw.rect()
                .stroke_weight(0.0)
                .x(x)
                .y(y)
                .width(width)
                .height(height)
                .color(color);
        }

        draw.to_frame(app, &frame).unwrap();
    });

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