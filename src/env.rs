pub fn local_guess_curl_ca_bundle() {
    // See https://github.com/rust-bio/rust-htslib/issues/404
    let ca_file = "/etc/ssl/certs/ca-certificates.crt";

    if std::env::var("CURL_CA_BUNDLE").is_err() && std::path::Path::new(ca_file).exists() {
        std::env::set_var("CURL_CA_BUNDLE", ca_file);
    }
}

fn gcs_gcloud_is_installed() -> bool {
    // Check if gcloud is installed on the PATH
    // Suppress stdout and stderr to prevent them from printing to the screen
    let mut cmd = std::process::Command::new("gcloud");
    cmd.arg("version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
}

pub fn gcs_authorize_data_access() {
    // Check if gcloud is installed on the PATH
    if !gcs_gcloud_is_installed() {
        panic!("gcloud is not installed on the PATH");
    }

    // Execute the command and capture the output
    let output = std::process::Command
        ::new("gcloud")
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
