use nannou::prelude::*;

use crate::app::Model;

pub fn raw_window_event(_app: &App, model: &mut Model, event: &nannou::winit::event::WindowEvent) {
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
            Some(nannou::winit::event::VirtualKeyCode::Up) => {
                if input.state == nannou::winit::event::ElementState::Pressed {
                    let shift_multiplier = if model.egui.ctx().input(|i| i.modifiers.shift) { 10.0 } else { 1.0 };
                    model.settings.pan.y -= 10.0 * shift_multiplier;
                }
            },
            Some(nannou::winit::event::VirtualKeyCode::Down) => {
                if input.state == nannou::winit::event::ElementState::Pressed {
                    let shift_multiplier = if model.egui.ctx().input(|i| i.modifiers.shift) { 10.0 } else { 1.0 };
                    model.settings.pan.y += 10.0 * shift_multiplier;
                }
            },
            Some(nannou::winit::event::VirtualKeyCode::Left) => {
                if input.state == nannou::winit::event::ElementState::Pressed {
                    let shift_multiplier = if model.egui.ctx().input(|i| i.modifiers.shift) { 10.0 } else { 1.0 };
                    model.settings.pan.x += 1000.0 * shift_multiplier;
                }
            },
            Some(nannou::winit::event::VirtualKeyCode::Right) => {
                if input.state == nannou::winit::event::ElementState::Pressed {
                    let shift_multiplier = if model.egui.ctx().input(|i| i.modifiers.shift) { 10.0 } else { 1.0 };
                    model.settings.pan.x -= 1000.0 * shift_multiplier;
                }
            },
            _ => {}
        }
    }
}
