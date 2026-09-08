use std::sync::atomic::{AtomicU64, Ordering};

// GCS access tokens expire at 1h. Refresh proactively at 45 min so a long
// session never hits a 401. Checked lazily at request time (no background
// thread). 0 = we have never minted / attempted one.
static GCS_TOKEN_MINTED_AT: AtomicU64 = AtomicU64::new(0);
const GCS_TOKEN_TTL_SECS: u64 = 45 * 60;

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

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

/// Mint a fresh `GCS_OAUTH_TOKEN` via `gcloud auth application-default
/// print-access-token` and record when. Returns false (no panic) if gcloud is
/// missing or the command fails — the caller proceeds with whatever token is
/// already set and any 401 surfaces normally (vs. aborting the process).
pub fn refresh_gcs_token() -> bool {
    if !gcs_gcloud_is_installed() {
        return false;
    }
    let output = std::process::Command::new("gcloud")
        .args(["auth", "application-default", "print-access-token"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let token = String::from_utf8_lossy(&o.stdout).trim_end().to_string();
            if token.is_empty() {
                return false;
            }
            std::env::set_var("GCS_OAUTH_TOKEN", token);
            GCS_TOKEN_MINTED_AT.store(now_epoch_secs(), Ordering::Relaxed);
            true
        }
        _ => false,
    }
}

/// Proactive, request-time token freshness. Refresh `GCS_OAUTH_TOKEN` if we have
/// never minted one or it's older than 45 min (tokens live 1h). Cheap when
/// fresh — one atomic load; only shells out to gcloud when stale. Call before a
/// remote (gs://) open. Not a background thread: it runs on the request that
/// finds the token stale.
fn token_is_stale(minted: u64, now: u64) -> bool {
    minted == 0 || now.saturating_sub(minted) >= GCS_TOKEN_TTL_SECS
}

pub fn ensure_gcs_token_fresh() {
    let minted = GCS_TOKEN_MINTED_AT.load(Ordering::Relaxed);
    let now = now_epoch_secs();
    if token_is_stale(minted, now) {
        if !refresh_gcs_token() {
            // Refresh failed (no gcloud / transient). Record the attempt so we
            // don't shell out on every request; the reactive fallback on a 401
            // still tries, and the next proactive attempt is one TTL later.
            GCS_TOKEN_MINTED_AT.store(now, Ordering::Relaxed);
        }
    }
}

/// Reactive refresh used by the open-with-fallbacks ladders after a failed
/// request. Now non-panicking (see `refresh_gcs_token`).
pub fn gcs_authorize_data_access() {
    refresh_gcs_token();
}

#[cfg(test)]
mod tests {
    use super::{token_is_stale, GCS_TOKEN_TTL_SECS};

    #[test]
    fn token_staleness_timer() {
        // never minted -> refresh
        assert!(token_is_stale(0, 1_000_000));
        // just minted -> fresh
        assert!(!token_is_stale(1_000_000, 1_000_000));
        // under 45 min -> fresh
        assert!(!token_is_stale(1_000_000, 1_000_000 + GCS_TOKEN_TTL_SECS - 1));
        // exactly / past 45 min -> refresh
        assert!(token_is_stale(1_000_000, 1_000_000 + GCS_TOKEN_TTL_SECS));
        assert!(token_is_stale(1_000_000, 1_000_000 + GCS_TOKEN_TTL_SECS + 600));
        // clock skew (now < minted) must not underflow -> treat as fresh
        assert!(!token_is_stale(1_000_000, 999_000));
    }
}
