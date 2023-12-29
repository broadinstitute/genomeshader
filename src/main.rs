use egui::{Pos2, Widget, Id};
use nannou::{prelude::*, glam};
use nannou_egui::*;

const GS_UI_BACKGROUND: rgb::Srgb<u8> = rgb::Srgb { red: 255, green: 255, blue: 255, standard: ::core::marker::PhantomData };
const GS_UI_TEXT: rgb::Srgb<u8> = rgb::Srgb { red: 0, green: 0, blue: 0, standard: ::core::marker::PhantomData };
const GS_UI_TRACK_1: rgb::Srgb<u8> = rgb::Srgb { red: 196, green: 209, blue: 217, standard: ::core::marker::PhantomData };
const GS_UI_TRACK_2: rgb::Srgb<u8> = rgb::Srgb { red: 113, green: 131, blue: 143, standard: ::core::marker::PhantomData };

struct Settings {
    pan: Vec2,
    rotate: bool,
    stretch: f32,
    zoom: f32,

    show_settings: bool,

    show_popup: bool,
    pos_popup: Pos2,
}

struct Model {
    settings: Settings,
    egui: Egui,
}

fn raw_window_event(_app: &App, model: &mut Model, event: &nannou::winit::event::WindowEvent) {
    // Let egui handle things like keyboard and mouse input.
    model.egui.handle_raw_event(event);

    handle_zoom(event, model);
    handle_hotkeys(event, model);
}

fn handle_zoom(event: &nannou::winit::event::WindowEvent<'_>, model: &mut Model) {
    // Handle mouse wheel events
    if let nannou::winit::event::WindowEvent::MouseWheel { delta, .. } = event {
        match delta {
            nannou::winit::event::MouseScrollDelta::PixelDelta(p) => {
                if model.egui.ctx().input(|i| i.modifiers.shift) {
                    model.settings.stretch *= 1.0 + ((p.y as f32) * 0.01);
                } else {
                    model.settings.zoom *= 1.0 + ((p.y as f32) * 0.01); // adjust zoom factor as needed
                }
            }
            _ => (),
        }
    }

    // Capture Command+Plus and Command+Minus keyboard shortcuts
    if let nannou::winit::event::WindowEvent::KeyboardInput { input, .. } = event {
        if let Some(nannou::winit::event::VirtualKeyCode::Equals) = input.virtual_keycode {
            if input.state == nannou::winit::event::ElementState::Pressed && model.egui.ctx().input(|i| i.modifiers.command) {
                model.settings.zoom *= 1.2; // adjust zoom factor as needed
            }
        }

        if let Some(nannou::winit::event::VirtualKeyCode::Minus) = input.virtual_keycode {
            if input.state == nannou::winit::event::ElementState::Pressed && model.egui.ctx().input(|i| i.modifiers.command) {
                model.settings.zoom *= 0.8; // adjust zoom factor as needed
            }
        }
    }
}

fn handle_hotkeys(event: &nannou::winit::event::WindowEvent<'_>, model: &mut Model) {
    // Capture keypress for 'S' and toggle model.settings.show_settings
    if let nannou::winit::event::WindowEvent::KeyboardInput { input, .. } = event {
        match input.virtual_keycode {
            Some(nannou::winit::event::VirtualKeyCode::S) => {
                if input.state == nannou::winit::event::ElementState::Pressed {
                    model.settings.show_settings = !model.settings.show_settings;
                }
            },
            Some(nannou::winit::event::VirtualKeyCode::R) => {
                if input.state == nannou::winit::event::ElementState::Pressed {
                    model.settings.rotate = !model.settings.rotate;
                }
            },
            _ => {}
        }
    }
}

fn model(app: &App) -> Model {
    // Create window
    let window_id = app
        .new_window()
        .title("GenomeShader")
        .size(1000, 500)
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

fn view(app: &App, model: &Model, frame: Frame) {
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

    draw.background().color(GS_UI_BACKGROUND);

    draw.text("Sample 1")
        .color(GS_UI_TEXT)
        .center_justify()
        .font_size(10)
        .x(-50.0)
        .y(0.0);

    draw.rect()
        .stroke_weight(1.0)
        .caps_round()
        .x(200.0)
        .y(0.0)
        .width(400.0)
        .height(10.0)
        .color(GS_UI_TRACK_1);

    draw.rect()
        .stroke_weight(1.0)
        .caps_round()
        .x(200.0)
        .y(15.0)
        .width(400.0)
        .height(10.0)
        .color(GS_UI_TRACK_2);

    draw.to_frame(app, &frame).unwrap();

    // Now we're done! The commands we added will be submitted after `view` completes.
    model.egui.draw_to_frame(&frame).unwrap();
}

fn update(app: &App, model: &mut Model, update: Update) {
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
            }
        });
    }
}

fn main() {
    nannou::app(model).update(update).run();
}