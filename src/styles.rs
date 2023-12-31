pub mod colors {
    use nannou::color::*;

    pub const GS_UI_BACKGROUND: rgb::Srgb<u8> = rgb::Srgb { red: 255, green: 255, blue: 255, standard: ::core::marker::PhantomData };
    pub const GS_UI_TEXT: rgb::Srgb<u8> = rgb::Srgb { red: 0, green: 0, blue: 0, standard: ::core::marker::PhantomData };
    pub const GS_UI_TRACK_ODD: rgb::Srgb<u8> = rgb::Srgb { red: 196, green: 209, blue: 217, standard: ::core::marker::PhantomData };
    pub const GS_UI_TRACK_EVEN: rgb::Srgb<u8> = rgb::Srgb { red: 113, green: 131, blue: 143, standard: ::core::marker::PhantomData };

    pub const GS_UI_ELEMENT_DIFF_A: rgb::Srgb<u8> = rgb::Srgb { red: 69, green: 178, blue: 157, standard: ::core::marker::PhantomData };
    pub const GS_UI_ELEMENT_DIFF_C: rgb::Srgb<u8> = rgb::Srgb { red: 51, green: 77, blue: 92, standard: ::core::marker::PhantomData };
    pub const GS_UI_ELEMENT_DIFF_G: rgb::Srgb<u8> = rgb::Srgb { red: 226, green: 122, blue: 63, standard: ::core::marker::PhantomData };
    pub const GS_UI_ELEMENT_DIFF_T: rgb::Srgb<u8> = rgb::Srgb { red: 223, green: 90, blue: 73, standard: ::core::marker::PhantomData };

    pub const GS_UI_ELEMENT_INSERTION: rgb::Srgb<u8> = rgb::Srgb { red: 104, green: 92, blue: 121, standard: ::core::marker::PhantomData };
    pub const GS_UI_ELEMENT_DELETION: rgb::Srgb<u8> = rgb::Srgb { red: 0, green: 0, blue: 0, standard: ::core::marker::PhantomData };
    pub const GS_UI_ELEMENT_SOFTCLIP: rgb::Srgb<u8> = rgb::Srgb { red: 239, green: 201, blue: 76, standard: ::core::marker::PhantomData };
}

pub mod sizes {
    pub const GS_UI_APP_WIDTH: u32 = 1000;
    pub const GS_UI_APP_HEIGHT: u32 = 500;

    pub const GS_UI_TRACK_SPACING: f32 = -15.0;
    pub const GS_UI_TRACK_HEIGHT: f32 = 10.0;
    pub const GS_UI_TRACK_FONT_SIZE: u32 = 10;
    pub const GS_UI_TRACK_LABEL_SPACING: f32 = -50.0;
}