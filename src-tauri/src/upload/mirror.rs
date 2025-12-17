use crate::upload::drive_ops::create_unique_folder;
use crate::upload::scheduler::DrivePool;
use bytes::Bytes;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone)]
pub struct UploadTask {
    pub top_item_id: String,
    pub top_item_path: String,
    pub top_item_kind: String,
    pub drive_parent_id: String,
    pub local_file_path: PathBuf,
    pub display_name: String,
    pub total_bytes: u64,
    pub mime_type: String,
}

#[derive(Debug, Clone)]
pub struct FolderAggregate {
    pub total_bytes: u64,
}

pub async fn build_tasks_for_item(
    pool: &DrivePool,
    destination_folder_id: &str,
    item_id: &str,
    item_path: &str,
    kind: &str,
) -> Result<(Vec<UploadTask>, Option<FolderAggregate>), String> {
    if kind == "file" {
        let local = PathBuf::from(item_path);
        let name = local
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(item_path)
            .to_string();
        let meta = std::fs::metadata(&local).map_err(|e| format!("Failed to stat file: {e}"))?;
        let total_bytes = meta.len();
        let mime_type = guess_mime(&local);

        return Ok((
            vec![UploadTask {
                top_item_id: item_id.to_string(),
                top_item_path: item_path.to_string(),
                top_item_kind: kind.to_string(),
                drive_parent_id: destination_folder_id.to_string(),
                local_file_path: local,
                display_name: name,
                total_bytes,
                mime_type,
            }],
            None,
        ));
    }

    if kind != "folder" {
        return Err(format!("Unknown queue item kind: {kind}"));
    }

    let local_root = PathBuf::from(item_path);
    let base_name = local_root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(item_path)
        .to_string();

    let drive_root = create_unique_folder(&pool.next_client(), destination_folder_id, &base_name)
        .await?;

    let mut folder_map: HashMap<PathBuf, String> = HashMap::new();
    folder_map.insert(local_root.clone(), drive_root.id.clone());

    let mut tasks: Vec<UploadTask> = Vec::new();
    let mut total_bytes: u64 = 0;

    for entry in WalkDir::new(&local_root).into_iter().filter_map(Result::ok) {
        let path = entry.path().to_path_buf();
        if path == local_root {
            continue;
        }

        if entry.file_type().is_dir() {
            let parent = path.parent().unwrap_or(&local_root).to_path_buf();
            let parent_drive = folder_map
                .get(&parent)
                .cloned()
                .ok_or_else(|| format!("Missing parent mapping for {parent:?}"))?;

            let name = entry
                .file_name()
                .to_str()
                .unwrap_or("folder")
                .to_string();
            let created = create_unique_folder(&pool.next_client(), &parent_drive, &name).await?;
            folder_map.insert(path, created.id);
            continue;
        }

        if entry.file_type().is_file() {
            let parent = path.parent().unwrap_or(&local_root).to_path_buf();
            let parent_drive = folder_map
                .get(&parent)
                .cloned()
                .ok_or_else(|| format!("Missing parent mapping for {parent:?}"))?;

            let meta = std::fs::metadata(&path)
                .map_err(|e| format!("Failed to stat file {path:?}: {e}"))?;
            let size = meta.len();
            total_bytes = total_bytes.saturating_add(size);

            let name = entry.file_name().to_str().unwrap_or("file").to_string();
            let mime_type = guess_mime(&path);
            tasks.push(UploadTask {
                top_item_id: item_id.to_string(),
                top_item_path: item_path.to_string(),
                top_item_kind: kind.to_string(),
                drive_parent_id: parent_drive,
                local_file_path: path,
                display_name: name,
                total_bytes: size,
                mime_type,
            });
        }
    }

    Ok((tasks, Some(FolderAggregate { total_bytes })))
}

pub async fn read_file_chunk(
    file: &mut tokio::fs::File,
    buf: &mut Vec<u8>,
    max: usize,
) -> Result<Bytes, String> {
    use tokio::io::AsyncReadExt;

    buf.resize(max, 0);
    let n = file
        .read(&mut buf[..])
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?;
    buf.truncate(n);
    Ok(Bytes::copy_from_slice(&buf[..]))
}

fn guess_mime(path: &Path) -> String {
    // Conservative default.
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    match ext.to_ascii_lowercase().as_str() {
        "txt" => "text/plain",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
    .to_string()
}
