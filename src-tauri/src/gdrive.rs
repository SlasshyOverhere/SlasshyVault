//! Google Drive integration module
//! Handles OAuth2 authentication and Google Drive API operations

use crate::archive_manager;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::database::get_app_data_dir;

// Backend auth server URL (handles OAuth securely)
// This keeps client_id and client_secret on the server
const AUTH_SERVER_URL: &str = "https://slasshyvault.onrender.com";

fn get_auth_server_url() -> String {
    if let Ok(env_url) = std::env::var("STREAMVAULT_AUTH_SERVER_URL") {
        let trimmed = env_url.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }

    // Check media_config.json for dev_backend_url override
    let config_path = crate::database::get_app_data_dir().join("media_config.json");
    if let Ok(contents) = std::fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&contents) {
            if let Some(url) = config.get("dev_backend_url").and_then(|v| v.as_str()) {
                let trimmed = url.trim().trim_end_matches('/').to_string();
                if !trimmed.is_empty() {
                    return trimmed;
                }
            }
        }
    }

    AUTH_SERVER_URL.to_string()
}

// Google Drive API
const DRIVE_API_BASE: &str = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API_BASE: &str = "https://www.googleapis.com/upload/drive/v3";
const WATCH_HISTORY_FILE_NAME: &str = "slasshyvault_watch_history_v1.json";
const WATCHLIST_FILE_NAME: &str = "slasshyvault_watchlist_v1.json";

/// Stored OAuth tokens
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>,
    pub token_type: String,
}

/// Google Drive account info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveAccountInfo {
    pub email: String,
    pub display_name: Option<String>,
    pub photo_url: Option<String>,
    pub storage_used: Option<i64>,
    pub storage_limit: Option<i64>,
}

/// Google Drive file/folder item
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveItem {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    #[serde(default)]
    pub size: Option<String>,
    pub modified_time: Option<String>,
    pub parents: Option<Vec<String>>,
    #[serde(default)]
    pub web_content_link: Option<String>,
}

const VIDEO_MIME_TYPES: &[&str] = &[
    "video/mp4",
    "video/x-matroska",
    "video/avi",
    "video/quicktime",
    "video/webm",
    "video/x-m4v",
    "video/x-ms-wmv",
    "video/x-flv",
    "video/mp2t",
];

const ARCHIVE_MIME_TYPES: &[&str] = &[
    "application/zip",
    "application/x-zip-compressed",
    "application/x-rar-compressed",
    "application/vnd.rar",
    "application/x-tar",
    "application/gzip",
];

pub fn is_zip_archive_item(item: &DriveItem) -> bool {
    archive_manager::detect_archive_format(&item.name, Some(&item.mime_type))
        == Some(archive_manager::ArchiveFormat::Zip)
}

pub fn is_supported_archive_item(item: &DriveItem) -> bool {
    matches!(
        archive_manager::detect_archive_format(&item.name, Some(&item.mime_type)),
        Some(archive_manager::ArchiveFormat::Zip | archive_manager::ArchiveFormat::Rar)
    )
}

pub fn is_unsupported_archive_item(item: &DriveItem) -> bool {
    archive_manager::detect_archive_format(&item.name, Some(&item.mime_type))
        == Some(archive_manager::ArchiveFormat::Tar)
}

pub fn is_supported_cloud_media_item(item: &DriveItem) -> bool {
    VIDEO_MIME_TYPES.contains(&item.mime_type.as_str())
        || is_supported_archive_item(item)
        || is_unsupported_archive_item(item)
}

/// Response from Drive API files.list
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveListResponse {
    pub files: Vec<DriveItem>,
    pub next_page_token: Option<String>,
}

/// Response from Drive API changes.list
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveChangesResponse {
    pub changes: Vec<DriveChange>,
    pub new_start_page_token: Option<String>,
    pub next_page_token: Option<String>,
}

/// A single change from the Changes API
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveChange {
    pub kind: Option<String>,
    pub removed: Option<bool>,
    pub file: Option<DriveItem>,
    pub file_id: Option<String>,
    pub change_type: Option<String>,
}

/// Google Drive client state
#[derive(Debug, Clone)]
pub struct GoogleDriveClient {
    tokens: Arc<Mutex<Option<GoogleTokens>>>,
    http_client: reqwest::Client,
}

/// Maximum number of retries for transient Drive API errors (rate limits, 5xx)
const MAX_DRIVE_RETRIES: u32 = 3;

/// Execute a Drive API request with retry logic for rate limits (429) and server errors (5xx)
async fn drive_request_with_retry(
    client: &reqwest::Client,
    request_builder: reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let mut last_error = String::new();
    for attempt in 0..=MAX_DRIVE_RETRIES {
        let response = request_builder
            .try_clone()
            .ok_or("Failed to clone request for retry")?
            .send()
            .await
            .map_err(|e| format!("Drive API request failed: {}", e))?;

        let status = response.status();

        if status.is_success() {
            return Ok(response);
        }

        let error_text = response.text().await.unwrap_or_default();

        // Retry on 429 (rate limit) and 5xx (server errors)
        if status.as_u16() == 429 || status.as_u16() >= 500 {
            if attempt < MAX_DRIVE_RETRIES {
                let delay = std::time::Duration::from_millis(1000 * (2u64.pow(attempt)));
                println!(
                    "[GDRIVE] Rate limit/server error ({}), retrying in {:?}... (attempt {}/{})",
                    status.as_u16(),
                    delay,
                    attempt + 1,
                    MAX_DRIVE_RETRIES
                );
                tokio::time::sleep(delay).await;
                last_error = format!("Drive API error: {} (attempt {})", error_text, attempt + 1);
                continue;
            }
        }

        return Err(format!("Drive API error: {}", error_text));
    }

    Err(format!(
        "Drive API failed after {} retries: {}",
        MAX_DRIVE_RETRIES, last_error
    ))
}

impl GoogleDriveClient {
    pub fn new() -> Self {
        let tokens_path = get_tokens_path();
        let tokens = match load_tokens() {
            Ok(t) => Some(t),
            Err(e) => {
                if tokens_path.exists() {
                    eprintln!("[GDRIVE] Warning: Failed to load tokens (file exists but corrupted): {}. User will need to re-authenticate.", e);
                }
                None
            }
        };
        Self {
            tokens: Arc::new(Mutex::new(tokens)),
            http_client: reqwest::Client::builder()
                .user_agent("SlasshyVault/3.0.40")
                .build()
                .expect("Failed to build reqwest client"),
        }
    }

    /// Check if user is authenticated
    pub fn is_authenticated(&self) -> bool {
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// Validate that stored tokens are actually usable.
    /// Checks expiry and attempts refresh if expired. Returns false if
    /// tokens are missing or expired with no refresh token available.
    pub async fn validate_tokens(&self) -> bool {
        let tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner()).clone();
        match tokens {
            Some(t) => {
                // If we have an expiry, check it
                if let Some(expires_at) = t.expires_at {
                    let now = chrono::Utc::now().timestamp();
                    if now >= expires_at - 60 {
                        // Token expired — try to refresh
                        if let Some(refresh_token) = &t.refresh_token {
                            return self.refresh_access_token(refresh_token).await.is_ok();
                        }
                        return false;
                    }
                }
                // No expiry info but tokens exist — assume valid
                true
            }
            None => false,
        }
    }

    /// Get the current access token, refreshing if needed
    pub async fn get_access_token(&self) -> Result<String, String> {
        let tokens = self
            .tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();

        match tokens {
            Some(t) => {
                // Check if token is expired
                if let Some(expires_at) = t.expires_at {
                    let now = chrono::Utc::now().timestamp();
                    if now >= expires_at - 60 {
                        // Token expired or about to expire, refresh it
                        if let Some(refresh_token) = &t.refresh_token {
                            return self.refresh_access_token(refresh_token).await;
                        }
                        return Err("Token expired and no refresh token available".to_string());
                    }
                }
                Ok(t.access_token)
            }
            None => Err("Not authenticated".to_string()),
        }
    }

    /// Refresh the access token via backend proxy
    async fn refresh_access_token(&self, refresh_token: &str) -> Result<String, String> {
        let response = self
            .http_client
            .post(format!("{}/auth/refresh", get_auth_server_url()))
            .json(&serde_json::json!({
                "refresh_token": refresh_token
            }))
            .send()
            .await
            .map_err(|e| format!("Failed to refresh token: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("Token refresh failed: {}", error_text));
        }

        let token_response: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse token response: {}", e))?;

        let access_token = token_response["access_token"]
            .as_str()
            .ok_or("Missing access_token in response")?
            .to_string();

        let expires_in = token_response["expires_in"].as_i64().unwrap_or(3600);
        let expires_at = chrono::Utc::now().timestamp() + expires_in;

        // Update stored tokens
        let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref mut t) = *tokens {
            t.access_token = access_token.clone();
            t.expires_at = Some(expires_at);
            save_tokens(t).ok();
        }

        Ok(access_token)
    }

    /// Store tokens after successful authentication
    pub fn store_tokens(&self, tokens: GoogleTokens) -> Result<(), String> {
        save_tokens(&tokens)?;
        *self.tokens.lock().unwrap_or_else(|e| e.into_inner()) = Some(tokens);
        Ok(())
    }

    /// Revoke tokens with Google, then clear local state (logout)
    pub async fn revoke_and_clear_tokens(&self) -> Result<(), String> {
        // Try to revoke the refresh token first (more important to revoke)
        let tokens_snapshot = self.tokens.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(ref t) = tokens_snapshot {
            let token_to_revoke = t.refresh_token.as_deref().unwrap_or(&t.access_token);
            let _ = self
                .http_client
                .post(format!(
                    "https://oauth2.googleapis.com/revoke?token={}",
                    token_to_revoke
                ))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .send()
                .await;
            // Ignore revocation errors - we still want to clear local state
        }

        // Clear local tokens
        *self.tokens.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let path = get_tokens_path();
        if path.exists() {
            fs::remove_file(path).map_err(|e| format!("Failed to remove tokens: {}", e))?;
        }
        Ok(())
    }

    /// List files in a folder
    pub async fn list_files(
        &self,
        folder_id: Option<&str>,
        page_token: Option<&str>,
    ) -> Result<DriveListResponse, String> {
        let access_token = self.get_access_token().await?;

        let parent = folder_id.unwrap_or("root");
        let query = format!("'{}' in parents and trashed = false", parent);

        let mut url = format!(
            "{}/files?q={}&fields=files(id,name,mimeType,size,modifiedTime,parents,webContentLink),nextPageToken&pageSize=100&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true",
            DRIVE_API_BASE,
            urlencoding::encode(&query)
        );

        if let Some(token) = page_token {
            url.push_str(&format!("&pageToken={}", token));
        }

        let response = self
            .http_client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| format!("Failed to list files: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("Drive API error: {}", error_text));
        }

        response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))
    }

    /// List only folders
    pub async fn list_folders(&self, parent_id: Option<&str>) -> Result<Vec<DriveItem>, String> {
        let access_token = self.get_access_token().await?;

        let parent = parent_id.unwrap_or("root");
        let query = format!(
            "'{}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            parent
        );

        let url = format!(
            "{}/files?q={}&fields=files(id,name,mimeType,modifiedTime,parents)&pageSize=100&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true",
            DRIVE_API_BASE,
            urlencoding::encode(&query)
        );

        let response = self
            .http_client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| format!("Failed to list folders: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("Drive API error: {}", error_text));
        }

        let result: DriveListResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        Ok(result.files)
    }

    /// List video files in a folder (recursive option)
    pub async fn list_video_files(
        &self,
        folder_id: &str,
        recursive: bool,
    ) -> Result<Vec<DriveItem>, String> {
        let access_token = self.get_access_token().await?;

        let mime_conditions: Vec<String> = VIDEO_MIME_TYPES
            .iter()
            .chain(ARCHIVE_MIME_TYPES.iter())
            .map(|m| format!("mimeType = '{}'", m))
            .collect();

        let query = format!(
            "'{}' in parents and (({}) or name contains '.zip' or name contains '.ZIP' or name contains '.rar' or name contains '.RAR' or name contains '.tar' or name contains '.TAR' or name contains '.tgz' or name contains '.TGZ') and trashed = false",
            folder_id,
            mime_conditions.join(" or ")
        );

        let mut all_files = Vec::new();
        let mut page_token: Option<String> = None;

        loop {
            let mut url = format!(
                "{}/files?q={}&fields=files(id,name,mimeType,size,modifiedTime,parents,webContentLink),nextPageToken&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true",
                DRIVE_API_BASE,
                urlencoding::encode(&query)
            );

            if let Some(ref token) = page_token {
                url.push_str(&format!("&pageToken={}", token));
            }

            let response = self
                .http_client
                .get(&url)
                .header("Authorization", format!("Bearer {}", access_token))
                .send()
                .await
                .map_err(|e| format!("Failed to list video files: {}", e))?;

            if !response.status().is_success() {
                let error_text = response.text().await.unwrap_or_default();
                return Err(format!("Drive API error: {}", error_text));
            }

            let result: DriveListResponse = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {}", e))?;

            all_files.extend(result.files);

            if let Some(next_token) = result.next_page_token {
                page_token = Some(next_token);
            } else {
                break;
            }
        }

        // If recursive, also scan subfolders
        if recursive {
            let subfolders = self.list_folders(Some(folder_id)).await?;
            for folder in subfolders {
                let subfolder_files = Box::pin(self.list_video_files(&folder.id, true)).await?;
                all_files.extend(subfolder_files);
            }
        }

        Ok(all_files)
    }

    /// Get a streaming URL for a file (with auth header)
    pub async fn get_stream_url(&self, file_id: &str) -> Result<(String, String), String> {
        let access_token = self.get_access_token().await?;
        let url = self.build_stream_url(file_id);
        Ok((url, access_token))
    }

    pub fn build_stream_url(&self, file_id: &str) -> String {
        format!(
            "{}/files/{}?alt=media&supportsAllDrives=true",
            DRIVE_API_BASE, file_id
        )
    }

    async fn find_sync_file_id(&self, file_name: &str) -> Result<Option<String>, String> {
        let access_token = self.get_access_token().await?;
        let query = format!("name='{}' and trashed = false", file_name);
        let url = format!(
            "{}/files?q={}&fields=files(id,name,mimeType)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=modifiedTime desc",
            DRIVE_API_BASE,
            urlencoding::encode(&query)
        );

        let response = self
            .http_client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| format!("Failed to search sync file: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("Drive API search error: {}", error_text));
        }

        let result: DriveListResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse sync file search response: {}", e))?;

        Ok(result.files.first().map(|f| f.id.clone()))
    }

    async fn create_sync_file(&self, file_name: &str, mime_type: &str) -> Result<String, String> {
        let access_token = self.get_access_token().await?;

        let response = self
            .http_client
            .post(format!("{}/files?fields=id", DRIVE_API_BASE))
            .header("Authorization", format!("Bearer {}", access_token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "name": file_name,
                "mimeType": mime_type
            }))
            .send()
            .await
            .map_err(|e| format!("Failed to create sync file: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("Drive API create file error: {}", error_text));
        }

        let data: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse create file response: {}", e))?;

        data["id"]
            .as_str()
            .map(|id| id.to_string())
            .ok_or_else(|| "Missing file id in create file response".to_string())
    }

    pub async fn load_watch_history_snapshot(&self) -> Result<Option<String>, String> {
        let file_id = match self.find_sync_file_id(WATCH_HISTORY_FILE_NAME).await? {
            Some(id) => id,
            None => return Ok(None),
        };

        let access_token = self.get_access_token().await?;
        let response = self
            .http_client
            .get(format!(
                "{}/files/{}?alt=media&supportsAllDrives=true",
                DRIVE_API_BASE, file_id
            ))
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| format!("Failed to download watch history snapshot: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!(
                "Drive API download watch history snapshot error: {}",
                error_text
            ));
        }

        let text = response
            .text()
            .await
            .map_err(|e| format!("Failed to read watch history snapshot response: {}", e))?;

        Ok(Some(text))
    }

    pub async fn save_watch_history_snapshot(&self, history_json: &str) -> Result<(), String> {
        serde_json::from_str::<serde_json::Value>(history_json)
            .map_err(|e| format!("Invalid watch history snapshot JSON: {}", e))?;

        let file_id = match self.find_sync_file_id(WATCH_HISTORY_FILE_NAME).await? {
            Some(id) => id,
            None => {
                self.create_sync_file(WATCH_HISTORY_FILE_NAME, "application/json")
                    .await?
            }
        };

        let access_token = self.get_access_token().await?;
        let response = self
            .http_client
            .patch(format!(
                "{}/files/{}?uploadType=media",
                DRIVE_UPLOAD_API_BASE, file_id
            ))
            .header("Authorization", format!("Bearer {}", access_token))
            .header("Content-Type", "application/json")
            .body(history_json.to_string())
            .send()
            .await
            .map_err(|e| format!("Failed to upload watch history snapshot: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!(
                "Drive API upload watch history snapshot error: {}",
                error_text
            ));
        }

        Ok(())
    }

    pub async fn load_watchlist_snapshot(&self) -> Result<Option<String>, String> {
        let file_id = match self.find_sync_file_id(WATCHLIST_FILE_NAME).await? {
            Some(id) => id,
            None => return Ok(None),
        };

        let access_token = self.get_access_token().await?;
        let response = self
            .http_client
            .get(format!(
                "{}/files/{}?alt=media&supportsAllDrives=true",
                DRIVE_API_BASE, file_id
            ))
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| format!("Failed to download watchlist snapshot: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!(
                "Drive API download watchlist snapshot error: {}",
                error_text
            ));
        }

        let text = response
            .text()
            .await
            .map_err(|e| format!("Failed to read watchlist snapshot response: {}", e))?;

        Ok(Some(text))
    }

    pub async fn save_watchlist_snapshot(&self, watchlist_json: &str) -> Result<(), String> {
        serde_json::from_str::<serde_json::Value>(watchlist_json)
            .map_err(|e| format!("Invalid watchlist snapshot JSON: {}", e))?;

        let file_id = match self.find_sync_file_id(WATCHLIST_FILE_NAME).await? {
            Some(id) => id,
            None => {
                self.create_sync_file(WATCHLIST_FILE_NAME, "application/json")
                    .await?
            }
        };

        let access_token = self.get_access_token().await?;
        let response = self
            .http_client
            .patch(format!(
                "{}/files/{}?uploadType=media",
                DRIVE_UPLOAD_API_BASE, file_id
            ))
            .header("Authorization", format!("Bearer {}", access_token))
            .header("Content-Type", "application/json")
            .body(watchlist_json.to_string())
            .send()
            .await
            .map_err(|e| format!("Failed to upload watchlist snapshot: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!(
                "Drive API upload watchlist snapshot error: {}",
                error_text
            ));
        }

        Ok(())
    }

    /// Get file metadata
    pub async fn get_file_metadata(&self, file_id: &str) -> Result<DriveItem, String> {
        let access_token = self.get_access_token().await?;

        let url = format!(
            "{}/files/{}?fields=id,name,mimeType,size,modifiedTime,parents,webContentLink&supportsAllDrives=true",
            DRIVE_API_BASE, file_id
        );

        let response = self
            .http_client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| format!("Failed to get file metadata: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("Drive API error: {}", error_text));
        }

        response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))
    }

    /// Create a permission (share) for a file with a specific user
    pub async fn create_permission(
        &self,
        file_id: &str,
        email: &str,
        role: &str,
    ) -> Result<(), String> {
        let access_token = self.get_access_token().await?;

        let url = format!(
            "{}/files/{}/permissions?supportsAllDrives=true&sendNotificationEmail=true",
            DRIVE_API_BASE, file_id
        );

        let response = self
            .http_client
            .post(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "type": "user",
                "role": role,
                "emailAddress": email
            }))
            .send()
            .await
            .map_err(|e| format!("Failed to share file: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("Drive API share error: {}", error_text));
        }

        println!(
            "[GDRIVE] Successfully shared file {} with {} (role: {})",
            file_id, email, role
        );
        Ok(())
    }

    /// Delete a file from Google Drive
    pub async fn delete_file(&self, file_id: &str) -> Result<(), String> {
        let access_token = self.get_access_token().await?;

        let url = format!(
            "{}/files/{}?supportsAllDrives=true",
            DRIVE_API_BASE, file_id
        );

        let response = self
            .http_client
            .delete(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| format!("Failed to delete file: {}", e))?;

        // Google Drive API returns 204 No Content on successful deletion
        if response.status().is_success() || response.status().as_u16() == 204 {
            println!("[GDRIVE] Successfully deleted file: {}", file_id);
            Ok(())
        } else {
            let error_text = response.text().await.unwrap_or_default();
            Err(format!("Drive API delete error: {}", error_text))
        }
    }

    /// Get account info
    pub async fn get_account_info(&self) -> Result<DriveAccountInfo, String> {
        let access_token = self.get_access_token().await?;

        // Get user info
        let user_url = "https://www.googleapis.com/oauth2/v2/userinfo";
        let user_response = self
            .http_client
            .get(user_url)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| format!("Failed to get user info: {}", e))?;

        if !user_response.status().is_success() {
            let error_text = user_response.text().await.unwrap_or_default();
            return Err(format!("User info API error: {}", error_text));
        }

        let user_info: serde_json::Value = user_response
            .json()
            .await
            .map_err(|e| format!("Failed to parse user info: {}", e))?;

        // Get storage quota
        let quota_url = format!("{}/about?fields=storageQuota,user", DRIVE_API_BASE);
        let quota_response = self
            .http_client
            .get(&quota_url)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .ok();

        let (storage_used, storage_limit) = if let Some(resp) = quota_response {
            if let Ok(quota_info) = resp.json::<serde_json::Value>().await {
                let used = quota_info["storageQuota"]["usage"]
                    .as_str()
                    .and_then(|s| s.parse().ok());
                let limit = quota_info["storageQuota"]["limit"]
                    .as_str()
                    .and_then(|s| s.parse().ok());
                (used, limit)
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

        Ok(DriveAccountInfo {
            email: user_info["email"].as_str().unwrap_or("").to_string(),
            display_name: user_info["name"].as_str().map(String::from),
            photo_url: user_info["picture"].as_str().map(String::from),
            storage_used,
            storage_limit,
        })
    }

    // ==================== Changes API (Efficient Delta Sync) ====================

    /// Get the start page token for tracking changes
    /// Call this once when setting up change tracking
    pub async fn get_changes_start_token(&self) -> Result<String, String> {
        let access_token = self.get_access_token().await?;

        let url = format!("{}/changes/startPageToken?supportsAllDrives=true&includeItemsFromAllDrives=true", DRIVE_API_BASE);

        let response = self
            .http_client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| format!("Failed to get start page token: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("Drive API error: {}", error_text));
        }

        let result: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        result["startPageToken"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| "Missing startPageToken in response".to_string())
    }

    /// Get changes since the given page token
    /// Returns new/modified files and a new token for the next check
    pub async fn get_changes(&self, page_token: &str) -> Result<DriveChangesResponse, String> {
        let access_token = self.get_access_token().await?;

        let url = format!(
            "{}/changes?pageToken={}&fields=changes(fileId,removed,file(id,name,mimeType,size,modifiedTime,parents)),newStartPageToken,nextPageToken&pageSize=100&includeRemoved=true&spaces=drive&supportsAllDrives=true&includeItemsFromAllDrives=true",
            DRIVE_API_BASE,
            page_token
        );

        let response = self
            .http_client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| format!("Failed to get changes: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("Drive API error: {}", error_text));
        }

        response
            .json()
            .await
            .map_err(|e| format!("Failed to parse changes response: {}", e))
    }

    /// Check for new video files since last token
    /// Returns (new_video_files, removed_file_ids, new_token)
    pub async fn get_video_changes(
        &self,
        page_token: &str,
    ) -> Result<(Vec<DriveItem>, Vec<String>, String), String> {
        let mut all_video_files = Vec::new();
        let mut removed_file_ids = Vec::new();
        let mut current_token = page_token.to_string();

        loop {
            let changes = self.get_changes(&current_token).await?;

            // Collect removed file IDs and filter for added/changed video files
            for change in changes.changes {
                if change.removed.unwrap_or(false) {
                    if let Some(file_id) = change.file_id {
                        removed_file_ids.push(file_id);
                    }
                    continue;
                }

                if let Some(file) = change.file {
                    if is_supported_cloud_media_item(&file) {
                        all_video_files.push(file);
                    }
                }
            }

            // Check if we need to paginate
            if let Some(next_token) = changes.next_page_token {
                current_token = next_token;
            } else if let Some(new_token) = changes.new_start_page_token {
                // No more pages, return the new token for next time
                return Ok((all_video_files, removed_file_ids, new_token));
            } else {
                // Shouldn't happen, but use current token as fallback
                return Ok((all_video_files, removed_file_ids, current_token));
            }
        }
    }

    /// Recursively list all descendant folder IDs under a given parent folder.
    /// This is used to determine which files belong to tracked folders (including subfolders).
    pub async fn list_all_folder_ids(&self, folder_id: &str) -> Result<std::collections::HashSet<String>, String> {
        let access_token = self.get_access_token().await?;
        let mut all_ids = std::collections::HashSet::new();
        let mut page_token: Option<String> = None;

        all_ids.insert(folder_id.to_string());

        loop {
            let mut url = format!(
                "{}/files?q=%27{}%27+in+parents+and+mimeType=%27application/vnd.google-apps.folder%27&fields=nextPageToken,files(id)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true",
                DRIVE_API_BASE,
                folder_id
            );
            if let Some(ref pt) = page_token {
                url.push_str(&format!("&pageToken={}", pt));
            }

            let response = self
                .http_client
                .get(&url)
                .header("Authorization", format!("Bearer {}", access_token))
                .send()
                .await
                .map_err(|e| format!("Failed to list subfolders: {}", e))?;

            if !response.status().is_success() {
                let error_text = response.text().await.unwrap_or_default();
                return Err(format!("Drive API error listing subfolders: {}", error_text));
            }

            let result: serde_json::Value = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse subfolder response: {}", e))?;

            if let Some(files) = result["files"].as_array() {
                for file in files {
                    if let Some(id) = file["id"].as_str() {
                        if all_ids.insert(id.to_string()) {
                            // Recursively get subfolders of this folder
                            match Box::pin(self.list_all_folder_ids(id)).await {
                                Ok(descendant_ids) => {
                                    all_ids.extend(descendant_ids);
                                }
                                Err(e) => {
                                    println!("[GDRIVE] Warning: failed to list subfolders for {id}: {e}");
                                }
                            }
                        }
                    }
                }
            }

            match result["nextPageToken"].as_str() {
                Some(pt) => page_token = Some(pt.to_string()),
                None => break,
            }
        }

        Ok(all_ids)
    }
}

// ==================== OAuth Flow ====================

/// Generate the OAuth authorization URL (via backend proxy), with a CSRF nonce
pub fn get_auth_url_with_nonce(nonce: &str) -> String {
    format!("{}/auth/google?nonce={}", get_auth_server_url(), urlencoding::encode(nonce))
}

/// Bind the OAuth callback listener BEFORE opening the browser
/// so it's ready when the backend redirect comes back
/// Uses SO_REUSEADDR to allow quick rebinding when the user retries auth
/// (prevents EADDRINUSE from TIME_WAIT on Windows)
pub async fn start_oauth_listener() -> Result<tokio::net::TcpListener, String> {
    let address: std::net::SocketAddr = "127.0.0.1:8085"
        .parse()
        .map_err(|e| format!("Invalid address: {}", e))?;

    let socket = socket2::Socket::new(
        socket2::Domain::IPV4,
        socket2::Type::STREAM,
        Some(socket2::Protocol::TCP),
    )
    .map_err(|e| format!("Failed to create socket: {}", e))?;

    socket
        .set_reuse_address(true)
        .map_err(|e| format!("Failed to set SO_REUSEADDR: {}", e))?;

    socket
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to set nonblocking: {}", e))?;

    socket
        .bind(&address.into())
        .map_err(|e| format!("Failed to start OAuth callback server: {}", e))?;

    socket
        .listen(1024)
        .map_err(|e| format!("Failed to listen on OAuth callback socket: {}", e))?;

    let std_listener: TcpListener = socket.into();

    let listener = tokio::net::TcpListener::from_std(std_listener)
        .map_err(|e| format!("Failed to create async listener: {}", e))?;
    println!("[GDRIVE] OAuth callback server listening on port 8085");
    Ok(listener)
}

/// Wait for OAuth callback on an already-bound listener
/// The backend exchanges the code, stores tokens server-side with a session ID,
/// then redirects here with: /callback?session_id=<uuid>
/// We then fetch the tokens from the backend using that session ID.
pub async fn wait_for_oauth_callback_with_nonce(
    listener: &tokio::net::TcpListener,
    expected_nonce: Option<&str>,
) -> Result<GoogleTokens, String> {
    println!("[GDRIVE] Waiting for OAuth callback...");

    // Accept one connection (async, cancellable)
    let (tokio_stream, _) = listener
        .accept()
        .await
        .map_err(|e| format!("Failed to accept OAuth callback: {}", e))?;
    // Convert to std stream for synchronous I/O
    let mut stream = tokio_stream
        .into_std()
        .map_err(|e| format!("Failed to convert stream: {}", e))?;

    // The tokio stream is non-blocking; set to blocking mode so BufReader works
    stream
        .set_nonblocking(false)
        .map_err(|e| format!("Failed to set stream to blocking mode: {}", e))?;

    // Helper: send an HTTP response to the browser (best-effort)
    let send_http = |stream: &mut std::net::TcpStream, status: &str, body: &str| {
        let response = format!(
            "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            status,
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    };

    // Helper: error HTML page (SlasshyVault dark glassmorphism aesthetic)
    let error_page = |title: &str, message: &str| -> String {
        format!(r#"<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>SlasshyVault - {}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  *{{margin:0;padding:0;box-sizing:border-box}}
  body{{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    display:flex;justify-content:center;align-items:center;height:100vh;
    background:#0a0a0a;color:#fafafa;overflow:hidden;position:relative}}
  body::before{{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;
    background:radial-gradient(circle at 30% 20%,rgba(229,62,62,0.06) 0%,transparent 50%),
    radial-gradient(circle at 70% 80%,rgba(229,62,62,0.04) 0%,transparent 50%);
    pointer-events:none}}
  .card{{position:relative;background:rgba(18,18,18,0.8);backdrop-filter:blur(40px) saturate(180%);
    border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:48px 56px;
    text-align:center;max-width:420px;width:90%;
    box-shadow:0 0 80px rgba(229,62,62,0.08),0 20px 60px rgba(0,0,0,0.5)}}
  .icon-wrap{{width:56px;height:56px;border-radius:14px;margin:0 auto 20px;
    background:rgba(229,62,62,0.12);border:1px solid rgba(229,62,62,0.2);
    display:flex;align-items:center;justify-content:center}}
  .icon-wrap svg{{width:28px;height:28px;color:#e53e3e}}
  h1{{font-size:20px;font-weight:700;color:#fafafa;letter-spacing:-0.02em;margin-bottom:8px}}
  .msg{{font-size:14px;color:#8c8c8c;line-height:1.6;margin-bottom:24px}}
  .hint{{font-size:12px;color:#555;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06)}}
  .logo{{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);
    font-size:11px;font-weight:600;color:rgba(255,255,255,0.15);letter-spacing:0.08em;text-transform:uppercase}}
</style></head>
<body>
  <div class="card">
    <div class="icon-wrap">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"/>
      </svg>
    </div>
    <h1>{}</h1>
    <p class="msg">{}</p>
    <p class="hint">You can close this window and try again.</p>
  </div>
  <div class="logo">SlasshyVault</div>
</body></html>"#, title, title, message)
    };

    // Helper: success HTML page (SlasshyVault dark glassmorphism aesthetic)
    let success_page = || -> String {
        r#"<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>SlasshyVault - Connected</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    display:flex;justify-content:center;align-items:center;height:100vh;
    background:#0a0a0a;color:#fafafa;overflow:hidden;position:relative}
  body::before{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;
    background:radial-gradient(circle at 30% 20%,rgba(255,255,255,0.04) 0%,transparent 50%),
    radial-gradient(circle at 70% 80%,rgba(255,255,255,0.03) 0%,transparent 50%);
    pointer-events:none}
  .orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:0.06;pointer-events:none}
  .orb-1{width:300px;height:300px;background:#fff;top:10%;left:15%;animation:float 25s ease-in-out infinite}
  .orb-2{width:250px;height:250px;background:#fff;bottom:15%;right:10%;animation:float 25s ease-in-out infinite reverse}
  @keyframes float{0%,100%{transform:translate(0,0)}50%{transform:translate(30px,-30px)}}
  .card{position:relative;background:rgba(18,18,18,0.8);backdrop-filter:blur(40px) saturate(180%);
    border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:48px 56px;
    text-align:center;max-width:420px;width:90%;
    box-shadow:0 0 60px rgba(255,255,255,0.05),0 20px 60px rgba(0,0,0,0.5);
    animation:cardIn 0.5s cubic-bezier(0.16,1,0.3,1) forwards;opacity:0;transform:translateY(12px)}
  @keyframes cardIn{to{opacity:1;transform:translateY(0)}}
  .icon-wrap{width:56px;height:56px;border-radius:14px;margin:0 auto 20px;
    background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 0 30px rgba(255,255,255,0.06)}
  .icon-wrap svg{width:28px;height:28px;color:#fafafa}
  .checkmark{animation:checkPop 0.4s cubic-bezier(0.16,1,0.3,1) 0.3s forwards;opacity:0;transform:scale(0.5)}
  @keyframes checkPop{to{opacity:1;transform:scale(1)}}
  h1{font-size:20px;font-weight:700;color:#fafafa;letter-spacing:-0.02em;margin-bottom:8px}
  .msg{font-size:14px;color:#8c8c8c;line-height:1.6}
  .logo{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);
    font-size:11px;font-weight:600;color:rgba(255,255,255,0.15);letter-spacing:0.08em;text-transform:uppercase}
</style></head>
<body>
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>
  <div class="card">
    <div class="icon-wrap">
      <svg class="checkmark" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5"/>
      </svg>
    </div>
    <h1>Connected</h1>
    <p class="msg">Google Drive linked successfully.<br>You can close this window and return to SlasshyVault.</p>
  </div>
  <div class="logo">SlasshyVault</div>
</body></html>"#.to_string()
    };

    // Read the HTTP request
    let buf_reader = BufReader::new(&stream);
    let request_line = buf_reader
        .lines()
        .next()
        .ok_or("No request received")?
        .map_err(|e| format!("Failed to read request: {}", e))?;

    // Log only that we received a callback (without exposing query params/tokens)
    let safe_line = request_line
        .split(' ')
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    println!("[GDRIVE] Received callback: {}", safe_line);

    // Parse query parameters from the request path
    let path = match request_line.split_whitespace().nth(1) {
        Some(p) => p,
        None => {
            send_http(&mut stream, "400 Bad Request", &error_page("Invalid Request", "Could not parse request path."));
            return Err("Invalid request line".to_string());
        }
    };

    // Check for error from backend
    if path.contains("error=") {
        let query_start = match path.find('?') {
            Some(qs) => qs,
            None => {
                send_http(&mut stream, "400 Bad Request", &error_page("Invalid Callback", "Error present but no query string."));
                return Err("No query string".to_string());
            }
        };
        let query = &path[query_start + 1..];
        let params: HashMap<&str, &str> = query
            .split('&')
            .filter_map(|pair| {
                let mut parts = pair.splitn(2, '=');
                Some((parts.next()?, parts.next()?))
            })
            .collect();

        let error = params.get("error").unwrap_or(&"unknown_error");
        println!("[GDRIVE] OAuth error from backend: {}", error);
        send_http(&mut stream, "400 Bad Request", &error_page("OAuth Error", &format!("The authentication server returned an error: {}", error)));
        return Err(format!("OAuth error: {}", error));
    }

    let query_start = match path.find('?') {
        Some(qs) => qs,
        None => {
            send_http(&mut stream, "400 Bad Request", &error_page("Invalid Callback", "No query string in callback URL."));
            return Err("No query string in callback URL".to_string());
        }
    };
    let query = &path[query_start + 1..];

    let params: HashMap<&str, &str> = query
        .split('&')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            Some((parts.next()?, parts.next()?))
        })
        .collect();

    // CSRF verification: check that the nonce matches what we sent
    if let Some(expected) = expected_nonce {
        match params.get("nonce") {
            Some(received) if *received == expected => {
                // Nonce matches — callback was initiated by this instance
                println!("[GDRIVE] CSRF nonce verified OK");
            }
            Some(received) => {
                println!("[GDRIVE] CSRF nonce mismatch: expected={}, received={}", expected, received);
                send_http(&mut stream, "403 Forbidden", &error_page("Security Error", "Nonce mismatch — this login attempt may have been tampered with."));
                return Err("CSRF nonce mismatch — possible OAuth session fixation attack".to_string());
            }
            None => {
                // Backend doesn't support nonces yet (old deployment) — warn but allow
                println!("[GDRIVE] WARNING: Callback missing nonce (backend may not be updated yet) — skipping CSRF check");
            }
        }
    }

    // Resolve tokens: either from session_id or legacy tokens param
    let tokens = if let Some(session_id) = params.get("session_id") {
        println!("[GDRIVE] Fetching tokens for session...");
        let auth_url = get_auth_server_url();
        let session_url = format!("{}/auth/session/{}", auth_url, session_id);
        let response = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
        {
            Ok(client) => match client.get(&session_url).send().await {
                Ok(resp) => resp,
                Err(e) => {
                    let msg = format!("Failed to fetch session tokens: {}", e);
                    println!("[GDRIVE] {}", msg);
                    send_http(&mut stream, "502 Bad Gateway", &error_page("Token Fetch Failed", "Could not reach the authentication server to retrieve tokens."));
                    return Err(msg);
                }
            },
            Err(e) => {
                let msg = format!("Failed to build HTTP client: {}", e);
                send_http(&mut stream, "500 Internal Server Error", &error_page("Internal Error", "Failed to create HTTP client."));
                return Err(msg);
            }
        };

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            let msg = format!("Session token fetch failed ({}): {}", status, error_text);
            println!("[GDRIVE] {}", msg);
            send_http(&mut stream, "502 Bad Gateway", &error_page("Token Fetch Failed", &format!("Server returned an error. Session may have expired.")));
            return Err(msg);
        }

        let token_data: serde_json::Value = match response.json().await {
            Ok(data) => data,
            Err(e) => {
                let msg = format!("Failed to parse session tokens: {}", e);
                println!("[GDRIVE] {}", msg);
                send_http(&mut stream, "502 Bad Gateway", &error_page("Token Parse Error", "Received invalid token data from the authentication server."));
                return Err(msg);
            }
        };

        let access_token = match token_data["access_token"].as_str() {
            Some(t) => t.to_string(),
            None => {
                send_http(&mut stream, "502 Bad Gateway", &error_page("Token Error", "Server response missing access token."));
                return Err("Missing access_token".to_string());
            }
        };

        let refresh_token = token_data["refresh_token"].as_str().map(String::from);

        let expires_in = token_data["expires_in"].as_i64().unwrap_or(3600);
        let expires_at = chrono::Utc::now().timestamp() + expires_in;

        let token_type = token_data["token_type"]
            .as_str()
            .unwrap_or("Bearer")
            .to_string();

        println!("[GDRIVE] Tokens received successfully from session");

        GoogleTokens {
            access_token,
            refresh_token,
            expires_at: Some(expires_at),
            token_type,
        }
    } else if let Some(tokens_b64) = params.get("tokens") {
        // Legacy flow: tokens are base64-encoded in the URL
        println!("[GDRIVE] Decoding tokens from callback URL...");
        let tokens_json = match base64::engine::general_purpose::STANDARD.decode(tokens_b64) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(s) => s,
                Err(e) => {
                    send_http(&mut stream, "400 Bad Request", &error_page("Token Error", "Invalid token encoding."));
                    return Err(format!("Invalid UTF-8 in tokens: {}", e));
                }
            },
            Err(e) => {
                send_http(&mut stream, "400 Bad Request", &error_page("Token Error", "Could not decode token data."));
                return Err(format!("Failed to decode tokens: {}", e));
            }
        };

        let token_data: serde_json::Value = match serde_json::from_str(&tokens_json) {
            Ok(data) => data,
            Err(e) => {
                send_http(&mut stream, "400 Bad Request", &error_page("Token Error", "Invalid token JSON."));
                return Err(format!("Failed to parse tokens JSON: {}", e));
            }
        };

        let access_token = match token_data["access_token"].as_str() {
            Some(t) => t.to_string(),
            None => {
                send_http(&mut stream, "400 Bad Request", &error_page("Token Error", "Token data missing access token."));
                return Err("Missing access_token".to_string());
            }
        };

        let refresh_token = token_data["refresh_token"].as_str().map(String::from);

        let expires_in = token_data["expires_in"].as_i64().unwrap_or(3600);
        let expires_at = chrono::Utc::now().timestamp() + expires_in;

        let token_type = token_data["token_type"]
            .as_str()
            .unwrap_or("Bearer")
            .to_string();

        GoogleTokens {
            access_token,
            refresh_token,
            expires_at: Some(expires_at),
            token_type,
        }
    } else {
        send_http(&mut stream, "400 Bad Request", &error_page("Invalid Callback", "No session_id or tokens in callback URL."));
        return Err("No session_id or tokens in callback URL".to_string());
    };

    // Send a success response
    let response_body = success_page();
    send_http(&mut stream, "200 OK", &response_body);
    println!("[GDRIVE] Auth callback completed successfully");

    Ok(tokens)
}

// ==================== Helpers ====================

fn get_tokens_path() -> PathBuf {
    get_app_data_dir().join("gdrive_tokens.json")
}

fn obfuscate(data: &str) -> String {
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use rand::RngCore;

    let key = derive_encryption_key();
    let cipher = Aes256Gcm::new_from_slice(&key)
        .expect("AES-256-GCM key should always be 32 bytes");

    // Generate a random 12-byte nonce
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher.encrypt(nonce, data.as_bytes())
        .expect("Encryption should not fail for valid inputs");

    // Prepend nonce to ciphertext so we can extract it during decryption
    let mut output = Vec::with_capacity(12 + ciphertext.len());
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);

    BASE64.encode(&output)
}

fn deobfuscate(data: &str) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    // First, try AES-256-GCM decryption (new format)
    if let Ok(result) = deobfuscate_aes(data) {
        return Ok(result);
    }

    // Fall back to plain base64 (legacy format) for backward compatibility / migration
    let bytes = BASE64.decode(data).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

/// Attempts AES-256-GCM decryption on data produced by `obfuscate`.
fn deobfuscate_aes(data: &str) -> Result<String, String> {
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    let decoded = BASE64.decode(data).map_err(|e| format!("Base64 decode failed: {}", e))?;

    // Minimum size: 12 bytes nonce + 16 bytes auth tag + at least 1 byte ciphertext
    if decoded.len() < 29 {
        return Err("Data too short for AES-GCM".to_string());
    }

    let (nonce_bytes, ciphertext) = decoded.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    let key = derive_encryption_key();
    let cipher = Aes256Gcm::new_from_slice(&key)
        .expect("AES-256-GCM key should always be 32 bytes");

    let plaintext = cipher.decrypt(nonce, ciphertext)
        .map_err(|e| format!("AES-GCM decryption failed: {}", e))?;

    String::from_utf8(plaintext).map_err(|e| format!("UTF-8 decode failed: {}", e))
}

/// Derives a machine-specific encryption key. Combines a hardcoded app secret
/// with the current username, hostname, and app data path to produce a key that
/// is unique per machine + user. Not military-grade, but a significant upgrade
/// over plain base64: tokens encrypted on one machine/user can't be trivially
/// decrypted on another, and offline cracking requires knowing the secret.
fn derive_encryption_key() -> [u8; 32] {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    const APP_SECRET: &[u8] = b"SlasshyVault-TokenEncrypt-v1-2024";

    let mut hasher = DefaultHasher::new();
    APP_SECRET.hash(&mut hasher);

    if let Ok(user) = std::env::var("USERNAME").or_else(|_| std::env::var("USER")) {
        user.hash(&mut hasher);
    }
    if let Ok(host) = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")) {
        host.hash(&mut hasher);
    }
    if let Some(data_dir) = crate::database::get_app_data_dir().to_str() {
        data_dir.hash(&mut hasher);
    }

    let seed = hasher.finish();
    let seed_bytes = seed.to_le_bytes();

    // Expand the 8-byte hash seed into a 32-byte key using the app secret
    let mut key = [0u8; 32];
    for i in 0..32 {
        key[i] = seed_bytes[i % 8]
            .wrapping_add(APP_SECRET[i % APP_SECRET.len()])
            .wrapping_mul(i as u8 + 1);
    }
    key
}

fn save_tokens(tokens: &GoogleTokens) -> Result<(), String> {
    let path = get_tokens_path();
    let json = serde_json::to_string_pretty(tokens)
        .map_err(|e| format!("Failed to serialize tokens: {}", e))?;

    // Ensure directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }

    let encoded = obfuscate(&json);
    fs::write(&path, encoded).map_err(|e| format!("Failed to save tokens: {}", e))
}

fn load_tokens() -> Result<GoogleTokens, String> {
    let path = get_tokens_path();
    let encoded = fs::read_to_string(&path).map_err(|e| format!("Failed to read tokens: {}", e))?;

    // Check if the data is in the old base64-only format (not AES-GCM).
    // If so, we'll re-save after loading to migrate to the encrypted format.
    let is_legacy = deobfuscate_aes(&encoded).is_err();

    let json = deobfuscate(&encoded)?;
    let tokens: GoogleTokens = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse tokens: {}", e))?;

    // Transparently re-encrypt legacy tokens so the file is upgraded in place
    if is_legacy {
        if let Err(e) = save_tokens(&tokens) {
            eprintln!("Warning: failed to re-encrypt legacy tokens: {}", e);
        }
    }

    Ok(tokens)
}

// ==================== URL Encoding Helper ====================

mod urlencoding {
    pub fn encode(input: &str) -> String {
        percent_encoding::utf8_percent_encode(input, percent_encoding::NON_ALPHANUMERIC).to_string()
    }
}
