use anyhow::{ anyhow, Result };
use pyo3::prelude::*;

use cloud_storage::sync::*;
use chrono::{ DateTime, Utc };
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;

use crate::env::{gcs_authorize_data_access, gcs_billing_project};

pub fn gcs_split_path(path: &String) -> (String, String) {
    let re = regex::Regex::new(r"^gs://").unwrap();
    let path = re.replace(&path, "");
    let split: Vec<&str> = path.split('/').collect();

    let bucket_name = split[0].to_string();
    let prefix = split[1..].join("/");

    (bucket_name, prefix)
}

/// `gcloud [--quiet] [--billing-project=P] storage <subargs…>`
fn gcloud_storage_args(subargs: &[&str], quiet: bool) -> Vec<String> {
    let mut args = Vec::new();
    if quiet {
        args.push("--quiet".to_string());
    }
    if let Some(p) = gcs_billing_project() {
        args.push(format!("--billing-project={}", p));
    }
    args.push("storage".to_string());
    args.extend(subargs.iter().map(|s| (*s).to_string()));
    args
}

/// `gsutil [-u P] [-q] <subargs…>` — `-u` is the Requester Pays billing project,
/// the same flag as `gsutil -u $GOOGLE_PROJECT cp …` on a Workbench VM.
fn gsutil_args(subargs: &[&str], quiet: bool) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(p) = gcs_billing_project() {
        args.push("-u".to_string());
        args.push(p);
    }
    if quiet {
        args.push("-q".to_string());
    }
    args.extend(subargs.iter().map(|s| (*s).to_string()));
    args
}

/// Recursively list objects under a gs:// prefix by shelling out to the gcloud
/// CLI (falling back to gsutil), matching the auth path used for reads — plain
/// Application Default Credentials (`gcloud auth application-default login`),
/// no service-account key required. The cloud-storage crate, by contrast, only
/// accepts a service-account JSON, which panics under user ADC.
fn gcs_list_uris(path: &str) -> Result<Vec<String>> {
    let glob = format!("{}/**", path.trim_end_matches('/'));

    let run = |cmd: &str, args: &[&str]| -> Result<String> {
        // Capture stderr (not /dev/null) so a failure carries the real reason
        // (e.g. a 401/403 auth error) instead of a bare exit status.
        let output = Command::new(cmd)
            .args(args)
            .output()
            .map_err(|e| anyhow!("failed to run {}: {}", cmd, e))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            let detail = detail.trim();
            if detail.is_empty() {
                return Err(anyhow!("{} exited with {}", cmd, output.status));
            }
            return Err(anyhow!("{} exited with {}: {}", cmd, output.status, detail));
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    };

    let gcloud_args = gcloud_storage_args(&["ls", &glob], false);
    let gsutil_ls = gsutil_args(&["ls", &glob], false);
    let gcloud_ref: Vec<&str> = gcloud_args.iter().map(|s| s.as_str()).collect();
    let gsutil_ref: Vec<&str> = gsutil_ls.iter().map(|s| s.as_str()).collect();
    let stdout = run("gcloud", &gcloud_ref).or_else(|_| run("gsutil", &gsutil_ref))?;

    Ok(stdout
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("gs://"))
        .map(String::from)
        .collect())
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

/// Cache directory for URL-hashed htslib sidecar indexes (`.tbi`/`.bai`/…).
pub fn htslib_index_cache_dir() -> PathBuf {
    let base = std::env::var("GENOMESHADER_LOCAL_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("genomeshader"));
    base.join("htslib-idx")
}

/// Download a remote htslib sidecar index (`.tbi`/`.csi`/`.bai`/`.crai`) into
/// a URL-hashed cache file so cwd leftovers cannot win (`HTS_IDX_SAVE_REMOTE`
/// prefers a basename match in the process cwd). Returns the local path.
pub fn pin_remote_htslib_index(data_url: &str, extensions: &[&str]) -> Option<String> {
    if !data_url.starts_with("gs://") {
        return None;
    }
    for ext in extensions {
        let remote = format!("{}{}", data_url, ext);
        let mut hasher = DefaultHasher::new();
        remote.hash(&mut hasher);
        let base = remote.rsplit('/').next().unwrap_or("index");
        let dest = htslib_index_cache_dir().join(format!("{:016x}-{}", hasher.finish(), base));
        if gcs_fetch_object(&remote, &dest).is_ok() {
            return Some(dest.to_string_lossy().into_owned());
        }
    }
    None
}

/// Download a GCS object to `local_path`, overwriting. Errors if the copy does
/// not produce a non-empty file. Unlike `gcs_download_file_to`, a missing
/// object is a hard error (not a quiet cache miss).
pub fn gcs_fetch_object(path: &str, local_path: &PathBuf) -> Result<()> {
    if let Some(parent) = local_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if !run_gcs_cp(path, &local_path.to_string_lossy(), true) {
        return Err(anyhow!(
            "Failed to download '{}' via both 'gcloud storage cp' and 'gsutil cp'.",
            path
        ));
    }
    match std::fs::metadata(local_path) {
        Ok(m) if m.len() > 0 => Ok(()),
        _ => Err(anyhow!("downloaded '{}' but '{}' is missing or empty", path, local_path.display())),
    }
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
    let gcloud_args = gcloud_storage_args(&["cp", src, dst], quiet);
    let mut gcloud_cmd = Command::new("gcloud");
    gcloud_cmd.args(&gcloud_args);
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

    let gsutil_cp = gsutil_args(&["cp", src, dst], quiet);
    let mut gsutil_cmd = Command::new("gsutil");
    gsutil_cmd.args(&gsutil_cp);
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

    let gcloud_args = gcloud_storage_args(&["ls", path], true);
    let gcloud_exists = Command::new("gcloud")
        .args(&gcloud_args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if gcloud_exists {
        return true;
    }

    let gsutil_ls = gsutil_args(&["ls", path], true);
    Command::new("gsutil")
        .args(&gsutil_ls)
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

/// Heuristic: does a `gcloud`/`gsutil` error string look like an auth failure
/// (rather than a missing CLI or a genuinely absent path)? Used to lead the
/// user-facing message with the exact fix.
fn looks_like_requester_pays_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("requester pays")
        || lower.contains("requester-pays")
        || lower.contains("userprojectmissing")
        || lower.contains("user project")
        || lower.contains("no billing project")
}

fn looks_like_auth_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    looks_like_requester_pays_error(msg)
        || msg.contains("401")
        || msg.contains("403")
        || lower.contains("credential")
        || lower.contains("anonymous")
        || lower.contains("does not have")
        || lower.contains("unauthorized")
        || lower.contains("login")
}

#[pyfunction]
pub fn _gcs_list_files_of_type(path: String, suffix: &str) -> PyResult<Vec<String>> {
    let uris = gcs_list_uris(&path).map_err(|e| {
        let msg = e.to_string();
        let looks_auth = looks_like_auth_error(&msg);
        // When the failure looks like an auth problem, lead with the exact fix
        // rather than the generic "is it installed?" note — this is almost
        // always an expired/absent gcloud login, not a missing CLI.
        let hint = if looks_like_requester_pays_error(&msg) {
            "This looks like a Requester Pays bucket. Set a billing project \
             (Verily Workbench / Terra: $GOOGLE_PROJECT is already set — Genomeshader \
             should pick it up automatically; otherwise export \
             GCS_REQUESTER_PAYS_PROJECT=<your-project>) and retry."
        } else if looks_auth {
            "This looks like an authentication problem (not a code change). Run \
             `gcloud auth application-default login` (and, if listing still fails, \
             `gcloud auth login`), then retry. Or pass explicit file paths instead \
             of a directory."
        } else {
            "Ensure gcloud (or gsutil) is installed and authenticated \
             (`gcloud auth application-default login`), or pass explicit file paths \
             instead of a directory."
        };
        PyErr::new::<pyo3::exceptions::PyValueError, _>(format!(
            "Could not list '{}': {}. {}",
            path, msg, hint
        ))
    })?;

    Ok(uris.into_iter().filter(|u| u.ends_with(suffix)).collect())
}

#[cfg(test)]
mod tests {
    use super::{gcloud_storage_args, gsutil_args, looks_like_auth_error, looks_like_requester_pays_error};

    #[test]
    fn gcloud_storage_args_include_storage_subcommand() {
        let args = gcloud_storage_args(&["ls", "gs://b/p"], false);
        assert!(args.windows(2).any(|w| w == ["storage", "ls"]));
        assert!(args.contains(&"gs://b/p".to_string()));
    }

    #[test]
    fn gsutil_args_include_subcommand() {
        let args = gsutil_args(&["cp", "gs://b/a", "dst"], true);
        assert!(args.contains(&"-q".to_string()));
        assert!(args.windows(2).any(|w| w == ["cp", "gs://b/a"]));
    }

    #[test]
    fn requester_pays_errors_are_detected() {
        assert!(looks_like_requester_pays_error(
            "Bucket is a requester pays bucket but no user project provided."
        ));
        assert!(looks_like_requester_pays_error(
            "ERROR: (gcloud.storage.ls) Bucket is a requester pays bucket but no user project provided."
        ));
        assert!(looks_like_auth_error(
            "Bucket is a requester pays bucket but no user project provided."
        ));
    }

    #[test]
    fn auth_errors_are_detected() {
        // Real gsutil/gcloud auth failures.
        assert!(looks_like_auth_error(
            "ServiceException: 401 Anonymous caller does not have storage.objects.list access"
        ));
        assert!(looks_like_auth_error("AccessDeniedException: 403 Caller does not have permission"));
        assert!(looks_like_auth_error(
            "You do not currently have an active account selected; please run `gcloud auth login`"
        ));
        assert!(looks_like_auth_error("Reauthentication required. Please run: gcloud auth login"));
    }

    #[test]
    fn non_auth_errors_are_not_flagged() {
        assert!(!looks_like_auth_error("gsutil: command not found"));
        assert!(!looks_like_auth_error("CommandException: One or more URLs matched no objects"));
        assert!(!looks_like_auth_error("gsutil exited with exit status: 2"));
    }
}
