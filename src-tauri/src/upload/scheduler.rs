use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::watch;

#[derive(Clone)]
pub struct UploadControlHandle {
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
    pub pause_rx: watch::Receiver<bool>,
    pub paused_items_rx: watch::Receiver<HashSet<String>>,
    pub canceled_items_rx: watch::Receiver<HashSet<String>>,
}

impl UploadControlHandle {
    pub fn is_canceled(&self) -> bool {
        self.cancel.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItemInput {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub dest_path: Option<String>,
}

pub async fn wait_if_paused(control: &UploadControlHandle, item_id: &str) -> Result<(), String> {
    if control.is_canceled() {
        return Err("Upload canceled".to_string());
    }

    let mut pause_all_rx = control.pause_rx.clone();
    let mut paused_items_rx = control.paused_items_rx.clone();
    let mut canceled_items_rx = control.canceled_items_rx.clone();

    if canceled_items_rx.borrow().contains(item_id) {
        return Err("Upload canceled".to_string());
    }

    let is_blocked = *pause_all_rx.borrow() || paused_items_rx.borrow().contains(item_id);
    if !is_blocked {
        return Ok(());
    }

    while *pause_all_rx.borrow() || paused_items_rx.borrow().contains(item_id) {
        if control.is_canceled() {
            return Err("Upload canceled".to_string());
        }
        if canceled_items_rx.borrow().contains(item_id) {
            return Err("Upload canceled".to_string());
        }
        tokio::select! {
            r = pause_all_rx.changed() => {
                r.map_err(|_| "Pause channel closed".to_string())?;
            }
            r = paused_items_rx.changed() => {
                r.map_err(|_| "Pause channel closed".to_string())?;
            }
            r = canceled_items_rx.changed() => {
                r.map_err(|_| "Cancel channel closed".to_string())?;
            }
        }
    }

    Ok(())
}
