pub fn local_guess_curl_ca_bundle() {
    // See https://github.com/rust-bio/rust-htslib/issues/404
    if std::env::var("CURL_CA_BUNDLE").is_err() {
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
