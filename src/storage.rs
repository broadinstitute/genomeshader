use pyo3::prelude::*;

use cloud_storage::{sync::*, ListRequest, object::ObjectList};
use chrono::{DateTime, Utc};

use std::path::PathBuf;
use std::fs::metadata;

pub fn gcs_split_path(path: &String) -> (String, String) {
    let re = regex::Regex::new(r"^gs://").unwrap();
    let path = re.replace(&path, "");
    let split: Vec<&str> = path.split('/').collect();

    let bucket_name = split[0].to_string();
    let prefix = split[1..].join("/");

    (bucket_name, prefix)
}

pub fn gcs_list_files(path: &String) -> Result<Vec<ObjectList>, cloud_storage::Error> {
    let (bucket_name, prefix) = gcs_split_path(path);

    let client = Client::new()?;
    let file_list = client.object().list(&bucket_name, ListRequest { prefix: Some(prefix), ..Default::default() });

    file_list
}

pub fn gcs_get_file_update_time(path: &String) -> Result<DateTime<Utc>, cloud_storage::Error> {
    let (bucket_name, prefix) = gcs_split_path(path);

    let client = Client::new()?;
    let object = client.object().read(&bucket_name, &prefix)?;

    Ok(object.updated)
}

pub fn local_get_file_update_time(path: &PathBuf) -> std::io::Result<DateTime<Utc>> {
    let metadata = metadata(path)?;
    let modified_time = metadata.modified()?;

    Ok(DateTime::<Utc>::from(modified_time))
}

pub fn local_guess_curl_ca_bundle() {
    // See https://github.com/rust-bio/rust-htslib/issues/404

    // Set if CURL_CA_BUNDLE is unset or empty
    if std::env::var("CURL_CA_BUNDLE").map_or(true, |v| v.is_empty()) {
        std::env::set_var("CURL_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt");
    }
}

pub fn gcs_authorize_data_access() {
    // Execute the command and capture the output
    let output = std::process::Command::new("gcloud")
        .args(&["auth", "application-default", "print-access-token"])
        .output()
        .expect("Failed to execute command");

    if !output.status.success() {
        panic!("{}", String::from_utf8_lossy(&output.stderr));
    }

    // Decode the output and remove trailing newline
    let token = String::from_utf8(output.stdout)
        .expect("Failed to decode output")
        .trim_end()
        .to_string();

    // Set the environment variable
    std::env::set_var("GCS_OAUTH_TOKEN", token);
}

#[pyfunction]
pub fn _gcs_list_files_of_type(path: String, suffix: &str) -> PyResult<Vec<String>> {
    let file_list = gcs_list_files(&path).unwrap();

    let bam_files: Vec<_> = file_list.iter().flat_map(|fs| {
        fs.items.iter().filter_map(|f| {
            if f.name.ends_with(suffix) {
                Some(f.name.clone())
            } else {
                None
            }
        }).collect::<Vec<_>>()
    }).collect();

    Ok(bam_files)
}