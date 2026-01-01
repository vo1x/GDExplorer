use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn install_rclone_windows(app: AppHandle) -> Result<String, String> {
    if !cfg!(target_os = "windows") {
        return Err("Rclone installer is only available on Windows.".to_string());
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {e}"))?;

    let install_dir = app_data_dir.join("rclone");
    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create rclone directory: {e}"))?;

    let url = if cfg!(target_arch = "x86_64") {
        "https://downloads.rclone.org/rclone-current-windows-amd64.zip"
    } else if cfg!(target_arch = "aarch64") {
        "https://downloads.rclone.org/rclone-current-windows-arm64.zip"
    } else {
        return Err("Unsupported Windows architecture for rclone download.".to_string());
    };

    let zip_path = install_dir.join("rclone.zip");
    let bytes = reqwest::get(url)
        .await
        .map_err(|e| format!("Failed to download rclone: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("Failed to read rclone download: {e}"))?;

    let mut zip_file = File::create(&zip_path)
        .map_err(|e| format!("Failed to create rclone zip file: {e}"))?;
    zip_file
        .write_all(&bytes)
        .map_err(|e| format!("Failed to write rclone zip file: {e}"))?;

    let file = File::open(&zip_path).map_err(|e| format!("Failed to open zip: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Invalid zip archive: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        let outpath = install_dir.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("Failed to create directory: {e}"))?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory: {e}"))?;
            }
            let mut outfile =
                File::create(&outpath).map_err(|e| format!("Failed to write file: {e}"))?;
            let mut buffer = Vec::new();
            entry
                .read_to_end(&mut buffer)
                .map_err(|e| format!("Failed to read zip entry: {e}"))?;
            outfile
                .write_all(&buffer)
                .map_err(|e| format!("Failed to write zip entry: {e}"))?;
        }
    }

    let rclone_exe = find_rclone_exe(&install_dir)
        .ok_or_else(|| "Failed to locate rclone.exe after extraction.".to_string())?;

    Ok(rclone_exe.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn configure_rclone_remote(
    rclone_path: String,
    remote_name: String,
    service_account_folder: String,
) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("Rclone setup is only available on Windows.".to_string());
    }

    let service_account_file =
        pick_service_account_file(&service_account_folder)?.to_string_lossy().to_string();

    let status = std::process::Command::new(&rclone_path)
        .args([
            "config",
            "create",
            &remote_name,
            "drive",
            "service_account_file",
            &service_account_file,
            "scope",
            "drive",
            "--non-interactive",
        ])
        .status()
        .map_err(|e| format!("Failed to run rclone config create: {e}"))?;

    if status.success() {
        return Ok(());
    }

    let update_status = std::process::Command::new(&rclone_path)
        .args([
            "config",
            "update",
            &remote_name,
            "service_account_file",
            &service_account_file,
        ])
        .status()
        .map_err(|e| format!("Failed to run rclone config update: {e}"))?;

    if update_status.success() {
        return Ok(());
    }

    Err("Failed to configure rclone remote.".to_string())
}

fn pick_service_account_file(folder: &str) -> Result<PathBuf, String> {
    let entries = std::fs::read_dir(folder)
        .map_err(|e| format!("Failed to read service account folder: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read folder entry: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_json = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"));
        if !is_json {
            continue;
        }
        return Ok(path);
    }

    Err("No service account JSON files found in the selected folder.".to_string())
}

fn find_rclone_exe(root: &Path) -> Option<PathBuf> {
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.file_name().eq_ignore_ascii_case("rclone.exe") {
            return Some(entry.into_path());
        }
    }
    None
}
