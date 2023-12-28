use std::f32::INFINITY;

use nannou::{prelude::*, glam};
use nannou_egui::*;

use egui_dock::{DockArea, DockState, NodeIndex, Style};
use egui::{Ui, WidgetText};

const GS_UI_BACKGROUND: rgb::Srgb<u8> = rgb::Srgb { red: 255, green: 255, blue: 255, standard: ::core::marker::PhantomData };
const GS_UI_TRACK_1: rgb::Srgb<u8> = rgb::Srgb { red: 196, green: 209, blue: 217, standard: ::core::marker::PhantomData };
const GS_UI_TRACK_2: rgb::Srgb<u8> = rgb::Srgb { red: 113, green: 131, blue: 143, standard: ::core::marker::PhantomData };

struct TabViewer {}

impl egui_dock::TabViewer for TabViewer {
    type Tab = String;

    fn title(&mut self, tab: &mut Self::Tab) -> egui::WidgetText {
        (&*tab).into()
    }

    fn ui(&mut self, ui: &mut egui::Ui, tab: &mut Self::Tab) {
        ui.label(format!("Content of {tab}"));
    }
}

struct Settings {
    resolution: u32,
    scale: f32,
    rotation: bool,
    flip: bool,
    pan: bool,
    last_position: Vec2,
    position: Vec2,
    stretch: f32,
    zoom: f32,
    show_settings: bool,
    show_context_menu: bool,
    tree: DockState<String>,
}

struct Model {
    settings: Settings,
    egui: Egui,
}

fn raw_window_event(_app: &App, model: &mut Model, event: &nannou::winit::event::WindowEvent) {
    // Let egui handle things like keyboard and mouse input.
    model.egui.handle_raw_event(event);

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

    // Handle mouse drag events for panning
    if let nannou::winit::event::WindowEvent::MouseInput { state, button, .. } = event {
        if *state == nannou::winit::event::ElementState::Pressed && *button == nannou::state::mouse::Button::Left {
            model.settings.pan = true;
            model.settings.show_context_menu = false;
        }

        if *state == nannou::winit::event::ElementState::Released && *button == nannou::state::mouse::Button::Left {
            model.settings.pan = false;
        }

        if *state == nannou::winit::event::ElementState::Pressed && *button == nannou::state::mouse::Button::Right {
            model.settings.show_context_menu = true;
        }
    }

    if model.settings.pan {
        if let nannou::winit::event::WindowEvent::CursorMoved { position, .. } = event {
            let this_position = vec2(position.x as f32, -position.y as f32);

            if model.settings.last_position.x != INFINITY {
                let diff_position = this_position - model.settings.last_position;
                model.settings.position += diff_position/5.0;
            }

            model.settings.last_position = this_position;
        }
    }

    // Capture keypress for 'S' and toggle model.settings.show_settings
    if let nannou::winit::event::WindowEvent::KeyboardInput { input, .. } = event {
        if let Some(nannou::winit::event::VirtualKeyCode::S) = input.virtual_keycode {
            if input.state == nannou::winit::event::ElementState::Pressed {
                model.settings.show_settings = !model.settings.show_settings;
            }
        }

        if let Some(nannou::winit::event::VirtualKeyCode::R) = input.virtual_keycode {
            if input.state == nannou::winit::event::ElementState::Pressed {
                model.settings.rotation = !model.settings.rotation;
            }
        }

        if let Some(nannou::winit::event::VirtualKeyCode::F) = input.virtual_keycode {
            if input.state == nannou::winit::event::ElementState::Pressed {
                model.settings.flip = !model.settings.flip;
            }
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
    let tree = DockState::new(vec!["Tab1".to_owned()]);

    Model {
        egui,
        settings: Settings {
            resolution: 10,
            scale: 200.0,
            rotation: true,
            flip: false,
            pan: false,
            last_position: vec2(INFINITY, INFINITY),
            position: vec2(0.0, 0.0),
            stretch: 1.0,
            zoom: 1.0,
            show_settings: false,
            show_context_menu: false,
            tree: tree
        },
    }
}

fn view(app: &App, model: &Model, frame: Frame) {
    let settings = &model.settings;

    let transform = glam::Mat4::from_scale_rotation_translation(
        glam::Vec3::new(settings.zoom, settings.zoom, 1.0), // scale
        if settings.rotation {
            glam::Quat::IDENTITY
        } else {
            glam::Quat::from_rotation_z(std::f32::consts::FRAC_PI_2)
        },
        glam::Vec3::new(settings.position.x, settings.position.y, 0.0) // translation
    );

    let draw = app
        .draw()
        .scale_x(if settings.rotation { settings.stretch } else { 1.0 })
        .scale_y(if settings.rotation { 1.0 } else { settings.stretch })
        .transform(transform);

    draw.background().color(GS_UI_BACKGROUND);

    draw.rect()
        .stroke_weight(1.0)
        .caps_round()
        .x(settings.position.x)
        .y(settings.position.y)
        .width(400.0)
        .height(10.0)
        .color(GS_UI_TRACK_1);

    draw.rect()
        .stroke_weight(1.0)
        .caps_round()
        .x(settings.position.x)
        .y(settings.position.y + 15.0)
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

    egui::TopBottomPanel::top("header").show(&ctx, |ui| {
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.small_button("Rotate").clicked() {
                settings.rotation = !settings.rotation;
            }

            if ui.small_button("+").clicked() {
                let tab_id = format!("Tab{}", settings.tree.main_surface().num_tabs() + 1);
                // settings.tree.main_surface_mut().split_right(NodeIndex::root(), 0.3, vec![tab_id.to_owned()]);
                if let Some(root_node) = settings.tree.main_surface_mut().root_node_mut() {
                    root_node.append_tab(tab_id.to_owned());
                } else {
                    settings.tree = DockState::new(vec!["Tab1".to_owned()]);
                }
            }
        });
    });

    let mut status_height = 0.0;
    egui::TopBottomPanel::bottom("footer").show(&ctx, |ui| {
        let status_label = ui.label("Status");
        status_height = status_label.rect.height();
    });

    egui::CentralPanel::default().show(&ctx, |ui| {
        let mut style = Style::from_egui(ui.style());

        // style.tab

        DockArea::new(&mut settings.tree)
            .style(Style::from_egui(ctx.style().as_ref()))
            .show(&ctx, &mut TabViewer {});
    });

    if settings.show_settings {
        egui::Window::new("Settings").show(&ctx, |ui| {
            // Resolution slider
            ui.label("Resolution:");
            ui.add(egui::Slider::new(&mut settings.resolution, 1..=40));

            // Scale slider
            ui.label("Scale:");
            ui.add(egui::Slider::new(&mut settings.scale, 0.0..=1000.0));
        });
    }

    if settings.show_context_menu {

    }
}

fn main() {
    nannou::app(model).update(update).run();
}