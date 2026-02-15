use anyhow::{ anyhow, Result };
use pyo3::prelude::*;

use cloud_storage::{ sync::*, ListRequest, object::ObjectList };
use chrono::{ DateTime, Utc };
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;

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

pub fn gcs_download_file_to(path: &str, local_path: &PathBuf) -> Result<()> {
    if !gcs_object_exists(path) {
        // Cache miss is expected for first use; keep this path quiet.
        return Ok(());
    }

    if let Some(parent) = local_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    if run_gcs_cp(path, &local_path.to_string_lossy(), true) {
        return Ok(());
    }

    Err(anyhow!(
        "Failed to download '{}' via both 'gcloud storage cp' and 'gsutil cp'. Ensure one CLI is installed and authenticated.",
        path
    ))
}

pub fn gcs_upload_file(local_path: &PathBuf, path: &str) -> Result<()> {
    let src = local_path.to_string_lossy();
    if run_gcs_cp(&src, path, false) {
        return Ok(());
    }

    Err(anyhow!(
        "Failed to upload '{}' via both 'gcloud storage cp' and 'gsutil cp'. Ensure one CLI is installed and authenticated.",
        local_path.display()
    ))
}

fn run_gcs_cp(src: &str, dst: &str, quiet: bool) -> bool {
    gcs_authorize_data_access();
    let mut gcloud_cmd = Command::new("gcloud");
    gcloud_cmd.args(["storage", "cp", src, dst]);
    if quiet {
        gcloud_cmd.stdout(Stdio::null()).stderr(Stdio::null());
    }
    let gcloud_ok = gcloud_cmd
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if gcloud_ok {
        return true;
    }

    let mut gsutil_cmd = Command::new("gsutil");
    gsutil_cmd.args(["cp", src, dst]);
    if quiet {
        gsutil_cmd.stdout(Stdio::null()).stderr(Stdio::null());
    }
    gsutil_cmd
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn gcs_object_exists(path: &str) -> bool {
    gcs_authorize_data_access();

    let gcloud_exists = Command::new("gcloud")
        .args(["storage", "ls", path])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if gcloud_exists {
        return true;
    }

    Command::new("gsutil")
        .args(["ls", path])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[allow(dead_code)]
fn has_cloud_storage_auth_env() -> bool {
    std::env::var("SERVICE_ACCOUNT").is_ok()
        || std::env::var("SERVICE_ACCOUNT_JSON").is_ok()
        || std::env::var("GOOGLE_APPLICATION_CREDENTIALS").is_ok()
        || std::env::var("GOOGLE_APPLICATION_CREDENTIALS_JSON").is_ok()
}

#[allow(dead_code)]
fn _normalize_cloud_storage_auth_env() {
    _normalize_json_env_path_variant("SERVICE_ACCOUNT_JSON", "SERVICE_ACCOUNT");
    _normalize_json_env_path_variant(
        "GOOGLE_APPLICATION_CREDENTIALS_JSON",
        "GOOGLE_APPLICATION_CREDENTIALS",
    );
}

#[allow(dead_code)]
fn _normalize_json_env_path_variant(json_key: &str, file_key: &str) {
    let Ok(val) = std::env::var(json_key) else {
        return;
    };

    if std::path::Path::new(&val).exists() {
        if std::env::var(file_key).is_err() {
            std::env::set_var(file_key, val);
        }
        std::env::remove_var(json_key);
    }
}

#[allow(dead_code)]
fn _cloud_storage_client_upload_fallback(local_path: &PathBuf, path: &str) -> Result<()> {
    if !has_cloud_storage_auth_env() {
        return Err(anyhow!(
            "Missing cloud-storage auth env (SERVICE_ACCOUNT(_JSON) or GOOGLE_APPLICATION_CREDENTIALS(_JSON))"
        ));
    }

    let (bucket_name, prefix) = gcs_split_path(&path.to_string());
    let bytes = std::fs::read(local_path)?;
    let _ = std::panic::catch_unwind(|| {
        let client = Client::new()?;
        client
            .object()
            .create(&bucket_name, bytes, &prefix, "application/octet-stream")
    })
    .map_err(|_| anyhow!("cloud-storage client panicked while uploading to '{}'", path))??;

    Ok(())
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
