use anyhow::Result;
use pyo3::prelude::*;

use cloud_storage::{ sync::*, ListRequest, object::ObjectList };
use chrono::{ DateTime, Utc };

use crate::env::gcs_authorize_data_access;

pub fn gcs_split_path(path: &String) -> (String, String) {
    let re = regex::Regex::new(r"^gs://").unwrap();
    let path = re.replace(&path, "");
    let split: Vec<&str> = path.split('/').collect();

    let bucket_name = split[0].to_string();
    let prefix = split[1..].join("/");

    (bucket_name, prefix)
}

pub fn gcs_list_files(path: &String) -> Result<Vec<ObjectList>> {
    let (bucket_name, prefix) = gcs_split_path(path);

    let client = Client::new()?;
    let file_list = client
        .object()
        .list(&bucket_name, ListRequest { prefix: Some(prefix), ..Default::default() })?;

    Ok(file_list)
}

pub fn gcs_get_file_update_time(path: &String) -> Result<DateTime<Utc>> {
    let (bucket_name, prefix) = gcs_split_path(path);

    let client = Client::new()?;
    let object = client.object().read(&bucket_name, &prefix)?;

    Ok(object.updated)
}

#[pyfunction]
pub fn _gcs_download_file(path: String) -> PyResult<String> {
    let (bucket_name, prefix) = gcs_split_path(&path);
    let filename = prefix.split('/').last().unwrap_or_default().to_string();

    if !std::path::Path::new(&filename).exists() {
        let client = Client::new().unwrap();
        let bytes = client.object().download(&bucket_name, &prefix).unwrap();

        std::fs::write(&filename, &bytes)?;
    }

    Ok(filename)
}

#[pyfunction]
pub fn _gcs_list_files_of_type(path: String, suffix: &str) -> PyResult<Vec<String>> {
    let file_list = gcs_list_files(&path).unwrap();

    let bam_files: Vec<_> = file_list
        .iter()
        .flat_map(|fs| {
            fs.items
                .iter()
                .filter_map(|f| {
                    if f.name.ends_with(suffix) { Some(f.name.clone()) } else { None }
                })
                .collect::<Vec<_>>()
        })
        .collect();

    Ok(bam_files)
}
