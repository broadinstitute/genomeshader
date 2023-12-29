use egui::{Pos2, Vec2, vec2};
use nannou::{prelude::*, glam};
use nannou_egui::*;

use crate::raw_window_event;
use crate::styles::{colors, sizes};

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

    for i in 0..3 {
        draw.text(format!("Sample {}", i).as_str())
            .color(colors::GS_UI_TEXT)
            .center_justify()
            .font_size(sizes::GS_UI_TRACK_FONT_SIZE)
            .x(sizes::GS_UI_TRACK_LABEL_SPACING)
            .y((i as f32) * sizes::GS_UI_TRACK_SPACING);

        draw.rect()
            .stroke_weight(1.0)
            .caps_round()
            .x(200.0)
            .y((i as f32) * sizes::GS_UI_TRACK_SPACING)
            .width(400.0)
            .height(sizes::GS_UI_TRACK_HEIGHT)
            .color(colors::GS_UI_TRACK_1);
    }

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
            // egui::show_tooltip_text(&ctx, egui::Id::new("my_tooltip"), "Hello");
            // egui::show_tooltip_at_pointer(&ctx, egui::Id::new("my_tooltip"), |ui| {});

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
