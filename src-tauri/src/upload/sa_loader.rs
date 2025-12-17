use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct ServiceAccount {
    pub client_email: String,
    pub private_key: String,
}

#[derive(Debug, Deserialize)]
struct ServiceAccountJson {
    client_email: Option<String>,
    private_key: Option<String>,
}

pub fn load_service_accounts(folder: &Path) -> Result<Vec<ServiceAccount>, String> {
    let entries = std::fs::read_dir(folder)
        .map_err(|e| format!("Failed to read service account folder: {e}"))?;

    let mut accounts = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read folder entry: {e}"))?;
        let path = entry.path();
        let metadata = std::fs::metadata(&path)
            .map_err(|e| format!("Failed to read metadata for {path:?}: {e}"))?;
        if !metadata.is_file() {
            continue;
        }

        let is_json = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"));
        if !is_json {
            continue;
        }

        let contents =
            std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {path:?}: {e}"))?;
        let parsed: ServiceAccountJson = serde_json::from_str(&contents)
            .map_err(|e| format!("Invalid JSON in {path:?}: {e}"))?;

        let client_email = parsed
            .client_email
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| format!("Missing client_email in {path:?}"))?;
        let private_key = parsed
            .private_key
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| format!("Missing private_key in {path:?}"))?;

        accounts.push(ServiceAccount {
            client_email,
            private_key,
        });
    }

    Ok(accounts)
}
