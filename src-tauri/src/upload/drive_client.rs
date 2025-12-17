use crate::upload::sa_loader::ServiceAccount;
use bytes::Bytes;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use reqwest::header::{
    HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, LOCATION,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const DRIVE_API_BASE: &str = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE: &str = "https://www.googleapis.com/upload/drive/v3";

#[derive(Debug, Clone)]
pub struct DriveClient {
    http: reqwest::Client,
    account: ServiceAccount,
    token: Arc<Mutex<Option<CachedToken>>>,
}

#[derive(Debug, Clone)]
struct CachedToken {
    access_token: String,
    expires_at: u64,
}

#[derive(Debug, Serialize)]
struct JwtClaims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    exp: u64,
    iat: u64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
}

impl DriveClient {
    pub fn new(http: reqwest::Client, account: ServiceAccount) -> Self {
        Self {
            http,
            account,
            token: Arc::new(Mutex::new(None)),
        }
    }

    pub fn sa_email(&self) -> &str {
        &self.account.client_email
    }

    async fn get_access_token(&self) -> Result<String, String> {
        let now = now_epoch_seconds();
        {
            let guard = self.token.lock().await;
            if let Some(cached) = guard.as_ref() {
                if cached.expires_at.saturating_sub(60) > now {
                    return Ok(cached.access_token.clone());
                }
            }
        }

        let iat = now;
        let exp = now + 3600;
        let claims = JwtClaims {
            iss: &self.account.client_email,
            scope: DRIVE_SCOPE,
            aud: TOKEN_URL,
            exp,
            iat,
        };

        let mut header = Header::new(Algorithm::RS256);
        header.typ = Some("JWT".to_string());
        let key = EncodingKey::from_rsa_pem(self.account.private_key.as_bytes())
            .map_err(|e| format!("Invalid RSA private key: {e}"))?;
        let assertion =
            encode(&header, &claims, &key).map_err(|e| format!("JWT encode failed: {e}"))?;

        let body = serde_urlencoded::to_string([
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", assertion.as_str()),
        ])
        .map_err(|e| format!("Failed to encode token request: {e}"))?;

        let resp = self
            .http
            .post(TOKEN_URL)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|e| format!("Token request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Token request failed ({status}): {text}"));
        }

        let token_resp: TokenResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse token response: {e}"))?;

        let expires_at = now + token_resp.expires_in;
        let mut guard = self.token.lock().await;
        *guard = Some(CachedToken {
            access_token: token_resp.access_token.clone(),
            expires_at,
        });

        Ok(token_resp.access_token)
    }

    pub async fn authorized_headers(&self) -> Result<HeaderMap, String> {
        let token = self.get_access_token().await?;
        let mut headers = HeaderMap::new();
        let value = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|e| format!("Invalid auth header: {e}"))?;
        headers.insert(AUTHORIZATION, value);
        Ok(headers)
    }

    pub async fn get_file_metadata(&self, file_id: &str) -> Result<DriveFile, String> {
        let headers = self.authorized_headers().await?;
        log::debug!(
            target: "drive",
            "files.get file_id={} supportsAllDrives=true",
            file_id
        );
        let url = format!(
            "{DRIVE_API_BASE}/files/{file_id}?fields=id,name,mimeType,driveId&supportsAllDrives=true"
        );
        let resp = self
            .http
            .get(url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| format!("Drive files.get failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            log::warn!(
                target: "drive",
                "files.get failed file_id={} status={} body={}",
                file_id,
                status,
                text
            );
            return Err(format!("Drive files.get failed ({status}): {text}"));
        }

        resp.json()
            .await
            .map_err(|e| format!("Failed to parse Drive response: {e}"))
    }

    pub async fn delete_file(&self, file_id: &str) -> Result<(), String> {
        let headers = self.authorized_headers().await?;
        log::debug!(
            target: "drive",
            "files.delete file_id={} supportsAllDrives=true",
            file_id
        );
        let url = format!("{DRIVE_API_BASE}/files/{file_id}?supportsAllDrives=true");
        let resp = self
            .http
            .delete(url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| format!("Drive files.delete failed: {e}"))?;

        if resp.status().is_success() {
            return Ok(());
        }

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        log::warn!(
            target: "drive",
            "files.delete failed file_id={} status={} body={}",
            file_id,
            status,
            text
        );
        Err(format!("Drive files.delete failed ({status}): {text}"))
    }

    pub async fn list_child_folders(&self, parent_id: &str) -> Result<Vec<DriveFile>, String> {
        let headers = self.authorized_headers().await?;
        log::debug!(
            target: "drive",
            "files.list parent_id={} supportsAllDrives=true includeItemsFromAllDrives=true corpora=allDrives",
            parent_id
        );

        let q = format!(
            "'{parent_id}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'"
        );
        let url = format!(
            "{DRIVE_API_BASE}/files?fields=files(id,name,mimeType)&q={}&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives",
            urlencoding::encode(&q)
        );

        let resp = self
            .http
            .get(url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| format!("Drive files.list failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            log::warn!(
                target: "drive",
                "files.list failed parent_id={} status={} body={}",
                parent_id,
                status,
                text
            );
            return Err(format!("Drive files.list failed ({status}): {text}"));
        }

        let list: FilesListResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse Drive list response: {e}"))?;

        Ok(list.files.unwrap_or_default())
    }

    pub async fn create_folder(&self, parent_id: &str, name: &str) -> Result<DriveFile, String> {
        let headers = self.authorized_headers().await?;
        log::debug!(
            target: "drive",
            "files.create folder parent_id={} supportsAllDrives=true name={}",
            parent_id,
            name
        );
        let url = format!("{DRIVE_API_BASE}/files?supportsAllDrives=true");
        let body = serde_json::json!({
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id]
        });

        let resp = self
            .http
            .post(url)
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Drive files.create folder failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            log::warn!(
                target: "drive",
                "files.create folder failed parent_id={} status={} body={}",
                parent_id,
                status,
                text
            );
            return Err(format!(
                "Drive files.create folder failed ({status}): {text}"
            ));
        }

        resp.json()
            .await
            .map_err(|e| format!("Failed to parse Drive create folder response: {e}"))
    }

    pub async fn start_resumable_upload(
        &self,
        parent_id: &str,
        name: &str,
        mime_type: &str,
        total_bytes: u64,
    ) -> Result<String, String> {
        let mut headers = self.authorized_headers().await?;
        log::debug!(
            target: "drive",
            "resumable.init parent_id={} supportsAllDrives=true name={} total_bytes={}",
            parent_id,
            name,
            total_bytes
        );
        headers.insert(
            "Content-Type",
            HeaderValue::from_static("application/json; charset=UTF-8"),
        );
        headers.insert(
            "X-Upload-Content-Type",
            HeaderValue::from_str(mime_type).unwrap(),
        );
        headers.insert(
            "X-Upload-Content-Length",
            HeaderValue::from_str(&total_bytes.to_string()).unwrap(),
        );

        let url = format!("{DRIVE_UPLOAD_BASE}/files?uploadType=resumable&supportsAllDrives=true");
        let body = serde_json::json!({
            "name": name,
            "parents": [parent_id]
        });
        log::debug!(
            target: "drive",
            "resumable.init metadata name={} parents=[{}]",
            name,
            parent_id
        );

        let resp = self
            .http
            .post(url)
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Drive resumable init failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            log::warn!(
                target: "drive",
                "resumable.init failed parent_id={} status={} body={}",
                parent_id,
                status,
                text
            );
            return Err(format!("Drive resumable init failed ({status}): {text}"));
        }

        let location = resp
            .headers()
            .get(LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| "Resumable upload missing Location header".to_string())?;

        if let Ok(url) = reqwest::Url::parse(location) {
            log::debug!(
                target: "drive",
                "resumable.init Location ok host={:?} path={}",
                url.host_str(),
                url.path()
            );
        } else {
            log::debug!(
                target: "drive",
                "resumable.init Location ok (unparsed) value={}",
                location
            );
        }

        Ok(location.to_string())
    }

    pub async fn upload_resumable_chunk(
        &self,
        upload_url: &str,
        chunk: Bytes,
        start: u64,
        end_inclusive: u64,
        total: u64,
        is_last: bool,
    ) -> Result<Option<DriveFile>, String> {
        let mut headers = self.authorized_headers().await?;
        log::debug!(
            target: "drive",
            "resumable.chunk start={} end={} total={} is_last={}",
            start,
            end_inclusive,
            total,
            is_last
        );
        headers.insert(
            CONTENT_LENGTH,
            HeaderValue::from_str(&chunk.len().to_string()).unwrap(),
        );
        headers.insert(
            CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end_inclusive}/{total}")).unwrap(),
        );

        let resp = self
            .http
            .put(upload_url)
            .headers(headers)
            .body(chunk)
            .send()
            .await
            .map_err(|e| format!("Drive upload chunk failed: {e}"))?;

        if resp.status().is_success() {
            if is_last {
                let file: DriveFile = resp
                    .json()
                    .await
                    .map_err(|e| format!("Failed to parse upload response: {e}"))?;
                return Ok(Some(file));
            }
            return Ok(None);
        }

        if resp.status().as_u16() == 308 {
            return Ok(None);
        }

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        log::warn!(
            target: "drive",
            "resumable.chunk failed status={} body={}",
            status,
            text
        );
        Err(format!("Drive upload chunk failed ({status}): {text}"))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct DriveFile {
    pub id: String,
    pub name: Option<String>,
    #[serde(rename = "mimeType")]
    pub mime_type: Option<String>,
    #[serde(rename = "driveId")]
    pub drive_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct FilesListResponse {
    files: Option<Vec<DriveFile>>,
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_secs()
}
