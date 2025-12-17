use crate::upload::drive_client::DriveClient;
use crate::upload::events::{CompletedEvent, ItemStatusEvent, ProgressEvent, Summary};
use crate::upload::mirror::{build_tasks_for_item, read_file_chunk, FolderAggregate, UploadTask};
use crate::upload::sa_loader::load_service_accounts;
use reqwest::Client;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, watch, Mutex};

#[derive(Clone)]
pub struct UploadControlHandle {
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
    pub pause_rx: watch::Receiver<bool>,
    pub paused_items_rx: watch::Receiver<HashSet<String>>,
}

impl UploadControlHandle {
    pub fn is_canceled(&self) -> bool {
        self.cancel.load(std::sync::atomic::Ordering::Relaxed)
    }
}

pub fn build_drive_pool(service_account_folder: &str) -> Result<DrivePool, String> {
    let folder = PathBuf::from(service_account_folder);
    let accounts = load_service_accounts(&folder)?;
    if accounts.is_empty() {
        return Err(
            "No valid service account JSON files found in the selected folder.".to_string(),
        );
    }

    let http = Client::builder()
        .user_agent("googul/0.1.0")
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let clients: Vec<DriveClient> = accounts
        .into_iter()
        .map(|a| DriveClient::new(http.clone(), a))
        .collect();
    DrivePool::new(clients)
}

#[derive(Clone)]
pub struct DrivePool {
    clients: Arc<Vec<DriveClient>>,
    next_index: Arc<AtomicUsize>,
}

impl DrivePool {
    pub fn new(clients: Vec<DriveClient>) -> Result<Self, String> {
        if clients.is_empty() {
            return Err("No service accounts available".to_string());
        }
        Ok(Self {
            clients: Arc::new(clients),
            next_index: Arc::new(AtomicUsize::new(0)),
        })
    }

    pub fn next_client(&self) -> DriveClient {
        let idx = self.next_index.fetch_add(1, Ordering::Relaxed);
        let i = idx % self.clients.len();
        self.clients[i].clone()
    }

    pub fn first_email(&self) -> String {
        self.clients
            .first()
            .map(|c| c.sa_email().to_string())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItemInput {
    pub id: String,
    pub path: String,
    pub kind: String,
}

pub async fn run_upload_job_with_pool(
    app: AppHandle,
    pool: DrivePool,
    control: UploadControlHandle,
    max_concurrent: u8,
    chunk_size_bytes: usize,
    queue: Vec<QueueItemInput>,
    destination_folder_id: String,
) -> Result<(), String> {
    // Preparing: build tasks and stream them into a bounded worker pool.
    let per_item_totals: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));
    let per_item_sent: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));
    let per_item_failed: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));

    let mut folder_aggregates: HashMap<String, FolderAggregate> = HashMap::new();

    let concurrency = max_concurrent.clamp(1, 10) as usize;
    let (tx, rx) = mpsc::channel::<UploadTask>(concurrency.saturating_mul(2).max(8));
    let rx = Arc::new(Mutex::new(rx));

    let mut worker_handles = Vec::with_capacity(concurrency);
    for _ in 0..concurrency {
        let app = app.clone();
        let pool = pool.clone();
        let control = control.clone();
        let rx = rx.clone();
        let per_item_totals = per_item_totals.clone();
        let per_item_sent = per_item_sent.clone();
        let per_item_failed = per_item_failed.clone();

        worker_handles.push(tokio::spawn(async move {
            loop {
                if control.is_canceled() {
                    break;
                }
                let task = {
                    let mut guard = rx.lock().await;
                    guard.recv().await
                };
                let Some(task) = task else { break };

                let client = pool.next_client();
                let sa_email = client.sa_email().to_string();
                let result = upload_one_file(
                    &client,
                    &control,
                    &app,
                    &task,
                    per_item_totals.clone(),
                    per_item_sent.clone(),
                    chunk_size_bytes,
                )
                .await;
                if let Err(e) = &result {
                    let mut failed = per_item_failed.lock().await;
                    failed
                        .entry(task.top_item_id.clone())
                        .or_insert_with(|| format!("SA {sa_email}: {e}"));
                    let _ = app.emit(
                        "upload:item_status",
                        ItemStatusEvent {
                            item_id: task.top_item_id.clone(),
                            path: task.top_item_path.clone(),
                            kind: task.top_item_kind.clone(),
                            status: "failed".to_string(),
                            message: Some(e.clone()),
                            sa_email: Some(sa_email.clone()),
                        },
                    );
                }
            }
        }));
    }

    for item in &queue {
        if control.is_canceled() {
            break;
        }
        let _ = app.emit(
            "upload:item_status",
            ItemStatusEvent {
                item_id: item.id.clone(),
                path: item.path.clone(),
                kind: item.kind.clone(),
                status: "preparing".to_string(),
                message: None,
                sa_email: Some(pool.first_email()),
            },
        );

        let (tasks, aggregate) = build_tasks_for_item(
            &pool,
            &destination_folder_id,
            &item.id,
            &item.path,
            &item.kind,
        )
        .await
        .map_err(|e| format!("Failed to prepare {}: {e}", item.path))?;

        if let Some(agg) = aggregate {
            folder_aggregates.insert(item.id.clone(), agg);
        }

        let total_bytes_for_item = if item.kind == "folder" {
            folder_aggregates
                .get(&item.id)
                .map(|a| a.total_bytes)
                .unwrap_or(0)
        } else {
            tasks.first().map(|t| t.total_bytes).unwrap_or(0)
        };

        {
            let mut totals = per_item_totals.lock().await;
            totals.insert(item.id.clone(), total_bytes_for_item);
        }
        {
            let mut sent = per_item_sent.lock().await;
            sent.insert(item.id.clone(), 0);
        }

        // Mark as uploading once tasks are enqueued (folder mirroring has finished).
        let should_pause =
            *control.pause_rx.borrow() || control.paused_items_rx.borrow().contains(&item.id);
        let _ = app.emit(
            "upload:item_status",
            ItemStatusEvent {
                item_id: item.id.clone(),
                path: item.path.clone(),
                kind: item.kind.clone(),
                status: if should_pause {
                    "paused".to_string()
                } else {
                    "uploading".to_string()
                },
                message: None,
                sa_email: None,
            },
        );

        for task in tasks {
            if control.is_canceled() {
                break;
            }
            // If workers have exited unexpectedly, this will error; treat it as fatal.
            tx.send(task)
                .await
                .map_err(|e| format!("Failed to enqueue upload task: {e}"))?;
        }
    }

    drop(tx);
    for handle in worker_handles {
        let _ = handle.await;
    }

    // Finalize per-item statuses.
    let failed_map = per_item_failed.lock().await.clone();
    let mut succeeded = 0u32;
    let mut failed = 0u32;

    for item in &queue {
        if let Some(msg) = failed_map.get(&item.id) {
            failed += 1;
            let _ = app.emit(
                "upload:item_status",
                ItemStatusEvent {
                    item_id: item.id.clone(),
                    path: item.path.clone(),
                    kind: item.kind.clone(),
                    status: "failed".to_string(),
                    message: Some(msg.clone()),
                    sa_email: None,
                },
            );
        } else {
            succeeded += 1;
            let _ = app.emit(
                "upload:item_status",
                ItemStatusEvent {
                    item_id: item.id.clone(),
                    path: item.path.clone(),
                    kind: item.kind.clone(),
                    status: "done".to_string(),
                    message: None,
                    sa_email: None,
                },
            );
        }
    }

    let _ = app.emit(
        "upload:completed",
        CompletedEvent {
            summary: Summary {
                total: queue.len() as u32,
                succeeded,
                failed,
            },
        },
    );

    Ok(())
}

async fn upload_one_file(
    client: &DriveClient,
    control: &UploadControlHandle,
    app: &AppHandle,
    task: &UploadTask,
    per_item_totals: Arc<Mutex<HashMap<String, u64>>>,
    per_item_sent: Arc<Mutex<HashMap<String, u64>>>,
    chunk_size_bytes: usize,
) -> Result<(), String> {
    if control.is_canceled() {
        return Err("Upload canceled".to_string());
    }
    let mut file = tokio::fs::File::open(&task.local_file_path)
        .await
        .map_err(|e| format!("Failed to open file: {e}"))?;

    let upload_url = client
        .start_resumable_upload(
            &task.drive_parent_id,
            &task.display_name,
            &task.mime_type,
            task.total_bytes,
        )
        .await?;

    let mut buf = Vec::new();
    let mut offset: u64 = 0;
    let align = 256 * 1024;
    let raw = chunk_size_bytes.clamp(align, 64 * 1024 * 1024);
    let mut chunk_size = raw - (raw % align);
    if chunk_size == 0 {
        chunk_size = align;
    }

    loop {
        if control.is_canceled() {
            return Err("Upload canceled".to_string());
        }
        wait_if_paused(control, &task.top_item_id).await?;

        let chunk = read_file_chunk(&mut file, &mut buf, chunk_size).await?;
        if chunk.is_empty() {
            break;
        }

        let start = offset;
        let end_inclusive = offset + (chunk.len() as u64) - 1;
        let is_last = end_inclusive + 1 == task.total_bytes;

        let _ = client
            .upload_resumable_chunk(
                &upload_url,
                chunk,
                start,
                end_inclusive,
                task.total_bytes,
                is_last,
            )
            .await?;

        let delta = (end_inclusive + 1).saturating_sub(offset);
        offset = end_inclusive + 1;

        let (sent, total) = {
            let mut sent_map = per_item_sent.lock().await;
            let totals_map = per_item_totals.lock().await;
            let total = *totals_map
                .get(&task.top_item_id)
                .unwrap_or(&task.total_bytes);
            let entry = sent_map.entry(task.top_item_id.clone()).or_insert(0);
            *entry = entry.saturating_add(delta);
            (*entry, total)
        };

        let _ = app.emit(
            "upload:progress",
            ProgressEvent {
                item_id: task.top_item_id.clone(),
                path: task.top_item_path.clone(),
                bytes_sent: sent.min(total),
                total_bytes: total,
            },
        );
    }

    Ok(())
}

async fn wait_if_paused(control: &UploadControlHandle, item_id: &str) -> Result<(), String> {
    if control.is_canceled() {
        return Err("Upload canceled".to_string());
    }

    let mut pause_all_rx = control.pause_rx.clone();
    let mut paused_items_rx = control.paused_items_rx.clone();

    let is_blocked = *pause_all_rx.borrow() || paused_items_rx.borrow().contains(item_id);
    if !is_blocked {
        return Ok(());
    }

    while *pause_all_rx.borrow() || paused_items_rx.borrow().contains(item_id) {
        if control.is_canceled() {
            return Err("Upload canceled".to_string());
        }
        tokio::select! {
            r = pause_all_rx.changed() => {
                r.map_err(|_| "Pause channel closed".to_string())?;
            }
            r = paused_items_rx.changed() => {
                r.map_err(|_| "Pause channel closed".to_string())?;
            }
        }
    }

    Ok(())
}
