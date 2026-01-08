use crate::upload::events::{
    CompletedEvent, FileListEntry, FileListEvent, FileProgressEvent, ItemStatusEvent,
    ProgressEvent, Summary,
};
use crate::upload::scheduler::{wait_if_paused, QueueItemInput, UploadControlHandle};
use regex::Regex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{mpsc, watch, Mutex, Semaphore};
use walkdir::WalkDir;

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
    last_used: u64,
}

#[derive(Clone, Debug)]
struct FolderFileEntry {
    path: PathBuf,
    rel_path: String,
    size: u64,
}

#[derive(Debug)]
struct FolderProgressTracker {
    total_bytes: u64,
    current_bytes: u64,
    by_file: HashMap<String, u64>,
}

impl FolderProgressTracker {
    fn new(total_bytes: u64) -> Self {
        Self {
            total_bytes,
            current_bytes: 0,
            by_file: HashMap::new(),
        }
    }

    fn update(&mut self, file_key: &str, bytes: u64) -> (u64, u64) {
        let prev = self.by_file.insert(file_key.to_string(), bytes).unwrap_or(0);
        if bytes >= prev {
            self.current_bytes = self.current_bytes.saturating_add(bytes - prev);
        } else {
            self.current_bytes = self.current_bytes.saturating_sub(prev - bytes);
        }
        (self.current_bytes, self.total_bytes)
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
        return Err(
            "No valid service account JSON files found in the selected folder.".to_string(),
        );
    }

    let sa_pool = Arc::new(Mutex::new(sa_files));
    let sa_tick = Arc::new(AtomicU64::new(0));

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
        let destination_folder_id = destination_folder_id.clone();
        let sa_pool = sa_pool.clone();
        let sa_tick = sa_tick.clone();
        let succeeded = succeeded.clone();
        let failed = failed.clone();

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
                    max_concurrent,
                    &sa_pool,
                    &sa_tick,
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

const MAX_SA_ATTEMPTS: usize = 5;
const RETRY_BACKOFF_MS: u64 = 1200;

#[allow(clippy::too_many_arguments)]
async fn run_rclone_for_item(
    app: &AppHandle,
    control: &UploadControlHandle,
    prefs: &RclonePreferences,
    max_concurrent: u8,
    sa_pool: &Arc<Mutex<Vec<ServiceAccountFile>>>,
    sa_tick: &Arc<AtomicU64>,
    destination_folder_id: &str,
    item: &QueueItemInput,
) -> Result<(), String> {
    if is_item_canceled(control, &item.id) {
        return Err("Upload canceled".to_string());
    }
    let folder_entries = collect_folder_file_entries(item);
    if let Some(entries) = folder_entries.as_ref() {
        let file_list = entries
            .iter()
            .map(|entry| FileListEntry {
                file_path: entry.path.to_string_lossy().to_string(),
                total_bytes: entry.size,
            })
            .collect::<Vec<_>>();
        if !file_list.is_empty() {
            let _ = app.emit(
                "upload:file_list",
                FileListEvent {
                    item_id: item.id.clone(),
                    files: file_list,
                },
            );
        }
    } else if let Some(file_list) = collect_file_list(item) {
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

    if let Some(entries) = folder_entries {
        return run_rclone_for_folder_entries(
            app,
            control,
            prefs,
            max_concurrent,
            sa_pool,
            sa_tick,
            destination_folder_id,
            item,
            entries,
        )
        .await;
    }

    let max_attempts = {
        let guard = sa_pool.lock().await;
        guard.len().clamp(1, MAX_SA_ATTEMPTS)
    };
    let mut attempts = 0_usize;
    let mut tried: HashSet<PathBuf> = HashSet::new();

    loop {
        if is_item_canceled(control, &item.id) {
            return Err("Upload canceled".to_string());
        }
        attempts += 1;
        let (sa_path, sa_email) =
            select_service_account_excluding(sa_pool, sa_tick, &tried).await?;
        tried.insert(sa_path.clone());

        let result = run_rclone_command(
            app,
            control,
            prefs,
            &sa_path,
            sa_email,
            destination_folder_id,
            item,
        )
        .await;

        match result {
            Ok(()) => return Ok(()),
            Err(err) => {
                let retryable = is_retryable_error(&err);
                log::warn!(
                    target: "rclone",
                    "upload.attempt_failed id={} attempt={}/{} retryable={} error={}",
                    item.id,
                    attempts,
                    max_attempts,
                    retryable,
                    err
                );
                if !retryable || attempts >= max_attempts {
                    return Err(err);
                }
                tokio::time::sleep(Duration::from_millis(
                    RETRY_BACKOFF_MS.saturating_mul(attempts as u64),
                ))
                .await;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_rclone_for_folder_entries(
    app: &AppHandle,
    control: &UploadControlHandle,
    prefs: &RclonePreferences,
    max_concurrent: u8,
    sa_pool: &Arc<Mutex<Vec<ServiceAccountFile>>>,
    sa_tick: &Arc<AtomicU64>,
    destination_folder_id: &str,
    item: &QueueItemInput,
    entries: Vec<FolderFileEntry>,
) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }

    let total_bytes: u64 = entries.iter().map(|entry| entry.size).sum();
    if total_bytes > 0 {
        emit_progress(app, item, 0, total_bytes).await;
    }

    let dest_base = resolve_folder_dest_base(item);
    let concurrency = max_concurrent.clamp(1, 10) as usize;
    let semaphore = Arc::new(Semaphore::new(concurrency.max(1)));
    let progress_tracker = Arc::new(Mutex::new(FolderProgressTracker::new(total_bytes)));
    let last_sa_email = Arc::new(Mutex::new(None::<String>));
    let mut tasks = tokio::task::JoinSet::new();

    for entry in entries {
        if control.is_canceled() {
            return Err("Upload canceled".to_string());
        }
        if is_item_canceled(control, &item.id) {
            return Err("Upload canceled".to_string());
        }

        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "Upload canceled".to_string())?;

        let app = app.clone();
        let control = control.clone();
        let prefs = prefs.clone();
        let sa_pool = sa_pool.clone();
        let sa_tick = sa_tick.clone();
        let destination_folder_id = destination_folder_id.to_string();
        let item = item.clone();
        let progress_tracker = progress_tracker.clone();
        let last_sa_email = last_sa_email.clone();
        let dest_base = dest_base.clone();

        tasks.spawn(async move {
            let _permit = permit;
            let dest_dir = build_folder_dest_dir(&dest_base, &entry.rel_path);
            let max_attempts = {
                let guard = sa_pool.lock().await;
                guard.len().clamp(1, MAX_SA_ATTEMPTS)
            };
            let mut attempts = 0_usize;
            let mut tried: HashSet<PathBuf> = HashSet::new();

            loop {
                if is_item_canceled(&control, &item.id) || control.is_canceled() {
                    return Err("Upload canceled".to_string());
                }
                attempts += 1;
                let (sa_path, sa_email) =
                    select_service_account_excluding(&sa_pool, &sa_tick, &tried).await?;
                tried.insert(sa_path.clone());

                let result = run_rclone_for_file(
                    &app,
                    &control,
                    &prefs,
                    &sa_path,
                    sa_email.clone(),
                    &destination_folder_id,
                    &item,
                    &entry.path,
                    entry.size,
                    &dest_dir,
                    progress_tracker.clone(),
                )
                .await;

                match result {
                    Ok(()) => {
                        if let Some(sa_email) = sa_email {
                            let mut guard = last_sa_email.lock().await;
                            *guard = Some(sa_email);
                        }
                        return Ok(());
                    }
                    Err(err) => {
                        let retryable = is_retryable_error(&err);
                        log::warn!(
                            target: "rclone",
                            "upload.attempt_failed id={} file={} attempt={}/{} retryable={} error={}",
                            item.id,
                            entry.path.to_string_lossy(),
                            attempts,
                            max_attempts,
                            retryable,
                            err
                        );
                        if !retryable || attempts >= max_attempts {
                            return Err(format!(
                                "Failed to upload {}: {}",
                                entry.path.to_string_lossy(),
                                err
                            ));
                        }
                        tokio::time::sleep(Duration::from_millis(
                            RETRY_BACKOFF_MS.saturating_mul(attempts as u64),
                        ))
                        .await;
                    }
                }
            }
        });
    }

    let mut first_error: Option<String> = None;
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                if first_error.is_none() {
                    first_error = Some(err);
                }
            }
            Err(err) => {
                if first_error.is_none() {
                    first_error = Some(format!("Upload task failed: {err}"));
                }
            }
        }
    }

    if let Some(err) = first_error {
        return Err(err);
    }

    let sa_email = last_sa_email.lock().await.clone();
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

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_rclone_command(
    app: &AppHandle,
    control: &UploadControlHandle,
    prefs: &RclonePreferences,
    sa_path: &Path,
    sa_email: Option<String>,
    destination_folder_id: &str,
    item: &QueueItemInput,
) -> Result<(), String> {
    if control.is_canceled() {
        return Err("Upload canceled".to_string());
    }
    if is_item_canceled(control, &item.id) {
        return Err("Upload canceled".to_string());
    }

    log::debug!(
        target: "rclone",
        "upload.sa id={} sa={}",
        item.id,
        sa_path.to_string_lossy()
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

    let args = build_rclone_args(prefs, destination_folder_id, item, sa_path);

    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut std_command = std::process::Command::new(&prefs.rclone_path);
        std_command
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW);
        Command::from(std_command)
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(&prefs.rclone_path);
        command
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    };

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
    let mut last_error: Option<String> = None;

    while let Some(line) = line_rx.recv().await {
        log::debug!(target: "rclone", "{}", line);
        if is_item_canceled(control, &item.id) {
            return Err("Upload canceled".to_string());
        }
        if let Some(msg) = extract_error_message(&line) {
            last_error = Some(msg);
        }
        if let Some(entries) = parse_json_file_progress(&line) {
            for (file_path, bytes, total) in entries {
                let should_emit = match last_file_progress.get(&file_path) {
                    Some((last_bytes, last_total)) => *last_bytes != bytes || *last_total != total,
                    None => true,
                };
                if should_emit {
                    last_file_progress.insert(file_path.clone(), (bytes, total));
                    emit_file_progress(
                        app,
                        item,
                        &file_path,
                        bytes,
                        total,
                        sa_email.clone(),
                    )
                    .await;
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

    let message = last_error.unwrap_or_else(|| format!("Rclone failed with status: {status}"));
    Err(message)
}

#[allow(clippy::too_many_arguments)]
async fn run_rclone_for_file(
    app: &AppHandle,
    control: &UploadControlHandle,
    prefs: &RclonePreferences,
    sa_path: &Path,
    sa_email: Option<String>,
    destination_folder_id: &str,
    item: &QueueItemInput,
    file_path: &Path,
    file_size: u64,
    dest_dir: &str,
    progress_tracker: Arc<Mutex<FolderProgressTracker>>,
) -> Result<(), String> {
    if control.is_canceled() {
        return Err("Upload canceled".to_string());
    }
    if is_item_canceled(control, &item.id) {
        return Err("Upload canceled".to_string());
    }

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

    let file_path_string = file_path.to_string_lossy().to_string();
    let file_item = QueueItemInput {
        id: item.id.clone(),
        path: file_path_string.clone(),
        kind: "file".to_string(),
        dest_path: Some(dest_dir.to_string()),
    };
    let args = build_rclone_args(prefs, destination_folder_id, &file_item, sa_path);

    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut std_command = std::process::Command::new(&prefs.rclone_path);
        std_command
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW);
        Command::from(std_command)
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(&prefs.rclone_path);
        command
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    };

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
    let mut last_error: Option<String> = None;

    emit_file_progress(
        app,
        item,
        &file_path_string,
        0,
        file_size,
        sa_email.clone(),
    )
    .await;
    let (total_sent, total_size) = {
        let mut guard = progress_tracker.lock().await;
        guard.update(&file_path_string, 0)
    };
    if total_size > 0 {
        emit_progress(app, item, total_sent, total_size).await;
    }

    while let Some(line) = line_rx.recv().await {
        log::debug!(target: "rclone", "{}", line);
        if is_item_canceled(control, &item.id) {
            return Err("Upload canceled".to_string());
        }
        if let Some(msg) = extract_error_message(&line) {
            last_error = Some(msg);
        }
        if let Some((bytes, total)) = parse_json_progress(&line, &file_path_string)
            .or_else(|| parse_progress_line(&progress_re, &line))
        {
            if bytes != last_bytes || total != last_total {
                last_bytes = bytes;
                last_total = total;
                emit_file_progress(
                    app,
                    item,
                    &file_path_string,
                    bytes,
                    total,
                    sa_email.clone(),
                )
                .await;
                let (total_sent, total_size) = {
                    let mut guard = progress_tracker.lock().await;
                    guard.update(&file_path_string, bytes)
                };
                if total_size > 0 {
                    emit_progress(app, item, total_sent, total_size).await;
                }
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
        emit_file_progress(
            app,
            item,
            &file_path_string,
            file_size,
            file_size,
            sa_email.clone(),
        )
        .await;
        let (total_sent, total_size) = {
            let mut guard = progress_tracker.lock().await;
            guard.update(&file_path_string, file_size)
        };
        if total_size > 0 {
            emit_progress(app, item, total_sent, total_size).await;
        }
        return Ok(());
    }

    let message = last_error.unwrap_or_else(|| format!("Rclone failed with status: {status}"));
    Err(message)
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
    sa_email: Option<String>,
) {
    let _ = app.emit(
        "upload:file_progress",
        FileProgressEvent {
            item_id: item.id.clone(),
            file_path: file_path.to_string(),
            bytes_sent: bytes,
            total_bytes: total,
            sa_email,
        },
    );
}

fn extract_error_message(line: &str) -> Option<String> {
    if line.trim_start().starts_with('{') {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            let level = value.get("level").and_then(|v| v.as_str()).unwrap_or("");
            if level.eq_ignore_ascii_case("error") {
                if let Some(msg) = value.get("msg").and_then(|v| v.as_str()) {
                    return Some(msg.to_string());
                }
                if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
                    return Some(err.to_string());
                }
            }
        }
    }

    if line.contains("ERROR") || line.contains("error") {
        return Some(line.to_string());
    }

    None
}

fn is_retryable_error(message: &str) -> bool {
    let msg = message.to_ascii_lowercase();
    msg.contains("ratelimit")
        || msg.contains("rate limit")
        || msg.contains("userratelimitexceeded")
        || msg.contains("dailylimitexceeded")
        || msg.contains("quotaexceeded")
        || msg.contains("storagequotaexceeded")
        || msg.contains("backend rate limit")
        || msg.contains("too many requests")
        || msg.contains("http 429")
        || msg.contains("http 403")
}

async fn monitor_pause_state(
    app: AppHandle,
    control: UploadControlHandle,
    item: QueueItemInput,
    pid: u32,
    mut done_rx: watch::Receiver<bool>,
) {
    #[cfg(windows)]
    let _pid = pid;
    let mut pause_all_rx = control.pause_rx.clone();
    let mut paused_items_rx = control.paused_items_rx.clone();
    let mut canceled_items_rx = control.canceled_items_rx.clone();
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

        if canceled_items_rx.borrow().contains(&item.id) {
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

        let should_pause = *pause_all_rx.borrow() || paused_items_rx.borrow().contains(&item.id);
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
            _ = canceled_items_rx.changed() => {}
            _ = done_rx.changed() => {}
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
    }
}

fn is_item_canceled(control: &UploadControlHandle, item_id: &str) -> bool {
    control.canceled_items_rx.borrow().contains(item_id)
}

fn build_rclone_args(
    prefs: &RclonePreferences,
    destination_folder_id: &str,
    item: &QueueItemInput,
    sa_path: &Path,
) -> Vec<String> {
    let args = vec![
        "copy".to_string(),
        item.path.clone(),
        format!(
            "{}:{}",
            prefs.remote_name,
            if let Some(dest_path) = item.dest_path.as_ref() {
                dest_path.clone()
            } else if item.kind == "folder" {
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
        "--drive-service-account-file".to_string(),
        sa_path.to_string_lossy().to_string(),
    ];

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
        accounts.push(ServiceAccountFile {
            path,
            email,
            last_used: 0,
        });
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

async fn select_service_account_excluding(
    pool: &Arc<Mutex<Vec<ServiceAccountFile>>>,
    tick: &Arc<AtomicU64>,
    exclude: &HashSet<PathBuf>,
) -> Result<(PathBuf, Option<String>), String> {
    let mut guard = pool.lock().await;
    if guard.is_empty() {
        return Err("No service account JSON files available.".to_string());
    }

    let mut best_idx: Option<usize> = None;
    let mut best_used = u64::MAX;
    for (idx, entry) in guard.iter().enumerate() {
        if exclude.contains(&entry.path) {
            continue;
        }
        if entry.last_used < best_used {
            best_idx = Some(idx);
            best_used = entry.last_used;
        }
    }

    let Some(best_idx) = best_idx else {
        return Err("No unused service account JSON files available.".to_string());
    };

    let next = tick.fetch_add(1, Ordering::Relaxed) + 1;
    guard[best_idx].last_used = next;

    let entry = &guard[best_idx];
    Ok((entry.path.clone(), entry.email.clone()))
}

fn progress_regex() -> Regex {
    Regex::new(r"([0-9.]+)\s*([A-Za-z]+)\s*/\s*([0-9.]+)\s*([A-Za-z]+)").expect("progress regex")
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

fn collect_folder_file_entries(item: &QueueItemInput) -> Option<Vec<FolderFileEntry>> {
    if item.kind != "folder" {
        return None;
    }

    let base = PathBuf::from(&item.path);
    let mut entries = Vec::new();

    for entry in WalkDir::new(&base).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path().to_path_buf();
        let rel_path = path
            .strip_prefix(&base)
            .ok()
            .and_then(|p| p.to_str())
            .map(|p| p.replace('\\', "/"))
            .unwrap_or_else(|| path.to_string_lossy().to_string());
        if let Ok(metadata) = std::fs::metadata(&path) {
            entries.push(FolderFileEntry {
                path,
                rel_path,
                size: metadata.len(),
            });
        }
    }

    if entries.is_empty() {
        None
    } else {
        Some(entries)
    }
}

fn resolve_folder_dest_base(item: &QueueItemInput) -> String {
    if let Some(dest_path) = item.dest_path.as_ref() {
        return dest_path.clone();
    }
    Path::new(&item.path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("folder")
        .to_string()
}

fn build_folder_dest_dir(base: &str, rel_path: &str) -> String {
    let rel_dir = Path::new(rel_path)
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("")
        .replace('\\', "/");
    if rel_dir.is_empty() {
        base.to_string()
    } else if base.is_empty() {
        rel_dir
    } else {
        format!("{}/{}", base, rel_dir)
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
                    let line = String::from_utf8_lossy(&pending[start..i])
                        .trim()
                        .to_string();
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
