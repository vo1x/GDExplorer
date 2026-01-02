use crate::upload::events::{
    CompletedEvent, FileListEntry, FileListEvent, FileProgressEvent, ItemStatusEvent, ProgressEvent,
    Summary,
};
use crate::upload::scheduler::{wait_if_paused, QueueItemInput, UploadControlHandle};
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{mpsc, watch, Mutex};
use walkdir::WalkDir;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Clone, Debug)]
pub struct RclonePreferences {
    pub rclone_path: String,
    pub remote_name: String,
    pub drive_chunk_size_mib: u32,
    pub transfers: u16,
    pub checkers: u16,
}

#[derive(Clone, Debug)]
struct ServiceAccountFile {
    path: PathBuf,
    email: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ServiceAccountMode {
    Unknown = 0,
    Directory = 1,
    SingleFile = 2,
}

impl ServiceAccountMode {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => ServiceAccountMode::Directory,
            2 => ServiceAccountMode::SingleFile,
            _ => ServiceAccountMode::Unknown,
        }
    }
}

pub async fn run_rclone_job(
    app: AppHandle,
    control: UploadControlHandle,
    prefs: RclonePreferences,
    max_concurrent: u8,
    service_account_folder: String,
    queue: Vec<QueueItemInput>,
    destination_folder_id: String,
) -> Result<(), String> {
    log::debug!(
        target: "rclone",
        "queue.received items={} max_concurrent={}",
        queue.len(),
        max_concurrent
    );
    let sa_files = load_service_account_files(&service_account_folder)?;
    if sa_files.is_empty() {
        return Err("No valid service account JSON files found in the selected folder.".to_string());
    }

    let sa_mode = Arc::new(AtomicU8::new(ServiceAccountMode::Unknown as u8));
    let supports_dir_flag = detect_sa_directory_support(&prefs).await.unwrap_or(false);
    if supports_dir_flag {
        sa_mode.store(ServiceAccountMode::Directory as u8, Ordering::Relaxed);
        log::debug!(
            target: "rclone",
            "sa.mode directory folder={}",
            service_account_folder
        );
    } else {
        sa_mode.store(ServiceAccountMode::SingleFile as u8, Ordering::Relaxed);
        log::debug!(
            target: "rclone",
            "sa.mode single-file folder={}",
            service_account_folder
        );
        let _ = app.emit(
            "upload:notice",
            serde_json::json!({
                "message": "Rclone does not support --drive-service-account-file-path. Using a single service account per file.",
            }),
        );
    }

    let concurrency = max_concurrent.clamp(1, 10) as usize;
    let (tx, rx) = mpsc::channel::<QueueItemInput>(concurrency.saturating_mul(2).max(8));
    let rx = Arc::new(Mutex::new(rx));

    let succeeded = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let failed = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    for item in &queue {
        log::debug!(
            target: "rclone",
            "queue.added id={} kind={} path={}",
            item.id,
            item.kind,
            item.path
        );
        let _ = app.emit(
            "upload:item_status",
            ItemStatusEvent {
                item_id: item.id.clone(),
                path: item.path.clone(),
                kind: item.kind.clone(),
                status: "preparing".to_string(),
                message: None,
                sa_email: None,
            },
        );
    }

    let mut worker_handles = Vec::with_capacity(concurrency);
    for _ in 0..concurrency {
        let app = app.clone();
        let control = control.clone();
        let rx = rx.clone();
        let prefs = prefs.clone();
        let sa_files = sa_files.clone();
        let sa_mode = sa_mode.clone();
        let destination_folder_id = destination_folder_id.clone();
        let succeeded = succeeded.clone();
        let failed = failed.clone();
        let service_account_folder = service_account_folder.clone();

        worker_handles.push(tokio::spawn(async move {
            loop {
                if control.is_canceled() {
                    break;
                }
                let item = {
                    let mut guard = rx.lock().await;
                    guard.recv().await
                };
                let Some(item) = item else { break };

                let result = run_rclone_for_item(
                    &app,
                    &control,
                    &prefs,
                    &sa_files,
                    &sa_mode,
                    &service_account_folder,
                    &destination_folder_id,
                    &item,
                )
                .await;

                if let Err(err) = result {
                    failed.fetch_add(1, Ordering::Relaxed);
                    let _ = app.emit(
                        "upload:item_status",
                        ItemStatusEvent {
                            item_id: item.id.clone(),
                            path: item.path.clone(),
                            kind: item.kind.clone(),
                            status: "failed".to_string(),
                            message: Some(err),
                            sa_email: None,
                        },
                    );
                } else {
                    succeeded.fetch_add(1, Ordering::Relaxed);
                }
            }
        }));
    }

    let total_items = queue.len() as u32;
    for item in queue {
        if control.is_canceled() {
            break;
        }
        log::debug!(
            target: "rclone",
            "queue.enqueued id={} kind={} path={}",
            item.id,
            item.kind,
            item.path
        );
        tx.send(item)
            .await
            .map_err(|e| format!("Failed to enqueue upload task: {e}"))?;
    }

    drop(tx);

    for handle in worker_handles {
        let _ = handle.await;
    }

    let succeeded = succeeded.load(Ordering::Relaxed) as u32;
    let failed = failed.load(Ordering::Relaxed) as u32;

    let _ = app.emit(
        "upload:completed",
        CompletedEvent {
            summary: Summary {
                total: total_items,
                succeeded,
                failed,
            },
        },
    );

    Ok(())
}

async fn run_rclone_for_item(
    app: &AppHandle,
    control: &UploadControlHandle,
    prefs: &RclonePreferences,
    sa_files: &[ServiceAccountFile],
    sa_mode: &Arc<AtomicU8>,
    service_account_folder: &str,
    destination_folder_id: &str,
    item: &QueueItemInput,
) -> Result<(), String> {
    if let Some(file_list) = collect_file_list(item) {
        let _ = app.emit(
            "upload:file_list",
            FileListEvent {
                item_id: item.id.clone(),
                files: file_list,
            },
        );
    }

    let should_pause =
        *control.pause_rx.borrow() || control.paused_items_rx.borrow().contains(&item.id);
    let initial_status = if should_pause { "paused" } else { "uploading" };
    log::debug!(
        target: "rclone",
        "upload.start id={} kind={} path={} paused={}",
        item.id,
        item.kind,
        item.path,
        should_pause
    );
    let _ = app.emit(
        "upload:item_status",
        ItemStatusEvent {
            item_id: item.id.clone(),
            path: item.path.clone(),
            kind: item.kind.clone(),
            status: initial_status.to_string(),
            message: None,
            sa_email: None,
        },
    );

    wait_if_paused(control, &item.id).await?;

    let mode = ServiceAccountMode::from_u8(sa_mode.load(Ordering::Relaxed));

    let attempt = run_rclone_command(
        app,
        control,
        prefs,
        sa_files,
        mode,
        service_account_folder,
        destination_folder_id,
        item,
    )
    .await;

    if let Err(err) = &attempt {
        if mode == ServiceAccountMode::Directory && err.contains("unknown flag") {
            sa_mode.store(ServiceAccountMode::SingleFile as u8, Ordering::Relaxed);
            let _ = app.emit(
                "upload:notice",
                serde_json::json!({
                    "message": "Rclone does not support --drive-service-account-file-path. Falling back to a single service account per file.",
                }),
            );
            return run_rclone_command(
                app,
                control,
                prefs,
                sa_files,
                ServiceAccountMode::SingleFile,
                service_account_folder,
                destination_folder_id,
                item,
            )
            .await;
        }
    }

    attempt
}

async fn run_rclone_command(
    app: &AppHandle,
    control: &UploadControlHandle,
    prefs: &RclonePreferences,
    sa_files: &[ServiceAccountFile],
    mode: ServiceAccountMode,
    service_account_folder: &str,
    destination_folder_id: &str,
    item: &QueueItemInput,
) -> Result<(), String> {
    if control.is_canceled() {
        return Err("Upload canceled".to_string());
    }

    let (sa_path, sa_email) = match mode {
        ServiceAccountMode::Directory => (None, None),
        ServiceAccountMode::SingleFile => {
            let sa = pick_service_account(sa_files)?;
            (Some(sa.path.clone()), sa.email.clone())
        }
        ServiceAccountMode::Unknown => (None, None),
    };

    log::debug!(
        target: "rclone",
        "upload.sa id={} mode={:?} sa={}",
        item.id,
        mode,
        sa_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| service_account_folder.to_string())
    );
    let _ = app.emit(
        "upload:item_status",
        ItemStatusEvent {
            item_id: item.id.clone(),
            path: item.path.clone(),
            kind: item.kind.clone(),
            status: "uploading".to_string(),
            message: None,
            sa_email: sa_email.clone(),
        },
    );

    let mut args = build_rclone_args(
        prefs,
        destination_folder_id,
        item,
        mode,
        service_account_folder,
        sa_path.as_ref(),
    );

    let mut command = Command::new(&prefs.rclone_path);
    command
        .args(&mut args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    log::debug!(
        target: "rclone",
        "upload.exec id={} cmd={} args={:?}",
        item.id,
        prefs.rclone_path,
        args
    );
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start rclone: {e}"))?;

    let pid = child
        .id()
        .ok_or_else(|| "Failed to get rclone process id".to_string())?;

    let (done_tx, done_rx) = watch::channel(false);
    let pause_task = tokio::spawn(monitor_pause_state(
        app.clone(),
        control.clone(),
        item.clone(),
        pid,
        done_rx,
    ));

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Missing stderr".to_string())?;

    let (line_tx, mut line_rx) = mpsc::channel::<String>(256);
    let stdout_task = tokio::spawn(read_rclone_stream(stdout, line_tx.clone()));
    let stderr_task = tokio::spawn(read_rclone_stream(stderr, line_tx.clone()));
    drop(line_tx);

    let progress_re = progress_regex();
    let mut last_bytes = 0_u64;
    let mut last_total = 0_u64;
    let mut last_file_progress: HashMap<String, (u64, u64)> = HashMap::new();
    let mut saw_unknown_flag = false;

    while let Some(line) = line_rx.recv().await {
        log::debug!(target: "rclone", "{}", line);
        if line.contains("unknown flag: --drive-service-account-file-path") {
            saw_unknown_flag = true;
        }
        if let Some(entries) = parse_json_file_progress(&line) {
            for (file_path, bytes, total) in entries {
                let should_emit = match last_file_progress.get(&file_path) {
                    Some((last_bytes, last_total)) => {
                        *last_bytes != bytes || *last_total != total
                    }
                    None => true,
                };
                if should_emit {
                    last_file_progress.insert(file_path.clone(), (bytes, total));
                    emit_file_progress(app, item, &file_path, bytes, total).await;
                }
            }
        }
        if let Some((bytes, total)) = parse_json_progress(&line, &item.path)
            .or_else(|| parse_progress_line(&progress_re, &line))
        {
            if bytes != last_bytes || total != last_total {
                last_bytes = bytes;
                last_total = total;
                emit_progress(app, item, bytes, total).await;
            }
        }
    }

    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let _ = done_tx.send(true);
    let _ = pause_task.await;

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait for rclone: {e}"))?;

    if control.is_canceled() {
        return Err("Upload canceled".to_string());
    }

    if status.success() {
        log::info!(
            target: "rclone",
            "upload.done id={} status=ok",
            item.id
        );
        let _ = app.emit(
            "upload:item_status",
            ItemStatusEvent {
                item_id: item.id.clone(),
                path: item.path.clone(),
                kind: item.kind.clone(),
                status: "done".to_string(),
                message: None,
                sa_email,
            },
        );
        return Ok(());
    }

    log::warn!(
        target: "rclone",
        "upload.failed id={} status={}",
        item.id,
        status
    );
    if saw_unknown_flag {
        return Err("unknown flag: --drive-service-account-file-path".to_string());
    }

    Err(format!("Rclone failed with status: {status}"))
}

async fn emit_progress(app: &AppHandle, item: &QueueItemInput, bytes: u64, total: u64) {
    log::debug!(
        target: "rclone",
        "progress id={} bytes={} total={}",
        item.id,
        bytes,
        total
    );
    let _ = app.emit(
        "upload:progress",
        ProgressEvent {
            item_id: item.id.clone(),
            path: item.path.clone(),
            bytes_sent: bytes,
            total_bytes: total,
        },
    );
}

async fn emit_file_progress(
    app: &AppHandle,
    item: &QueueItemInput,
    file_path: &str,
    bytes: u64,
    total: u64,
) {
    let _ = app.emit(
        "upload:file_progress",
        FileProgressEvent {
            item_id: item.id.clone(),
            file_path: file_path.to_string(),
            bytes_sent: bytes,
            total_bytes: total,
        },
    );
}

async fn monitor_pause_state(
    app: AppHandle,
    control: UploadControlHandle,
    item: QueueItemInput,
    pid: u32,
    mut done_rx: watch::Receiver<bool>,
) {
    let mut pause_all_rx = control.pause_rx.clone();
    let mut paused_items_rx = control.paused_items_rx.clone();
    let mut is_paused = false;

    loop {
        if *done_rx.borrow() {
            break;
        }

        if control.is_canceled() {
            log::debug!(target: "rclone", "upload.cancel id={}", item.id);
            #[cfg(unix)]
            {
                let _ = signal_process(pid, libc::SIGTERM);
            }
            #[cfg(windows)]
            {
                log::debug!(
                    target: "rclone",
                    "upload.cancel skipped on Windows id={}",
                    item.id
                );
            }
            break;
        }

        let should_pause =
            *pause_all_rx.borrow() || paused_items_rx.borrow().contains(&item.id);
        if should_pause != is_paused {
            is_paused = should_pause;
            log::debug!(
                target: "rclone",
                "upload.pause id={} paused={}",
                item.id,
                is_paused
            );
            #[cfg(unix)]
            {
                let _ = if is_paused {
                    signal_process(pid, libc::SIGSTOP)
                } else {
                    signal_process(pid, libc::SIGCONT)
                };
            }
            #[cfg(windows)]
            {
                log::debug!(
                    target: "rclone",
                    "upload.pause skipped on Windows id={} paused={}",
                    item.id,
                    is_paused
                );
            }
            let _ = app.emit(
                "upload:item_status",
                ItemStatusEvent {
                    item_id: item.id.clone(),
                    path: item.path.clone(),
                    kind: item.kind.clone(),
                    status: if is_paused {
                        "paused".to_string()
                    } else {
                        "uploading".to_string()
                    },
                    message: None,
                    sa_email: None,
                },
            );
        }

        tokio::select! {
            _ = pause_all_rx.changed() => {}
            _ = paused_items_rx.changed() => {}
            _ = done_rx.changed() => {}
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
    }
}

fn build_rclone_args(
    prefs: &RclonePreferences,
    destination_folder_id: &str,
    item: &QueueItemInput,
    mode: ServiceAccountMode,
    service_account_folder: &str,
    sa_path: Option<&PathBuf>,
) -> Vec<String> {
    let mut args = vec![
        "copy".to_string(),
        item.path.clone(),
        format!(
            "{}:{}",
            prefs.remote_name,
            if item.kind == "folder" {
                Path::new(&item.path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("folder")
                    .to_string()
            } else {
                "".to_string()
            }
        ),
        "--drive-root-folder-id".to_string(),
        destination_folder_id.to_string(),
        "--drive-chunk-size".to_string(),
        format!("{}M", prefs.drive_chunk_size_mib),
        "--transfers".to_string(),
        prefs.transfers.to_string(),
        "--checkers".to_string(),
        prefs.checkers.to_string(),
        "--stats".to_string(),
        "1s".to_string(),
        "--stats-log-level".to_string(),
        "INFO".to_string(),
        "--log-level".to_string(),
        "INFO".to_string(),
        "--use-json-log".to_string(),
    ];

    match mode {
        ServiceAccountMode::Directory => {
            args.push("--drive-service-account-file-path".to_string());
            args.push(service_account_folder.to_string());
        }
        ServiceAccountMode::SingleFile => {
            if let Some(path) = sa_path {
                args.push("--drive-service-account-file".to_string());
                args.push(path.to_string_lossy().to_string());
            }
        }
        ServiceAccountMode::Unknown => {}
    }

    args
}

fn load_service_account_files(folder: &str) -> Result<Vec<ServiceAccountFile>, String> {
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

        let email = match read_service_account_email(&path) {
            Ok(email) => email,
            Err(_) => continue,
        };
        accounts.push(ServiceAccountFile { path, email });
    }

    Ok(accounts)
}

fn read_service_account_email(path: &Path) -> Result<Option<String>, String> {
    #[derive(serde::Deserialize)]
    struct ServiceAccountJson {
        client_email: Option<String>,
    }

    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read service account JSON: {e}"))?;
    let parsed: ServiceAccountJson = serde_json::from_str(&contents)
        .map_err(|e| format!("Invalid service account JSON: {e}"))?;

    Ok(parsed.client_email)
}

fn pick_service_account(sa_files: &[ServiceAccountFile]) -> Result<&ServiceAccountFile, String> {
    if sa_files.is_empty() {
        return Err("No service account JSON files available.".to_string());
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .subsec_nanos();
    let idx = (nanos as usize) % sa_files.len();
    Ok(&sa_files[idx])
}

fn progress_regex() -> Regex {
    Regex::new(r"([0-9.]+)\s*([A-Za-z]+)\s*/\s*([0-9.]+)\s*([A-Za-z]+)")
        .expect("progress regex")
}

fn parse_progress_line(regex: &Regex, line: &str) -> Option<(u64, u64)> {
    let caps = regex.captures(line)?;
    let sent = parse_size(&caps[1], &caps[2])?;
    let total = parse_size(&caps[3], &caps[4])?;
    Some((sent, total))
}

fn parse_json_progress(line: &str, path: &str) -> Option<(u64, u64)> {
    if !line.trim_start().starts_with('{') {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    let stats = value.get("stats")?;
    let file_name = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path);

    if let Some(transferring) = stats.get("transferring").and_then(|v| v.as_array()) {
        for entry in transferring {
            let name = entry
                .get("name")
                .and_then(|v| v.as_str())
                .or_else(|| entry.get("path").and_then(|v| v.as_str()))
                .or_else(|| entry.get("object").and_then(|v| v.as_str()));
            if let Some(name) = name {
                if name == file_name || name.ends_with(file_name) {
                    let bytes = entry.get("bytes").and_then(|v| v.as_u64())?;
                    let total = entry.get("size").and_then(|v| v.as_u64())?;
                    return Some((bytes, total));
                }
            }
        }

        if transferring.len() == 1 {
            let entry = &transferring[0];
            let bytes = entry.get("bytes").and_then(|v| v.as_u64())?;
            let total = entry.get("size").and_then(|v| v.as_u64())?;
            return Some((bytes, total));
        }
    }

    let bytes = stats.get("bytes").and_then(|v| v.as_u64())?;
    let total = stats.get("totalBytes").and_then(|v| v.as_u64())?;
    Some((bytes, total))
}

fn parse_json_file_progress(line: &str) -> Option<Vec<(String, u64, u64)>> {
    if !line.trim_start().starts_with('{') {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    let stats = value.get("stats")?;
    let transferring = stats.get("transferring")?.as_array()?;
    let mut entries = Vec::new();
    for entry in transferring {
        let name = entry
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| entry.get("path").and_then(|v| v.as_str()))
            .or_else(|| entry.get("object").and_then(|v| v.as_str()));
        let bytes = entry.get("bytes").and_then(|v| v.as_u64());
        let total = entry.get("size").and_then(|v| v.as_u64());
        if let (Some(name), Some(bytes), Some(total)) = (name, bytes, total) {
            entries.push((name.to_string(), bytes, total));
        }
    }
    if entries.is_empty() {
        None
    } else {
        Some(entries)
    }
}

fn collect_file_list(item: &QueueItemInput) -> Option<Vec<FileListEntry>> {
    let path = PathBuf::from(&item.path);
    let mut files = Vec::new();

    if item.kind == "file" {
        if let Ok(metadata) = std::fs::metadata(&path) {
            files.push(FileListEntry {
                file_path: path.to_string_lossy().to_string(),
                total_bytes: metadata.len(),
            });
        }
        return Some(files);
    }

    if item.kind != "folder" {
        return None;
    }

    for entry in WalkDir::new(&path).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let file_path = entry.path().to_path_buf();
        if let Ok(metadata) = std::fs::metadata(&file_path) {
            files.push(FileListEntry {
                file_path: file_path.to_string_lossy().to_string(),
                total_bytes: metadata.len(),
            });
        }
    }

    if files.is_empty() {
        None
    } else {
        Some(files)
    }
}

fn parse_size(value: &str, unit: &str) -> Option<u64> {
    let number: f64 = value.parse().ok()?;
    let unit = unit.to_ascii_lowercase();
    let multiplier = match unit.as_str() {
        "b" => 1.0,
        "kb" => 1_000.0,
        "mb" => 1_000_000.0,
        "gb" => 1_000_000_000.0,
        "tb" => 1_000_000_000_000.0,
        "kib" => 1024.0,
        "mib" => 1024.0 * 1024.0,
        "gib" => 1024.0 * 1024.0 * 1024.0,
        "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((number * multiplier).round() as u64)
}

#[cfg(unix)]
fn signal_process(pid: u32, signal: i32) -> Result<(), String> {
    let result = unsafe { libc::kill(pid as i32, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err("Failed to signal rclone process".to_string())
    }
}

async fn detect_sa_directory_support(prefs: &RclonePreferences) -> Result<bool, String> {
    let output = Command::new(&prefs.rclone_path)
        .args(["help", "flags"])
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone help: {e}"))?;

    if !output.status.success() {
        return Err("Failed to detect rclone flag support.".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}\n{stderr}");
    Ok(combined.contains("drive-service-account-file-path"))
}

async fn read_rclone_stream<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    tx: mpsc::Sender<String>,
) {
    let mut buf = [0_u8; 4096];
    let mut pending = Vec::new();

    loop {
        let read = match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        pending.extend_from_slice(&buf[..read]);

        let mut start = 0;
        for i in 0..pending.len() {
            let b = pending[i];
            if b == b'\n' || b == b'\r' {
                if i > start {
                    let line = String::from_utf8_lossy(&pending[start..i]).trim().to_string();
                    if !line.is_empty() {
                        let _ = tx.send(line).await;
                    }
                }
                start = i + 1;
            }
        }

        if start > 0 {
            pending.drain(0..start);
        }
    }

    if !pending.is_empty() {
        let line = String::from_utf8_lossy(&pending).trim().to_string();
        if !line.is_empty() {
            let _ = tx.send(line).await;
        }
    }
}
