use pyo3::prelude::*;

use cloud_storage::{sync::*, ListRequest, object::ObjectList};

fn gcs_split_path(path: &String) -> (String, String) {
    let re = regex::Regex::new(r"^gs://").unwrap();
    let path = re.replace(&path, "");
    let split: Vec<&str> = path.split('/').collect();

    let bucket_name = split[0].to_string();
    let prefix = split[1..].join("/");

    (bucket_name, prefix)
}

fn gcs_list_files(path: &String) -> Result<Vec<ObjectList>, cloud_storage::Error> {
    let (bucket_name, prefix) = gcs_split_path(path);

    let client = Client::new()?;
    let file_list = client.object().list(&bucket_name, ListRequest { prefix: Some(prefix), ..Default::default() });

    file_list
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