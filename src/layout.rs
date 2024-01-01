use std::{collections::HashSet, cmp::max};
use polars::prelude::*;
use sprs::{CsMat, TriMat};

pub fn layout(df: DataFrame) {
    let df = df.sort(
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

    // let mut mat = TriMat::new((num_samples, num_bases));
    let mut ls = Vec::new();

    for i in 0..sample_names.len() {
        let sample_name = sample_names.get(i).unwrap();
        if cur_sample_name != sample_name {
            cur_sample_name = sample_name;
            cur_sample_index += 1;

            let cur_sample_name_series = Series::new("", vec![cur_sample_name; df.height()]);
            let mask = df.filter(&df["sample_name"].equal(&cur_sample_name_series).unwrap()).unwrap();
            let num_reads = mask.column("query_name").unwrap().unique().unwrap().len();

            ls.push(TriMat::new((num_reads, num_bases)));
        }

        if cur_sample_index >= 0 {
            let l = ls.get_mut(cur_sample_index as usize).unwrap();

            let reference_start = reference_starts.get(i).unwrap();
            let reference_end = reference_ends.get(i).unwrap();
            let element_type = element_types.get(i).unwrap();

            for p in reference_start..reference_end {
                if element_type != 0 {
                    l.add_triplet(cur_sample_index as usize, (p - reference_start_min) as usize, element_type);
                }
            }
        }
    }

    for l in &mut ls {
        let m = l.to_csr::<usize>();

        println!("{:?}", m);
    }

    println!("nums {} {}", num_samples, num_bases);
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

        layout(df);
    }
}
