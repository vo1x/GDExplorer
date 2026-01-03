use crate::upload::drive_client::{DriveClient, DriveFile};
use bytes::Bytes;

#[allow(dead_code)]
pub async fn ensure_destination_folder_access(
    client: &DriveClient,
    destination_folder_id: &str,
) -> Result<(), String> {
    log::info!(
        target: "drive",
        "Preflight starting destination_folder_id={} sa_email={}",
        destination_folder_id,
        client.sa_email()
    );
    let meta = client.get_file_metadata(destination_folder_id).await?;
    let mime = meta
        .mime_type
        .clone()
        .unwrap_or_else(|| "(missing mimeType)".to_string());
    if mime != "application/vnd.google-apps.folder" {
        return Err(format!("Destination is not a folder (mimeType = {mime})"));
    }

    let drive_id_present = meta.drive_id.is_some();
    log::info!(
        target: "drive",
        "Preflight destination mime ok, driveId_present={} driveId={}",
        drive_id_present,
        meta.drive_id.as_deref().unwrap_or("null")
    );
    if !drive_id_present {
        return Err(
            "Service Accounts can only upload to Shared Drives. Please choose a folder inside a Shared Drive."
                .to_string(),
        );
    }

    let test_name = format!("googul-preflight-{}", chrono_like_timestamp());
    // Creating a folder alone may not catch quota / write limitations for service accounts.
    // Use a tiny (1 byte) resumable upload as a "write + quota" check, then delete the created file.
    let upload_url = client
        .start_resumable_upload(
            destination_folder_id,
            &format!("{test_name}.txt"),
            "text/plain",
            1,
        )
        .await
        .map_err(map_preflight_error)?;

    let created = client
        .upload_resumable_chunk(&upload_url, Bytes::from_static(b"x"), 0, 0, 1, true)
        .await
        .map_err(map_preflight_error)?
        .ok_or_else(|| "Preflight upload did not return a file resource".to_string())?;

    client
        .delete_file(&created.id)
        .await
        .map_err(map_preflight_error)?;

    log::info!(target: "drive", "Preflight succeeded");
    Ok(())
}

#[allow(dead_code)]
pub async fn create_unique_folder(
    client: &DriveClient,
    parent_id: &str,
    desired_name: &str,
) -> Result<DriveFile, String> {
    let existing = client.list_child_folders(parent_id).await?;
    let mut names = std::collections::HashSet::new();
    for f in existing {
        if let Some(name) = f.name {
            names.insert(name);
        }
    }

    let mut candidate = desired_name.to_string();
    if names.contains(&candidate) {
        let mut n = 1;
        loop {
            let next = format!("{desired_name} ({n})");
            if !names.contains(&next) {
                candidate = next;
                break;
            }
            n += 1;
        }
    }

    client.create_folder(parent_id, &candidate).await
}

#[allow(dead_code)]
fn chrono_like_timestamp() -> String {
    // Avoid pulling in chrono; stable enough for preflight naming.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    now.to_string()
}

#[allow(dead_code)]
fn map_service_account_quota_error(error: String) -> String {
    if !is_service_account_quota_error(&error) {
        return error;
    }

    format!(
        "Service Accounts do not have storage quota for My Drive uploads. Use a Shared Drive destination, or configure Workspace Domain-Wide Delegation / OAuth delegation to upload as a user. Original error: {error}"
    )
}

#[allow(dead_code)]
fn is_service_account_quota_error(error: &str) -> bool {
    error.contains("storageQuotaExceeded")
        || error.contains("Service Accounts do not have storage quota")
        || error.contains("\"reason\": \"storageQuotaExceeded\"")
}

#[allow(dead_code)]
fn map_preflight_error(error: String) -> String {
    if is_shared_drive_membership_error(&error) {
        return format!(
            "Service Account is not a member of the Shared Drive. Please add it as a Shared Drive member. Original error: {error}"
        );
    }
    map_service_account_quota_error(error)
}

#[allow(dead_code)]
fn is_shared_drive_membership_error(error: &str) -> bool {
    error.contains("teamDriveMembershipRequired")
        || error.contains("sharedDriveMembershipRequired")
        || error.contains("driveMembershipRequired")
        || error.contains("insufficientFilePermissions")
}
