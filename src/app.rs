use egui::{Pos2, Vec2, vec2};
use nannou::{prelude::*, glam};
use nannou_egui::*;
use polars::prelude::*;

use crate::raw_window_event;
use crate::styles::{colors, sizes};
use crate::GLOBAL_DATA;

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
        .transform(transform);

    draw.background().color(colors::GS_UI_BACKGROUND);

    GLOBAL_DATA.with(|data| {
        let of = &data.borrow().0;

        let df = of.sort(
            &["sample_name", "query_name", "reference_start"],
            false,
            true
        ).unwrap();

        let mut prev_sample_name = df.column("sample_name").unwrap().get(0).unwrap().to_string();
        let mut y0s = vec![0.0 as f32];
        let mut y0 = 0.0 as f32;

        for sample_name in df.column("sample_name").unwrap().iter() {
            let sample_name = sample_name.to_string();

            if prev_sample_name != sample_name {
                y0 += 1.0;
                prev_sample_name = sample_name;
            }

            y0s.push(y0);
        }

        let sample_names = df.column("sample_name").unwrap().utf8().unwrap();
        let reference_starts = df.column("reference_start").unwrap().u32().unwrap();
        let reference_ends = df.column("reference_end").unwrap().u32().unwrap();
        let element_types = df.column("element_type").unwrap().u8().unwrap();

        let reference_start_0 = df.column("reference_start").unwrap().u32().unwrap().get(0).unwrap();

        for i in 0..sample_names.len() {
            let y = *y0s.get(i).unwrap();

            draw.rect()
                .stroke_weight(1.0)
                .caps_round()
                .x((reference_starts.get(i).unwrap() - reference_start_0) as f32)
                .width((reference_ends.get(i).unwrap() - reference_starts.get(i).unwrap()) as f32)
                .y(y * sizes::GS_UI_TRACK_SPACING)
                .height(sizes::GS_UI_TRACK_HEIGHT)
                .color(colors::GS_UI_TRACK_1);
        }
    });

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
        ui.label(format!("Status: {:?} {:?}", app.mouse.position(), app.mouse.buttons));
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
            ui.add(egui::Slider::new(&mut settings.pan.x, -1000.0..=1000.0));

            // Pan Y slider
            ui.label("Pan Y:");
            ui.add(egui::Slider::new(&mut settings.pan.y, -1000.0..=1000.0));

            if ui.button("reset").clicked() {
                settings.pan.x = 0.0;
                settings.pan.y = 0.0;
                settings.rotate = true;
                settings.zoom = 1.0;
            }
        });
    }
}