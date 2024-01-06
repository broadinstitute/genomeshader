use std::{collections::{HashSet, HashMap}, cmp::max};

use egui::{Pos2, Vec2, vec2};
use nannou::{prelude::*, glam};
use nannou_egui::*;
use polars::prelude::*;

use crate::styles::{colors, sizes};
use crate::app::{Model, Settings};
use crate::GLOBAL_DATA;

use polars::prelude::*;
use rayon::prelude::*; 

pub fn compute_rects_and_colors() -> Vec<(f32, f32, f32, f32, Rgb<u8>)> {
    let df = GLOBAL_DATA.with(|data| {
        data.borrow().0.clone()
    });

    let df = df.sort(
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

    let reference_starts = df.column("reference_start").unwrap().u32().unwrap();
    let reference_ends = df.column("reference_end").unwrap().u32().unwrap();
    let element_types = df.column("element_type").unwrap().u8().unwrap();
    let sequence = df.column("sequence").unwrap().utf8().unwrap();
    let column_widths = df.column("column_width").unwrap().u32().unwrap();

    let reference_start_min = df.column("reference_start").unwrap().u32().unwrap().min().unwrap();
    let reference_end_max = df.column("reference_end").unwrap().u32().unwrap().max().unwrap();

    let samples = df.column("sample_name").unwrap().utf8().unwrap().into_iter().map(|s| s.unwrap()).collect::<HashSet<_>>();

    let mut rects = Vec::new();
    for (i, _) in samples.iter().enumerate() {
        rects.push((
            ((reference_end_max - reference_start_min) as f32)/2.0,
            i as f32 * sizes::GS_UI_TRACK_SPACING,
            (reference_end_max - reference_start_min) as f32,
            sizes::GS_UI_TRACK_HEIGHT,
            if i % 2 == 0 { colors::GS_UI_TRACK_EVEN } else { colors::GS_UI_TRACK_ODD },
        ));
    }

    rects.extend((0..reference_starts.len()).into_par_iter().map(|i| {
        let width = column_widths.get(i).unwrap() as f32;
        let height = sizes::GS_UI_TRACK_HEIGHT;
        let x = reference_starts.get(i).unwrap() as f32 + (width/2.0) - (reference_start_min as f32);
        let y = *y0s.get(i).unwrap() as f32 * sizes::GS_UI_TRACK_SPACING;
        let seq = sequence.get(i).unwrap();

        let color = match element_types.get(i).unwrap() {
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
    }).collect::<Vec<_>>());

    rects
}

pub fn compute_transform(settings: &Settings) -> Mat4 {
    glam::Mat4::from_scale_rotation_translation(
        glam::Vec3::new(settings.zoom, settings.zoom, 1.0),
        if settings.rotate {
            glam::Quat::IDENTITY
        } else {
            glam::Quat::from_rotation_z(std::f32::consts::FRAC_PI_2)
        },
        glam::Vec3::new(settings.pan.x, settings.pan.y, 0.0)
    )
}

pub fn draw_rects(app: &App, transform: &Mat4, rects: &Vec<(f32, f32, f32, f32, Rgb<u8>)>) -> Draw {
    let draw = app
        .draw()
        .transform(*transform);

    draw.background().color(colors::GS_UI_BACKGROUND);

    for (x, y, width, height, color) in rects {
        draw.rect()
            .stroke_weight(0.0)
            .x(*x)
            .y(*y)
            .width(*width)
            .height(*height)
            .color(*color);
    }

    draw
}

pub fn layout(df_in: &DataFrame) -> HashMap<u32, usize> {
    let df = df_in.sort(
        &["sample_name", "query_name", "reference_start"],
        false,
        true
    ).unwrap();

    let sample_names = df.column("sample_name").unwrap().utf8().unwrap();
    let reference_starts = df.column("reference_start").unwrap().u32().unwrap();
    let reference_ends = df.column("reference_end").unwrap().u32().unwrap();
    let element_types = df.column("element_type").unwrap().u8().unwrap();
    let sequence = df.column("sequence").unwrap().utf8().unwrap();

    let reference_start_min = df.column("reference_start").unwrap().u32().unwrap().min().unwrap();
    let reference_end_max = df.column("reference_end").unwrap().u32().unwrap().max().unwrap();

    let num_samples = df.column("sample_name").unwrap().utf8().unwrap().into_iter().collect::<HashSet<_>>().len();
    let num_bases = (reference_end_max - reference_start_min) as usize;

    let mut cur_sample_name = "";
    let mut cur_sample_index: i32 = -1;
    let mut mask = HashMap::new();

    for i in 0..reference_starts.len() {
        let sample_name = sample_names.get(i).unwrap();
        if cur_sample_name != sample_name {
            cur_sample_name = sample_name;
            cur_sample_index += 1;

            let cur_sample_name_series = Series::new("", vec![cur_sample_name; df.height()]);
            let mask = df.filter(&df["sample_name"].equal(&cur_sample_name_series).unwrap()).unwrap();
            let num_reads = mask.column("query_name").unwrap().unique().unwrap().len();

            // ls.push(TriMat::new((num_reads, num_bases)));
        }

        if cur_sample_index >= 0 {
            // let l = ls.get_mut(cur_sample_index as usize).unwrap();

            let reference_start = reference_starts.get(i).unwrap();
            let reference_end = reference_ends.get(i).unwrap();
            let element_type = element_types.get(i).unwrap();
            let sequence = sequence.get(i).unwrap();
            let sequence_length = if element_type == 3 { (reference_end - reference_start) as usize } else { sequence.len() };

            if element_type > 0 {
                mask.entry(reference_start)
                    .and_modify(|e| *e = std::cmp::max(*e, sequence_length))
                    .or_insert(sequence_length);
            }

            // for p in reference_start..reference_end {
            //     if element_type != 0 {
            //         let position = (p - reference_start_min) as usize;
            //         let sequence_length = if element_type == 3 { (reference_end - reference_start) as usize } else { sequence.len() };
            //         mask.entry(position)
            //             .and_modify(|e| *e = std::cmp::max(*e, sequence_length))
            //             .or_insert(sequence_length);

            //         l.add_triplet(cur_sample_index as usize, position, sequence);
            //     }
            // }
        }
    }

    for (key, value) in &mask {
        println!("{}: {}", key, value);
    }

    // for (a, b) in mask.triplet_iter() {
    //     println!("mask {} {:?}", a, b);
    // }
    // let csc = mask.to_csc::<usize>();

    // for l in ls.iter_mut() {
    //     for (a, b) in l.triplet_iter() {
            // let len = mask.get(&b.1);

            // println!("{} {} {} {:?}", b.0, b.1, *a, len);

            // let width = 
            // let x = b.1 as f32;
            // let y = b.0 as f32 * GS_UI_TRACK_SPACING;

            // draw.rect()
            //     .stroke_weight(0.0)
            //     .x(x)
            //     .y(y)
            //     .width(width)
            //     .height(height)
            //     .color(color);
    //     }
    // }

    // println!("nums {} {}", num_samples, num_bases);

    mask
}

#[cfg(test)]
mod tests {
    use super::*;
    use polars::prelude::*;

    #[test]
    fn test_layout() {
        let filename = "/var/folders/jp/l0z21gnj4f531jw12fvm0bx80000gq/T/chr15_23960193_23963918.parquet";
        let file = std::fs::File::open(&filename).unwrap();
        let df = ParquetReader::new(file).finish().unwrap();

        layout(&df);
    }
}
