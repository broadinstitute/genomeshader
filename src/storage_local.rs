use chrono::{DateTime, Utc};

use std::path::PathBuf;
use std::fs::metadata;

pub fn local_get_file_update_time(path: &PathBuf) -> std::io::Result<DateTime<Utc>> {
    let metadata = metadata(path)?;
    let modified_time = metadata.modified()?;

    Ok(DateTime::<Utc>::from(modified_time))
}