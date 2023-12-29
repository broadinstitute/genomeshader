pub mod colors {
    use nannou::color::*;

    pub const GS_UI_BACKGROUND: rgb::Srgb<u8> = rgb::Srgb { red: 255, green: 255, blue: 255, standard: ::core::marker::PhantomData };
    pub const GS_UI_TEXT: rgb::Srgb<u8> = rgb::Srgb { red: 0, green: 0, blue: 0, standard: ::core::marker::PhantomData };
    pub const GS_UI_TRACK_1: rgb::Srgb<u8> = rgb::Srgb { red: 196, green: 209, blue: 217, standard: ::core::marker::PhantomData };
    pub const GS_UI_TRACK_2: rgb::Srgb<u8> = rgb::Srgb { red: 113, green: 131, blue: 143, standard: ::core::marker::PhantomData };
}

pub mod sizes {
    pub const GS_UI_APP_WIDTH: u32 = 1000;
    pub const GS_UI_APP_HEIGHT: u32 = 500;

    pub const GS_UI_TRACK_SPACING: f32 = -15.0;
    pub const GS_UI_TRACK_HEIGHT: f32 = 10.0;
    pub const GS_UI_TRACK_FONT_SIZE: u32 = 10;
    pub const GS_UI_TRACK_LABEL_SPACING: f32 = -50.0;
}