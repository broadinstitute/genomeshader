use std::sync::atomic::{AtomicU64, Ordering};

// GCS access tokens expire at 1h. Refresh proactively at 45 min so a long
// session never hits a 401. Checked lazily at request time (no background
// thread). 0 = we have never minted / attempted one.
static GCS_TOKEN_MINTED_AT: AtomicU64 = AtomicU64::new(0);
const GCS_TOKEN_TTL_SECS: u64 = 45 * 60;

/// Env vars that can supply a GCS Requester Pays billing project, in preference
/// order. `GOOGLE_PROJECT` is set automatically on Verily Workbench / Terra VMs
/// — the same value users pass to `gsutil -u $GOOGLE_PROJECT`.
const GCS_BILLING_PROJECT_ENVS: &[&str] = &[
    "GENOMESHADER_GCS_BILLING_PROJECT",
    "GCS_REQUESTER_PAYS_PROJECT",
    "CLOUDSDK_BILLING_PROJECT",
    "GOOGLE_PROJECT",
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CORE_PROJECT",
];

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Resolve a GCS billing / Requester Pays project from `get`, which is normally
/// `std::env::var`. Injected so the preference order is unit-testable without
/// mutating process env.
pub fn gcs_billing_project_from<F>(mut get: F) -> Option<String>
where
    F: FnMut(&str) -> Option<String>,
{
    for key in GCS_BILLING_PROJECT_ENVS {
        if let Some(v) = get(key) {
            let t = v.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

pub fn gcs_billing_project() -> Option<String> {
    gcs_billing_project_from(|k| std::env::var(k).ok())
}

/// Copy a resolved billing project into the env vars htslib (`GCS_REQUESTER_PAYS_PROJECT`
/// → `X-Goog-User-Project`) and gcloud (`CLOUDSDK_BILLING_PROJECT`) actually
/// honour. Safe to call on every remote open: no-ops when already set or when
/// no project can be resolved.
pub fn ensure_gcs_requester_pays() {
    let Some(project) = gcs_billing_project() else {
        return;
    };
    let current = std::env::var("GCS_REQUESTER_PAYS_PROJECT").unwrap_or_default();
    if current.trim().is_empty() {
        std::env::set_var("GCS_REQUESTER_PAYS_PROJECT", &project);
    }
    let current = std::env::var("CLOUDSDK_BILLING_PROJECT").unwrap_or_default();
    if current.trim().is_empty() {
        std::env::set_var("CLOUDSDK_BILLING_PROJECT", &project);
    }
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
    ensure_gcs_requester_pays();
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
    ensure_gcs_requester_pays();
    refresh_gcs_token();
}

#[cfg(test)]
mod tests {
    use super::{gcs_billing_project_from, token_is_stale, GCS_TOKEN_TTL_SECS};
    use std::collections::HashMap;

    fn lookup<'a>(map: &'a HashMap<&str, &str>) -> impl FnMut(&str) -> Option<String> + 'a {
        move |k| map.get(k).map(|s| (*s).to_string())
    }

    #[test]
    fn billing_project_prefers_explicit_htslib_env() {
        let mut env = HashMap::new();
        env.insert("GCS_REQUESTER_PAYS_PROJECT", "htslib-proj");
        env.insert("GOOGLE_PROJECT", "workbench-proj");
        assert_eq!(
            gcs_billing_project_from(lookup(&env)).as_deref(),
            Some("htslib-proj")
        );
    }

    #[test]
    fn billing_project_uses_google_project_on_workbench() {
        let mut env = HashMap::new();
        env.insert("GOOGLE_PROJECT", "workbench-proj");
        assert_eq!(
            gcs_billing_project_from(lookup(&env)).as_deref(),
            Some("workbench-proj")
        );
    }

    #[test]
    fn billing_project_skips_blank_and_falls_through() {
        let mut env = HashMap::new();
        env.insert("GCS_REQUESTER_PAYS_PROJECT", "  ");
        env.insert("GOOGLE_CLOUD_PROJECT", "gcp-proj");
        assert_eq!(
            gcs_billing_project_from(lookup(&env)).as_deref(),
            Some("gcp-proj")
        );
    }

    #[test]
    fn billing_project_none_when_unset() {
        let env: HashMap<&str, &str> = HashMap::new();
        assert_eq!(gcs_billing_project_from(lookup(&env)), None);
    }

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
