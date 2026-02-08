use anyhow::Result;
use std::collections::HashMap;

use polars::prelude::*;

use rust_htslib::bcf::{Read, Reader, record::GenotypeAllele};

pub fn extract_variants(
    bcf_path: &str,
    chr: &String,
    start: &u64,
    stop: &u64
) -> Result<DataFrame> {
    // Open BCF file as regular reader
    // We'll iterate through all records and filter by position
    // For indexed access optimization, we could use IndexedReader separately if needed
    let mut reader = Reader::from_path(bcf_path)?;
    
    // Get header to extract sample names
    let header = reader.header().clone();
    let sample_names: Vec<String> = header
        .samples()
        .iter()
        .map(|s| String::from_utf8_lossy(s).to_string())
        .collect();
    
    let mut chromosomes = Vec::new();
    let mut positions = Vec::new();
    let mut ref_alleles = Vec::new();
    let mut alt_alleles = Vec::new();
    let mut sample_names_vec = Vec::new();
    let mut genotypes = Vec::new();
    let mut variant_ids = Vec::new();
    let mut vcf_ids = Vec::new();
    
    // Track unique variants (position + allele combination)
    let mut variant_map: HashMap<(u64, String, String), u32> = HashMap::new();
    let mut next_variant_id: u32 = 0;
    
    for record_result in reader.records() {
        let record: rust_htslib::bcf::record::Record = record_result?;
        
        let pos = record.pos() as u64 + 1; // Convert to 1-based
        
        // Skip if outside our region
        if pos < *start || pos > *stop {
            continue;
        }
        
        // Get VCF ID from record (ID field)
        let vcf_id_bytes = record.id();
        let vcf_id_str = if vcf_id_bytes.is_empty() || (vcf_id_bytes.len() == 1 && vcf_id_bytes[0] == b'.') {
            None // No ID or just "." means missing
        } else {
            Some(String::from_utf8_lossy(&vcf_id_bytes).to_string())
        };
        
        // Get reference and alternate alleles
        let alleles = record.alleles();
        let ref_allele: String = String::from_utf8_lossy(alleles[0]).to_string();
        let alt_alleles_list: Vec<String> = alleles[1..]
            .iter()
            .map(|a| String::from_utf8_lossy(a).to_string())
            .collect();
        
        // Process each alternate allele as a separate variant
        for (_alt_idx, alt_allele) in alt_alleles_list.iter().enumerate() {
            let alt_allele_str: String = alt_allele.clone();
            
            // Get or create variant ID
            let variant_id = *variant_map
                .entry((pos, ref_allele.clone(), alt_allele_str.clone()))
                .or_insert_with(|| {
                    let id = next_variant_id;
                    next_variant_id += 1;
                    id
                });
            
            // Get genotypes for all samples
            let genotypes_array = record.genotypes()?;
            
            for (sample_idx, sample_name) in sample_names.iter().enumerate() {
                // Get genotype (GT field) for this sample
                let gt = genotypes_array.get(sample_idx);
                
                // Format genotype as string: "0|1" (phased) or "0/1" (unphased)
                let gt_str = if gt.len() >= 2 {
                    let a1 = match gt[0] {
                        GenotypeAllele::Unphased(idx) | GenotypeAllele::Phased(idx) => idx.to_string(),
                        GenotypeAllele::UnphasedMissing | GenotypeAllele::PhasedMissing => ".".to_string(),
                    };
                    let a2 = match gt[1] {
                        GenotypeAllele::Unphased(idx) | GenotypeAllele::Phased(idx) => idx.to_string(),
                        GenotypeAllele::UnphasedMissing | GenotypeAllele::PhasedMissing => ".".to_string(),
                    };
                    let sep = match (&gt[0], &gt[1]) {
                        (GenotypeAllele::Phased(_) | GenotypeAllele::PhasedMissing, GenotypeAllele::Phased(_) | GenotypeAllele::PhasedMissing) => "|",
                        _ => "/",
                    };
                    format!("{}{}{}", a1, sep, a2)
                } else if gt.len() == 1 {
                    match gt[0] {
                        GenotypeAllele::Unphased(idx) | GenotypeAllele::Phased(idx) => idx.to_string(),
                        GenotypeAllele::UnphasedMissing | GenotypeAllele::PhasedMissing => "./.".to_string(),
                    }
                } else {
                    "./.".to_string()
                };
                
                // For Tube Map visualization, we need ALL samples and ALL genotype states
                // Include this sample regardless of whether it has the alternate allele
                chromosomes.push(chr.clone());
                positions.push(pos);
                ref_alleles.push(ref_allele.clone());
                alt_alleles.push(alt_allele_str.clone());
                sample_names_vec.push(sample_name.clone());
                genotypes.push(gt_str);
                variant_ids.push(variant_id);
                vcf_ids.push(vcf_id_str.clone());
            }
        }
    }
    
    let df = DataFrame::new(
        vec![
            Series::new("chromosome", chromosomes),
            Series::new("position", positions),
            Series::new("ref_allele", ref_alleles),
            Series::new("alt_allele", alt_alleles),
            Series::new("sample_name", sample_names_vec),
            Series::new("genotype", genotypes),
            Series::new("variant_id", variant_ids),
            Series::new("vcf_id", vcf_ids),
        ]
    )?;
    
    Ok(df)
}

