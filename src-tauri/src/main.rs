// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod archive_manager;
mod database;
mod gdrive;
mod media_manager;
mod mpv_ipc;
mod social_auth;
mod tmdb;
mod transcoder;
mod watch_together;
mod watch_together_mpv;
mod zip_manager;
mod zip_parser;
mod zip_stream_proxy;

use tauri_plugin_autostart::MacosLauncher;

use notify_rust::Notification as SystemNotification;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::api::notification::Notification as TauriNotification;
use tauri::{
    AppHandle, CustomMenuItem, Manager, State, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem, Window, WindowBuilder, WindowUrl,
};
use uuid::Uuid;

// Channel for receiving OAuth codes from deep links
lazy_static::lazy_static! {
    static ref OAUTH_CODE_CHANNEL: (Mutex<mpsc::Sender<String>>, Mutex<mpsc::Receiver<String>>) = {
        let (tx, rx) = mpsc::channel();
        (Mutex::new(tx), Mutex::new(rx))
    };
    static ref RECENT_UI_NOTIFICATIONS: Mutex<HashMap<String, std::time::Instant>> =
        Mutex::new(HashMap::new());
}

// MPV session info
#[derive(Clone, Serialize)]
pub struct MpvSession {
    pub media_id: i64,
    pub pid: u32,
    pub title: String,
    pub start_time: i64,
}

pub struct ActiveMpvSession {
    pub session: MpvSession,
    pub zip_proxy: Option<zip_stream_proxy::ZipStreamProxyHandle>,
}

pub struct ActiveZipStream {
    pub created_at: std::time::Instant,
    pub proxy: zip_stream_proxy::ZipStreamProxyHandle,
}

// Application state
pub struct AppState {
    pub db: Mutex<database::Database>,
    pub config: Mutex<config::Config>,
    pub is_scanning: Arc<AtomicBool>,
    pub active_mpv_sessions: Mutex<HashMap<i64, ActiveMpvSession>>,
    pub active_zip_streams: Mutex<HashMap<i64, ActiveZipStream>>,
    pub gdrive_client: gdrive::GoogleDriveClient,
    pub social_auth_client: social_auth::SocialAuthClient,
    pub watch_together: Arc<tokio::sync::Mutex<watch_together::WatchTogetherManager>>,
    pub wt_controller: Arc<tokio::sync::Mutex<Option<watch_together_mpv::WatchTogetherController>>>,
}

// API Response types
#[derive(Serialize)]
struct ApiResponse {
    message: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct WatchHistorySnapshot {
    version: i32,
    exported_at: String,
    events: Vec<database::WatchHistoryEvent>,
}

#[derive(Debug, Serialize)]
struct WatchHistorySyncStatus {
    synced: bool,
    merged_remote_events: usize,
    uploaded_events: usize,
    skipped_reason: Option<String>,
}

// Scan event payloads
#[derive(Clone, Serialize)]
struct ScanProgressPayload {
    title: String,
    media_type: String,
}

#[derive(Clone, Serialize)]
struct ScanCompletePayload {
    movies_count: usize,
    tv_count: usize,
}

fn enrich_media_item_archive_assessment(mut media: database::MediaItem) -> database::MediaItem {
    if let Some(assessment) = archive_manager::assess_archive_playback(&media) {
        media.archive_playback_can_play = Some(assessment.can_play);
        media.archive_playback_mode = Some(assessment.mode);
        media.archive_playback_message = Some(assessment.message);
        media.archive_playback_details = Some(assessment.details);
    }

    media
}

fn enrich_media_items_archive_assessment(
    items: Vec<database::MediaItem>,
) -> Vec<database::MediaItem> {
    items.into_iter()
        .map(enrich_media_item_archive_assessment)
        .collect()
}

async fn sync_watch_history_to_drive(
    state: &AppState,
) -> Result<WatchHistorySyncStatus, String> {
    if !state.gdrive_client.is_authenticated() {
        return Ok(WatchHistorySyncStatus {
            synced: false,
            merged_remote_events: 0,
            uploaded_events: 0,
            skipped_reason: Some("Google Drive is not connected".to_string()),
        });
    }

    let mut merged_remote_events = 0usize;

    if let Some(remote_json) = state.gdrive_client.load_watch_history_snapshot().await? {
        let remote_snapshot: WatchHistorySnapshot = serde_json::from_str(&remote_json)
            .map_err(|e| format!("Failed to parse remote watch history snapshot: {}", e))?;
        let db = state.db.lock().map_err(|e| e.to_string())?;
        merged_remote_events = db
            .upsert_watch_history_events(&remote_snapshot.events)
            .map_err(|e| e.to_string())?;
    }

    let events = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_watch_history_events(5000)
            .map_err(|e| e.to_string())?
    };

    let snapshot = WatchHistorySnapshot {
        version: 1,
        exported_at: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        events: events.clone(),
    };
    let snapshot_json = serde_json::to_string(&snapshot)
        .map_err(|e| format!("Failed to serialize watch history snapshot: {}", e))?;
    state
        .gdrive_client
        .save_watch_history_snapshot(&snapshot_json)
        .await?;

    Ok(WatchHistorySyncStatus {
        synced: true,
        merged_remote_events,
        uploaded_events: events.len(),
        skipped_reason: None,
    })
}

// Get library items (movies or TV shows)
#[tauri::command]
async fn get_library(
    state: State<'_, AppState>,
    media_type: String,
    search: Option<String>,
) -> Result<Vec<database::MediaItem>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let db_type = if media_type == "tv" {
        "tvshow"
    } else {
        "movie"
    };
    let items = db
        .get_library(db_type, search.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(enrich_media_items_archive_assessment(items))
}

// Get library filtered by cloud status
#[tauri::command]
async fn get_library_filtered(
    state: State<'_, AppState>,
    media_type: String,
    search: Option<String>,
    is_cloud: Option<bool>,
) -> Result<Vec<database::MediaItem>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let db_type = if media_type == "tv" {
        "tvshow"
    } else {
        "movie"
    };
    let items = db
        .get_library_filtered(db_type, search.as_deref(), is_cloud)
        .map_err(|e| e.to_string())?;
    Ok(enrich_media_items_archive_assessment(items))
}

// Get episodes for a TV show
#[tauri::command]
async fn get_episodes(
    state: State<'_, AppState>,
    series_id: i64,
) -> Result<Vec<database::MediaItem>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let items = db.get_episodes(series_id).map_err(|e| e.to_string())?;
    Ok(enrich_media_items_archive_assessment(items))
}

// Get watch history
#[tauri::command]
async fn get_watch_history(
    state: State<'_, AppState>,
    limit: Option<i32>,
) -> Result<Vec<database::MediaItem>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let items = db
        .get_watch_history(limit.unwrap_or(50))
        .map_err(|e| e.to_string())?;
    Ok(enrich_media_items_archive_assessment(items))
}

#[tauri::command]
async fn get_watch_history_events(
    state: State<'_, AppState>,
    limit: Option<i32>,
) -> Result<Vec<database::WatchHistoryEvent>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_watch_history_events(limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_library_stats(
    state: State<'_, AppState>,
    is_cloud: Option<bool>,
) -> Result<database::LibraryStats, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_library_stats(is_cloud).map_err(|e| e.to_string())
}

// Remove a single item from watch history
#[tauri::command]
async fn remove_from_watch_history(
    state: State<'_, AppState>,
    media_id: i64,
) -> Result<ApiResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.remove_from_watch_history(media_id)
        .map_err(|e| e.to_string())?;
    Ok(ApiResponse {
        message: "Item removed from watch history".to_string(),
    })
}

#[tauri::command]
async fn remove_watch_history_entry(
    state: State<'_, AppState>,
    event_id: String,
) -> Result<ApiResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.remove_watch_history_event(&event_id)
        .map_err(|e| e.to_string())?;
    Ok(ApiResponse {
        message: "Watch history entry removed".to_string(),
    })
}

// Mark media as complete (set progress to 100%)
#[tauri::command]
async fn mark_as_complete(
    state: State<'_, AppState>,
    media_id: i64,
) -> Result<ApiResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Get the media item to find its duration
    let item = db.get_media_by_id(media_id).map_err(|e| e.to_string())?;

    let duration = item.duration_seconds.unwrap_or(3600.0); // Default 1 hour if no duration
                                                            // Set position to duration (100% complete) - this will trigger the watched reset in update_progress
    db.update_progress(media_id, duration, duration)
        .map_err(|e| e.to_string())?;

    Ok(ApiResponse {
        message: format!("Marked '{}' as complete", item.title),
    })
}

// Clear all watch history
#[tauri::command]
async fn clear_all_watch_history(state: State<'_, AppState>) -> Result<ApiResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let count = db.clear_all_watch_history().map_err(|e| e.to_string())?;
    Ok(ApiResponse {
        message: format!("Cleared {} items from watch history", count),
    })
}

#[tauri::command]
async fn sync_watch_history(state: State<'_, AppState>) -> Result<WatchHistorySyncStatus, String> {
    sync_watch_history_to_drive(&state).await
}

// ==================== STREAMING HISTORY COMMANDS ====================

// Save streaming progress (for Videasy player)
#[tauri::command]
async fn save_streaming_progress(
    state: State<'_, AppState>,
    tmdb_id: String,
    media_type: String,
    title: String,
    poster_path: Option<String>,
    season: Option<i32>,
    episode: Option<i32>,
    position: f64,
    duration: f64,
) -> Result<ApiResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_streaming_progress(
        &tmdb_id,
        &media_type,
        &title,
        poster_path.as_deref(),
        season,
        episode,
        position,
        duration,
    )
    .map_err(|e| e.to_string())?;

    Ok(ApiResponse {
        message: "Streaming progress saved".to_string(),
    })
}

// Get streaming history
#[tauri::command]
async fn get_streaming_history(
    state: State<'_, AppState>,
    limit: Option<i32>,
) -> Result<Vec<database::StreamingHistoryItem>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_streaming_history(limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}

// Get streaming resume info for a specific content
#[tauri::command]
async fn get_streaming_resume_info(
    state: State<'_, AppState>,
    tmdb_id: String,
    media_type: String,
    season: Option<i32>,
    episode: Option<i32>,
) -> Result<Option<database::StreamingHistoryItem>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_streaming_resume_info(&tmdb_id, &media_type, season, episode)
        .map_err(|e| e.to_string())
}

// ==================== SOCIAL SYNC COMMANDS ====================

// Get aggregated watch stats for social sync
#[tauri::command]
async fn get_watch_stats(
    state: State<'_, AppState>,
) -> Result<database::WatchStatsAggregated, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_watch_stats().map_err(|e| e.to_string())
}

// Get recently completed watch activities since a timestamp
#[tauri::command]
async fn get_recent_watch_activities(
    state: State<'_, AppState>,
    since_timestamp: String,
) -> Result<Vec<database::WatchActivityItem>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_recent_watch_activities(&since_timestamp)
        .map_err(|e| e.to_string())
}

// Remove a single item from streaming history
#[tauri::command]
async fn remove_from_streaming_history(
    state: State<'_, AppState>,
    id: i64,
) -> Result<ApiResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.remove_from_streaming_history(id)
        .map_err(|e| e.to_string())?;
    Ok(ApiResponse {
        message: "Item removed from streaming history".to_string(),
    })
}

// Clear all streaming history
#[tauri::command]
async fn clear_all_streaming_history(state: State<'_, AppState>) -> Result<ApiResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let count = db
        .clear_all_streaming_history()
        .map_err(|e| e.to_string())?;
    Ok(ApiResponse {
        message: format!("Cleared {} items from streaming history", count),
    })
}

// ==================== GOOGLE DRIVE COMMANDS ====================

/// Check if user is connected to Google Drive
#[tauri::command]
async fn gdrive_is_connected(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.gdrive_client.is_authenticated())
}

/// Get Google Drive access token for social features
#[tauri::command]
async fn gdrive_get_access_token(state: State<'_, AppState>) -> Result<String, String> {
    state.gdrive_client.get_access_token().await
}

/// Get Google Drive account info
#[tauri::command]
async fn gdrive_get_account_info(
    state: State<'_, AppState>,
) -> Result<gdrive::DriveAccountInfo, String> {
    state.gdrive_client.get_account_info().await
}

/// Load AI chat history JSON from Google Drive appDataFolder (hidden app storage)
#[tauri::command]
async fn gdrive_get_ai_chat_history(state: State<'_, AppState>) -> Result<String, String> {
    let history = state.gdrive_client.load_ai_chat_history().await?;
    Ok(history.unwrap_or_else(|| "[]".to_string()))
}

/// Save AI chat history JSON to Google Drive appDataFolder (hidden app storage)
#[tauri::command]
async fn gdrive_save_ai_chat_history(
    state: State<'_, AppState>,
    history_json: String,
) -> Result<ApiResponse, String> {
    state
        .gdrive_client
        .save_ai_chat_history(&history_json)
        .await?;
    Ok(ApiResponse {
        message: "AI chat history saved".to_string(),
    })
}

/// Start Google Drive OAuth flow - returns auth URL
#[tauri::command]
async fn gdrive_start_auth() -> Result<String, String> {
    let auth_url = gdrive::get_auth_url();

    // Open the URL in the default browser
    if let Err(e) = open::that(&auth_url) {
        println!("[GDRIVE] Failed to open browser: {}", e);
        // Return URL anyway so user can copy it
    }

    Ok(auth_url)
}

/// Wait for OAuth callback and complete authentication
/// The backend handles token exchange and sends tokens directly to localhost callback
#[tauri::command]
async fn gdrive_complete_auth(
    state: State<'_, AppState>,
) -> Result<gdrive::DriveAccountInfo, String> {
    println!("[GDRIVE] Waiting for OAuth callback...");

    // Wait for tokens from backend (it redirects to localhost with tokens)
    let tokens = gdrive::wait_for_oauth_callback().await?;
    println!("[GDRIVE] Received tokens from backend");

    // Store tokens
    state.gdrive_client.store_tokens(tokens)?;
    println!("[GDRIVE] Tokens stored successfully");

    // Get and return account info
    state.gdrive_client.get_account_info().await
}

/// Disconnect from Google Drive
#[tauri::command]
async fn gdrive_disconnect(state: State<'_, AppState>) -> Result<ApiResponse, String> {
    state.gdrive_client.clear_tokens()?;
    Ok(ApiResponse {
        message: "Disconnected from Google Drive".to_string(),
    })
}

/// Check if Social auth is connected
#[tauri::command]
async fn social_is_connected(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.social_auth_client.is_authenticated())
}

/// Get Social auth access token
#[tauri::command]
async fn social_get_access_token(
    state: State<'_, AppState>,
    server_url: Option<String>,
) -> Result<String, String> {
    state
        .social_auth_client
        .get_access_token(server_url.as_deref())
        .await
}

/// Start Social Google OAuth flow
#[tauri::command]
async fn social_start_auth(server_url: Option<String>) -> Result<String, String> {
    let auth_url = social_auth::get_auth_url(server_url.as_deref());

    if let Err(e) = open::that(&auth_url) {
        println!("[SOCIAL AUTH] Failed to open browser: {}", e);
    }

    Ok(auth_url)
}

/// Wait for OAuth callback and complete Social authentication
#[tauri::command]
async fn social_complete_auth(
    state: State<'_, AppState>,
) -> Result<gdrive::DriveAccountInfo, String> {
    println!("[SOCIAL AUTH] Waiting for OAuth callback...");

    let tokens = gdrive::wait_for_oauth_callback().await?;
    println!("[SOCIAL AUTH] Received tokens from backend");

    state.social_auth_client.store_tokens(tokens)?;
    println!("[SOCIAL AUTH] Tokens stored successfully");

    state.social_auth_client.get_account_info().await
}

/// Disconnect Social auth
#[tauri::command]
async fn social_disconnect(state: State<'_, AppState>) -> Result<ApiResponse, String> {
    state.social_auth_client.clear_tokens()?;
    Ok(ApiResponse {
        message: "Disconnected from Social auth".to_string(),
    })
}

/// Complete OAuth with manually entered authorization code
/// NOTE: This is deprecated. The new flow uses backend proxy which handles token exchange.
#[tauri::command]
async fn gdrive_auth_with_code(
    _state: State<'_, AppState>,
    _code: String,
) -> Result<gdrive::DriveAccountInfo, String> {
    Err("Manual code entry is no longer supported. Please use the 'Connect Google Drive' button which opens the browser for authentication.".to_string())
}

/// List folders in Google Drive
#[tauri::command]
async fn gdrive_list_folders(
    state: State<'_, AppState>,
    parent_id: Option<String>,
) -> Result<Vec<gdrive::DriveItem>, String> {
    state.gdrive_client.list_folders(parent_id.as_deref()).await
}

/// List all files in a folder
#[tauri::command]
async fn gdrive_list_files(
    state: State<'_, AppState>,
    folder_id: Option<String>,
) -> Result<gdrive::DriveListResponse, String> {
    state
        .gdrive_client
        .list_files(folder_id.as_deref(), None)
        .await
}

/// List video files in a folder (with optional recursive scan)
#[tauri::command]
async fn gdrive_list_video_files(
    state: State<'_, AppState>,
    folder_id: String,
    recursive: bool,
) -> Result<Vec<gdrive::DriveItem>, String> {
    state
        .gdrive_client
        .list_video_files(&folder_id, recursive)
        .await
}

/// Get streaming URL for a Google Drive file
#[tauri::command]
async fn gdrive_get_stream_url(
    state: State<'_, AppState>,
    file_id: String,
) -> Result<(String, String), String> {
    state.gdrive_client.get_stream_url(&file_id).await
}

/// Get file metadata from Google Drive
#[tauri::command]
async fn gdrive_get_file_metadata(
    state: State<'_, AppState>,
    file_id: String,
) -> Result<gdrive::DriveItem, String> {
    state.gdrive_client.get_file_metadata(&file_id).await
}

/// Cloud folder info for indexing
#[derive(serde::Deserialize)]
struct CloudFolderInfo {
    id: String,
    name: String,
    #[serde(rename = "type")]
    folder_type: String, // "movies" or "tv"
}

/// Result of cloud indexing
#[derive(serde::Serialize)]
struct CloudIndexResult {
    success: bool,
    indexed_count: usize,
    skipped_count: usize,
    movies_count: usize,
    tv_count: usize,
    message: String,
}

/// Resolve an existing TV show using normalized/fuzzy matching to avoid split series
/// when cloud filenames use slightly different punctuation or formatting.
fn find_existing_cloud_tvshow(
    db: &database::Database,
    show_title: &str,
    year: Option<i32>,
) -> Option<database::MediaItem> {
    let series_id = db
        .find_series_by_tmdb_or_title(None, show_title, year)
        .ok()
        .flatten()?;
    db.get_media_by_id(series_id).ok()
}

fn auto_merge_duplicate_tvshows(db: &database::Database, source: &str) -> i32 {
    match db.merge_duplicate_tvshows() {
        Ok(count) => {
            if count > 0 {
                println!(
                    "[MERGE] Auto-merge from '{}' consolidated {} duplicate TV show entries",
                    source, count
                );
            }
            count
        }
        Err(e) => {
            println!("[MERGE] Auto-merge from '{}' failed: {}", source, e);
            0
        }
    }
}

/// Scan a cloud folder and index its contents
/// Auto-detects movies vs TV shows based on filename patterns
#[tauri::command]
async fn gdrive_scan_folder(
    state: State<'_, AppState>,
    window: Window,
    folder_id: String,
    folder_name: String,
) -> Result<CloudIndexResult, String> {
    println!(
        "[CLOUD] Starting scan of folder: {} (auto-detect)",
        folder_name
    );

    // Get video files from the folder
    let files = state
        .gdrive_client
        .list_video_files(&folder_id, true)
        .await?;
    println!("[CLOUD] Found {} video files", files.len());

    let unsupported_archives: Vec<String> = files
        .iter()
        .filter(|file| is_unsupported_archive_drive_item(file))
        .map(|file| {
            let _ = unsupported_archive_reason(file);
            file.name.clone()
        })
        .collect();
    let files: Vec<_> = files
        .into_iter()
        .filter(|file| !is_unsupported_archive_drive_item(file))
        .collect();

    notify_unsupported_archives_window(&window, &unsupported_archives);

    // Get API key from config
    let (api_key, zip_indexing_enabled, archive_cache_config) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        (
            tmdb::get_tmdb_credential(&config.tmdb_api_key.clone().unwrap_or_default()),
            config.zip_indexing_enabled,
            build_zip_cache_config(&config),
        )
    };

    // API key check is no longer needed since we have a default

    // Get image cache dir for poster downloads
    let image_cache_dir = database::get_image_cache_dir();
    std::fs::create_dir_all(&image_cache_dir).ok();

    // Clone data for the blocking task
    let folder_id_clone = folder_id.clone();
    let zip_files_detected: Vec<String> = if zip_indexing_enabled {
        files
            .iter()
            .filter(|file| is_zip_drive_item(file))
            .map(|file| file.name.clone())
            .collect()
    } else {
        Vec::new()
    };
    let zip_access_token = if zip_indexing_enabled && files.iter().any(is_zip_drive_item) {
        Some(state.gdrive_client.get_access_token().await?)
    } else {
        None
    };

    if !zip_files_detected.is_empty() {
        let archive_name = zip_files_detected.first().map(|name| name.as_str());
        emit_zip_processing_event(
            &window,
            "detected",
            zip_files_detected.len(),
            archive_name,
            None,
            &format!(
                "Archive{} detected in {}. Processing episode entries...",
                if zip_files_detected.len() == 1 {
                    ""
                } else {
                    "s"
                },
                folder_name
            ),
        );
    }

    // Get database path for creating new connection in blocking task
    let db_path = database::get_database_path();

    // Run the blocking indexing work in a separate thread
    let result = tokio::task::spawn_blocking(move || {
        use std::collections::HashMap;

        // Create a new database connection for this thread
        let db = match database::Database::new(&db_path) {
            Ok(d) => d,
            Err(e) => return Err(format!("Failed to open database: {}", e)),
        };

        let mut indexed_count = 0;
        let mut skipped_count = 0;
        let mut movies_count = 0;
        let mut tv_count = 0;
        let mut entry_counter = 0usize;

        // Cache for TV shows: title -> (db_id, tmdb_id, show_folder_id)
        let mut tv_show_cache: HashMap<String, (i64, Option<String>, String)> = HashMap::new();

        // Cache for season episodes: (tmdb_id, season) -> Vec<episode_info>
        let mut season_cache: HashMap<(String, i32), Vec<tmdb::TmdbEpisodeInfo>> = HashMap::new();

        for file in files {
            // Check if already indexed
            if db.cloud_file_exists(&file.id) {
                skipped_count += 1;
                continue;
            }

            if is_zip_drive_item(&file) {
                if !zip_indexing_enabled {
                    skipped_count += 1;
                    continue;
                }

                let Some(access_token) = zip_access_token.as_deref() else {
                    skipped_count += 1;
                    continue;
                };

                match index_zip_archive_with_metadata(
                    &db,
                    access_token,
                    &file,
                    &folder_id_clone,
                    &api_key,
                    &image_cache_dir,
                    &archive_cache_config,
                    &mut tv_show_cache,
                    &mut season_cache,
                ) {
                    Ok(indexed_items) => {
                        if indexed_items.is_empty() {
                            skipped_count += 1;
                            continue;
                        }

                        for (media_id, title, _, _, season, episode, _, _) in indexed_items {
                            indexed_count += 1;
                            tv_count += 1;
                            entry_counter += 1;
                            println!(
                                "[INDEX] #{} archive episode '{}' S{:02}E{:02} (db_id: {}, archive_file_id: {})",
                                entry_counter,
                                title,
                                season.unwrap_or(0),
                                episode.unwrap_or(0),
                                media_id,
                                file.id
                            );
                        }
                        continue;
                    }
                    Err(error) => {
                        println!("[ARCHIVE] Failed to index '{}': {}", file.name, error);
                        skipped_count += 1;
                        continue;
                    }
                }
            }

            // Parse filename to extract metadata
            let parsed = media_manager::parse_cloud_filename(&file.name);

            // Auto-detect: if we have season and episode numbers, it's a TV show
            let is_tv_show = parsed.season.is_some() && parsed.episode.is_some();

            if is_tv_show {
                // Index as TV episode
                let season = parsed.season.unwrap();
                let episode = parsed.episode.unwrap();
                let show_title = parsed.title.clone();
                let show_title_lower = show_title.to_lowercase();

                // Get the episode's actual parent folder (the TV show folder, not the tracked folder)
                let episode_parent_folder = file.parents.as_ref()
                    .and_then(|p| p.first())
                    .cloned()
                    .unwrap_or_else(|| folder_id_clone.clone());

                // Check cache first, then database, then TMDB
                let (db_show_id, tmdb_id, show_folder_id) = if let Some(cached) = tv_show_cache.get(&show_title_lower) {
                    cached.clone()
                } else {
                    let result = if let Some(existing_show) =
                        find_existing_cloud_tvshow(&db, &show_title, parsed.year)
                    {
                        // Use existing show's folder or the episode's parent
                        (existing_show.id, existing_show.tmdb_id, episode_parent_folder.clone())
                    } else {
                        // Search TMDB for the show (only once per show)
                        println!("[CLOUD] Searching TMDB for show: {}", show_title);
                        let tmdb_result = tmdb::search_metadata(
                            &api_key,
                            &show_title,
                            "tv",
                            parsed.year,
                            &image_cache_dir,
                        ).ok().flatten();

                        // Create the show
                        let (title, year, overview, cast_names, poster_path, tmdb_id_opt) = match &tmdb_result {
                            Some(meta) => (
                                meta.title.clone(),
                                meta.year,
                                meta.overview.clone(),
                                meta.cast_names.clone(),
                                meta.poster_path.clone(),
                                meta.tmdb_id.clone(),
                            ),
                            None => (show_title.clone(), None, None, None, None, None),
                        };

                        let title = media_manager::prefer_title_with_leading_article(&show_title, &title);

                        // Use episode's parent folder as the show's folder ID (for deletion)
                        match db.insert_cloud_tvshow(
                            &title,
                            year,
                            overview.as_deref(),
                            cast_names.as_deref(),
                            poster_path.as_deref(),
                            &format!("gdrive:{}", episode_parent_folder),
                            &episode_parent_folder,  // Use episode's parent folder, not tracked folder
                            tmdb_id_opt.as_deref(),
                        ) {
                            Ok(show_id) => (show_id, tmdb_id_opt, episode_parent_folder.clone()),
                            Err(e) => {
                                println!("[CLOUD] Failed to insert show: {}", e);
                                continue;
                            }
                        }
                    };

                    // Cache the result
                    tv_show_cache.insert(show_title_lower.clone(), result.clone());
                    result
                };

                // Get episode metadata from cache or TMDB
                let (ep_title, ep_overview, ep_still): (Option<String>, Option<String>, Option<String>) =
                    if let Some(ref tid) = tmdb_id {
                        let cache_key = (tid.clone(), season);

                        // Check season cache
                        let episodes = if let Some(cached_episodes) = season_cache.get(&cache_key) {
                            cached_episodes.clone()
                        } else {
                            // Fetch from TMDB (only once per season)
                            println!("[CLOUD] Fetching season {} episodes for {}", season, show_title);
                            match tmdb::fetch_season_episodes(&api_key, tid, season, &show_title, &image_cache_dir) {
                                Ok(season_info) => {
                                    let eps = season_info.episodes.clone();
                                    season_cache.insert(cache_key.clone(), eps.clone());
                                    eps
                                }
                                Err(_) => {
                                    season_cache.insert(cache_key.clone(), Vec::new());
                                    Vec::new()
                                }
                            }
                        };

                        // Find our episode in the cached list
                        episodes.iter()
                            .find(|e| e.episode_number == episode)
                            .map(|e| (Some(e.name.clone()), e.overview.clone(), e.still_path.clone()))
                            .unwrap_or((None, None, None))
                    } else {
                        (None, None, None)
                    };

                // Insert episode
                let ep_id = match db.insert_cloud_episode(
                    &show_title,
                    &file.name,
                    db_show_id,
                    season,
                    episode,
                    &file.id,
                    &show_folder_id,  // Use the show's folder ID, not tracked folder
                    ep_title.as_deref(),
                    ep_overview.as_deref(),
                    ep_still.as_deref(),
                ) {
                    Ok(id) => id,
                    Err(e) => {
                        println!("[CLOUD] Failed to insert episode: {}", e);
                        continue;
                    }
                };

                indexed_count += 1;
                tv_count += 1;
                entry_counter += 1;
                println!("[CLOUD] Indexed TV: {} S{:02}E{:02}", show_title, season, episode);
                println!(
                    "[INDEX] #{} TV episode '{}' (db_id: {}, cloud_file_id: {})",
                    entry_counter,
                    file.name,
                    ep_id,
                    file.id
                );

            } else {
                // Index as movie
                println!("[CLOUD] Searching TMDB for movie: {}", parsed.title);
                let tmdb_result = tmdb::search_metadata(
                    &api_key,
                    &parsed.title,
                    "movie",
                    parsed.year,
                    &image_cache_dir,
                ).ok().flatten();

                let (title, year, overview, cast_names, director, poster_path, tmdb_id, runtime_seconds) = match tmdb_result {
                    Some(meta) => (
                        meta.title,
                        meta.year,
                        meta.overview,
                        meta.cast_names,
                        meta.director,
                        meta.poster_path,
                        meta.tmdb_id,
                        meta.runtime_seconds.unwrap_or(0.0),
                    ),
                    None => (parsed.title.clone(), parsed.year, None, None, None, None, None, 0.0),
                };

                let title = media_manager::prefer_title_with_leading_article(&parsed.title, &title);

                // Insert into database
                let movie_id = match db.insert_cloud_movie(
                    &title,
                    year,
                    overview.as_deref(),
                    cast_names.as_deref(),
                    director.as_deref(),
                    poster_path.as_deref(),
                    &file.name,
                    &file.id,
                    &folder_id_clone,
                    runtime_seconds,
                    tmdb_id.as_deref(),
                ) {
                    Ok(id) => id,
                    Err(e) => {
                        println!("[CLOUD] Failed to insert movie: {}", e);
                        continue;
                    }
                };

                indexed_count += 1;
                movies_count += 1;
                entry_counter += 1;
                println!("[CLOUD] Indexed Movie: {}", title);
                println!(
                    "[INDEX] #{} Movie '{}' (db_id: {}, cloud_file_id: {})",
                    entry_counter,
                    file.name,
                    movie_id,
                    file.id
                );
            }
        }

        Ok((indexed_count, skipped_count, movies_count, tv_count))
    }).await.map_err(|e| format!("Task failed: {}", e))??;

    let (indexed_count, skipped_count, movies_count, tv_count) = result;
    let skipped_count = skipped_count + unsupported_archives.len();

    if !zip_files_detected.is_empty() {
        let archive_name = zip_files_detected.first().map(|name| name.as_str());
        emit_zip_processing_event(
            &window,
            "complete",
            zip_files_detected.len(),
            archive_name,
            None,
            &format!(
                "Finished processing {} ZIP archive(s). Episode entries have been added to your library.",
                zip_files_detected.len()
            ),
        );
    }

    if indexed_count > 0 {
        if let Ok(db) = state.db.lock() {
            let merged = auto_merge_duplicate_tvshows(&db, "gdrive_scan_folder");
            if merged > 0 {
                window.emit("library-updated", ()).ok();
            }
        }
    }

    // Emit completion
    window
        .emit(
            "cloud-scan-complete",
            serde_json::json!({
                "folder": folder_name,
                "indexed": indexed_count,
                "skipped": skipped_count,
                "movies": movies_count,
                "tv": tv_count
            }),
        )
        .ok();

    window.emit("library-updated", ()).ok();

    let message = format!(
        "Indexed {} items ({} movies, {} TV episodes) from '{}' ({} skipped)",
        indexed_count, movies_count, tv_count, folder_name, skipped_count
    );
    println!("[CLOUD] {}", message);

    Ok(CloudIndexResult {
        success: true,
        indexed_count,
        skipped_count,
        movies_count,
        tv_count,
        message,
    })
}

/// Delete all indexed media from a cloud folder
#[tauri::command]
async fn gdrive_delete_folder_media(
    state: State<'_, AppState>,
    window: Window,
    folder_id: String,
) -> Result<ApiResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let deleted = db
        .delete_cloud_folder_media(&folder_id)
        .map_err(|e| e.to_string())?;

    window.emit("library-updated", ()).ok();

    Ok(ApiResponse {
        message: format!("Deleted {} cloud media items", deleted),
    })
}

// ==================== CLOUD FOLDER MANAGEMENT ====================

/// Add a cloud folder to track (stored in database, auto-scanned)
#[tauri::command]
async fn add_cloud_folder(
    state: State<'_, AppState>,
    folder_id: String,
    folder_name: String,
) -> Result<ApiResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.add_cloud_folder(&folder_id, &folder_name)
        .map_err(|e| e.to_string())?;
    Ok(ApiResponse {
        message: format!("Added cloud folder: {}", folder_name),
    })
}

/// Remove a cloud folder from tracking
#[tauri::command]
async fn remove_cloud_folder(
    state: State<'_, AppState>,
    window: Window,
    folder_id: String,
) -> Result<ApiResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Delete media from this folder
    let deleted_media = db
        .delete_cloud_folder_media(&folder_id)
        .map_err(|e| e.to_string())?;

    // Remove folder from tracking
    db.remove_cloud_folder(&folder_id)
        .map_err(|e| e.to_string())?;

    window.emit("library-updated", ()).ok();

    Ok(ApiResponse {
        message: format!("Removed cloud folder and {} media items", deleted_media),
    })
}

/// Get all tracked cloud folders
#[tauri::command]
async fn get_cloud_folders(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let folders = db.get_cloud_folders().map_err(|e| e.to_string())?;

    Ok(folders
        .into_iter()
        .map(|(id, name, auto_scan)| {
            serde_json::json!({
                "id": id,
                "name": name,
                "auto_scan": auto_scan
            })
        })
        .collect())
}

/// Scan all cloud folders for new files (incremental scan)
#[tauri::command]
async fn scan_all_cloud_folders(
    state: State<'_, AppState>,
    window: Window,
) -> Result<CloudIndexResult, String> {
    // Get all tracked folders
    let folders = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_cloud_folders().map_err(|e| e.to_string())?
    };

    if folders.is_empty() {
        return Ok(CloudIndexResult {
            success: true,
            indexed_count: 0,
            skipped_count: 0,
            movies_count: 0,
            tv_count: 0,
            message: "No cloud folders configured".to_string(),
        });
    }

    let mut total_indexed = 0;
    let mut total_skipped = 0;
    let mut total_movies = 0;
    let mut total_tv = 0;

    for (folder_id, folder_name, _) in folders {
        println!(
            "[CLOUD SCAN] Scanning folder: {} ({})",
            folder_name, folder_id
        );

        // Get video files from the folder
        let files = match state.gdrive_client.list_video_files(&folder_id, true).await {
            Ok(f) => f,
            Err(e) => {
                println!(
                    "[CLOUD SCAN] Error listing files for {}: {}",
                    folder_name, e
                );
                continue;
            }
        };
        let unsupported_archives: Vec<String> = files
            .iter()
            .filter(|file| is_unsupported_archive_drive_item(file))
            .map(|file| file.name.clone())
            .collect();
        if !unsupported_archives.is_empty() {
            notify_unsupported_archives_window(&window, &unsupported_archives);
        }
        let files: Vec<_> = files
            .into_iter()
            .filter(|file| !is_unsupported_archive_drive_item(file))
            .collect();

        // Get API key from config
        let (api_key, zip_indexing_enabled, archive_cache_config) = {
            let config = state.config.lock().map_err(|e| e.to_string())?;
            (
                tmdb::get_tmdb_credential(&config.tmdb_api_key.clone().unwrap_or_default()),
                config.zip_indexing_enabled,
                build_zip_cache_config(&config),
            )
        };

        // API key is always available now with default

        // Get image cache dir for poster downloads
        let image_cache_dir = database::get_image_cache_dir();
        std::fs::create_dir_all(&image_cache_dir).ok();

        // Clone data for the blocking task
        let folder_id_clone = folder_id.clone();
        let db_path = database::get_database_path();
        let zip_access_token = if zip_indexing_enabled && files.iter().any(is_zip_drive_item) {
            Some(state.gdrive_client.get_access_token().await?)
        } else {
            None
        };

        // Run the blocking indexing work in a separate thread
        let result = tokio::task::spawn_blocking(move || {
            use std::collections::HashMap;

            let db = match database::Database::new(&db_path) {
                Ok(d) => d,
                Err(e) => return Err(format!("Failed to open database: {}", e)),
            };

            let mut indexed_count = 0;
            let mut skipped_count = 0;
            let mut movies_count = 0;
            let mut tv_count = 0;

            let mut tv_show_cache: HashMap<String, (i64, Option<String>, String)> = HashMap::new();
            let mut season_cache: HashMap<(String, i32), Vec<tmdb::TmdbEpisodeInfo>> =
                HashMap::new();

            for file in files {
                if db.cloud_file_exists(&file.id) {
                    skipped_count += 1;
                    continue;
                }

                if is_zip_drive_item(&file) {
                    if !zip_indexing_enabled {
                        skipped_count += 1;
                        continue;
                    }

                    let Some(access_token) = zip_access_token.as_deref() else {
                        skipped_count += 1;
                        continue;
                    };

                    match index_zip_archive_with_metadata(
                        &db,
                        access_token,
                        &file,
                        &folder_id_clone,
                        &api_key,
                        &image_cache_dir,
                        &archive_cache_config,
                        &mut tv_show_cache,
                        &mut season_cache,
                    ) {
                        Ok(indexed_items) => {
                            if indexed_items.is_empty() {
                                skipped_count += 1;
                            } else {
                                indexed_count += indexed_items.len();
                                tv_count += indexed_items.len();
                            }
                            continue;
                        }
                        Err(error) => {
                            println!("[ZIP] Failed to index '{}': {}", file.name, error);
                            skipped_count += 1;
                            continue;
                        }
                    }
                }

                let parsed = media_manager::parse_cloud_filename(&file.name);
                let is_tv_show = parsed.season.is_some() && parsed.episode.is_some();

                if is_tv_show {
                    let season = parsed.season.unwrap();
                    let episode = parsed.episode.unwrap();
                    let show_title = parsed.title.clone();
                    let show_title_lower = show_title.to_lowercase();

                    let (db_show_id, tmdb_id, _show_folder_id) =
                        if let Some(cached) = tv_show_cache.get(&show_title_lower) {
                            cached.clone()
                        } else {
                            let result = if let Some(existing_show) =
                                find_existing_cloud_tvshow(&db, &show_title, parsed.year)
                            {
                                (
                                    existing_show.id,
                                    existing_show.tmdb_id,
                                    folder_id_clone.clone(),
                                )
                            } else {
                                let tmdb_result = tmdb::search_metadata(
                                    &api_key,
                                    &show_title,
                                    "tv",
                                    parsed.year,
                                    &image_cache_dir,
                                )
                                .ok()
                                .flatten();

                                let (title, year, overview, cast_names, poster_path, tmdb_id_opt) =
                                    match &tmdb_result {
                                        Some(meta) => (
                                            meta.title.clone(),
                                            meta.year,
                                            meta.overview.clone(),
                                            meta.cast_names.clone(),
                                            meta.poster_path.clone(),
                                            meta.tmdb_id.clone(),
                                        ),
                                        None => (show_title.clone(), None, None, None, None, None),
                                    };

                                let title = media_manager::prefer_title_with_leading_article(
                                    &show_title,
                                    &title,
                                );

                                match db.insert_cloud_tvshow(
                                    &title,
                                    year,
                                    overview.as_deref(),
                                    cast_names.as_deref(),
                                    poster_path.as_deref(),
                                    &format!("gdrive:{}", folder_id_clone),
                                    &folder_id_clone,
                                    tmdb_id_opt.as_deref(),
                                ) {
                                    Ok(show_id) => (show_id, tmdb_id_opt, folder_id_clone.clone()),
                                    Err(_) => continue,
                                }
                            };
                            tv_show_cache.insert(show_title_lower.clone(), result.clone());
                            result
                        };

                    let (ep_title, ep_overview, ep_still): (
                        Option<String>,
                        Option<String>,
                        Option<String>,
                    ) = if let Some(ref tid) = tmdb_id {
                        let cache_key = (tid.clone(), season);
                        let episodes = if let Some(cached_episodes) = season_cache.get(&cache_key) {
                            cached_episodes.clone()
                        } else {
                            match tmdb::fetch_season_episodes(
                                &api_key,
                                tid,
                                season,
                                &show_title,
                                &image_cache_dir,
                            ) {
                                Ok(season_info) => {
                                    let eps = season_info.episodes.clone();
                                    season_cache.insert(cache_key.clone(), eps.clone());
                                    eps
                                }
                                Err(_) => {
                                    season_cache.insert(cache_key.clone(), Vec::new());
                                    Vec::new()
                                }
                            }
                        };
                        episodes
                            .iter()
                            .find(|e| e.episode_number == episode)
                            .map(|e| {
                                (
                                    Some(e.name.clone()),
                                    e.overview.clone(),
                                    e.still_path.clone(),
                                )
                            })
                            .unwrap_or((None, None, None))
                    } else {
                        (None, None, None)
                    };

                    if db
                        .insert_cloud_episode(
                            &show_title,
                            &file.name,
                            db_show_id,
                            season,
                            episode,
                            &file.id,
                            &folder_id_clone,
                            ep_title.as_deref(),
                            ep_overview.as_deref(),
                            ep_still.as_deref(),
                        )
                        .is_err()
                    {
                        continue;
                    }

                    indexed_count += 1;
                    tv_count += 1;
                } else {
                    let tmdb_result = tmdb::search_metadata(
                        &api_key,
                        &parsed.title,
                        "movie",
                        parsed.year,
                        &image_cache_dir,
                    )
                    .ok()
                    .flatten();

                    let (
                        title,
                        year,
                        overview,
                        cast_names,
                        director,
                        poster_path,
                        tmdb_id,
                        runtime_seconds,
                    ) = match tmdb_result {
                        Some(meta) => (
                            meta.title,
                            meta.year,
                            meta.overview,
                            meta.cast_names,
                            meta.director,
                            meta.poster_path,
                            meta.tmdb_id,
                            meta.runtime_seconds.unwrap_or(0.0),
                        ),
                        None => (
                            parsed.title.clone(),
                            parsed.year,
                            None,
                            None,
                            None,
                            None,
                            None,
                            0.0,
                        ),
                    };

                    let title =
                        media_manager::prefer_title_with_leading_article(&parsed.title, &title);

                    if db
                        .insert_cloud_movie(
                            &title,
                            year,
                            overview.as_deref(),
                            cast_names.as_deref(),
                            director.as_deref(),
                            poster_path.as_deref(),
                            &file.name,
                            &file.id,
                            &folder_id_clone,
                            runtime_seconds,
                            tmdb_id.as_deref(),
                        )
                        .is_err()
                    {
                        continue;
                    }

                    indexed_count += 1;
                    movies_count += 1;
                }
            }

            Ok((indexed_count, skipped_count, movies_count, tv_count))
        })
        .await
        .map_err(|e| format!("Task failed: {}", e))?;

        let result = result?;

        let (indexed, skipped, movies, tv) = result;
        total_indexed += indexed;
        total_skipped += skipped + unsupported_archives.len();
        total_movies += movies;
        total_tv += tv;

        // Update last scanned timestamp
        if let Ok(db) = state.db.lock() {
            let _ = db.update_cloud_folder_scanned(&folder_id);
        }

        if indexed > 0 {
            window.emit("library-updated", ()).ok();
        }
    }

    if total_indexed > 0 {
        if let Ok(db) = state.db.lock() {
            let merged = auto_merge_duplicate_tvshows(&db, "scan_all_cloud_folders");
            if merged > 0 {
                window.emit("library-updated", ()).ok();
            }
        }
    }

    let message = format!(
        "Cloud scan complete: {} new ({} movies, {} TV shows), {} already indexed",
        total_indexed, total_movies, total_tv, total_skipped
    );

    window
        .emit(
            "cloud-scan-complete",
            serde_json::json!({
                "indexed": total_indexed,
                "movies": total_movies,
                "tv": total_tv,
                "skipped": total_skipped
            }),
        )
        .ok();

    Ok(CloudIndexResult {
        success: true,
        indexed_count: total_indexed,
        skipped_count: total_skipped,
        movies_count: total_movies,
        tv_count: total_tv,
        message,
    })
}

/// Check for new cloud files using the efficient Changes API
/// This is MUCH lighter than scanning all folders - only returns changed files
#[tauri::command]
async fn check_cloud_changes(
    state: State<'_, AppState>,
    window: Window,
) -> Result<CloudIndexResult, String> {
    let start_time = std::time::Instant::now();
    println!("[CLOUD CHANGES] ══════════════════════════════════════════");
    println!("[CLOUD CHANGES] Starting change detection poll...");

    // Check if authenticated
    if !state.gdrive_client.is_authenticated() {
        println!("[CLOUD CHANGES] Not authenticated - skipping");
        return Ok(CloudIndexResult {
            success: true,
            indexed_count: 0,
            skipped_count: 0,
            movies_count: 0,
            tv_count: 0,
            message: "Not connected to Google Drive".to_string(),
        });
    }

    // Get or initialize the changes token
    let current_token = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_gdrive_changes_token().map_err(|e| e.to_string())?
    };

    let page_token = match current_token {
        Some(token) => {
            println!(
                "[CLOUD CHANGES] Using existing token: {}...",
                &token[..token.len().min(20)]
            );
            token
        }
        None => {
            // First time - get the start token
            println!("[CLOUD CHANGES] No token found - initializing changes tracking...");
            let start_token = state.gdrive_client.get_changes_start_token().await?;
            println!(
                "[CLOUD CHANGES] Got start token: {}...",
                &start_token[..start_token.len().min(20)]
            );

            // Save it
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db.set_gdrive_changes_token(&start_token)
                .map_err(|e| e.to_string())?;
            println!("[CLOUD CHANGES] Token saved - will detect changes on next poll");

            // Return empty result - we'll catch changes on next poll
            return Ok(CloudIndexResult {
                success: true,
                indexed_count: 0,
                skipped_count: 0,
                movies_count: 0,
                tv_count: 0,
                message: "Changes tracking initialized".to_string(),
            });
        }
    };

    // Get tracked folder IDs
    let tracked_folders: std::collections::HashSet<String> = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let folders = db.get_cloud_folders().map_err(|e| e.to_string())?;
        folders.into_iter().map(|(id, _, _)| id).collect()
    };

    if tracked_folders.is_empty() {
        println!("[CLOUD CHANGES] No cloud folders configured - skipping");
        return Ok(CloudIndexResult {
            success: true,
            indexed_count: 0,
            skipped_count: 0,
            movies_count: 0,
            tv_count: 0,
            message: "No cloud folders configured".to_string(),
        });
    }

    println!(
        "[CLOUD CHANGES] Tracking {} folder(s)",
        tracked_folders.len()
    );

    // Get changes since last check
    let api_start = std::time::Instant::now();
    let (changed_files, removed_file_ids, new_token) =
        state.gdrive_client.get_video_changes(&page_token).await?;
    let api_duration = api_start.elapsed();
    println!("[CLOUD CHANGES] Changes API call took {:?}", api_duration);

    // Save the new token immediately
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.set_gdrive_changes_token(&new_token)
            .map_err(|e| e.to_string())?;
    }

    let mut removed_titles: Vec<String> = Vec::new();
    if !removed_file_ids.is_empty() {
        if let Ok(db) = state.db.lock() {
            for file_id in removed_file_ids {
                if let Ok(Some((_id, title, _media_type, _parent_id))) =
                    db.remove_media_by_cloud_file_id(&file_id)
                {
                    removed_titles.push(title);
                }
            }

            if !removed_titles.is_empty() {
                let _ = db.cleanup_empty_series();
            }
        }

        if !removed_titles.is_empty() {
            window.emit("library-updated", ()).ok();

            // Group TV episodes by series name to avoid spamming notifications
            let mut series_episodes: std::collections::HashMap<String, Vec<String>> =
                std::collections::HashMap::new();
            let mut non_tv_titles: Vec<String> = Vec::new();

            for title in &removed_titles {
                // Check if this is a TV episode (format: "Title SXXEXX" or "Title SXEX")
                // Examples: "Breaking Bad S01E01", "Breaking Bad S1E1", "Breaking Bad S10E15"
                let is_tv_episode = if let Some(pos) = title.find(" S") {
                    let rest = &title[pos + 2..]; // Skip " S"
                    if rest.len() >= 3 && rest.starts_with(|c: char| c.is_ascii_digit()) {
                        // Look for pattern: digit(s) + 'E' + digit(s)
                        if let Some(e_pos) = rest.find(|c: char| c.to_ascii_uppercase() == 'E') {
                            if e_pos > 0 && e_pos < rest.len() - 1 {
                                let season_part = &rest[..e_pos];
                                let episode_part = &rest[e_pos + 1..];
                                // Both season and episode should be numeric
                                season_part.chars().all(|c| c.is_ascii_digit()) && 
                                episode_part.chars().all(|c| c.is_ascii_digit()) &&
                                !season_part.is_empty() && !episode_part.is_empty()
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                };

                if is_tv_episode {
                    // Extract series name (everything before " S")
                    if let Some(pos) = title.find(" S") {
                        let series_name = &title[..pos];
                        series_episodes.entry(series_name.to_string())
                            .or_insert_with(Vec::new)
                            .push(title.clone());
                        continue;
                    }
                }
                // Not a TV episode, add to regular titles
                non_tv_titles.push(title.clone());
            }

            let mut messages = Vec::new();

            for (series_name, episodes) in &series_episodes {
                let episode_count = episodes.len();
                if episode_count == 1 {
                    messages.push(format!("{} (1 episode)", series_name));
                } else {
                    messages.push(format!("{} ({} episodes)", series_name, episode_count));
                }
            }

            for title in &non_tv_titles {
                messages.push(title.clone());
            }

            if !messages.is_empty() {
                let message = if messages.len() == 1 {
                    format!("{} removed (deleted from Drive)", messages[0])
                } else {
                    format!("{} items removed (deleted from Drive)", messages.len())
                };

                dispatch_notification(&window, "StreamVault", &message, "info");
            }
        }
    }

    if changed_files.is_empty() {
        let total_duration = start_time.elapsed();
        println!(
            "[CLOUD CHANGES] No changes detected (total: {:?})",
            total_duration
        );
        println!("[CLOUD CHANGES] ══════════════════════════════════════════");
        return Ok(CloudIndexResult {
            success: true,
            indexed_count: 0,
            skipped_count: 0,
            movies_count: 0,
            tv_count: 0,
            message: if removed_titles.is_empty() {
                "No new files detected".to_string()
            } else {
                format!(
                    "Removed {} item(s) deleted from Drive",
                    removed_titles.len()
                )
            },
        });
    }

    println!("[CLOUD CHANGES] ┌─────────────────────────────────────────");
    println!(
        "[CLOUD CHANGES] │ DETECTED {} changed video file(s)!",
        changed_files.len()
    );
    for file in &changed_files {
        println!("[CLOUD CHANGES] │   • {}", file.name);
    }
    println!("[CLOUD CHANGES] └─────────────────────────────────────────");

    // Filter to only files in our tracked folders
    let files_to_index: Vec<gdrive::DriveItem> = changed_files
        .into_iter()
        .filter(|file| {
            if let Some(ref parents) = file.parents {
                let in_tracked = parents.iter().any(|p| tracked_folders.contains(p));
                if !in_tracked {
                    println!(
                        "[CLOUD CHANGES] Skipping {} (not in tracked folders)",
                        file.name
                    );
                }
                in_tracked
            } else {
                println!("[CLOUD CHANGES] Skipping {} (no parent folder)", file.name);
                false
            }
        })
        .collect();

    let unsupported_archives: Vec<String> = files_to_index
        .iter()
        .filter(|file| is_unsupported_archive_drive_item(file))
        .map(|file| file.name.clone())
        .collect();
    if !unsupported_archives.is_empty() {
        notify_unsupported_archives_window(&window, &unsupported_archives);
    }
    let files_to_index: Vec<gdrive::DriveItem> = files_to_index
        .into_iter()
        .filter(|file| !is_unsupported_archive_drive_item(file))
        .collect();

    if files_to_index.is_empty() {
        let total_duration = start_time.elapsed();
        println!(
            "[CLOUD CHANGES] No files in tracked folders (total: {:?})",
            total_duration
        );
        println!("[CLOUD CHANGES] ══════════════════════════════════════════");
        return Ok(CloudIndexResult {
            success: true,
            indexed_count: 0,
            skipped_count: unsupported_archives.len(),
            movies_count: 0,
            tv_count: 0,
            message: if unsupported_archives.is_empty() {
                "No new files in tracked folders".to_string()
            } else {
                format!(
                    "Skipped {} unsupported TAR archive(s) in tracked folders",
                    unsupported_archives.len()
                )
            },
        });
    }

    println!(
        "[CLOUD CHANGES] {} file(s) to index in tracked folders",
        files_to_index.len()
    );

    // Emit event to show indexing has started
    window
        .emit(
            "cloud-indexing-started",
            serde_json::json!({
                "count": files_to_index.len()
            }),
        )
        .ok();

    let image_cache_dir = database::get_image_cache_dir();
    std::fs::create_dir_all(&image_cache_dir).ok();

    let db_path = database::get_database_path();
    let _files_count = files_to_index.len();
    let (zip_indexing_enabled, archive_cache_config) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        (config.zip_indexing_enabled, build_zip_cache_config(&config))
    };
    let zip_access_token = if zip_indexing_enabled && files_to_index.iter().any(is_zip_drive_item) {
        Some(state.gdrive_client.get_access_token().await?)
    } else {
        None
    };

    println!("[CLOUD CHANGES] ┌─────────────────────────────────────────");
    println!("[CLOUD CHANGES] │ PHASE 1: Adding files immediately (no metadata)");
    println!("[CLOUD CHANGES] └─────────────────────────────────────────");
    let index_start = std::time::Instant::now();

    // PHASE 1: Add files immediately without metadata
    let phase1_result = {
        let db_path_clone = db_path.clone();
        let files_to_index_clone: Vec<_> = files_to_index
            .iter()
            .map(|f| (f.id.clone(), f.name.clone(), f.parents.clone()))
            .collect();

        tokio::task::spawn_blocking(move || {
            let db = match database::Database::new(&db_path_clone) {
                Ok(d) => d,
                Err(e) => return Err(format!("Failed to open database: {}", e)),
            };

            let mut indexed_items: Vec<(
                i64,
                String,
                String,
                bool,
                Option<i32>,
                Option<i32>,
                String,
                Option<i32>,
            )> = Vec::new(); // (id, title, file_id, is_tv, season, episode, folder_id, year)
            let mut skipped_count = 0;
            let mut movies_count = 0;
            let mut tv_count = 0;

            // Cache for TV show IDs to avoid creating duplicates
            let mut tv_show_cache: std::collections::HashMap<String, i64> =
                std::collections::HashMap::new();

            for (file_id, file_name, parents) in files_to_index_clone {
                // Check if already indexed (by cloud_file_id OR by file_path)
                if db.cloud_file_exists(&file_id) {
                    println!(
                        "[CLOUD CHANGES]   ⊘ Skipping (already indexed by file_id): {}",
                        file_name
                    );
                    skipped_count += 1;
                    continue;
                }

                // Also check if file_path already exists (from previous incomplete indexing)
                if let Ok(Some(_)) = db.get_media_by_file_path(&file_name) {
                    println!(
                        "[CLOUD CHANGES]   ⊘ Skipping (file_path already exists): {}",
                        file_name
                    );
                    skipped_count += 1;
                    continue;
                }

                // Get the parent folder ID
                let folder_id = parents
                    .as_ref()
                    .and_then(|p| p.first())
                    .cloned()
                    .unwrap_or_default();

                let pseudo_file = gdrive::DriveItem {
                    id: file_id.clone(),
                    name: file_name.clone(),
                    mime_type: if file_name.to_ascii_lowercase().ends_with(".zip") {
                        "application/zip".to_string()
                    } else {
                        String::new()
                    },
                    size: None,
                    modified_time: None,
                    parents: parents.clone(),
                    web_content_link: None,
                };

                if is_zip_drive_item(&pseudo_file) {
                    if !zip_indexing_enabled {
                        skipped_count += 1;
                        continue;
                    }

                    let Some(access_token) = zip_access_token.as_deref() else {
                        skipped_count += 1;
                        continue;
                    };

                        match index_zip_archive_without_metadata(
                            &db,
                            access_token,
                            &pseudo_file,
                            &folder_id,
                            &archive_cache_config,
                            &mut tv_show_cache,
                        ) {
                        Ok(items) => {
                            if items.is_empty() {
                                skipped_count += 1;
                            } else {
                                tv_count += items.len();
                                indexed_items.extend(items);
                            }
                            continue;
                        }
                        Err(error) => {
                            println!("[ZIP] Failed to index '{}': {}", file_name, error);
                            skipped_count += 1;
                            continue;
                        }
                    }
                }

                let parsed = media_manager::parse_cloud_filename(&file_name);
                let is_tv_show = parsed.season.is_some() && parsed.episode.is_some();

                if is_tv_show {
                    let season = parsed.season.unwrap();
                    let episode = parsed.episode.unwrap();
                    let show_title = parsed.title.clone();
                    let show_title_lower = show_title.to_lowercase();

                    // Get or create TV show entry (without metadata for now)
                    let db_show_id = if let Some(&cached_id) = tv_show_cache.get(&show_title_lower)
                    {
                        println!(
                            "[CLOUD CHANGES]   Using cached show ID {} for '{}'",
                            cached_id, show_title
                        );
                        cached_id
                    } else {
                        let show_id = if let Some(existing_show) =
                            find_existing_cloud_tvshow(&db, &show_title, parsed.year)
                        {
                            println!(
                                "[CLOUD CHANGES]   Found existing show '{}' with ID {}",
                                show_title, existing_show.id
                            );
                            existing_show.id
                        } else {
                            // Create TV show entry without metadata
                            // Use a unique file_path combining folder ID and show title
                            let show_path = format!(
                                "gdrive:{}:{}",
                                folder_id,
                                show_title.to_lowercase().replace(" ", "_")
                            );
                            println!(
                                "[CLOUD CHANGES]   Creating new TV show '{}' with path '{}'",
                                show_title, show_path
                            );
                            match db.insert_cloud_tvshow(
                                &show_title,
                                None,
                                None,
                                None,
                                None,
                                &show_path,
                                &folder_id,
                                None,
                            ) {
                                Ok(id) => {
                                    println!("[CLOUD CHANGES]   Created TV show with ID {}", id);
                                    id
                                }
                                Err(e) => {
                                    println!("[CLOUD CHANGES]   ERROR creating TV show: {}", e);
                                    continue;
                                }
                            }
                        };
                        tv_show_cache.insert(show_title_lower, show_id);
                        show_id
                    };

                    // Insert episode without metadata
                    match db.insert_cloud_episode(
                        &show_title,
                        &file_name,
                        db_show_id,
                        season,
                        episode,
                        &file_id,
                        &folder_id,
                        None,
                        None,
                        None,
                    ) {
                        Ok(ep_id) => {
                            let display_title =
                                format!("{} S{:02}E{:02}", show_title, season, episode);
                            println!("[CLOUD CHANGES]   ✓ Added (no metadata): {}", display_title);
                            indexed_items.push((
                                ep_id,
                                show_title,
                                file_id,
                                true,
                                Some(season),
                                Some(episode),
                                folder_id,
                                parsed.year,
                            ));
                            tv_count += 1;
                        }
                        Err(e) => {
                            println!("[CLOUD CHANGES]   ERROR inserting episode: {}", e);
                            continue;
                        }
                    }
                } else {
                    // Insert movie without metadata
                    match db.insert_cloud_movie(
                        &parsed.title,
                        parsed.year,
                        None,
                        None,
                        None,
                        None,
                        &file_name,
                        &file_id,
                        &folder_id,
                        0.0,
                        None,
                    ) {
                        Ok(movie_id) => {
                            println!("[CLOUD CHANGES]   ✓ Added (no metadata): {}", parsed.title);
                            indexed_items.push((
                                movie_id,
                                parsed.title,
                                file_id,
                                false,
                                None,
                                None,
                                folder_id,
                                parsed.year,
                            ));
                            movies_count += 1;
                        }
                        Err(_) => continue,
                    }
                }
            }

            Ok((indexed_items, skipped_count, movies_count, tv_count))
        })
        .await
        .map_err(|e| format!("Task failed: {}", e))?
    };

    let phase1_result = phase1_result?;

    let (indexed_items, skipped_count, movies_count, tv_count) = phase1_result;
    let skipped_count = skipped_count + unsupported_archives.len();
    let indexed_count = indexed_items.len();
    let phase1_duration = index_start.elapsed();

    println!(
        "[CLOUD CHANGES] Phase 1 took {:?} - {} file(s) added",
        phase1_duration, indexed_count
    );

    // Send notifications and emit events immediately after Phase 1
    if indexed_count > 0 {
        // Collect titles for notifications
        let titles: Vec<String> = indexed_items
            .iter()
            .map(|(_, title, _, is_tv, season, episode, _, _)| {
                if *is_tv {
                    format!(
                        "{} S{:02}E{:02}",
                        title,
                        season.unwrap_or(1),
                        episode.unwrap_or(1)
                    )
                } else {
                    title.clone()
                }
            })
            .collect();

        println!("[CLOUD CHANGES] ┌─────────────────────────────────────────");
        println!("[CLOUD CHANGES] │ ADDED TO LIBRARY:");
        for title in &titles {
            println!("[CLOUD CHANGES] │   ✓ {}", title);
        }
        println!("[CLOUD CHANGES] └─────────────────────────────────────────");

        // Emit library-updated so UI refreshes immediately
        window.emit("library-updated", ()).ok();

        // Send Windows notification for each item (simple format)
        for title in &titles {
            dispatch_notification(
                &window,
                "StreamVault",
                &format!("{} added to your library", title),
                "success",
            );
        }
    }

    // PHASE 2: Fetch metadata in background (don't block)
    if !indexed_items.is_empty() {
        let api_key = {
            let config = state.config.lock().map_err(|e| e.to_string())?;
            tmdb::get_tmdb_credential(&config.tmdb_api_key.clone().unwrap_or_default())
        };

        // API key is always available now with default
        if !api_key.is_empty() {
            let db_path_bg = db_path.clone();
            let image_cache_dir_bg = image_cache_dir.clone();
            let window_bg = window.clone();
            let indexed_items_bg = indexed_items.clone();

            println!("[CLOUD CHANGES] ┌─────────────────────────────────────────");
            println!("[CLOUD CHANGES] │ PHASE 2: Fetching metadata in background...");
            println!("[CLOUD CHANGES] └─────────────────────────────────────────");

            // Spawn background task for metadata fetching
            tokio::spawn(async move {
                let metadata_start = std::time::Instant::now();

                let result = tokio::task::spawn_blocking(move || {
                    let db = match database::Database::new(&db_path_bg) {
                        Ok(d) => d,
                        Err(e) => {
                            println!("[CLOUD CHANGES BG] Failed to open database: {}", e);
                            return;
                        }
                    };

                    let mut tv_metadata_cache: std::collections::HashMap<String, Option<tmdb::TmdbMetadata>> = std::collections::HashMap::new();
                    let mut tv_show_updated: std::collections::HashSet<String> = std::collections::HashSet::new();
                    let mut season_cache: std::collections::HashMap<(String, i32), Vec<tmdb::TmdbEpisodeInfo>> = std::collections::HashMap::new();

                    for (media_id, title, _file_id, is_tv, season_opt, episode_opt, _folder_id, year) in indexed_items_bg {
                        if is_tv {
                            let season = season_opt.unwrap_or(1);
                            let episode = episode_opt.unwrap_or(1);
                            let title_lower = title.to_lowercase();

                            println!("[CLOUD CHANGES BG] Processing {} S{:02}E{:02}...", title, season, episode);

                            // Get or fetch TV show metadata
                            let show_meta = if let Some(cached) = tv_metadata_cache.get(&title_lower) {
                                cached.clone()
                            } else {
                                println!("[CLOUD CHANGES BG]   Searching TMDB for show '{}'...", title);
                                let meta = tmdb::search_metadata(&api_key, &title, "tv", year, &image_cache_dir_bg).ok().flatten();
                                if meta.is_some() {
                                    println!("[CLOUD CHANGES BG]   ✓ Found show metadata");
                                } else {
                                    println!("[CLOUD CHANGES BG]   ✗ Show not found on TMDB");
                                }
                                tv_metadata_cache.insert(title_lower.clone(), meta.clone());
                                meta
                            };

                            if let Some(ref meta) = show_meta {
                                // Update the parent TV show with poster (only once per show)
                                if !tv_show_updated.contains(&title_lower) {
                                    if let Some(show) = find_existing_cloud_tvshow(&db, &title, None) {
                                        let mut show_meta_to_apply = meta.clone();
                                        show_meta_to_apply.title = media_manager::prefer_title_with_leading_article(&title, &show_meta_to_apply.title);
                                        if db.update_metadata(show.id, &show_meta_to_apply).is_ok() {
                                            println!("[CLOUD CHANGES BG]   ✓ Updated TV show poster for '{}'", title);
                                        }
                                    }
                                    tv_show_updated.insert(title_lower.clone());
                                }

                                // Fetch episode metadata
                                if let Some(ref tmdb_id) = meta.tmdb_id {
                                    let cache_key = (tmdb_id.clone(), season);
                                    let episodes = if let Some(cached_eps) = season_cache.get(&cache_key) {
                                        cached_eps.clone()
                                    } else {
                                        println!("[CLOUD CHANGES BG]   Fetching season {} episodes from TMDB...", season);
                                        match tmdb::fetch_season_episodes(&api_key, tmdb_id, season, &title, &image_cache_dir_bg) {
                                            Ok(season_info) => {
                                                println!("[CLOUD CHANGES BG]   ✓ Got {} episodes for season {}", season_info.episodes.len(), season);
                                                let eps = season_info.episodes.clone();
                                                season_cache.insert(cache_key.clone(), eps.clone());
                                                eps
                                            }
                                            Err(e) => {
                                                println!("[CLOUD CHANGES BG]   ✗ Failed to fetch season {}: {}", season, e);
                                                season_cache.insert(cache_key.clone(), Vec::new());
                                                Vec::new()
                                            }
                                        }
                                    };

                                    // Find and update episode metadata
                                    if let Some(ep_info) = episodes.iter().find(|e| e.episode_number == episode) {
                                        if db.update_episode_metadata(
                                            media_id,
                                            Some(&ep_info.name),
                                            ep_info.overview.as_deref(),
                                            ep_info.still_path.as_deref()
                                        ).is_ok() {
                                            println!("[CLOUD CHANGES BG]   ✓ Updated episode metadata: {} S{:02}E{:02}", title, season, episode);
                                        } else {
                                            println!("[CLOUD CHANGES BG]   ✗ Failed to update episode in DB");
                                        }
                                    } else {
                                        println!("[CLOUD CHANGES BG]   ✗ Episode {} not found in TMDB season data (available: {:?})",
                                            episode,
                                            episodes.iter().map(|e| e.episode_number).collect::<Vec<_>>()
                                        );
                                    }
                                }
                            }
                        } else {
                            // Movie metadata
                            println!("[CLOUD CHANGES BG] Processing movie '{}'...", title);
                            match tmdb::search_metadata(&api_key, &title, "movie", year, &image_cache_dir_bg) {
                                Ok(Some(meta)) => {
                                    let mut movie_meta = meta;
                                    movie_meta.title = media_manager::prefer_title_with_leading_article(&title, &movie_meta.title);
                                    if db.update_metadata(media_id, &movie_meta).is_ok() {
                                        println!("[CLOUD CHANGES BG]   ✓ Updated movie metadata: {}", movie_meta.title);
                                    } else {
                                        println!("[CLOUD CHANGES BG]   ✗ Failed to update movie in DB");
                                    }
                                }
                                Ok(None) => {
                                    println!("[CLOUD CHANGES BG]   ✗ Movie not found on TMDB");
                                }
                                Err(e) => {
                                    println!("[CLOUD CHANGES BG]   ✗ TMDB search error: {}", e);
                                }
                            }
                        }
                    }
                }).await;

                let metadata_duration = metadata_start.elapsed();
                println!(
                    "[CLOUD CHANGES BG] Metadata fetch completed in {:?}",
                    metadata_duration
                );

                // Emit library-updated again so UI gets the metadata
                window_bg.emit("library-updated", ()).ok();

                if let Err(e) = result {
                    println!("[CLOUD CHANGES BG] Background task error: {}", e);
                }
            });
        } else {
            println!("[CLOUD CHANGES] No TMDB API key - skipping metadata fetch");
        }
    }

    if indexed_count > 0 {
        if let Ok(db) = state.db.lock() {
            let merged = auto_merge_duplicate_tvshows(&db, "check_cloud_changes");
            if merged > 0 {
                window.emit("library-updated", ()).ok();
            }
        }
    }

    let total_duration = start_time.elapsed();
    let message = if indexed_count > 0 {
        format!(
            "Indexed {} new files ({} movies, {} TV)",
            indexed_count, movies_count, tv_count
        )
    } else {
        "No new files to index".to_string()
    };

    println!("[CLOUD CHANGES] ══════════════════════════════════════════");
    println!(
        "[CLOUD CHANGES] SUMMARY: {} indexed, {} skipped",
        indexed_count, skipped_count
    );
    println!("[CLOUD CHANGES] Total time: {:?}", total_duration);
    println!("[CLOUD CHANGES] ══════════════════════════════════════════");

    Ok(CloudIndexResult {
        success: true,
        indexed_count,
        skipped_count,
        movies_count,
        tv_count,
        message,
    })
}

// Clear all app data (reset to new state)
#[tauri::command]
async fn clear_all_app_data(state: State<'_, AppState>) -> Result<ApiResponse, String> {
    println!("[RESET] Starting complete app data reset...");

    // Clear database and get image cache path
    let image_cache_path = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.clear_all_data().map_err(|e| e.to_string())?
    };

    println!("[RESET] Database cleared successfully");

    // Delete image cache directory
    let cache_path = std::path::Path::new(&image_cache_path);
    if cache_path.exists() {
        match std::fs::remove_dir_all(cache_path) {
            Ok(_) => println!("[RESET] Image cache deleted successfully"),
            Err(e) => println!("[RESET] Warning: Failed to delete image cache: {}", e),
        }
        // Recreate empty image cache directory
        std::fs::create_dir_all(cache_path).ok();
    }

    println!("[RESET] App data reset complete!");

    Ok(ApiResponse {
        message: "All app data has been cleared. The app is now like new.".to_string(),
    })
}

// Response for cleanup operation
#[derive(serde::Serialize)]
struct CleanupResponse {
    success: bool,
    removed_count: usize,
    message: String,
}

// Cleanup orphaned metadata - removes entries and posters for missing files
#[tauri::command]
async fn cleanup_missing_metadata(state: State<'_, AppState>) -> Result<CleanupResponse, String> {
    println!("[CLEANUP] Starting cleanup of missing media metadata...");

    let removed_count = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let image_cache_path = database::get_image_cache_dir();
        media_manager::cleanup_orphaned_media(&db, &image_cache_path)
    };

    let message = if removed_count > 0 {
        format!(
            "Cleaned up {} orphaned entries and their posters",
            removed_count
        )
    } else {
        "No orphaned entries found. Your library is clean!".to_string()
    };

    println!("[CLEANUP] {}", message);

    Ok(CleanupResponse {
        success: true,
        removed_count,
        message,
    })
}

// Repair broken file paths - not applicable for cloud-only mode
#[tauri::command]
async fn repair_file_paths(_state: State<'_, AppState>) -> Result<ApiResponse, String> {
    // In cloud-only mode, file paths are managed by Google Drive
    // No local file repair is needed
    Ok(ApiResponse {
        message: "Cloud media paths are managed automatically by Google Drive. No repair needed."
            .to_string(),
    })
}

// Response for delete operation
#[derive(serde::Serialize)]
struct DeleteResponse {
    success: bool,
    deleted_count: usize,
    failed_count: usize,
    message: String,
}

// Delete media files permanently from disk (bypasses recycle bin)
// Also handles cloud files by deleting from Google Drive
#[tauri::command]
async fn delete_media_files(
    state: State<'_, AppState>,
    window: Window,
    media_ids: Vec<i64>,
) -> Result<DeleteResponse, String> {
    if media_ids.is_empty() {
        return Err("No media IDs provided".to_string());
    }

    println!(
        "[DELETE] Starting permanent deletion for {} items",
        media_ids.len()
    );

    // Get media info including cloud details
    let (media_info, parent_series_ids) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let info = db
            .get_media_delete_info(&media_ids)
            .map_err(|e| e.to_string())?;
        let parents = db
            .get_parent_series_ids(&media_ids)
            .map_err(|e| e.to_string())?;
        (info, parents)
    };

    let mut deleted_count = 0;
    let mut deleted_zip_archives = 0;
    let mut failed_count = 0;
    let mut deleted_file_paths: Vec<String> = Vec::new();
    let mut cloud_file_ids_to_delete: HashSet<String> = HashSet::new();
    let mut zip_archive_ids_to_delete: HashSet<String> = HashSet::new();
    let mut db_media_ids_to_delete: Vec<i64> = Vec::new();

    // Separate cloud and local files
    for (id, file_path, is_cloud, cloud_file_id, parent_zip_id) in &media_info {
        if *is_cloud {
            if let Some(zip_file_id) = parent_zip_id {
                println!(
                    "[DELETE] Queuing ZIP archive for deletion via representative item {}: {}",
                    id, zip_file_id
                );
                zip_archive_ids_to_delete.insert(zip_file_id.clone());
                continue;
            }

            // Cloud file - queue for Google Drive deletion
            if let Some(cloud_id) = cloud_file_id {
                println!(
                    "[DELETE] Queuing cloud file for deletion: {} (cloud_file_id: {})",
                    file_path.as_deref().unwrap_or("unknown"),
                    cloud_id
                );
                cloud_file_ids_to_delete.insert(cloud_id.clone());
                db_media_ids_to_delete.push(*id);
            }
        } else {
            // Local file - delete from disk
            if let Some(path_str) = file_path {
                let path = std::path::Path::new(path_str);
                if path.exists() {
                    match std::fs::remove_file(path) {
                        Ok(_) => {
                            println!("[DELETE] Successfully deleted local file: {}", path_str);
                            deleted_file_paths.push(path_str.clone());
                            deleted_count += 1;
                        }
                        Err(e) => {
                            println!("[DELETE] Failed to delete {}: {}", path_str, e);
                            failed_count += 1;
                        }
                    }
                } else {
                    println!(
                        "[DELETE] Local file not found (already deleted?): {}",
                        path_str
                    );
                    deleted_file_paths.push(path_str.clone());
                    deleted_count += 1;
                }
            }
            db_media_ids_to_delete.push(*id);
        }
    }

    if !zip_archive_ids_to_delete.is_empty() {
        println!(
            "[DELETE] Deleting {} ZIP archive(s) from Google Drive",
            zip_archive_ids_to_delete.len()
        );
        for zip_file_id in zip_archive_ids_to_delete {
            match state.gdrive_client.delete_file(&zip_file_id).await {
                Ok(_) => {
                    let archive_summary = {
                        let db = state.db.lock().map_err(|e| e.to_string())?;
                        db.remove_media_by_cloud_file_id(&zip_file_id)
                            .map_err(|e| e.to_string())?
                    };

                    if let Some((_, title, media_type, _)) = archive_summary {
                        println!("[DELETE] Successfully deleted {}: {}", media_type, title);
                    } else {
                        println!("[DELETE] Successfully deleted ZIP archive: {}", zip_file_id);
                    }

                    deleted_count += 1;
                    deleted_zip_archives += 1;
                }
                Err(e) => {
                    println!(
                        "[DELETE] Failed to delete ZIP archive {}: {}",
                        zip_file_id, e
                    );
                    failed_count += 1;
                }
            }
        }
    }

    // Delete cloud files from Google Drive
    if !cloud_file_ids_to_delete.is_empty() {
        println!(
            "[DELETE] Deleting {} cloud files from Google Drive",
            cloud_file_ids_to_delete.len()
        );
        for cloud_file_id in cloud_file_ids_to_delete {
            match state.gdrive_client.delete_file(&cloud_file_id).await {
                Ok(_) => {
                    println!(
                        "[DELETE] Successfully deleted cloud file: {}",
                        cloud_file_id
                    );
                    deleted_count += 1;
                }
                Err(e) => {
                    println!(
                        "[DELETE] Failed to delete cloud file {}: {}",
                        cloud_file_id, e
                    );
                    failed_count += 1;
                }
            }
        }
    }

    // Delete from database
    if !db_media_ids_to_delete.is_empty() {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.delete_media_entries(&db_media_ids_to_delete)
            .map_err(|e| e.to_string())?;
    }

    // Cleanup empty series if we deleted the last episode(s)
    let mut cleaned_empty_series = false;
    if !parent_series_ids.is_empty() {
        let series_cleanup: Vec<(i64, String, bool, Option<String>, bool)> = {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            let mut list = Vec::new();
            for series_id in parent_series_ids {
                let has_episodes = db
                    .series_has_episodes(series_id)
                    .map_err(|e| e.to_string())?;
                if has_episodes {
                    continue;
                }

                let media = db.get_media_by_id(series_id).map_err(|e| e.to_string())?;
                let (is_cloud, folder_id) = db
                    .get_series_cloud_info(series_id)
                    .map_err(|e| e.to_string())?;
                let is_tracked_folder = if let Some(ref folder) = folder_id {
                    db.get_cloud_folders()
                        .map(|folders| folders.iter().any(|(id, _, _)| id == folder))
                        .unwrap_or(false)
                } else {
                    false
                };

                list.push((
                    series_id,
                    media.title,
                    is_cloud,
                    folder_id,
                    is_tracked_folder,
                ));
            }
            list
        };

        for (series_id, title, is_cloud, folder_id, is_tracked_folder) in series_cleanup {
            if is_cloud {
                if let Some(folder_id) = folder_id {
                    if is_tracked_folder {
                        println!(
                            "[DELETE] SAFETY: Refusing to delete tracked root folder: {}",
                            folder_id
                        );
                    } else {
                        println!(
                            "[DELETE] Skipping cloud folder delete for empty series '{}': {}",
                            title, folder_id
                        );
                    }
                }
            }

            let db = state.db.lock().map_err(|e| e.to_string())?;
            db.remove_media(series_id).map_err(|e| e.to_string())?;
            cleaned_empty_series = true;
        }
    }

    if cleaned_empty_series {
        window.emit("library-updated", ()).ok();
    }

    // Clean up empty parent directories (only for local files)
    media_manager::cleanup_empty_parent_dirs(&deleted_file_paths);

    let message =
        if failed_count == 0 && deleted_zip_archives > 0 && deleted_count == deleted_zip_archives {
            format!(
                "Successfully deleted {} ZIP archive(s)",
                deleted_zip_archives
            )
        } else if failed_count == 0 && deleted_zip_archives > 0 {
            format!(
                "Successfully deleted {} item(s), including {} ZIP archive(s)",
                deleted_count, deleted_zip_archives
            )
        } else if failed_count == 0 {
            format!("Successfully deleted {} file(s)", deleted_count)
        } else {
            format!("Deleted {} file(s), {} failed", deleted_count, failed_count)
        };

    println!("[DELETE] Complete: {}", message);

    Ok(DeleteResponse {
        success: failed_count == 0,
        deleted_count,
        failed_count,
        message,
    })
}

// Episode info for delete selection modal
#[derive(serde::Serialize)]
struct EpisodeDeleteInfo {
    id: i64,
    title: String,
    season_number: Option<i32>,
    episode_number: Option<i32>,
    file_path: Option<String>,
    parent_zip_id: Option<String>,
    delete_kind: String,
    archive_episode_count: Option<i32>,
}

// Get episodes for a TV show for delete selection
#[tauri::command]
async fn get_episodes_for_delete(
    state: State<'_, AppState>,
    series_id: i64,
) -> Result<Vec<EpisodeDeleteInfo>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let episodes = db.get_episodes(series_id).map_err(|e| e.to_string())?;

    let mut zip_archive_details: HashMap<String, (String, i32)> = HashMap::new();
    for episode in &episodes {
        if let Some(zip_file_id) = episode.parent_zip_id.as_deref() {
            let archive_name = zip_archive_details
                .entry(zip_file_id.to_string())
                .or_insert_with(|| {
                    let archive_name = db
                        .get_zip_archive(zip_file_id)
                        .map(|archive| archive.filename)
                        .unwrap_or_else(|_| "ZIP archive".to_string());
                    (archive_name, 0)
                });
            archive_name.1 += 1;
        }
    }

    let mut seen_zip_archives = HashSet::new();
    let mut result = Vec::new();

    for episode in episodes {
        if let Some(zip_file_id) = episode.parent_zip_id.clone() {
            if seen_zip_archives.insert(zip_file_id.clone()) {
                let (archive_name, archive_episode_count) = zip_archive_details
                    .get(&zip_file_id)
                    .cloned()
                    .unwrap_or_else(|| ("ZIP archive".to_string(), 1));
                let archive_suffix = if archive_episode_count == 1 {
                    "episode"
                } else {
                    "episodes"
                };

                result.push(EpisodeDeleteInfo {
                    id: episode.id,
                    title: archive_name,
                    season_number: None,
                    episode_number: None,
                    file_path: Some(format!(
                        "Deletes the ZIP archive from Google Drive and removes {} indexed {}.",
                        archive_episode_count, archive_suffix
                    )),
                    parent_zip_id: Some(zip_file_id),
                    delete_kind: "zip_archive".to_string(),
                    archive_episode_count: Some(archive_episode_count),
                });
            }

            continue;
        }

        result.push(EpisodeDeleteInfo {
            id: episode.id,
            title: episode.title,
            season_number: episode.season_number,
            episode_number: episode.episode_number,
            file_path: episode.file_path,
            parent_zip_id: None,
            delete_kind: "episode".to_string(),
            archive_episode_count: None,
        });
    }

    Ok(result)
}

// Delete a TV show series and optionally all its episodes
#[tauri::command]
async fn delete_series(
    state: State<'_, AppState>,
    series_id: i64,
    delete_files: bool,
) -> Result<DeleteResponse, String> {
    println!(
        "[DELETE] Deleting series ID {} (delete_files: {})",
        series_id, delete_files
    );

    // Get series cloud info first
    let (is_cloud_series, cloud_folder_id) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_series_cloud_info(series_id)
            .map_err(|e| e.to_string())?
    };

    println!(
        "[DELETE] Series is_cloud: {}, cloud_folder_id: {:?}",
        is_cloud_series, cloud_folder_id
    );

    // Get all episode IDs and their cloud info
    let episode_ids: Vec<i64> = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let episodes = db.get_episodes(series_id).map_err(|e| e.to_string())?;
        episodes.into_iter().map(|ep| ep.id).collect()
    };

    let mut total_deleted = 0;
    let mut total_failed = 0;
    let mut deleted_file_paths: Vec<String> = Vec::new();

    // Delete episodes if there are any
    if !episode_ids.is_empty() {
        // Get detailed info for cloud file deletion
        let episode_info = {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db.get_media_delete_info(&episode_ids)
                .map_err(|e| e.to_string())?
        };

        if delete_files {
            // Handle cloud episode files
            let mut cloud_file_ids: Vec<String> = Vec::new();
            let mut local_file_paths: Vec<String> = Vec::new();

            for (_id, file_path, is_cloud, cloud_file_id, _parent_zip_id) in &episode_info {
                if *is_cloud {
                    if let Some(cloud_id) = cloud_file_id {
                        cloud_file_ids.push(cloud_id.clone());
                    }
                } else if let Some(path) = file_path {
                    local_file_paths.push(path.clone());
                }
            }

            // Delete cloud files from Google Drive
            if !cloud_file_ids.is_empty() {
                println!(
                    "[DELETE] Deleting {} cloud episode files from Google Drive",
                    cloud_file_ids.len()
                );
                for cloud_file_id in cloud_file_ids {
                    match state.gdrive_client.delete_file(&cloud_file_id).await {
                        Ok(_) => {
                            println!("[DELETE] Deleted cloud episode: {}", cloud_file_id);
                            total_deleted += 1;
                        }
                        Err(e) => {
                            println!(
                                "[DELETE] Failed to delete cloud episode {}: {}",
                                cloud_file_id, e
                            );
                            total_failed += 1;
                        }
                    }
                }
            }

            // Delete local files
            for file_path in local_file_paths {
                let path = std::path::Path::new(&file_path);
                if path.exists() {
                    match std::fs::remove_file(path) {
                        Ok(_) => {
                            println!("[DELETE] Deleted episode file: {}", file_path);
                            deleted_file_paths.push(file_path);
                            total_deleted += 1;
                        }
                        Err(e) => {
                            println!("[DELETE] Failed to delete episode {}: {}", file_path, e);
                            total_failed += 1;
                        }
                    }
                } else {
                    deleted_file_paths.push(file_path);
                    total_deleted += 1;
                }
            }
        } else {
            total_deleted = episode_ids.len();
        }

        // Delete episode entries from database
        {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db.delete_media_entries(&episode_ids)
                .map_err(|e| e.to_string())?;
        }
    }

    // Clean up empty parent directories (only for local files)
    if delete_files && !deleted_file_paths.is_empty() {
        media_manager::cleanup_empty_parent_dirs(&deleted_file_paths);
    }

    // Delete the series entry itself
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.remove_media(series_id).map_err(|e| e.to_string())?;
    }

    let message = format!("Deleted series and {} episode(s)", total_deleted);
    println!("[DELETE] {}", message);

    Ok(DeleteResponse {
        success: total_failed == 0,
        deleted_count: total_deleted + 1, // +1 for the series itself
        failed_count: total_failed,
        message,
    })
}

// Remove a TV series from the database and delete only matching cloud files
#[tauri::command]
async fn delete_series_cloud_folder(
    state: State<'_, AppState>,
    series_id: i64,
) -> Result<ApiResponse, String> {
    // Get series info including cloud folder ID
    let (series_title, is_cloud, cloud_folder_id) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let media = db.get_media_by_id(series_id).map_err(|e| e.to_string())?;
        let (is_cloud, folder_id) = db
            .get_series_cloud_info(series_id)
            .map_err(|e| e.to_string())?;
        (media.title, is_cloud, folder_id)
    };

    println!(
        "[DELETE] Removing series '{}' (ID: {}) - is_cloud: {}, folder_id: {:?}",
        series_title, series_id, is_cloud, cloud_folder_id
    );

    // Never delete parent folders from Drive; only delete matching files
    if is_cloud {
        let episode_ids: Vec<i64> = {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            let episodes = db.get_episodes(series_id).map_err(|e| e.to_string())?;
            episodes.into_iter().map(|ep| ep.id).collect()
        };

        if !episode_ids.is_empty() {
            let episode_info = {
                let db = state.db.lock().map_err(|e| e.to_string())?;
                db.get_media_delete_info(&episode_ids)
                    .map_err(|e| e.to_string())?
            };

            for (_id, _file_path, _is_cloud, cloud_file_id, _parent_zip_id) in episode_info {
                if let Some(cloud_id) = cloud_file_id {
                    println!(
                        "[DELETE] Deleting cloud file for series '{}': {}",
                        series_title, cloud_id
                    );
                    if let Err(e) = state.gdrive_client.delete_file(&cloud_id).await {
                        println!(
                            "[DELETE] Warning: Failed to delete cloud file {}: {}",
                            cloud_id, e
                        );
                    }
                }
            }
        }
    }

    // Delete all episodes from database first
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.remove_series_episodes(series_id)
            .map_err(|e| e.to_string())?;
    }

    // Remove the series from database
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.remove_media(series_id).map_err(|e| e.to_string())?;
    }

    Ok(ApiResponse {
        message: format!("Series '{}' completely removed", series_title),
    })
}

// Auto-detect MPV executable on the system
#[tauri::command]
async fn auto_detect_mpv(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let result = config::auto_detect_mpv(&mut config);
    Ok(result)
}

// Get configuration
#[tauri::command]
async fn get_config(state: State<'_, AppState>) -> Result<config::Config, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.clone())
}

// Save configuration
#[tauri::command]
async fn save_config(
    state: State<'_, AppState>,
    new_config: config::Config,
) -> Result<ApiResponse, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    *config = new_config.clone();
    config::save_config(&new_config).map_err(|e| e.to_string())?;
    Ok(ApiResponse {
        message: "Configuration saved.".to_string(),
    })
}

// Get scan status
#[tauri::command]
async fn get_scan_status(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.is_scanning.load(Ordering::SeqCst))
}

// Merge duplicate TV shows into single entries
#[tauri::command]
async fn merge_duplicate_shows(state: State<'_, AppState>) -> Result<ApiResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let merged_count = db.merge_duplicate_tvshows().map_err(|e| e.to_string())?;
    Ok(ApiResponse {
        message: format!("Merged {} duplicate TV shows", merged_count),
    })
}

// Get resume info for a media item
#[tauri::command]
async fn get_resume_info(
    state: State<'_, AppState>,
    media_id: i64,
) -> Result<database::ResumeInfo, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_resume_info(media_id).map_err(|e| e.to_string())
}

// Get media info by ID
#[tauri::command]
async fn get_media_info(
    state: State<'_, AppState>,
    media_id: i64,
) -> Result<database::MediaItem, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let item = db.get_media_by_id(media_id).map_err(|e| e.to_string())?;
    Ok(enrich_media_item_archive_assessment(item))
}

#[tauri::command]
async fn get_archive_playback_assessment(
    state: State<'_, AppState>,
    media_id: i64,
) -> Result<Option<archive_manager::ArchivePlaybackAssessment>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let item = db.get_media_by_id(media_id).map_err(|e| e.to_string())?;
    Ok(archive_manager::assess_archive_playback(&item))
}

// Get stream info for built-in player
#[derive(Serialize)]
pub struct StreamInfo {
    pub stream_url: String,
    pub file_path: String,
    pub title: String,
    pub poster: Option<String>,
    pub duration_seconds: Option<f64>,
    pub resume_position_seconds: Option<f64>,
    // Cloud streaming fields
    pub is_cloud: bool,
    pub access_token: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct AudioTrackInfo {
    pub stream_index: i32,
    pub track_id: Option<i32>,
    pub language_code: Option<String>,
    pub label: String,
    pub detail: Option<String>,
    pub mpv_value: Option<String>,
}

#[derive(Clone, Serialize)]
struct MpvAudioTracksDetectedPayload {
    media_id: i64,
    series_id: Option<i64>,
    season_number: Option<i32>,
    tracks: Vec<AudioTrackInfo>,
}

#[derive(Deserialize)]
struct FfprobeStreamsOutput {
    #[serde(default)]
    streams: Vec<FfprobeAudioStream>,
}

#[derive(Deserialize)]
struct FfprobeAudioStream {
    index: i32,
    #[serde(default)]
    tags: HashMap<String, String>,
}

struct AudioProbeSource {
    stream_url: String,
    access_token: Option<String>,
    temp_zip_proxy: Option<zip_stream_proxy::ZipStreamProxyHandle>,
}

#[derive(Deserialize)]
struct MpvIpcMessage {
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    data: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    request_id: Option<u64>,
}

fn resolve_ffprobe_path(config: &config::Config) -> Option<String> {
    let configured = config
        .ffprobe_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if let Some(path) = configured {
        if std::path::Path::new(&path).exists()
            && config::validate_executable_path(&path, "ffprobe").is_ok()
        {
            return Some(path);
        }
    }

    if let Some(ffmpeg_path) = config
        .ffmpeg_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let sibling = std::path::Path::new(ffmpeg_path).with_file_name("ffprobe.exe");
        if sibling.exists()
            && config::validate_executable_path(&sibling.to_string_lossy(), "ffprobe").is_ok()
        {
            return Some(sibling.to_string_lossy().to_string());
        }
    }

    if let Ok(output) = std::process::Command::new("where")
        .arg("ffprobe.exe")
        .output()
    {
        if output.status.success() {
            if let Ok(paths) = String::from_utf8(output.stdout) {
                if let Some(path) = paths.lines().map(str::trim).find(|value| !value.is_empty()) {
                    if std::path::Path::new(path).exists()
                        && config::validate_executable_path(path, "ffprobe").is_ok()
                    {
                        return Some(path.to_string());
                    }
                }
            }
        }
    }

    None
}

fn infer_language_from_text(value: &str) -> Option<(&'static str, &'static str, &'static str)> {
    let normalized = value.trim().to_lowercase();

    match normalized.as_str() {
        "en" | "eng" | "english" => Some(("en", "English", "en,eng,english")),
        "hi" | "hin" | "hindi" => Some(("hi", "Hindi", "hi,hin,hindi")),
        "ta" | "tam" | "tamil" => Some(("ta", "Tamil", "ta,tam,tamil")),
        "te" | "tel" | "telugu" => Some(("te", "Telugu", "te,tel,telugu")),
        "ml" | "mal" | "malayalam" => Some(("ml", "Malayalam", "ml,mal,malayalam")),
        "ja" | "jpn" | "japanese" => Some(("ja", "Japanese", "ja,jpn,japanese")),
        "ko" | "kor" | "korean" => Some(("ko", "Korean", "ko,kor,korean")),
        "ar" | "ara" | "arabic" => Some(("ar", "Arabic", "ar,ara,arabic")),
        "fr" | "fra" | "fre" | "french" => Some(("fr", "French", "fr,fra,french")),
        "es" | "spa" | "spanish" => Some(("es", "Spanish", "es,spa,spanish")),
        "de" | "deu" | "ger" | "german" => Some(("de", "German", "de,deu,german")),
        "it" | "ita" | "italian" => Some(("it", "Italian", "it,ita,italian")),
        "ru" | "rus" | "russian" => Some(("ru", "Russian", "ru,rus,russian")),
        "und" | "" => None,
        _ => {
            let contains = |needle: &str| normalized.contains(needle);

            if contains("english") {
                Some(("en", "English", "en,eng,english"))
            } else if contains("hindi") {
                Some(("hi", "Hindi", "hi,hin,hindi"))
            } else if contains("tamil") {
                Some(("ta", "Tamil", "ta,tam,tamil"))
            } else if contains("telugu") {
                Some(("te", "Telugu", "te,tel,telugu"))
            } else if contains("malayalam") {
                Some(("ml", "Malayalam", "ml,mal,malayalam"))
            } else if contains("japanese") {
                Some(("ja", "Japanese", "ja,jpn,japanese"))
            } else if contains("korean") {
                Some(("ko", "Korean", "ko,kor,korean"))
            } else if contains("arabic") {
                Some(("ar", "Arabic", "ar,ara,arabic"))
            } else if contains("french") {
                Some(("fr", "French", "fr,fra,french"))
            } else if contains("spanish") {
                Some(("es", "Spanish", "es,spa,spanish"))
            } else if contains("german") {
                Some(("de", "German", "de,deu,german"))
            } else if contains("italian") {
                Some(("it", "Italian", "it,ita,italian"))
            } else if contains("russian") {
                Some(("ru", "Russian", "ru,rus,russian"))
            } else {
                None
            }
        }
    }
}

fn build_audio_track_info(
    stream_index: i32,
    track_id: Option<i32>,
    language_tag: Option<String>,
    title: Option<String>,
) -> AudioTrackInfo {
    let language_tag = language_tag
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let title = title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let inferred = language_tag
        .as_deref()
        .and_then(infer_language_from_text)
        .or_else(|| title.as_deref().and_then(infer_language_from_text));

    let (language_code, label, mpv_value) = if let Some((code, name, mpv_value)) = inferred {
        (
            Some(code.to_string()),
            name.to_string(),
            Some(mpv_value.to_string()),
        )
    } else if let Some(tag) = language_tag.as_deref() {
        (
            Some(tag.to_lowercase()),
            tag.to_uppercase(),
            Some(tag.to_lowercase()),
        )
    } else {
        (
            None,
            title
                .clone()
                .unwrap_or_else(|| format!("Track {}", stream_index + 1)),
            None,
        )
    };

    let detail = match title {
        Some(track_title) if track_title.to_lowercase() != label.to_lowercase() => {
            Some(track_title)
        }
        _ => language_tag
            .filter(|tag| tag.to_lowercase() != label.to_lowercase())
            .filter(|tag| tag.to_lowercase() != language_code.clone().unwrap_or_default()),
    };

    AudioTrackInfo {
        stream_index,
        track_id,
        language_code,
        label,
        detail,
        mpv_value,
    }
}

fn normalize_audio_track(stream: FfprobeAudioStream) -> AudioTrackInfo {
    let language_tag = stream
        .tags
        .get("language")
        .or_else(|| stream.tags.get("LANGUAGE"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let title = stream
        .tags
        .get("title")
        .or_else(|| stream.tags.get("handler_name"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    build_audio_track_info(stream.index, None, language_tag, title)
}

fn normalize_mpv_audio_track(track: &serde_json::Value) -> Option<AudioTrackInfo> {
    if track.get("type").and_then(|value| value.as_str()) != Some("audio") {
        return None;
    }

    let stream_index = track
        .get("ff-index")
        .and_then(|value| value.as_i64())
        .or_else(|| track.get("id").and_then(|value| value.as_i64()))
        .unwrap_or(0) as i32;
    let track_id = track
        .get("id")
        .and_then(|value| value.as_i64())
        .map(|value| value as i32);
    let language_tag = track
        .get("lang")
        .or_else(|| track.get("language"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let title = track
        .get("title")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let codec = track
        .get("codec")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let selected = track
        .get("selected")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    let mut normalized = build_audio_track_info(stream_index, track_id, language_tag, title);
    if let Some(id) = track_id.filter(|value| *value > 0) {
        normalized.mpv_value = Some(format!("aid:{}", id));
    }
    let mut detail_parts = Vec::new();

    if let Some(detail) = normalized.detail.take() {
        detail_parts.push(detail);
    }

    if let Some(codec_name) = codec {
        let already_listed = detail_parts
            .iter()
            .any(|part| part.eq_ignore_ascii_case(&codec_name));
        if !already_listed {
            detail_parts.push(codec_name);
        }
    }

    if selected {
        detail_parts.push("Selected".to_string());
    }

    normalized.detail = if detail_parts.is_empty() {
        None
    } else {
        Some(detail_parts.join(" • "))
    };

    Some(normalized)
}

fn parse_mpv_audio_tracks(value: &serde_json::Value) -> Vec<AudioTrackInfo> {
    let serde_json::Value::Array(items) = value else {
        return Vec::new();
    };

    let mut seen = HashSet::new();
    let mut tracks = Vec::new();

    for track in items.iter().filter_map(normalize_mpv_audio_track) {
        let key = (
            track.stream_index,
            track.label.to_lowercase(),
            track.mpv_value.clone().unwrap_or_default(),
        );
        if seen.insert(key) {
            tracks.push(track);
        }
    }

    tracks
}

#[cfg(windows)]
fn detect_audio_tracks_from_running_mpv(pipe_name: &str) -> Result<Vec<AudioTrackInfo>, String> {
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let mut file = None;
    for _ in 0..100 {
        let wide_name: Vec<u16> = pipe_name.encode_utf16().chain(std::iter::once(0)).collect();

        let handle = unsafe {
            CreateFileW(
                wide_name.as_ptr(),
                0x80000000 | 0x40000000,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                0,
            )
        };

        if handle != INVALID_HANDLE_VALUE {
            file = Some(unsafe { std::fs::File::from_raw_handle(handle as *mut std::ffi::c_void) });
            break;
        }

        std::thread::sleep(Duration::from_millis(100));
    }

    let mut pipe_file =
        file.ok_or_else(|| format!("Failed to connect to MPV pipe: {}", pipe_name))?;
    let read_file = pipe_file
        .try_clone()
        .map_err(|error| format!("Failed to clone MPV pipe handle: {}", error))?;
    let mut reader = BufReader::new(read_file);

    let observe_tracks = serde_json::json!({
        "command": ["observe_property", 91, "track-list"],
    });
    let read_tracks = serde_json::json!({
        "command": ["get_property", "track-list"],
        "request_id": 901,
    });

    writeln!(pipe_file, "{}", observe_tracks)
        .map_err(|error| format!("Failed to observe MPV track-list: {}", error))?;
    writeln!(pipe_file, "{}", read_tracks)
        .map_err(|error| format!("Failed to request MPV track-list: {}", error))?;

    loop {
        let mut line = String::new();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|error| format!("Failed to read MPV IPC response: {}", error))?;

        if bytes_read == 0 {
            return Ok(Vec::new());
        }

        let message = match serde_json::from_str::<MpvIpcMessage>(line.trim()) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };

        match message.event.as_deref() {
            Some("file-loaded") => {
                writeln!(pipe_file, "{}", read_tracks)
                    .map_err(|error| format!("Failed to refresh MPV track-list: {}", error))?;
            }
            Some("shutdown") | Some("end-file") => return Ok(Vec::new()),
            _ => {}
        }

        let is_track_update = matches!(message.event.as_deref(), Some("property-change"))
            && message.name.as_deref() == Some("track-list");
        let is_track_response = message.request_id == Some(901)
            && message.error.as_deref() != Some("property unavailable");

        if is_track_update || is_track_response {
            if let Some(data) = message.data.as_ref() {
                let tracks = parse_mpv_audio_tracks(data);
                if !tracks.is_empty() {
                    return Ok(tracks);
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn detect_audio_tracks_from_running_mpv(_pipe_name: &str) -> Result<Vec<AudioTrackInfo>, String> {
    Err("MPV IPC audio detection is currently supported only on Windows".to_string())
}

fn probe_audio_tracks_with_ffprobe(
    ffprobe_path: &str,
    source: &str,
    access_token: Option<&str>,
) -> Result<Vec<AudioTrackInfo>, String> {
    config::validate_executable_path(ffprobe_path, "ffprobe")?;

    let mut command = std::process::Command::new(ffprobe_path);
    command
        .arg("-v")
        .arg("error")
        .arg("-probesize")
        .arg("1048576")
        .arg("-analyzeduration")
        .arg("1000000")
        .arg("-select_streams")
        .arg("a")
        .arg("-show_entries")
        .arg("stream=index:stream_tags=language,title,handler_name,LANGUAGE")
        .arg("-of")
        .arg("json");

    if let Some(token) = access_token.filter(|value| !value.trim().is_empty()) {
        command
            .arg("-headers")
            .arg(format!("Authorization: Bearer {}\r\n", token));
    }

    let output = command
        .arg("--")
        .arg(source)
        .output()
        .map_err(|error| format!("Failed to run ffprobe: {}", error))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ffprobe could not read audio streams: {}",
            stderr.trim()
        ));
    }

    let parsed: FfprobeStreamsOutput = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Failed to parse ffprobe output: {}", error))?;

    Ok(parsed
        .streams
        .into_iter()
        .map(normalize_audio_track)
        .collect())
}

async fn resolve_audio_probe_source(
    state: &AppState,
    media: &database::MediaItem,
) -> Result<AudioProbeSource, String> {
    let file_path = media.file_path.clone().unwrap_or_default();
    let is_cloud = media.is_cloud.unwrap_or(false);
    let is_zip_media = media.parent_zip_id.is_some();

    if is_cloud {
        if is_zip_media {
            match archive_manager::archive_format_for_media(media) {
                archive_manager::ArchiveFormat::Zip => {
                    match zip_manager::zip_entry_compression_method(media)
                        .map_err(|e| e.to_string())?
                    {
                        0 => {
                            let (stream_url, proxy) =
                                build_temporary_zip_stream_url(state, media).await?;
                            return Ok(AudioProbeSource {
                                stream_url,
                                access_token: None,
                                temp_zip_proxy: Some(proxy),
                            });
                        }
                        8 => {
                            let extracted_path = build_zip_extracted_path(state, media).await?;
                            return Ok(AudioProbeSource {
                                stream_url: extracted_path,
                                access_token: None,
                                temp_zip_proxy: None,
                            });
                        }
                        method => {
                            return Err(format!(
                                "ZIP entry compression method {} is not supported for audio detection",
                                method
                            ));
                        }
                    }
                }
                archive_manager::ArchiveFormat::Tar | archive_manager::ArchiveFormat::Rar => {
                    if archive_manager::build_archive_stream_info(media).is_ok() {
                        let (stream_url, proxy) =
                            build_temporary_zip_stream_url(state, media).await?;
                        return Ok(AudioProbeSource {
                            stream_url,
                            access_token: None,
                            temp_zip_proxy: Some(proxy),
                        });
                    }

                    let extracted_path = build_zip_extracted_path(state, media).await?;
                    return Ok(AudioProbeSource {
                        stream_url: extracted_path,
                        access_token: None,
                        temp_zip_proxy: None,
                    });
                }
            }
        }

        if let Some(ref cloud_file_id) = media.cloud_file_id {
            let (stream_url, access_token) =
                state.gdrive_client.get_stream_url(cloud_file_id).await?;
            return Ok(AudioProbeSource {
                stream_url,
                access_token: Some(access_token),
                temp_zip_proxy: None,
            });
        }

        return Err("Cloud file ID not found".to_string());
    }

    if file_path.is_empty() || !std::path::Path::new(&file_path).exists() {
        return Err("File not found".to_string());
    }

    Ok(AudioProbeSource {
        stream_url: file_path,
        access_token: None,
        temp_zip_proxy: None,
    })
}

#[tauri::command]
async fn get_audio_tracks(
    state: State<'_, AppState>,
    media_id: i64,
) -> Result<Vec<AudioTrackInfo>, String> {
    let config = {
        let c = state.config.lock().map_err(|e| e.to_string())?;
        c.clone()
    };
    let ffprobe_path = resolve_ffprobe_path(&config).ok_or_else(|| {
        "FFprobe is not configured. Set FFprobe in Settings > Player to detect audio tracks."
            .to_string()
    })?;
    let media = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_media_by_id(media_id).map_err(|e| e.to_string())?
    };

    let mut source = resolve_audio_probe_source(&state, &media).await?;
    let result = probe_audio_tracks_with_ffprobe(
        &ffprobe_path,
        &source.stream_url,
        source.access_token.as_deref(),
    );

    if let Some(proxy) = source.temp_zip_proxy.as_mut() {
        proxy.stop();
    }

    result
}

#[tauri::command]
async fn get_stream_info(state: State<'_, AppState>, media_id: i64) -> Result<StreamInfo, String> {
    let media = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_media_by_id(media_id).map_err(|e| e.to_string())?
    };

    let file_path = media.file_path.clone().unwrap_or_default();
    let is_cloud = media.is_cloud.unwrap_or(false);
    let is_zip_media = media.parent_zip_id.is_some();

    // Handle cloud media
    if is_cloud {
        if is_zip_media {
            match archive_manager::archive_format_for_media(&media) {
                archive_manager::ArchiveFormat::Zip => {
                    match zip_manager::zip_entry_compression_method(&media)
                        .map_err(|e| e.to_string())?
                    {
                        0 => {
                            let stream_url = build_zip_stream_url(&state, &media, media_id).await?;

                            return Ok(StreamInfo {
                                stream_url,
                                file_path,
                                title: media.title,
                                poster: poster_asset_url(media.poster_path.as_ref()),
                                duration_seconds: media.duration_seconds,
                                resume_position_seconds: media.resume_position_seconds,
                                is_cloud: true,
                                access_token: None,
                            });
                        }
                        8 => {
                            let extracted_path = build_zip_extracted_path(&state, &media).await?;

                            return Ok(StreamInfo {
                                stream_url: extracted_path.clone(),
                                file_path: extracted_path,
                                title: media.title,
                                poster: poster_asset_url(media.poster_path.as_ref()),
                                duration_seconds: media.duration_seconds,
                                resume_position_seconds: media.resume_position_seconds,
                                is_cloud: false,
                                access_token: None,
                            });
                        }
                        method => {
                            return Err(format!(
                                "ZIP entry compression method {} is not supported for playback",
                                method
                            ));
                        }
                    }
                }
                archive_manager::ArchiveFormat::Tar | archive_manager::ArchiveFormat::Rar => {
                    if archive_manager::build_archive_stream_info(&media).is_ok() {
                        let stream_url = build_zip_stream_url(&state, &media, media_id).await?;
                        return Ok(StreamInfo {
                            stream_url,
                            file_path,
                            title: media.title,
                            poster: poster_asset_url(media.poster_path.as_ref()),
                            duration_seconds: media.duration_seconds,
                            resume_position_seconds: media.resume_position_seconds,
                            is_cloud: true,
                            access_token: None,
                        });
                    }

                    let extracted_path = build_zip_extracted_path(&state, &media).await?;

                    return Ok(StreamInfo {
                        stream_url: extracted_path.clone(),
                        file_path: extracted_path,
                        title: media.title,
                        poster: poster_asset_url(media.poster_path.as_ref()),
                        duration_seconds: media.duration_seconds,
                        resume_position_seconds: media.resume_position_seconds,
                        is_cloud: false,
                        access_token: None,
                    });
                }
            }
        }

        if let Some(ref cloud_file_id) = media.cloud_file_id {
            // Get streaming URL and access token from Google Drive
            let (stream_url, access_token) =
                state.gdrive_client.get_stream_url(cloud_file_id).await?;

            return Ok(StreamInfo {
                stream_url,
                file_path,
                title: media.title,
                poster: poster_asset_url(media.poster_path.as_ref()),
                duration_seconds: media.duration_seconds,
                resume_position_seconds: media.resume_position_seconds,
                is_cloud: true,
                access_token: Some(access_token),
            });
        } else {
            return Err("Cloud file ID not found".to_string());
        }
    }

    // Handle local media
    let stream_url = if !file_path.is_empty() && std::path::Path::new(&file_path).exists() {
        file_path.clone()
    } else {
        return Err("File not found".to_string());
    };

    Ok(StreamInfo {
        stream_url,
        file_path,
        title: media.title,
        poster: poster_asset_url(media.poster_path.as_ref()),
        duration_seconds: media.duration_seconds,
        resume_position_seconds: media.resume_position_seconds,
        is_cloud: false,
        access_token: None,
    })
}

#[tauri::command]
async fn zip_analyze(
    state: State<'_, AppState>,
    zip_file_id: String,
) -> Result<zip_manager::ZipAnalysisResult, String> {
    let access_token = state.gdrive_client.get_access_token().await?;
    let analysis = tokio::task::spawn_blocking(move || {
        zip_manager::analyze_zip_for_preview(&access_token, &zip_file_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(analysis)
}

#[tauri::command]
async fn zip_index_episodes(
    state: State<'_, AppState>,
    window: Window,
    zip_file_id: String,
    folder_id: String,
) -> Result<zip_manager::ZipIndexResult, String> {
    let (api_key, zip_indexing_enabled) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        (
            tmdb::get_tmdb_credential(&config.tmdb_api_key.clone().unwrap_or_default()),
            config.zip_indexing_enabled,
        )
    };

    if !zip_indexing_enabled {
        return Err("ZIP indexing is disabled in Settings > Cloud Storage.".to_string());
    }

    let access_token = state.gdrive_client.get_access_token().await?;
    let drive_item = state.gdrive_client.get_file_metadata(&zip_file_id).await?;
    emit_zip_processing_event(
        &window,
        "detected",
        1,
        Some(&drive_item.name),
        None,
        &format!(
            "Archive detected: {}. Processing episode entries...",
            drive_item.name
        ),
    );
    let image_cache_dir = database::get_image_cache_dir();
    std::fs::create_dir_all(&image_cache_dir).ok();
    let db_path = database::get_database_path();
    let drive_item_for_index = drive_item.clone();
    let archive_cache_config = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        build_zip_cache_config(&config)
    };

    let indexed_items = tokio::task::spawn_blocking(move || {
        let db = database::Database::new(&db_path).map_err(|e| e.to_string())?;
        let mut tv_show_cache: HashMap<String, (i64, Option<String>, String)> = HashMap::new();
        let mut season_cache: HashMap<(String, i32), Vec<tmdb::TmdbEpisodeInfo>> = HashMap::new();

        index_zip_archive_with_metadata(
            &db,
            &access_token,
            &drive_item_for_index,
            &folder_id,
            &api_key,
            &image_cache_dir,
            &archive_cache_config,
            &mut tv_show_cache,
            &mut season_cache,
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Err(error) = &indexed_items {
        emit_zip_processing_event(
            &window,
            "error",
            1,
            Some(&drive_item.name),
            None,
            &format!("ZIP processing failed: {}", error),
        );
    }

    let indexed_items = indexed_items?;

    emit_zip_processing_event(
        &window,
        "complete",
        1,
        Some(&drive_item.name),
        Some(indexed_items.len()),
        &format!(
            "Finished processing {}. Indexed {} episode(s).",
            drive_item.name,
            indexed_items.len()
        ),
    );

    Ok(zip_manager::ZipIndexResult {
        indexed_count: indexed_items.len(),
        skipped_count: 0,
        message: format!(
            "Indexed {} episode(s) from ZIP archive",
            indexed_items.len()
        ),
    })
}

#[tauri::command]
async fn zip_get_stream_info(
    state: State<'_, AppState>,
    media_id: i64,
) -> Result<zip_manager::ZipStreamInfo, String> {
    let media = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_media_by_id(media_id).map_err(|e| e.to_string())?
    };

    zip_manager::build_zip_stream_info(&media).map_err(|e| e.to_string())
}

// Update watch progress
#[tauri::command]
async fn update_progress(
    state: State<'_, AppState>,
    media_id: i64,
    current_time: f64,
    duration: f64,
) -> Result<ApiResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_progress(media_id, current_time, duration)
        .map_err(|e| e.to_string())?;
    Ok(ApiResponse {
        message: "Progress updated.".to_string(),
    })
}

// Clear progress for a media item
#[tauri::command]
async fn clear_progress(state: State<'_, AppState>, media_id: i64) -> Result<ApiResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.clear_progress(media_id).map_err(|e| e.to_string())?;
    Ok(ApiResponse {
        message: "Progress cleared.".to_string(),
    })
}

// Fix match - update metadata from TMDB
#[tauri::command]
async fn fix_match(
    window: Window,
    state: State<'_, AppState>,
    media_id: i64,
    tmdb_id: String,
    media_type: String,
) -> Result<ApiResponse, String> {
    let config = {
        let c = state.config.lock().map_err(|e| e.to_string())?;
        c.clone()
    };

    let api_key = tmdb::get_tmdb_credential(&config.tmdb_api_key.clone().unwrap_or_default());
    let image_cache_dir = database::get_image_cache_dir();
    let api_key_clone = api_key.clone();
    let tmdb_id_clone = tmdb_id.clone();
    let media_type_clone = media_type.clone();
    let image_cache_dir_clone = image_cache_dir.clone();

    // Prevent Update Match from hanging indefinitely on unstable network/image requests.
    let metadata = tokio::time::timeout(
        Duration::from_secs(40),
        tokio::task::spawn_blocking(move || {
            tmdb::fetch_metadata_by_id(
                &api_key_clone,
                &tmdb_id_clone,
                &media_type_clone,
                &image_cache_dir_clone,
            )
            .map_err(|e| e.to_string())
        }),
    )
    .await
    .map_err(|_| "Fix Match timed out while fetching metadata. Please try again.".to_string())?
    .map_err(|e| e.to_string())??;

    let updated_title = metadata.title.clone();
    let updated_tmdb_id = metadata.tmdb_id.clone();

    let parent_id = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.update_metadata(media_id, &metadata)
            .map_err(|e| e.to_string())?;
        db.get_media_by_id(media_id)
            .ok()
            .and_then(|item| item.parent_id)
    };

    let payload = serde_json::json!({
        "type": "metadata-updated",
        "title": updated_title,
        "media_id": media_id,
        "parent_id": parent_id,
        "media_type": media_type,
        "tmdb_id": updated_tmdb_id,
    });
    window.emit("media-metadata-updated", payload.clone()).ok();
    window.emit("library-updated", payload).ok();

    Ok(ApiResponse {
        message: format!("Metadata updated for: {}", metadata.title),
    })
}

// Play media with MPV (external player) with progress tracking
#[tauri::command]
async fn play_with_mpv(
    window: Window,
    state: State<'_, AppState>,
    media_id: i64,
    resume: bool,
    audio_language: Option<String>,
) -> Result<ApiResponse, String> {
    let config = {
        let c = state.config.lock().map_err(|e| e.to_string())?;
        c.clone()
    };

    let mpv_path = config
        .mpv_path
        .as_ref()
        .ok_or_else(|| "MPV path not set".to_string())?;

    if mpv_path.is_empty() || !std::path::Path::new(mpv_path).exists() {
        return Err("MPV path not set or invalid".to_string());
    }

    let (media, resume_info) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let media = db.get_media_by_id(media_id).map_err(|e| e.to_string())?;
        let resume_info = db.get_resume_info(media_id).map_err(|e| e.to_string())?;

        // Update last_watched
        db.update_last_watched(media_id)
            .map_err(|e| e.to_string())?;

        (media, resume_info)
    };

    let is_cloud = media.is_cloud.unwrap_or(false);
    let title = media.title.clone();
    let season_number = media.season_number;
    let episode_number = media.episode_number;
    let media_type = media.media_type.clone();
    let series_id = if media.media_type == "tvshow" {
        Some(media.id)
    } else {
        media.parent_id
    };
    let audio_language = audio_language.and_then(|value| {
        let normalized = value.trim().to_string();
        if normalized.is_empty() {
            None
        } else {
            Some(normalized)
        }
    });

    // Determine start position before picking the playback source so ZIP playback can
    // choose between proxy streaming and cache-backed local playback.
    let start_position = if resume && resume_info.has_progress {
        resume_info.position
    } else {
        0.0
    };

    // Get the playback URL and optional auth header
    let is_zip_media = media.parent_zip_id.is_some();
    let zip_compression_method = if is_zip_media
        && archive_manager::archive_format_for_media(&media) == archive_manager::ArchiveFormat::Zip
    {
        Some(zip_manager::zip_entry_compression_method(&media).map_err(|e| e.to_string())?)
    } else {
        None
    };

    let (playback_url, auth_header, zip_proxy, playback_is_cloud): (
        String,
        Option<String>,
        Option<zip_stream_proxy::ZipStreamProxyHandle>,
        bool,
    ) = if is_cloud {
        if is_zip_media {
            if should_extract_zip_for_mpv(&media, start_position)? {
                let extracted_path = build_zip_extracted_path(&state, &media).await?;
                let is_store_mkv = zip_compression_method.unwrap_or_default() == 0
                    && media
                        .zip_entry_path
                        .as_deref()
                        .or(media.file_path.as_deref())
                        .map(|path| path.to_ascii_lowercase().ends_with(".mkv"))
                        .unwrap_or(false);
                println!(
                    "[ZIP] Using {}cache for MPV: '{}' -> {}",
                    if is_store_mkv {
                        "fully prepared local "
                    } else {
                        "extracted "
                    },
                    media.title,
                    extracted_path
                );
                (extracted_path, None, None, false)
            } else {
                match archive_manager::archive_format_for_media(&media) {
                    archive_manager::ArchiveFormat::Zip => match zip_compression_method.unwrap_or_default() {
                        0 => {
                            let stream_info = archive_manager::build_archive_stream_info(&media)?;
                            let (drive_url, access_token) = state
                                .gdrive_client
                                .get_stream_url(&stream_info.zip_file_id)
                                .await?;
                            let (
                                cache_spec,
                                local_cache_path,
                                cache_is_complete,
                                use_partial_cache_via_proxy,
                            ) = {
                                let cache_config = build_zip_cache_config(&config);
                                match zip_manager::inspect_stream_cache_target(&media, &cache_config) {
                                    Ok(snapshot) => {
                                        let local_cache_path = choose_store_zip_local_cache_for_mpv(
                                            &media,
                                            &snapshot,
                                            start_position,
                                        );
                                        let use_partial_cache_via_proxy =
                                            !snapshot.is_complete && local_cache_path.is_some();
                                        (
                                            Some(zip_stream_proxy::ProxyCacheSpec {
                                                cache_paths: snapshot.paths,
                                                cache_config,
                                                start_delay_ms: 0,
                                                throttle_delay_ms: 0,
                                            }),
                                            local_cache_path,
                                            snapshot.is_complete,
                                            use_partial_cache_via_proxy,
                                        )
                                    }
                                    Err(error) => {
                                        println!(
                                            "[ZIP CACHE] Falling back to stream-only proxy for '{}': {:?}",
                                            media.title, error
                                        );
                                        (None, None, false, false)
                                    }
                                }
                            };
                            let proxy =
                                zip_stream_proxy::start_proxy(zip_stream_proxy::build_proxy_spec(
                                    drive_url,
                                    access_token,
                                    &stream_info,
                                    cache_spec,
                                ))?;
                            if let Some(local_path) = local_cache_path {
                                if use_partial_cache_via_proxy {
                                    println!(
                                        "[ZIP] Using streaming proxy for MPV with local partial cache assist: '{}' (partial cache: {}) -> {}",
                                        media.title,
                                        local_path,
                                        zip_stream_proxy::localhost_stream_url(proxy.port)
                                    );
                                    (
                                        zip_stream_proxy::localhost_stream_url(proxy.port),
                                        None,
                                        Some(proxy),
                                        true,
                                    )
                                } else {
                                    println!(
                                        "[ZIP] Using local {}cache for MPV: '{}' -> {}",
                                        if cache_is_complete {
                                            "complete "
                                        } else {
                                            "partial "
                                        },
                                        media.title,
                                        local_path
                                    );
                                    (local_path, None, Some(proxy), false)
                                }
                            } else {
                                println!(
                                    "[ZIP] Using streaming proxy for MPV: '{}' -> {}",
                                    media.title,
                                    zip_stream_proxy::localhost_stream_url(proxy.port)
                                );
                                (
                                    zip_stream_proxy::localhost_stream_url(proxy.port),
                                    None,
                                    Some(proxy),
                                    true,
                                )
                            }
                        }
                        8 => {
                            let extracted_path = build_zip_extracted_path(&state, &media).await?;
                            (extracted_path, None, None, false)
                        }
                        method => {
                            return Err(format!(
                                "ZIP entry compression method {} is not supported for playback",
                                method
                            ));
                        }
                    },
                    archive_manager::ArchiveFormat::Tar | archive_manager::ArchiveFormat::Rar => {
                        let (stream_url, proxy) =
                            build_temporary_zip_stream_url(&state, &media).await?;
                        println!(
                            "[ARCHIVE] Using direct proxy passthrough for MPV: '{}' -> {}",
                            media.title, stream_url
                        );
                        (stream_url, None, Some(proxy), true)
                    }
                }
            }
        } else {
            // Cloud file - get stream URL from Google Drive
            if let Some(ref cloud_file_id) = media.cloud_file_id {
                println!(
                    "[MPV] Cloud file detected, getting stream URL for file ID: {}",
                    cloud_file_id
                );
                let (stream_url, access_token) =
                    state.gdrive_client.get_stream_url(cloud_file_id).await?;
                println!(
                    "[MPV] Got cloud stream URL, token length: {}",
                    access_token.len()
                );
                (
                    stream_url,
                    Some(format!("Authorization: Bearer {}", access_token)),
                    None,
                    true,
                )
            } else {
                return Err("Cloud file ID not found".to_string());
            }
        }
    } else {
        // Local file - verify it exists
        let file_path = media
            .file_path
            .clone()
            .ok_or_else(|| "No file path".to_string())?;

        if !std::path::Path::new(&file_path).exists() {
            return Err(format!(
                "Video file not found: {}. The file may have been moved or deleted. Try rescanning your library.",
                file_path
            ));
        }

        (file_path, None, None, false)
    };

    config::validate_executable_path(&mpv_path, "mpv")?;
    let mpv_audio_probe_pipe = if is_zip_media {
        Some(format!(
            r"\\.\pipe\streamvault-mpv-{}-{}",
            media_id,
            chrono::Utc::now().timestamp_millis()
        ))
    } else {
        None
    };

    // Launch MPV with progress tracking
    let mpv_path_clone = mpv_path.clone();
    let playback_url_clone = playback_url.clone();

    // Launch MPV with tracking (pass auth header and cache settings for cloud files)
    let cache_settings = if playback_is_cloud && config.cloud_cache_enabled {
        config
            .cloud_cache_dir
            .as_ref()
            .map(|dir| mpv_ipc::CloudCacheSettings {
                enabled: true,
                cache_dir: dir.clone(),
                max_size_mb: config.cloud_cache_max_mb,
            })
    } else {
        None
    };

    let display_title = build_mpv_display_title(&media);

    let pid = mpv_ipc::launch_mpv_with_tracking(
        &mpv_path_clone,
        &playback_url_clone,
        media_id,
        Some(&display_title),
        start_position,
        auth_header.as_deref(),
        cache_settings.as_ref(),
        audio_language.as_deref(),
        mpv_audio_probe_pipe.as_deref(),
    )?;

    // Store the session
    {
        let mut sessions = state
            .active_mpv_sessions
            .lock()
            .map_err(|e| e.to_string())?;
        sessions.insert(
            media_id,
            ActiveMpvSession {
                session: MpvSession {
                    media_id,
                    pid,
                    title: title.clone(),
                    start_time: chrono::Utc::now().timestamp(),
                },
                zip_proxy,
            },
        );
    }

    // Spawn a background thread to monitor MPV and save progress
    let db_path = database::get_database_path();
    let window_clone = window.clone();
    let app_handle = window.app_handle();

    if let Some(pipe_name) = mpv_audio_probe_pipe {
        let window_for_audio = window.clone();
        std::thread::spawn(
            move || match detect_audio_tracks_from_running_mpv(&pipe_name) {
                Ok(tracks) if !tracks.is_empty() => {
                    let payload = MpvAudioTracksDetectedPayload {
                        media_id,
                        series_id,
                        season_number,
                        tracks,
                    };
                    let _ = window_for_audio.emit("mpv-audio-tracks-detected", payload);
                }
                Ok(_) => {}
                Err(error) => {
                    println!(
                        "[MPV] Audio track detection via playback pipe failed for media {}: {}",
                        media_id, error
                    );
                }
            },
        );
    }

    std::thread::spawn(move || {
        println!("[MPV] Starting progress monitor for media ID: {}", media_id);

        if let Ok(db) = database::Database::new(&db_path) {
            let result = mpv_ipc::monitor_mpv_and_save_progress(&db, media_id, pid);

            // Emit event to frontend when MPV exits
            let _ = window_clone.emit(
                "mpv-playback-ended",
                serde_json::json!({
                    "media_id": media_id,
                    "title": title,
                    "season_number": season_number,
                    "episode_number": episode_number,
                    "media_type": media_type,
                    "final_position": result.final_position,
                    "final_duration": result.final_duration,
                    "completed": result.completed,
                }),
            );

            println!(
                "[MPV] Playback ended for media ID: {}. Completed: {}",
                media_id, result.completed
            );
        }

        {
            let state: tauri::State<'_, AppState> = app_handle.state();
            if let Ok(mut sessions) = state.active_mpv_sessions.lock() {
                if let Some(mut session) = sessions.remove(&media_id) {
                    if let Some(proxy) = session.zip_proxy.as_mut() {
                        proxy.stop();
                    }
                }
            };
        }
    });

    Ok(ApiResponse {
        message: format!("Playback started: {}", media.title),
    })
}

// Play media with VLC (external player)
#[tauri::command]
async fn play_with_vlc(
    state: State<'_, AppState>,
    media_id: i64,
    resume: bool,
) -> Result<ApiResponse, String> {
    let config = {
        let c = state.config.lock().map_err(|e| e.to_string())?;
        c.clone()
    };

    let vlc_path = config
        .vlc_path
        .as_ref()
        .ok_or_else(|| "VLC path not set. Please configure it in Settings > Player.".to_string())?;

    if vlc_path.is_empty() || !std::path::Path::new(vlc_path).exists() {
        return Err(
            "VLC path not set or invalid. Please configure it in Settings > Player.".to_string(),
        );
    }

    // Security check: Validate VLC executable
    config::validate_executable_path(vlc_path, "vlc")?;

    let (media, resume_info) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let media = db.get_media_by_id(media_id).map_err(|e| e.to_string())?;
        let resume_info = db.get_resume_info(media_id).map_err(|e| e.to_string())?;

        // Update last_watched
        db.update_last_watched(media_id)
            .map_err(|e| e.to_string())?;

        (media, resume_info)
    };

    // Determine start position
    let start_position = if resume && resume_info.has_progress {
        resume_info.position
    } else {
        0.0
    };

    let is_cloud = media.is_cloud.unwrap_or(false);
    let title = media.title.clone();

    // Build VLC command
    let mut command = std::process::Command::new(vlc_path);

    if is_cloud {
        // VLC doesn't support authenticated Google Drive streams properly
        // The Google Drive API requires Authorization headers, which VLC can't pass
        return Err("VLC doesn't support authenticated cloud streaming. Please use MPV or the built-in player for cloud files.".to_string());
    } else {
        // Local file
        let file_path = media
            .file_path
            .clone()
            .ok_or_else(|| "No file path".to_string())?;

        if !std::path::Path::new(&file_path).exists() {
            return Err(format!("File not found: {}", file_path));
        }

        // Add start time if resuming (as global option before the file)
        if start_position > 0.0 {
            command.arg(format!("--start-time={:.0}", start_position));
        }

        command.arg("--");

        // Add the file path
        command.arg(&file_path);
    }

    // Launch VLC
    println!("[VLC] Launching with args: {:?}", command);
    command
        .spawn()
        .map_err(|e| format!("Failed to launch VLC: {}", e))?;

    println!("[VLC] Playback started for: {}", title);

    Ok(ApiResponse {
        message: format!("VLC playback started: {}", title),
    })
}

// Check MPV playback status (for polling from frontend if needed)
#[tauri::command]
async fn get_mpv_status(
    state: State<'_, AppState>,
    media_id: i64,
) -> Result<serde_json::Value, String> {
    // Check if there's an active session
    let session = {
        let sessions = state
            .active_mpv_sessions
            .lock()
            .map_err(|e| e.to_string())?;
        sessions
            .get(&media_id)
            .map(|session| session.session.clone())
    };

    match session {
        Some(session) => {
            let is_running = mpv_ipc::is_mpv_running(session.pid);
            let progress = mpv_ipc::poll_mpv_progress(media_id);

            // If not running, remove from active sessions
            if !is_running {
                let mut sessions = state
                    .active_mpv_sessions
                    .lock()
                    .map_err(|e| e.to_string())?;
                if let Some(mut session) = sessions.remove(&media_id) {
                    if let Some(proxy) = session.zip_proxy.as_mut() {
                        proxy.stop();
                    }
                }
            }

            Ok(serde_json::json!({
                "is_playing": is_running,
                "media_id": media_id,
                "title": session.title,
                "position": progress.as_ref().map(|p| p.position),
                "duration": progress.as_ref().map(|p| p.duration),
                "paused": progress.as_ref().map(|p| p.paused).unwrap_or(false),
            }))
        }
        None => Ok(serde_json::json!({
            "is_playing": false,
            "media_id": media_id,
        })),
    }
}

// Get all active MPV sessions
#[tauri::command]
async fn get_active_mpv_sessions(state: State<'_, AppState>) -> Result<Vec<MpvSession>, String> {
    let mut sessions = state
        .active_mpv_sessions
        .lock()
        .map_err(|e| e.to_string())?;

    // Filter out dead sessions
    let mut to_remove = Vec::new();
    for (media_id, session) in sessions.iter() {
        if !mpv_ipc::is_mpv_running(session.session.pid) {
            to_remove.push(*media_id);
        }
    }
    for id in to_remove {
        if let Some(mut session) = sessions.remove(&id) {
            if let Some(proxy) = session.zip_proxy.as_mut() {
                proxy.stop();
            }
        }
    }

    Ok(sessions
        .values()
        .map(|session| session.session.clone())
        .collect())
}

// Get image from cache (returns the file path for asset protocol)
#[tauri::command]
async fn get_cached_image(image_name: String) -> Result<String, String> {
    let cache_dir_str = database::get_image_cache_dir();
    let cache_dir = std::path::Path::new(&cache_dir_str);
    let image_path = cache_dir.join(&image_name);

    println!("[IMAGE] Looking for: {} in {}", image_name, cache_dir_str);
    println!("[IMAGE] Full path: {:?}", image_path);

    // Validate path to prevent traversal
    let canonical_cache = match cache_dir.canonicalize() {
        Ok(p) => p,
        Err(e) => return Err(format!("Cache directory error: {}", e)),
    };

    // Canonicalize the target path - this will fail if the file doesn't exist
    // effectively checking for existence as well
    let canonical_path = match image_path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            println!("[IMAGE] Not found: {:?}", image_path);
            return Err("Image not found".to_string());
        }
    };

    // Check if the canonical path starts with the canonical cache path
    if !canonical_path.starts_with(&canonical_cache) {
        println!(
            "[SECURITY] Path traversal attempt blocked: {:?}",
            canonical_path
        );
        return Err("Access denied".to_string());
    }

    let path_cow = canonical_path.to_string_lossy();
    let path_str = path_cow.as_ref();

    #[cfg(windows)]
    let path_str = if path_str.starts_with(r"\\?\") {
        &path_str[4..]
    } else {
        path_str
    };

    let asset_url = format!(
        "asset://localhost/{}",
        path_str.replace("\\", "/").replace(":", "")
    );
    println!("[IMAGE] Found! Asset URL: {}", asset_url);
    Ok(asset_url)
}

// Get image path for Tauri's convertFileSrc (returns raw file path)
#[tauri::command]
async fn get_cached_image_path(image_name: String) -> Result<String, String> {
    let cache_dir_str = database::get_image_cache_dir();
    let cache_dir = std::path::Path::new(&cache_dir_str);
    let image_path = cache_dir.join(&image_name);

    println!(
        "[IMAGE_PATH] Looking for: {} in {}",
        image_name, cache_dir_str
    );
    println!("[IMAGE_PATH] Full path: {:?}", image_path);

    // Validate path to prevent traversal
    let canonical_cache = match cache_dir.canonicalize() {
        Ok(p) => p,
        Err(e) => return Err(format!("Cache directory error: {}", e)),
    };

    let canonical_path = match image_path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            println!("[IMAGE_PATH] Not found: {:?}", image_path);
            return Err("Image not found".to_string());
        }
    };

    if !canonical_path.starts_with(&canonical_cache) {
        println!(
            "[SECURITY] Path traversal attempt blocked: {:?}",
            canonical_path
        );
        return Err("Access denied".to_string());
    }

    let path_cow = canonical_path.to_string_lossy();
    let path_str = path_cow.as_ref();

    #[cfg(windows)]
    let path_str = if path_str.starts_with(r"\\?\") {
        &path_str[4..]
    } else {
        path_str
    };

    let final_path = path_str.to_string();
    println!("[IMAGE_PATH] Found! Path: {}", final_path);
    Ok(final_path)
}

// Read video file chunk (workaround for asset protocol issues with Windows drive letters)
#[tauri::command]
async fn read_video_chunk(
    state: State<'_, AppState>,
    file_path: String,
    offset: u64,
    chunk_size: u64,
) -> Result<Vec<u8>, String> {
    use std::fs::File;
    use std::io::{Read, Seek, SeekFrom};

    // Security check: Verify file is in library
    let is_authorized = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.media_exists(&file_path).map_err(|e| e.to_string())?
    };

    if !is_authorized {
        println!(
            "[SECURITY] Blocked access to non-library file: {}",
            file_path
        );
        return Err("Access denied: File not found in library".to_string());
    }

    let mut file = File::open(&file_path).map_err(|e| format!("Failed to open file: {}", e))?;

    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("Failed to seek: {}", e))?;

    let mut buffer = vec![0u8; chunk_size as usize];
    let bytes_read = file
        .read(&mut buffer)
        .map_err(|e| format!("Failed to read: {}", e))?;

    buffer.truncate(bytes_read);
    Ok(buffer)
}

#[tauri::command]
async fn get_video_file_size(state: State<'_, AppState>, file_path: String) -> Result<u64, String> {
    // Security check: Verify file is in library
    let is_authorized = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.media_exists(&file_path).map_err(|e| e.to_string())?
    };

    if !is_authorized {
        println!(
            "[SECURITY] Blocked access to non-library file: {}",
            file_path
        );
        return Err("Access denied: File not found in library".to_string());
    }

    let metadata =
        std::fs::metadata(&file_path).map_err(|e| format!("Failed to get file metadata: {}", e))?;
    Ok(metadata.len())
}

/// Check if the given credential is an access token (starts with "eyJ") or API key
fn is_access_token(credential: &str) -> bool {
    credential.starts_with("eyJ")
}

/// Build TMDB URL with proper authentication
/// - For API keys: adds ?api_key=XXX to URL
/// - For access tokens: returns URL without api_key (auth goes in header)
fn build_tmdb_api_url(path: &str, credential: &str, extra_params: &str) -> String {
    if tmdb::is_backend_proxy_credential(credential) {
        let base = tmdb::get_tmdb_proxy_base_url();
        let normalized_path = path.trim_start_matches('/');
        return if extra_params.is_empty() {
            format!("{}/{}", base, normalized_path)
        } else {
            format!("{}/{}?{}", base, normalized_path, extra_params)
        };
    }

    let base = "https://api.themoviedb.org/3";
    if is_access_token(credential) {
        if extra_params.is_empty() {
            format!("{}{}", base, path)
        } else {
            format!("{}{}?{}", base, path, extra_params)
        }
    } else {
        if extra_params.is_empty() {
            format!("{}{}?api_key={}", base, path, credential)
        } else {
            format!("{}{}?api_key={}&{}", base, path, credential, extra_params)
        }
    }
}

// Helper function to perform HTTP GET with retry logic and optional Bearer auth
// Configured to handle Windows connection issues (error 10054 - connection reset)
fn http_get_with_retry_auth(
    url: &str,
    credential: &str,
    max_retries: u32,
) -> Result<reqwest::blocking::Response, String> {
    let mut last_error = String::new();
    let use_bearer = is_access_token(credential) && !tmdb::is_backend_proxy_credential(credential);

    for attempt in 0..max_retries {
        if attempt > 0 {
            // Exponential backoff: 1000ms, 2000ms, 4000ms...
            let delay_ms = 1000 * (1 << attempt);
            std::thread::sleep(std::time::Duration::from_millis(delay_ms as u64));
            println!(
                "[HTTP] Retry attempt {} after {}ms delay",
                attempt + 1,
                delay_ms
            );
        }

        // Create a fresh client for each attempt to avoid stale connection issues
        let client = match reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .connect_timeout(std::time::Duration::from_secs(15))
            .pool_max_idle_per_host(0)
            .tcp_keepalive(std::time::Duration::from_secs(20))
            .http1_only()
            .tcp_nodelay(true)
            .user_agent("StreamVault/1.0")
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                last_error = format!("Failed to build HTTP client: {}", e);
                println!(
                    "[HTTP] Client build failed (attempt {}): {}",
                    attempt + 1,
                    last_error
                );
                continue;
            }
        };

        let request = if use_bearer {
            client
                .get(url)
                .header("Authorization", format!("Bearer {}", credential))
        } else {
            client.get(url)
        };

        match request.send() {
            Ok(response) => {
                if response.status().is_success() {
                    return Ok(response);
                } else {
                    last_error = format!("TMDB API error: {}", response.status());
                    // Don't retry on client errors (4xx)
                    if response.status().is_client_error() {
                        return Err(last_error);
                    }
                    println!(
                        "[HTTP] Server error (attempt {}): {}",
                        attempt + 1,
                        last_error
                    );
                }
            }
            Err(e) => {
                last_error = format!("Network error: {}", e);
                println!(
                    "[HTTP] Request failed (attempt {}): {}",
                    attempt + 1,
                    last_error
                );
                // Continue to retry on network errors
            }
        }
    }

    Err(format!(
        "Failed after {} retries: {}",
        max_retries, last_error
    ))
}

// Helper function to perform HTTP GET with retry logic (legacy, no auth header)
// Configured to handle Windows connection issues (error 10054 - connection reset)
fn http_get_with_retry(url: &str, max_retries: u32) -> Result<reqwest::blocking::Response, String> {
    let mut last_error = String::new();

    for attempt in 0..max_retries {
        if attempt > 0 {
            // Exponential backoff: 1000ms, 2000ms, 4000ms...
            let delay_ms = 1000 * (1 << attempt);
            std::thread::sleep(std::time::Duration::from_millis(delay_ms as u64));
            println!(
                "[HTTP] Retry attempt {} after {}ms delay",
                attempt + 1,
                delay_ms
            );
        }

        // Create a fresh client for each attempt to avoid stale connection issues
        // This is important on Windows where error 10054 can occur with pooled connections
        let client = match reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .connect_timeout(std::time::Duration::from_secs(15))
            // Disable connection pooling to avoid stale connection issues on Windows
            .pool_max_idle_per_host(0)
            // Enable TCP keepalive to detect dead connections faster
            .tcp_keepalive(std::time::Duration::from_secs(20))
            // Force HTTP/1.1 to avoid potential HTTP/2 connection issues
            .http1_only()
            // Set TCP nodelay for faster request/response
            .tcp_nodelay(true)
            // Add a user agent (some APIs block requests without one)
            .user_agent("StreamVault/1.0")
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                last_error = format!("Failed to build HTTP client: {}", e);
                println!(
                    "[HTTP] Client build failed (attempt {}): {}",
                    attempt + 1,
                    last_error
                );
                continue;
            }
        };

        match client.get(url).send() {
            Ok(response) => {
                if response.status().is_success() {
                    return Ok(response);
                } else {
                    last_error = format!("TMDB API error: {}", response.status());
                    // Don't retry on client errors (4xx)
                    if response.status().is_client_error() {
                        return Err(last_error);
                    }
                    println!(
                        "[HTTP] Server error (attempt {}): {}",
                        attempt + 1,
                        last_error
                    );
                }
            }
            Err(e) => {
                last_error = format!("Network error: {}", e);
                println!(
                    "[HTTP] Request failed (attempt {}): {}",
                    attempt + 1,
                    last_error
                );
                // Continue to retry on network errors
            }
        }
    }

    Err(format!(
        "Failed after {} retries: {}",
        max_retries, last_error
    ))
}

// TMDB Search result for frontend
#[derive(serde::Serialize)]
struct TmdbSearchResultItem {
    id: i64,
    title: Option<String>,
    name: Option<String>,
    media_type: String,
    poster_path: Option<String>,
    backdrop_path: Option<String>,
    overview: Option<String>,
    release_date: Option<String>,
    first_air_date: Option<String>,
    vote_average: Option<f64>,
}

#[derive(serde::Serialize)]
struct TmdbSearchResponse {
    results: Vec<TmdbSearchResultItem>,
    total_results: usize,
}

#[derive(serde::Serialize)]
struct MovieDetails {
    id: i64,
    title: String,
    poster_path: Option<String>,
    backdrop_path: Option<String>,
    overview: Option<String>,
    release_date: Option<String>,
    runtime: Option<i32>,
    director: Option<String>,
}

// TV Show details for episode selection
#[derive(serde::Serialize)]
struct TvSeasonInfo {
    season_number: i32,
    name: String,
    episode_count: i32,
    overview: Option<String>,
    poster_path: Option<String>,
    air_date: Option<String>,
}

#[derive(serde::Serialize)]
struct TvEpisodeInfo {
    episode_number: i32,
    name: String,
    overview: Option<String>,
    still_path: Option<String>,
    air_date: Option<String>,
    runtime: Option<i32>,
    vote_average: Option<f64>,
}

#[derive(serde::Serialize)]
struct TvShowDetails {
    id: i64,
    name: String,
    poster_path: Option<String>,
    backdrop_path: Option<String>,
    overview: Option<String>,
    number_of_seasons: i32,
    seasons: Vec<TvSeasonInfo>,
    creator: Option<String>,
}

#[derive(serde::Serialize)]
struct TvSeasonDetails {
    season_number: i32,
    name: String,
    episodes: Vec<TvEpisodeInfo>,
}

#[tauri::command]
async fn get_movie_details(
    state: State<'_, AppState>,
    movie_id: i64,
) -> Result<MovieDetails, String> {
    let credential = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        tmdb::get_tmdb_credential(&config.tmdb_api_key.clone().unwrap_or_default())
    };

    let url = build_tmdb_api_url(
        &format!("/movie/{}", movie_id),
        &credential,
        "append_to_response=credits",
    );

    let result = tokio::task::spawn_blocking(move || -> Result<MovieDetails, String> {
        let response = http_get_with_retry_auth(&url, &credential, 3)?;

        #[derive(serde::Deserialize)]
        struct TmdbCrewMember {
            job: String,
            name: String,
        }

        #[derive(serde::Deserialize)]
        struct TmdbCredits {
            crew: Option<Vec<TmdbCrewMember>>,
        }

        #[derive(serde::Deserialize)]
        struct RawMovieDetails {
            id: i64,
            title: Option<String>,
            original_title: Option<String>,
            poster_path: Option<String>,
            backdrop_path: Option<String>,
            overview: Option<String>,
            release_date: Option<String>,
            runtime: Option<i32>,
            credits: Option<TmdbCredits>,
        }

        let raw: RawMovieDetails = response.json().map_err(|e| e.to_string())?;

        let director = raw
            .credits
            .as_ref()
            .and_then(|c| c.crew.as_ref())
            .and_then(|crew| crew.iter().find(|m| m.job == "Director"))
            .map(|m| m.name.clone());

        Ok(MovieDetails {
            id: raw.id,
            title: raw
                .title
                .or(raw.original_title)
                .unwrap_or_else(|| "Unknown".to_string()),
            poster_path: raw.poster_path,
            backdrop_path: raw.backdrop_path,
            overview: raw.overview,
            release_date: raw.release_date,
            runtime: raw.runtime,
            director,
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(result)
}

// Get TV show details including seasons
#[tauri::command]
async fn get_tv_details(state: State<'_, AppState>, tv_id: i64) -> Result<TvShowDetails, String> {
    let credential = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        tmdb::get_tmdb_credential(&config.tmdb_api_key.clone().unwrap_or_default())
    };

    let url = build_tmdb_api_url(&format!("/tv/{}", tv_id), &credential, "");

    let result = tokio::task::spawn_blocking(move || -> Result<TvShowDetails, String> {
        let response = http_get_with_retry_auth(&url, &credential, 3)?;

        #[derive(serde::Deserialize)]
        struct RawSeason {
            season_number: i32,
            name: Option<String>,
            episode_count: i32,
            overview: Option<String>,
            poster_path: Option<String>,
            air_date: Option<String>,
        }

        #[derive(serde::Deserialize)]
        struct TmdbCreator {
            name: String,
        }

        #[derive(serde::Deserialize)]
        struct RawTvShow {
            id: i64,
            name: Option<String>,
            poster_path: Option<String>,
            backdrop_path: Option<String>,
            overview: Option<String>,
            number_of_seasons: Option<i32>,
            seasons: Option<Vec<RawSeason>>,
            created_by: Option<Vec<TmdbCreator>>,
        }

        let raw: RawTvShow = response.json().map_err(|e| e.to_string())?;

        let creator = raw
            .created_by
            .as_ref()
            .and_then(|c| c.first())
            .map(|c| c.name.clone());

        let seasons: Vec<TvSeasonInfo> = raw
            .seasons
            .unwrap_or_default()
            .into_iter()
            .filter(|s| s.season_number > 0) // Filter out specials (season 0)
            .map(|s| TvSeasonInfo {
                season_number: s.season_number,
                name: s
                    .name
                    .unwrap_or_else(|| format!("Season {}", s.season_number)),
                episode_count: s.episode_count,
                overview: s.overview,
                poster_path: s.poster_path,
                air_date: s.air_date,
            })
            .collect();

        Ok(TvShowDetails {
            id: raw.id,
            name: raw.name.unwrap_or_else(|| "Unknown".to_string()),
            poster_path: raw.poster_path,
            backdrop_path: raw.backdrop_path,
            overview: raw.overview,
            number_of_seasons: raw.number_of_seasons.unwrap_or(0),
            seasons,
            creator,
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(result)
}

// Get episodes for a specific season of a TV show
#[tauri::command]
async fn get_tv_season_episodes(
    state: State<'_, AppState>,
    tv_id: i64,
    season_number: i32,
) -> Result<TvSeasonDetails, String> {
    // First, try to get from local cache
    let tv_id_str = tv_id.to_string();
    let image_cache_dir = database::get_image_cache_dir();
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        if let Ok(cached_episodes) = db.get_cached_episodes_for_season(&tv_id_str, season_number) {
            if !cached_episodes.is_empty() {
                println!(
                    "[CACHE] Using cached episode data for TV {} Season {}",
                    tv_id, season_number
                );
                let episodes: Vec<TvEpisodeInfo> = cached_episodes
                    .into_iter()
                    .map(|e| {
                        // Verify still_path file actually exists
                        let verified_still_path = e.still_path.and_then(|path| {
                            let full_path = std::path::Path::new(&image_cache_dir).join(&path);
                            if full_path.exists() {
                                Some(path)
                            } else {
                                None // File doesn't exist, return None
                            }
                        });

                        TvEpisodeInfo {
                            episode_number: e.episode_number,
                            name: e
                                .episode_title
                                .unwrap_or_else(|| format!("Episode {}", e.episode_number)),
                            overview: e.overview,
                            still_path: verified_still_path,
                            air_date: e.air_date,
                            runtime: None,
                            vote_average: None,
                        }
                    })
                    .collect();

                return Ok(TvSeasonDetails {
                    season_number,
                    name: format!("Season {}", season_number),
                    episodes,
                });
            }
        }
    }

    // Cache miss - fetch from TMDB API
    println!(
        "[TMDB] Cache miss, fetching from API for TV {} Season {}",
        tv_id, season_number
    );

    let credential = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        tmdb::get_tmdb_credential(&config.tmdb_api_key.clone().unwrap_or_default())
    };

    let url = build_tmdb_api_url(
        &format!("/tv/{}/season/{}", tv_id, season_number),
        &credential,
        "",
    );

    let result = tokio::task::spawn_blocking(move || -> Result<TvSeasonDetails, String> {
        let response = http_get_with_retry_auth(&url, &credential, 3)?;

        #[derive(serde::Deserialize)]
        struct RawEpisode {
            episode_number: i32,
            name: Option<String>,
            overview: Option<String>,
            still_path: Option<String>,
            air_date: Option<String>,
            runtime: Option<i32>,
            vote_average: Option<f64>,
        }

        #[derive(serde::Deserialize)]
        struct RawSeasonDetails {
            season_number: i32,
            name: Option<String>,
            episodes: Option<Vec<RawEpisode>>,
        }

        let raw: RawSeasonDetails = response.json().map_err(|e| e.to_string())?;

        let episodes: Vec<TvEpisodeInfo> = raw
            .episodes
            .unwrap_or_default()
            .into_iter()
            .map(|e| TvEpisodeInfo {
                episode_number: e.episode_number,
                name: e
                    .name
                    .unwrap_or_else(|| format!("Episode {}", e.episode_number)),
                overview: e.overview,
                still_path: e.still_path,
                air_date: e.air_date,
                runtime: e.runtime,
                vote_average: e.vote_average,
            })
            .collect();

        Ok(TvSeasonDetails {
            season_number: raw.season_number,
            name: raw
                .name
                .unwrap_or_else(|| format!("Season {}", raw.season_number)),
            episodes,
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(result)
}

// Force refresh episode metadata for a TV series (re-downloads images ONLY for owned episodes)
#[tauri::command]
async fn refresh_series_metadata(
    state: State<'_, AppState>,
    tv_id: i64,
    series_title: String,
) -> Result<String, String> {
    let credential = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        tmdb::get_tmdb_credential(&config.tmdb_api_key.clone().unwrap_or_default())
    };

    let image_cache_dir = database::get_image_cache_dir();
    let tv_id_str = tv_id.to_string();
    let series_title_clone = series_title.clone();

    println!(
        "[REFRESH] Starting metadata refresh for {} (TMDB ID: {})",
        series_title, tv_id
    );
    println!("[REFRESH] Image cache directory: {}", image_cache_dir);

    // Step 1: Find the series ID in our database by TMDB ID
    let (series_db_id, owned_episodes): (Option<i64>, Vec<(i64, i32, i32)>) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let series_id = db
            .find_series_id_by_tmdb(&tv_id_str)
            .map_err(|e| e.to_string())?;

        if let Some(sid) = series_id {
            let episodes = db
                .get_owned_episodes_for_series(sid)
                .map_err(|e| e.to_string())?;
            println!(
                "[REFRESH] Found series DB ID: {}, owned episodes: {}",
                sid,
                episodes.len()
            );
            (Some(sid), episodes)
        } else {
            println!(
                "[REFRESH] Warning: Series not found in database by TMDB ID {}",
                tv_id
            );
            (None, Vec::new())
        }
    };

    if owned_episodes.is_empty() {
        return Err("No episodes found for this series in your library".to_string());
    }

    // Convert to (season, episode) tuples for the TMDB function
    let episode_list: Vec<(i32, i32)> = owned_episodes
        .iter()
        .map(|(_, season, episode)| (*season, *episode))
        .collect();

    println!(
        "[REFRESH] Will only fetch metadata for {} owned episodes: {:?}",
        episode_list.len(),
        episode_list
    );

    // Clear old cached metadata for just the episodes we own
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        // Only clear metadata for this series
        if let Ok(deleted) = db.clear_cached_metadata_for_series(&tv_id_str) {
            println!(
                "[REFRESH] Cleared {} old cached entries for series {}",
                deleted, tv_id
            );
        }
    }

    // Step 2: Fetch ONLY the episodes the user owns
    let fetched_episodes = tokio::task::spawn_blocking(move || {
        tmdb::fetch_owned_episodes_only(
            &credential,
            &tv_id_str,
            &series_title_clone,
            &image_cache_dir,
            &episode_list,
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let mut total_images = 0;

    // Step 3: Save to cached_episode_metadata table AND update the media table directly
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        for ep in &fetched_episodes {
            if ep.still_path.is_some() {
                total_images += 1;
            }

            // Save to cache table
            if let Err(e) = db.save_cached_episode_metadata(
                &tv_id.to_string(),
                ep.season_number,
                ep.episode_number,
                Some(&ep.name),
                ep.overview.as_deref(),
                ep.still_path.as_deref(),
                ep.air_date.as_deref(),
            ) {
                println!(
                    "[REFRESH] Warning: Failed to save cached metadata S{:02}E{:02}: {}",
                    ep.season_number, ep.episode_number, e
                );
            }

            // Also update the media table directly so episodes show the images immediately
            // Find the episode ID from our owned_episodes list
            if let Some((episode_db_id, _, _)) = owned_episodes
                .iter()
                .find(|(_, s, e)| *s == ep.season_number && *e == ep.episode_number)
            {
                if let Err(e) = db.update_episode_metadata(
                    *episode_db_id,
                    Some(&ep.name),
                    ep.overview.as_deref(),
                    ep.still_path.as_deref(),
                ) {
                    println!(
                        "[REFRESH] Warning: Failed to update media S{:02}E{:02}: {}",
                        ep.season_number, ep.episode_number, e
                    );
                } else {
                    println!(
                        "[REFRESH] Updated media entry for S{:02}E{:02}",
                        ep.season_number, ep.episode_number
                    );
                }
            }
        }
    }

    let result = format!(
        "Refreshed {} episodes, {} images downloaded",
        fetched_episodes.len(),
        total_images
    );
    println!("[REFRESH] Completed: {}", result);
    Ok(result)
}

// Search TMDB for streaming - returns raw search results
#[tauri::command]
async fn search_tmdb(
    state: State<'_, AppState>,
    query: String,
) -> Result<TmdbSearchResponse, String> {
    println!("[SEARCH_TMDB] Starting search for: {}", query);

    let credential = {
        let config = state.config.lock().map_err(|e| {
            println!("[SEARCH_TMDB] Failed to lock config: {}", e);
            e.to_string()
        })?;
        let key = tmdb::get_tmdb_credential(&config.tmdb_api_key.clone().unwrap_or_default());
        println!(
            "[SEARCH_TMDB] Credential length: {} (is_token: {})",
            key.len(),
            is_access_token(&key)
        );
        key
    };

    println!("[SEARCH_TMDB] Using TMDB module search with robust retry logic");

    // Run blocking HTTP request in a separate thread using tmdb.rs retry handling
    let raw_results =
        tokio::task::spawn_blocking(move || -> Result<Vec<tmdb::TmdbSearchListItem>, String> {
            tmdb::search_multi_raw(&credential, &query).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;

    let results = raw_results
        .into_iter()
        .map(|item| TmdbSearchResultItem {
            id: item.id,
            title: item.title,
            name: item.name,
            media_type: item.media_type,
            poster_path: item.poster_path,
            backdrop_path: item.backdrop_path,
            overview: item.overview,
            release_date: item.release_date,
            first_air_date: item.first_air_date,
            vote_average: item.vote_average,
        })
        .collect::<Vec<_>>();

    Ok(TmdbSearchResponse {
        total_results: results.len(),
        results,
    })
}

// Videasy localStorage progress format
#[derive(serde::Deserialize, serde::Serialize, Debug)]
struct VideasyProgress {
    duration: f64,
    watched: f64,
}

#[derive(serde::Deserialize, serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct VideasyStorageItem {
    poster: Option<String>,
    background: Option<String>,
    id: i64,
    media_type: String,
    title: String,
    progress: Option<VideasyProgress>,
}

// Open Videasy in the user's default browser
#[tauri::command]
async fn open_videasy_player(
    app_handle: tauri::AppHandle,
    _state: State<'_, AppState>,
    url: String,
    tmdb_id: String,
    media_type: String,
    title: String,
    _poster_path: Option<String>,
    season: Option<i32>,
    episode: Option<i32>,
) -> Result<ApiResponse, String> {
    println!(
        "[VIDEASY] Opening in browser for: {} (tmdb_id: {})",
        title, tmdb_id
    );

    // Validate URL scheme and domain to prevent SSRF and arbitrary URI scheme exploitation
    let parsed_url = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    if parsed_url.scheme() != "https" {
        return Err("Only HTTPS URLs are allowed".to_string());
    }

    if let Some(host_str) = parsed_url.host_str() {
        if host_str != "videasy.net" && !host_str.ends_with(".videasy.net") {
            return Err("URL domain not allowed".to_string());
        }
    } else {
        return Err("Invalid URL domain".to_string());
    }

    // Open the URL directly in the user's default browser using Tauri's shell API
    tauri::api::shell::open(&app_handle.shell_scope(), &url, None)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    let display_title = if media_type == "tv" {
        format!(
            "{} - S{}E{}",
            title,
            season.unwrap_or(1),
            episode.unwrap_or(1)
        )
    } else {
        title.clone()
    };

    Ok(ApiResponse {
        message: format!("Opening \"{}\" in browser", display_title),
    })
}

// Save progress from Videasy player (called from JavaScript)
#[tauri::command]
async fn save_videasy_progress(
    state: State<'_, AppState>,
    tmdb_id: String,
    media_type: String,
    title: String,
    poster_path: Option<String>,
    season: Option<i32>,
    episode: Option<i32>,
    position: f64,
    duration: f64,
) -> Result<ApiResponse, String> {
    println!(
        "[VIDEASY] Saving progress: {} - {:.1}s / {:.1}s",
        title, position, duration
    );

    let db = state.db.lock().map_err(|e| e.to_string())?;

    let poster_url = poster_path.map(|p| {
        if p.starts_with("http") {
            p
        } else {
            format!("https://image.tmdb.org/t/p/w342{}", p)
        }
    });

    db.save_streaming_progress(
        &tmdb_id,
        &media_type,
        &title,
        poster_url.as_deref(),
        season,
        episode,
        position,
        duration,
    )
    .map_err(|e| e.to_string())?;

    Ok(ApiResponse {
        message: "Progress saved".to_string(),
    })
}

// ==================== TRANSCODING COMMANDS ====================

/// Transcode response with stream URL
#[derive(serde::Serialize)]
struct TranscodeResponse {
    session_id: u64,
    stream_url: String,
}

/// Check if a file needs transcoding for HTML5 playback
#[tauri::command]
async fn check_needs_transcode(file_path: String) -> Result<bool, String> {
    Ok(transcoder::needs_transcoding(&file_path))
}

/// Start transcoding a video file
#[tauri::command]
async fn start_transcode_stream(
    state: State<'_, AppState>,
    file_path: String,
    start_time: Option<f64>,
) -> Result<TranscodeResponse, String> {
    // Security check: Verify file is in library
    let is_authorized = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.media_exists(&file_path).map_err(|e| e.to_string())?
    };

    if !is_authorized {
        println!(
            "[SECURITY] Blocked access to non-library file for transcoding: {}",
            file_path
        );
        return Err("Access denied: File not found in library".to_string());
    }

    let ffmpeg_path = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config.ffmpeg_path.clone().ok_or_else(|| {
            "FFmpeg path not configured. Please set it in Settings > Player.".to_string()
        })?
    };

    if ffmpeg_path.is_empty() || !std::path::Path::new(&ffmpeg_path).exists() {
        return Err(
            "FFmpeg path not set or invalid. Please configure it in Settings > Player.".to_string(),
        );
    }

    let (session_id, stream_url) =
        transcoder::start_transcode(&ffmpeg_path, &file_path, start_time)?;

    Ok(TranscodeResponse {
        session_id,
        stream_url,
    })
}

/// Stop a transcoding session
#[tauri::command]
async fn stop_transcode_stream(session_id: u64) -> Result<ApiResponse, String> {
    transcoder::stop_transcode(session_id)?;
    Ok(ApiResponse {
        message: "Transcoding stopped".to_string(),
    })
}

/// Get stream info with transcoding support
#[tauri::command]
async fn get_stream_info_with_transcode(
    state: State<'_, AppState>,
    media_id: i64,
) -> Result<StreamInfo, String> {
    let media = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_media_by_id(media_id).map_err(|e| e.to_string())?
    };

    let file_path = media.file_path.clone().unwrap_or_default();
    let is_cloud = media.is_cloud.unwrap_or(false);
    let is_zip_media = media.parent_zip_id.is_some();

    // Handle cloud media - same as get_stream_info
    if is_cloud {
        if is_zip_media {
            match archive_manager::archive_format_for_media(&media) {
                archive_manager::ArchiveFormat::Zip => {
                    match zip_manager::zip_entry_compression_method(&media)
                        .map_err(|e| e.to_string())?
                    {
                        0 => {
                            let stream_url = build_zip_stream_url(&state, &media, media_id).await?;

                            return Ok(StreamInfo {
                                stream_url,
                                file_path,
                                title: media.title,
                                poster: poster_asset_url(media.poster_path.as_ref()),
                                duration_seconds: media.duration_seconds,
                                resume_position_seconds: media.resume_position_seconds,
                                is_cloud: true,
                                access_token: None,
                            });
                        }
                        8 => {}
                        method => {
                            return Err(format!(
                                "ZIP entry compression method {} is not supported for playback",
                                method
                            ));
                        }
                    }
                }
                archive_manager::ArchiveFormat::Tar | archive_manager::ArchiveFormat::Rar => {
                    if archive_manager::build_archive_stream_info(&media).is_ok() {
                        let stream_url = build_zip_stream_url(&state, &media, media_id).await?;

                        return Ok(StreamInfo {
                            stream_url,
                            file_path,
                            title: media.title,
                            poster: poster_asset_url(media.poster_path.as_ref()),
                            duration_seconds: media.duration_seconds,
                            resume_position_seconds: media.resume_position_seconds,
                            is_cloud: true,
                            access_token: None,
                        });
                    }
                }
            }

            let extracted_path = build_zip_extracted_path(&state, &media).await?;
            let poster = poster_asset_url(media.poster_path.as_ref());
            let needs_transcode = transcoder::needs_transcoding(&extracted_path);

            if needs_transcode {
                let ffmpeg_path = {
                    let config = state.config.lock().map_err(|e| e.to_string())?;
                    config.ffmpeg_path.clone()
                };

                if let Some(ref path) = ffmpeg_path {
                    if !path.is_empty() && std::path::Path::new(path).exists() {
                        let start_time = media.resume_position_seconds;
                        let (_, stream_url) =
                            transcoder::start_transcode(path, &extracted_path, start_time)?;

                        return Ok(StreamInfo {
                            stream_url,
                            file_path: extracted_path,
                            title: media.title,
                            poster,
                            duration_seconds: media.duration_seconds,
                            resume_position_seconds: Some(0.0),
                            is_cloud: false,
                            access_token: None,
                        });
                    }
                }

                return Err("This archived video format requires transcoding. Please configure FFmpeg in Settings > Player, or use MPV/VLC player instead.".to_string());
            }

            return Ok(StreamInfo {
                stream_url: extracted_path.clone(),
                file_path: extracted_path,
                title: media.title,
                poster,
                duration_seconds: media.duration_seconds,
                resume_position_seconds: media.resume_position_seconds,
                is_cloud: false,
                access_token: None,
            });
        }

        if let Some(ref cloud_file_id) = media.cloud_file_id {
            let (stream_url, access_token) =
                state.gdrive_client.get_stream_url(cloud_file_id).await?;

            return Ok(StreamInfo {
                stream_url,
                file_path,
                title: media.title,
                poster: poster_asset_url(media.poster_path.as_ref()),
                duration_seconds: media.duration_seconds,
                resume_position_seconds: media.resume_position_seconds,
                is_cloud: true,
                access_token: Some(access_token),
            });
        } else {
            return Err("Cloud file ID not found".to_string());
        }
    }

    // Check if local file needs transcoding
    let needs_transcode = transcoder::needs_transcoding(&file_path);

    if needs_transcode {
        // Check if FFmpeg is configured
        let ffmpeg_path = {
            let config = state.config.lock().map_err(|e| e.to_string())?;
            config.ffmpeg_path.clone()
        };

        if let Some(ref path) = ffmpeg_path {
            if !path.is_empty() && std::path::Path::new(path).exists() {
                // Start transcoding
                let start_time = media.resume_position_seconds;
                let (_, stream_url) = transcoder::start_transcode(path, &file_path, start_time)?;

                let poster = poster_asset_url(media.poster_path.as_ref());

                return Ok(StreamInfo {
                    stream_url,
                    file_path,
                    title: media.title,
                    poster,
                    duration_seconds: media.duration_seconds,
                    resume_position_seconds: Some(0.0), // Already seeked in transcode
                    is_cloud: false,
                    access_token: None,
                });
            }
        }

        // FFmpeg not configured, return error with helpful message
        return Err(format!(
            "This video format requires transcoding. Please configure FFmpeg in Settings > Player, or use MPV/VLC player instead."
        ));
    }

    // No transcoding needed - return local file path
    if !file_path.is_empty() && std::path::Path::new(&file_path).exists() {
        let poster = poster_asset_url(media.poster_path.as_ref());

        return Ok(StreamInfo {
            stream_url: file_path.clone(),
            file_path,
            title: media.title,
            poster,
            duration_seconds: media.duration_seconds,
            resume_position_seconds: media.resume_position_seconds,
            is_cloud: false,
            access_token: None,
        });
    }

    Err("File not found".to_string())
}

// ==================== CLOUD CACHE MANAGEMENT ====================

/// Cache info response
#[derive(serde::Serialize)]
struct CloudCacheInfo {
    enabled: bool,
    cache_dir: Option<String>,
    total_size_bytes: u64,
    total_size_mb: f64,
    file_count: usize,
    max_size_mb: u32,
    expiry_hours: u32,
}

/// Get cloud cache info and statistics
#[tauri::command]
async fn get_cloud_cache_info(state: State<'_, AppState>) -> Result<CloudCacheInfo, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;

    if !config.cloud_cache_enabled || config.cloud_cache_dir.is_none() {
        return Ok(CloudCacheInfo {
            enabled: false,
            cache_dir: None,
            total_size_bytes: 0,
            total_size_mb: 0.0,
            file_count: 0,
            max_size_mb: config.cloud_cache_max_mb,
            expiry_hours: config.cloud_cache_expiry_hours,
        });
    }

    let cache_dir = config.cloud_cache_dir.clone().unwrap();
    let (total_size, file_count) = calculate_cache_size(&cache_dir);

    Ok(CloudCacheInfo {
        enabled: true,
        cache_dir: Some(cache_dir),
        total_size_bytes: total_size,
        total_size_mb: total_size as f64 / (1024.0 * 1024.0),
        file_count,
        max_size_mb: config.cloud_cache_max_mb,
        expiry_hours: config.cloud_cache_expiry_hours,
    })
}

/// Calculate total size and file count of cache directory
fn calculate_cache_size(cache_dir: &str) -> (u64, usize) {
    let path = std::path::Path::new(cache_dir);
    if !path.exists() {
        return (0, 0);
    }

    let mut total_size: u64 = 0;
    let mut file_count: usize = 0;

    for entry in walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            if let Ok(metadata) = entry.metadata() {
                total_size += metadata.len();
                file_count += 1;
            }
        }
    }

    (total_size, file_count)
}

/// Clean up expired cache files (older than expiry_hours)
#[tauri::command]
async fn cleanup_cloud_cache(state: State<'_, AppState>) -> Result<ApiResponse, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;

    if !config.cloud_cache_enabled || config.cloud_cache_dir.is_none() {
        return Ok(ApiResponse {
            message: "Cloud cache is not enabled".to_string(),
        });
    }

    let cache_dir = config.cloud_cache_dir.clone().unwrap();
    let expiry_hours = config.cloud_cache_expiry_hours;

    let (deleted_count, freed_bytes) = cleanup_expired_cache(&cache_dir, expiry_hours);
    let freed_mb = freed_bytes as f64 / (1024.0 * 1024.0);

    Ok(ApiResponse {
        message: format!(
            "Cleaned up {} files, freed {:.1} MB",
            deleted_count, freed_mb
        ),
    })
}

/// Clean up cache files older than expiry_hours
fn cleanup_expired_cache(cache_dir: &str, expiry_hours: u32) -> (usize, u64) {
    let path = std::path::Path::new(cache_dir);
    if !path.exists() {
        return (0, 0);
    }

    let expiry_duration = std::time::Duration::from_secs((expiry_hours as u64) * 3600);
    let now = std::time::SystemTime::now();

    let mut deleted_count = 0;
    let mut freed_bytes: u64 = 0;

    // Collect directories to potentially remove (media_X folders)
    let mut empty_dirs: Vec<std::path::PathBuf> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let entry_path = entry.path();

            if entry_path.is_dir() {
                // Check each file in the media cache subdirectory
                let mut dir_has_files = false;

                if let Ok(files) = std::fs::read_dir(&entry_path) {
                    for file in files.filter_map(|f| f.ok()) {
                        let file_path = file.path();
                        if file_path.is_file() {
                            if let Ok(metadata) = file.metadata() {
                                if let Ok(modified) = metadata.modified() {
                                    if let Ok(age) = now.duration_since(modified) {
                                        if age > expiry_duration {
                                            let size = metadata.len();
                                            if std::fs::remove_file(&file_path).is_ok() {
                                                deleted_count += 1;
                                                freed_bytes += size;
                                                println!(
                                                    "[CACHE] Deleted expired: {:?}",
                                                    file_path
                                                );
                                            }
                                        } else {
                                            dir_has_files = true;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Mark empty directories for removal
                if !dir_has_files {
                    empty_dirs.push(entry_path);
                }
            }
        }
    }

    // Remove empty directories
    for dir in empty_dirs {
        if std::fs::remove_dir(&dir).is_ok() {
            println!("[CACHE] Removed empty directory: {:?}", dir);
        }
    }

    println!(
        "[CACHE] Cleanup complete: {} files deleted, {} bytes freed",
        deleted_count, freed_bytes
    );
    (deleted_count, freed_bytes)
}

/// Clear all cloud cache
#[tauri::command]
async fn clear_cloud_cache(state: State<'_, AppState>) -> Result<ApiResponse, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;

    if config.cloud_cache_dir.is_none() {
        return Ok(ApiResponse {
            message: "No cache directory configured".to_string(),
        });
    }

    let cache_dir = config.cloud_cache_dir.clone().unwrap();
    let path = std::path::Path::new(&cache_dir);

    if !path.exists() {
        return Ok(ApiResponse {
            message: "Cache directory does not exist".to_string(),
        });
    }

    let (total_size, file_count) = calculate_cache_size(&cache_dir);

    // Remove all contents
    if let Err(e) = std::fs::remove_dir_all(path) {
        return Err(format!("Failed to clear cache: {}", e));
    }

    // Recreate empty directory
    std::fs::create_dir_all(path).ok();

    let freed_mb = total_size as f64 / (1024.0 * 1024.0);
    Ok(ApiResponse {
        message: format!("Cleared {} files, freed {:.1} MB", file_count, freed_mb),
    })
}

/// Helper function to create the main window
/// Used when showing the app from tray - creates a new window if none exists
fn create_main_window(app: &AppHandle) -> Result<tauri::Window, tauri::Error> {
    WindowBuilder::new(app, "main", WindowUrl::App("index.html".into()))
        .title("StreamVault")
        .inner_size(1200.0, 800.0)
        .resizable(true)
        .build()
}

fn send_system_notification(app_handle: &AppHandle, summary: &str, body: &str) {
    let mut notification = SystemNotification::new();
    notification
        .summary(summary)
        .body(body)
        .appname("StreamVault")
        .timeout(notify_rust::Timeout::Milliseconds(3000));

    #[cfg(target_os = "windows")]
    {
        notification.app_id("com.streamvault.app");
    }

    if let Err(e) = notification.show() {
        println!("[NOTIFY] notify-rust failed: {}", e);

        let tauri_notification =
            TauriNotification::new(&app_handle.config().tauri.bundle.identifier)
                .title(summary)
                .body(body);

        if let Err(err) = tauri_notification.show() {
            println!("[NOTIFY] tauri notification failed: {}", err);
        }
    }
}

/// Format a standardized "added" notification message for a single item.
/// For TV episodes, includes the S##E## designator.
fn format_added_notification(title: &str, is_tv: bool, season: Option<i32>, episode: Option<i32>) -> String {
    if is_tv {
        format!(
            "{} S{:02}E{:02} added to your library",
            title,
            season.unwrap_or(1),
            episode.unwrap_or(1)
        )
    } else {
        format!("{} added to your library", title)
    }
}

/// Format a standardized "removed" notification message.
/// When count > 1, uses plural form; otherwise uses the item title directly.
#[allow(dead_code)]
fn format_removed_notification(title: &str, count: Option<usize>) -> String {
    match count {
        Some(n) if n > 1 => format!("{} - {} items removed (deleted from Drive)", title, n),
        _ => format!("{} removed (deleted from Drive)", title),
    }
}

type IndexedCloudItem = (
    i64,
    String,
    String,
    bool,
    Option<i32>,
    Option<i32>,
    String,
    Option<i32>,
);

fn poster_asset_url(poster_path: Option<&String>) -> Option<String> {
    poster_path.and_then(|path| {
        let cache_dir = database::get_image_cache_dir();
        // Prevent path traversal by extracting just the file name.
        // If no valid file name is found (e.g. path is empty or ".."), return None.
        let file_name = std::path::Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())?;

        let full_path = std::path::Path::new(&cache_dir).join(file_name);

        let path_cow = full_path.to_string_lossy();
        let path_str = path_cow.as_ref();

        #[cfg(windows)]
        let path_str = if path_str.starts_with(r"\\?\") {
            &path_str[4..]
        } else {
            path_str
        };

        Some(format!(
            "asset://localhost/{}",
            path_str.replace("\\", "/").replace(":", "")
        ))
    })
}

fn cleanup_expired_zip_streams(state: &AppState) {
    if let Ok(mut streams) = state.active_zip_streams.lock() {
        let stale_ids: Vec<i64> = streams
            .iter()
            .filter_map(|(media_id, stream)| {
                if stream.created_at.elapsed() > Duration::from_secs(21_600) {
                    Some(*media_id)
                } else {
                    None
                }
            })
            .collect();

        for media_id in stale_ids {
            if let Some(mut stream) = streams.remove(&media_id) {
                stream.proxy.stop();
            }
        }
    }
}

fn stop_zip_stream_proxy(state: &AppState, media_id: i64) {
    if let Ok(mut streams) = state.active_zip_streams.lock() {
        if let Some(mut stream) = streams.remove(&media_id) {
            stream.proxy.stop();
        }
    }
}

fn build_zip_cache_config(config: &config::Config) -> zip_manager::ZipCacheConfig {
    let cache_dir = config
        .zip_cache_dir
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(database::get_zip_cache_dir);

    zip_manager::ZipCacheConfig {
        cache_dir,
        max_size_bytes: u64::from(config.zip_cache_max_gb.max(1))
            .saturating_mul(1024 * 1024 * 1024),
        expiry_days: config.zip_cache_expiry_days.max(1),
    }
}

fn should_extract_zip_for_mpv(
    media: &database::MediaItem,
    _start_position: f64,
) -> Result<bool, String> {
    match archive_manager::archive_format_for_media(media) {
        archive_manager::ArchiveFormat::Zip => {
            match zip_manager::zip_entry_compression_method(media).map_err(|e| e.to_string())? {
                8 => Ok(true),
                0 => Ok(false),
                method => Err(format!(
                    "ZIP entry compression method {} is not supported for playback",
                    method
                )),
            }
        }
        archive_manager::ArchiveFormat::Tar | archive_manager::ArchiveFormat::Rar => {
            Ok(archive_manager::build_archive_stream_info(media).is_err())
        }
    }
}

fn choose_store_zip_local_cache_for_mpv(
    media: &database::MediaItem,
    cache_snapshot: &zip_manager::ZipCacheSnapshot,
    start_position: f64,
) -> Option<String> {
    if cache_snapshot.is_complete {
        return Some(
            cache_snapshot
                .paths
                .cache_path
                .to_string_lossy()
                .to_string(),
        );
    }

    if cache_snapshot.available_bytes == 0 {
        return None;
    }
    let is_mkv = media
        .zip_entry_path
        .as_deref()
        .or(media.file_path.as_deref())
        .map(|path| path.to_ascii_lowercase().ends_with(".mkv"))
        .unwrap_or(false);

    let duration_seconds = media.duration_seconds?;
    let total_size = media.zip_uncompressed_size? as f64;
    if duration_seconds <= 0.0 || total_size <= 0.0 {
        return None;
    }

    let bytes_per_second = total_size / duration_seconds;
    let startup_floor_bytes = if start_position > 0.0 {
        if is_mkv {
            24 * 1024 * 1024
        } else {
            18 * 1024 * 1024
        }
    } else if is_mkv {
        10 * 1024 * 1024
    } else {
        6 * 1024 * 1024
    } as f64;

    let required_window_seconds = if start_position > 0.0 {
        if is_mkv {
            8.0
        } else {
            5.0
        }
    } else if is_mkv {
        2.5
    } else {
        1.5
    };

    let required_bytes =
        ((start_position + required_window_seconds) * bytes_per_second).max(startup_floor_bytes);

    if cache_snapshot.available_bytes as f64 >= required_bytes {
        return Some(cache_snapshot.paths.temp_path.to_string_lossy().to_string());
    }

    if start_position <= 1.0 && cache_snapshot.available_bytes as f64 >= startup_floor_bytes {
        return Some(cache_snapshot.paths.temp_path.to_string_lossy().to_string());
    }

    None
}

async fn build_zip_extracted_path(
    state: &AppState,
    media: &database::MediaItem,
) -> Result<String, String> {
    let cache_config = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        build_zip_cache_config(&config)
    };

    if let Err(error) = zip_manager::cleanup_stale_zip_cache(&cache_config) {
        println!("[ZIP] Cache cleanup warning: {}", error);
    }

    let access_token = state.gdrive_client.get_access_token().await?;
    let media = media.clone();
    let cache_config = cache_config.clone();

    tokio::task::spawn_blocking(move || {
        archive_manager::extract_archive_entry_to_cache(&access_token, &media, &cache_config)
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn build_zip_stream_url(
    state: &AppState,
    media: &database::MediaItem,
    media_id: i64,
) -> Result<String, String> {
    let cache_config = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        build_zip_cache_config(&config)
    };

    if let Err(error) = zip_manager::cleanup_stale_zip_cache(&cache_config) {
        println!("[ZIP] Cache cleanup warning: {}", error);
    }
    cleanup_expired_zip_streams(state);
    stop_zip_stream_proxy(state, media_id);

    let stream_info = archive_manager::build_archive_stream_info(media)?;
    let (drive_url, access_token) = state
        .gdrive_client
        .get_stream_url(&stream_info.zip_file_id)
        .await?;
    let proxy_cache_spec = match archive_manager::archive_format_for_media(media) {
        archive_manager::ArchiveFormat::Zip => match zip_manager::zip_entry_compression_method(media) {
        Ok(0) => match zip_manager::prepare_stream_cache_target(media, &cache_config) {
            Ok(cache_paths) => Some(zip_stream_proxy::ProxyCacheSpec {
                cache_paths,
                cache_config: cache_config.clone(),
                start_delay_ms: 4_000,
                throttle_delay_ms: 250,
            }),
            Err(error) => {
                println!(
                    "[ZIP CACHE] Falling back to stream-only built-in proxy for '{}': {:?}",
                    media.title, error
                );
                None
            }
        },
        _ => None,
        },
        archive_manager::ArchiveFormat::Tar | archive_manager::ArchiveFormat::Rar => None,
    };
    let proxy = zip_stream_proxy::start_proxy(zip_stream_proxy::build_proxy_spec(
        drive_url,
        access_token,
        &stream_info,
        proxy_cache_spec,
    ))?;
    let stream_url = zip_stream_proxy::localhost_stream_url(proxy.port);

    let mut streams = state.active_zip_streams.lock().map_err(|e| e.to_string())?;
    streams.insert(
        media_id,
        ActiveZipStream {
            created_at: std::time::Instant::now(),
            proxy,
        },
    );

    Ok(stream_url)
}

async fn build_temporary_zip_stream_url(
    state: &AppState,
    media: &database::MediaItem,
) -> Result<(String, zip_stream_proxy::ZipStreamProxyHandle), String> {
    let stream_info = archive_manager::build_archive_stream_info(media)?;
    let (drive_url, access_token) = state
        .gdrive_client
        .get_stream_url(&stream_info.zip_file_id)
        .await?;

    let proxy = zip_stream_proxy::start_proxy(zip_stream_proxy::build_proxy_spec(
        drive_url,
        access_token,
        &stream_info,
        None,
    ))?;

    Ok((zip_stream_proxy::localhost_stream_url(proxy.port), proxy))
}

fn is_zip_drive_item(file: &gdrive::DriveItem) -> bool {
    gdrive::is_supported_archive_item(file)
}

fn is_unsupported_archive_drive_item(file: &gdrive::DriveItem) -> bool {
    gdrive::is_unsupported_archive_item(file)
}

fn unsupported_archive_reason(file: &gdrive::DriveItem) -> Option<String> {
    if !is_unsupported_archive_drive_item(file) {
        return None;
    }

    Some(
        "TAR archives are not supported because indexing them requires reading the entire archive sequentially from Google Drive, which can consume full bandwidth and cannot behave like ZIP store mode."
            .to_string(),
    )
}

fn notify_unsupported_archives_window(
    window: &Window,
    archive_names: &[String],
) {
    if archive_names.is_empty() {
        return;
    }

    let message = if archive_names.len() == 1 {
        format!(
            "{} is not supported. TAR archives require a full sequential read from Google Drive during indexing, which consumes full bandwidth and cannot work like ZIP store mode.",
            archive_names[0]
        )
    } else {
        format!(
            "{} TAR archive(s) were skipped. TAR archives require a full sequential read from Google Drive during indexing, which consumes full bandwidth and cannot work like ZIP store mode.",
            archive_names.len()
        )
    };

    dispatch_notification(window, "Unsupported TAR Archive", &message, "warning");
}

fn notify_unsupported_archives_handle(
    app_handle: &AppHandle,
    archive_names: &[String],
) {
    if archive_names.is_empty() {
        return;
    }

    let message = if archive_names.len() == 1 {
        format!(
            "{} is not supported. TAR archives require a full sequential read from Google Drive during indexing, which consumes full bandwidth and cannot work like ZIP store mode.",
            archive_names[0]
        )
    } else {
        format!(
            "{} TAR archive(s) were skipped. TAR archives require a full sequential read from Google Drive during indexing, which consumes full bandwidth and cannot work like ZIP store mode.",
            archive_names.len()
        )
    };

    dispatch_notification_from_handle(app_handle, "Unsupported TAR Archive", &message, "warning");
}

fn ensure_cloud_show_with_metadata(
    db: &database::Database,
    api_key: &str,
    image_cache_dir: &str,
    tv_show_cache: &mut HashMap<String, (i64, Option<String>, String)>,
    show_title: &str,
    year: Option<i32>,
    folder_id: &str,
) -> Result<(i64, Option<String>, String), String> {
    let cache_key = show_title.to_lowercase();
    if let Some(cached) = tv_show_cache.get(&cache_key) {
        return Ok(cached.clone());
    }

    let result = if let Some(existing_show) = find_existing_cloud_tvshow(db, show_title, year) {
        (
            existing_show.id,
            existing_show.tmdb_id,
            folder_id.to_string(),
        )
    } else {
        let tmdb_result = tmdb::search_metadata(api_key, show_title, "tv", year, image_cache_dir)
            .ok()
            .flatten();

        let (title, year, overview, cast_names, poster_path, tmdb_id_opt) = match &tmdb_result {
            Some(meta) => (
                meta.title.clone(),
                meta.year,
                meta.overview.clone(),
                meta.cast_names.clone(),
                meta.poster_path.clone(),
                meta.tmdb_id.clone(),
            ),
            None => (show_title.to_string(), None, None, None, None, None),
        };

        let preferred_title = media_manager::prefer_title_with_leading_article(show_title, &title);
        let show_id = db
            .insert_cloud_tvshow(
                &preferred_title,
                year,
                overview.as_deref(),
                cast_names.as_deref(),
                poster_path.as_deref(),
                &format!("gdrive:{}", folder_id),
                folder_id,
                tmdb_id_opt.as_deref(),
            )
            .map_err(|e| e.to_string())?;

        (show_id, tmdb_id_opt, folder_id.to_string())
    };

    tv_show_cache.insert(cache_key, result.clone());
    Ok(result)
}

fn ensure_cloud_show_without_metadata(
    db: &database::Database,
    tv_show_cache: &mut HashMap<String, i64>,
    show_title: &str,
    year: Option<i32>,
    folder_id: &str,
) -> Result<i64, String> {
    let cache_key = show_title.to_lowercase();
    if let Some(cached) = tv_show_cache.get(&cache_key) {
        return Ok(*cached);
    }

    let show_id = if let Some(existing_show) = find_existing_cloud_tvshow(db, show_title, year) {
        existing_show.id
    } else {
        db.insert_cloud_tvshow(
            show_title,
            None,
            None,
            None,
            None,
            &format!("gdrive:{}:{}", folder_id, cache_key.replace(' ', "_")),
            folder_id,
            None,
        )
        .map_err(|e| e.to_string())?
    };

    tv_show_cache.insert(cache_key, show_id);
    Ok(show_id)
}

fn fetch_episode_metadata(
    api_key: &str,
    image_cache_dir: &str,
    season_cache: &mut HashMap<(String, i32), Vec<tmdb::TmdbEpisodeInfo>>,
    tmdb_id: Option<&String>,
    show_title: &str,
    season: i32,
    episode: i32,
) -> (Option<String>, Option<String>, Option<String>) {
    let Some(tmdb_id) = tmdb_id else {
        return (None, None, None);
    };

    let cache_key = (tmdb_id.clone(), season);
    let episodes = if let Some(cached_episodes) = season_cache.get(&cache_key) {
        cached_episodes.clone()
    } else {
        match tmdb::fetch_season_episodes(api_key, tmdb_id, season, show_title, image_cache_dir) {
            Ok(season_info) => {
                let episodes = season_info.episodes.clone();
                season_cache.insert(cache_key.clone(), episodes.clone());
                episodes
            }
            Err(_) => {
                season_cache.insert(cache_key.clone(), Vec::new());
                Vec::new()
            }
        }
    };

    episodes
        .iter()
        .find(|item| item.episode_number == episode)
        .map(|item| {
            (
                Some(item.name.clone()),
                item.overview.clone(),
                item.still_path.clone(),
            )
        })
        .unwrap_or((None, None, None))
}

fn index_zip_archive_with_metadata(
    db: &database::Database,
    access_token: &str,
    file: &gdrive::DriveItem,
    folder_id_fallback: &str,
    api_key: &str,
    image_cache_dir: &str,
    cache_config: &zip_manager::ZipCacheConfig,
    tv_show_cache: &mut HashMap<String, (i64, Option<String>, String)>,
    season_cache: &mut HashMap<(String, i32), Vec<tmdb::TmdbEpisodeInfo>>,
) -> Result<Vec<IndexedCloudItem>, String> {
    let analyzed = archive_manager::analyze_archive_from_drive(
        access_token,
        &file.id,
        &file.name,
        Some(&file.mime_type),
        cache_config,
    )?;

    if analyzed.indexed_entries.is_empty() {
        return Ok(Vec::new());
    }

    db.insert_zip_archive(&analyzed.archive)
        .map_err(|e| e.to_string())?;
    let archive_format = analyzed.archive.archive_format.clone();

    let folder_id = file
        .parents
        .as_ref()
        .and_then(|parents| parents.first())
        .cloned()
        .unwrap_or_else(|| folder_id_fallback.to_string());

    let mut indexed_items = Vec::new();

    for entry in analyzed.indexed_entries {
        let season = entry.parsed.season.unwrap_or(0);
        let episode = entry.parsed.episode.unwrap_or(0);
        if season <= 0 || episode <= 0 {
            continue;
        }

        let show_title = entry.parsed.title.clone();
        let (show_id, tmdb_id, show_folder_id) = ensure_cloud_show_with_metadata(
            db,
            api_key,
            image_cache_dir,
            tv_show_cache,
            &show_title,
            entry.parsed.year,
            &folder_id,
        )?;

        let (episode_title, overview, still_path) = fetch_episode_metadata(
            api_key,
            image_cache_dir,
            season_cache,
            tmdb_id.as_ref(),
            &show_title,
            season,
            episode,
        );

        let media_id = db
            .insert_cloud_episode_from_zip(
                &show_title,
                show_id,
                season,
                episode,
                &show_folder_id,
                &archive_format,
                &file.id,
                &entry.entry_path,
                entry.local_header_offset as i64,
                entry.data_start_offset as i64,
                entry.compressed_size as i64,
                entry.uncompressed_size as i64,
                &entry.crc32,
                entry.compression_method as i64,
                episode_title.as_deref(),
                overview.as_deref(),
                still_path.as_deref(),
            )
            .map_err(|e| e.to_string())?;

        indexed_items.push((
            media_id,
            show_title,
            file.id.clone(),
            true,
            Some(season),
            Some(episode),
            show_folder_id,
            entry.parsed.year,
        ));
    }

    Ok(indexed_items)
}

fn index_zip_archive_without_metadata(
    db: &database::Database,
    access_token: &str,
    file: &gdrive::DriveItem,
    folder_id_fallback: &str,
    cache_config: &zip_manager::ZipCacheConfig,
    tv_show_cache: &mut HashMap<String, i64>,
) -> Result<Vec<IndexedCloudItem>, String> {
    let analyzed = archive_manager::analyze_archive_from_drive(
        access_token,
        &file.id,
        &file.name,
        Some(&file.mime_type),
        cache_config,
    )?;

    if analyzed.indexed_entries.is_empty() {
        return Ok(Vec::new());
    }

    db.insert_zip_archive(&analyzed.archive)
        .map_err(|e| e.to_string())?;
    let archive_format = analyzed.archive.archive_format.clone();

    let folder_id = file
        .parents
        .as_ref()
        .and_then(|parents| parents.first())
        .cloned()
        .unwrap_or_else(|| folder_id_fallback.to_string());

    let mut indexed_items = Vec::new();

    for entry in analyzed.indexed_entries {
        let season = entry.parsed.season.unwrap_or(0);
        let episode = entry.parsed.episode.unwrap_or(0);
        if season <= 0 || episode <= 0 {
            continue;
        }

        let show_title = entry.parsed.title.clone();
        let show_id = ensure_cloud_show_without_metadata(
            db,
            tv_show_cache,
            &show_title,
            entry.parsed.year,
            &folder_id,
        )?;

        let media_id = db
            .insert_cloud_episode_from_zip(
                &show_title,
                show_id,
                season,
                episode,
                &folder_id,
                &archive_format,
                &file.id,
                &entry.entry_path,
                entry.local_header_offset as i64,
                entry.data_start_offset as i64,
                entry.compressed_size as i64,
                entry.uncompressed_size as i64,
                &entry.crc32,
                entry.compression_method as i64,
                None,
                None,
                None,
            )
            .map_err(|e| e.to_string())?;

        indexed_items.push((
            media_id,
            show_title,
            file.id.clone(),
            true,
            Some(season),
            Some(episode),
            folder_id.clone(),
            entry.parsed.year,
        ));
    }

    Ok(indexed_items)
}

fn emit_ui_notification(window: &tauri::Window, title: &str, message: &str, kind: &str) {
    let notification_key = format!("{}|{}|{}", kind, title, message);
    let now = std::time::Instant::now();
    let dedupe_window = Duration::from_secs(3);

    if let Ok(mut recent) = RECENT_UI_NOTIFICATIONS.lock() {
        recent.retain(|_, instant| now.duration_since(*instant) <= dedupe_window);
        if let Some(last_seen) = recent.get(&notification_key) {
            if now.duration_since(*last_seen) <= dedupe_window {
                return;
            }
        }
        recent.insert(notification_key, now);
    }

    if let Err(e) = window
        .emit(
            "notification",
            serde_json::json!({ "type": kind, "title": title, "message": message }),
        )
    {
        eprintln!("[NOTIFY] Failed to emit notification: {}", e);
    }
}

fn should_show_in_app_notification(window: &tauri::Window) -> bool {
    if window.is_minimized().unwrap_or(false) {
        return false;
    }

    window.is_focused().unwrap_or(false)
}

fn dispatch_notification(window: &tauri::Window, title: &str, message: &str, kind: &str) {
    if should_show_in_app_notification(window) {
        emit_ui_notification(window, title, message, kind);
    } else {
        send_system_notification(&window.app_handle(), title, message);
    }
}

fn emit_ui_notification_from_handle(
    app_handle: &AppHandle,
    title: &str,
    message: &str,
    kind: &str,
) {
    if let Some(window) = app_handle.get_window("main") {
        dispatch_notification(&window, title, message, kind);
    } else {
        // Window not available, send system notification only
        send_system_notification(app_handle, title, message);
    }
}

fn dispatch_notification_from_handle(
    app_handle: &AppHandle,
    title: &str,
    message: &str,
    kind: &str,
) {
    emit_ui_notification_from_handle(app_handle, title, message, kind);
}

fn emit_zip_processing_event(
    window: &tauri::Window,
    phase: &str,
    archive_count: usize,
    archive_name: Option<&str>,
    episodes_indexed: Option<usize>,
    message: &str,
) {
    let payload = ZipProcessingEventPayload {
        phase: phase.to_string(),
        archive_count,
        archive_name: archive_name.map(|value| value.to_string()),
        episodes_indexed,
        message: message.to_string(),
    };

    window.emit("zip-processing-status", payload).ok();
}

fn build_mpv_display_title(media: &database::MediaItem) -> String {
    let inferred_episode_numbers = media
        .zip_entry_path
        .as_deref()
        .or(media.file_path.as_deref())
        .and_then(infer_episode_numbers_from_path);

    let season = media
        .season_number
        .or(inferred_episode_numbers.map(|(season, _)| season));
    let episode = media
        .episode_number
        .or(inferred_episode_numbers.map(|(_, episode)| episode));
    let is_episode = matches!(
        media.media_type.as_str(),
        "tv" | "tvepisode" | "episode"
    ) || season.is_some() || episode.is_some();

    if is_episode {
        let season = season.unwrap_or(1);
        let episode = episode.unwrap_or(1);
        let mut display_title = format!("{} S{:02}E{:02}", media.title, season, episode);

        if let Some(episode_title) = media
            .episode_title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != media.title)
        {
            display_title.push_str(" - ");
            display_title.push_str(episode_title);
        }

        display_title
    } else {
        media.title.clone()
    }
}

fn infer_episode_numbers_from_path(path: &str) -> Option<(i32, i32)> {
    let pattern = regex::Regex::new(r"(?i)\bS(?P<season>\d{1,2})E(?P<episode>\d{1,3})\b").ok()?;
    let captures = pattern.captures(path)?;
    let season = captures.name("season")?.as_str().parse::<i32>().ok()?;
    let episode = captures.name("episode")?.as_str().parse::<i32>().ok()?;
    Some((season, episode))
}

fn emit_zip_processing_event_from_handle(
    app_handle: &AppHandle,
    phase: &str,
    archive_count: usize,
    archive_name: Option<&str>,
    episodes_indexed: Option<usize>,
    message: &str,
) {
    if let Some(window) = app_handle.get_window("main") {
        emit_zip_processing_event(
            &window,
            phase,
            archive_count,
            archive_name,
            episodes_indexed,
            message,
        );
    }
}

/// Background cloud change detection polling
/// Runs independently of the window to detect new files even when minimized to tray
async fn background_cloud_poll(app_handle: AppHandle) {
    use std::time::Duration;

    // Initial delay to let app fully initialize (same as frontend)
    tokio::time::sleep(Duration::from_secs(3)).await;

    println!("[CLOUD BG] Background cloud polling started (5-second interval)");

    loop {
        // Get state from app handle
        let state: tauri::State<'_, AppState> = app_handle.state();

        // Check if authenticated
        if !state.gdrive_client.is_authenticated() {
            // Not connected - wait and retry (silent, don't spam logs)
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        }

        // Cloud-only mode: No folder check needed - we monitor entire Drive
        println!("[CLOUD BG] Polling for changes...");

        // Perform the actual check
        match background_check_cloud_changes(&app_handle).await {
            Ok(result) => {
                if result.indexed_count > 0 {
                    println!(
                        "[CLOUD BG] ✓ Indexed {} new items ({} movies, {} TV)",
                        result.indexed_count, result.movies_count, result.tv_count
                    );

                    // Emit event to window if it exists
                    if let Some(window) = app_handle.get_window("main") {
                        window.emit("library-updated", ()).ok();
                    }
                } else {
                    println!("[CLOUD BG] No new files detected");
                }
            }
            Err(e) => {
                println!("[CLOUD BG] Poll error: {}", e);
            }
        }

        // Wait 5 seconds before next poll (same as frontend)
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Background version of check_cloud_changes that doesn't require a Window parameter
async fn background_check_cloud_changes(
    app_handle: &AppHandle,
) -> Result<CloudIndexResult, String> {
    let state: tauri::State<'_, AppState> = app_handle.state();
    let start_time = std::time::Instant::now();

    println!("[CLOUD BG] ══════════════════════════════════════════");
    println!("[CLOUD BG] Starting change detection poll...");

    // Check if authenticated
    if !state.gdrive_client.is_authenticated() {
        println!("[CLOUD BG] Not authenticated - skipping");
        println!("[CLOUD BG] ══════════════════════════════════════════");
        return Ok(CloudIndexResult {
            success: true,
            indexed_count: 0,
            skipped_count: 0,
            movies_count: 0,
            tv_count: 0,
            message: "Not connected to Google Drive".to_string(),
        });
    }

    // Get or initialize the changes token
    let current_token = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_gdrive_changes_token().map_err(|e| e.to_string())?
    };

    let page_token = match current_token {
        Some(token) => {
            println!(
                "[CLOUD BG] Using existing token: {}...",
                &token[..token.len().min(20)]
            );
            token
        }
        None => {
            // First time - get the start token
            println!("[CLOUD BG] No token found - initializing changes tracking...");
            let start_token = state.gdrive_client.get_changes_start_token().await?;
            println!(
                "[CLOUD BG] Got start token: {}...",
                &start_token[..start_token.len().min(20)]
            );
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db.set_gdrive_changes_token(&start_token)
                .map_err(|e| e.to_string())?;
            println!("[CLOUD BG] Token saved - will detect changes on next poll");
            println!("[CLOUD BG] ══════════════════════════════════════════");
            return Ok(CloudIndexResult {
                success: true,
                indexed_count: 0,
                skipped_count: 0,
                movies_count: 0,
                tv_count: 0,
                message: "Changes tracking initialized".to_string(),
            });
        }
    };

    // Note: We no longer filter by tracked folders - index all video files in Drive
    println!("[CLOUD BG] Monitoring entire Google Drive for changes");

    // Get changes since last check
    let api_start = std::time::Instant::now();
    let (changed_files, removed_file_ids, new_token) =
        state.gdrive_client.get_video_changes(&page_token).await?;
    let api_duration = api_start.elapsed();
    println!("[CLOUD BG] Changes API call took {:?}", api_duration);

    // Save the new token immediately
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.set_gdrive_changes_token(&new_token)
            .map_err(|e| e.to_string())?;
    }

    let mut removed_titles: Vec<String> = Vec::new();
    if !removed_file_ids.is_empty() {
        if let Ok(db) = state.db.lock() {
            for file_id in removed_file_ids {
                if let Ok(Some((_id, title, _media_type, _parent_id))) =
                    db.remove_media_by_cloud_file_id(&file_id)
                {
                    removed_titles.push(title);
                }
            }

            if !removed_titles.is_empty() {
                let _ = db.cleanup_empty_series();
            }
        }

        if !removed_titles.is_empty() {
            if let Some(window) = app_handle.get_window("main") {
                window.emit("library-updated", ()).ok();
            }

            // Group TV episodes by series name to avoid spamming notifications
            let mut series_episodes: std::collections::HashMap<String, Vec<String>> =
                std::collections::HashMap::new();
            let mut non_tv_titles: Vec<String> = Vec::new();

            for title in &removed_titles {
                // Check if this is a TV episode (format: "Title SXXEXX" or "Title SXEX")
                // Examples: "Breaking Bad S01E01", "Breaking Bad S1E1", "Breaking Bad S10E15"
                let is_tv_episode = if let Some(pos) = title.find(" S") {
                    let rest = &title[pos + 2..]; // Skip " S"
                    if rest.len() >= 3 && rest.starts_with(|c: char| c.is_ascii_digit()) {
                        // Look for pattern: digit(s) + 'E' + digit(s)
                        if let Some(e_pos) = rest.find(|c: char| c.to_ascii_uppercase() == 'E') {
                            if e_pos > 0 && e_pos < rest.len() - 1 {
                                let season_part = &rest[..e_pos];
                                let episode_part = &rest[e_pos + 1..];
                                // Both season and episode should be numeric
                                season_part.chars().all(|c| c.is_ascii_digit()) && 
                                episode_part.chars().all(|c| c.is_ascii_digit()) &&
                                !season_part.is_empty() && !episode_part.is_empty()
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                };

                if is_tv_episode {
                    // Extract series name (everything before " S")
                    if let Some(pos) = title.find(" S") {
                        let series_name = &title[..pos];
                        series_episodes.entry(series_name.to_string())
                            .or_insert_with(Vec::new)
                            .push(title.clone());
                        continue;
                    }
                }
                // Not a TV episode, add to regular titles
                non_tv_titles.push(title.clone());
            }

            let mut messages = Vec::new();

            for (series_name, episodes) in &series_episodes {
                let episode_count = episodes.len();
                if episode_count == 1 {
                    messages.push(format!("{} (1 episode)", series_name));
                } else {
                    messages.push(format!("{} ({} episodes)", series_name, episode_count));
                }
            }

            for title in &non_tv_titles {
                messages.push(title.clone());
            }

            if !messages.is_empty() {
                let message = if messages.len() == 1 {
                    format!("{} removed (deleted from Drive)", messages[0])
                } else {
                    format!("{} items removed (deleted from Drive)", messages.len())
                };

                dispatch_notification_from_handle(app_handle, "StreamVault", &message, "info");
            }
        }
    }

    if changed_files.is_empty() {
        let total_duration = start_time.elapsed();
        println!(
            "[CLOUD BG] No changes detected (total: {:?})",
            total_duration
        );
        println!("[CLOUD BG] ══════════════════════════════════════════");
        return Ok(CloudIndexResult {
            success: true,
            indexed_count: 0,
            skipped_count: 0,
            movies_count: 0,
            tv_count: 0,
            message: if removed_titles.is_empty() {
                "No new files detected".to_string()
            } else {
                format!(
                    "Removed {} item(s) deleted from Drive",
                    removed_titles.len()
                )
            },
        });
    }

    println!(
        "[CLOUD BG] Detected {} changed video file(s)",
        changed_files.len()
    );

    // Index all detected video files (no folder filtering)
    let unsupported_archives: Vec<String> = changed_files
        .iter()
        .filter(|file| is_unsupported_archive_drive_item(file))
        .map(|file| file.name.clone())
        .collect();
    if !unsupported_archives.is_empty() {
        notify_unsupported_archives_handle(app_handle, &unsupported_archives);
    }
    let files_to_index: Vec<_> = changed_files
        .into_iter()
        .filter(|file| !is_unsupported_archive_drive_item(file))
        .collect();

    if files_to_index.is_empty() {
        return Ok(CloudIndexResult {
            success: true,
            indexed_count: 0,
            skipped_count: unsupported_archives.len(),
            movies_count: 0,
            tv_count: 0,
            message: if unsupported_archives.is_empty() {
                "No new files detected".to_string()
            } else {
                format!(
                    "Skipped {} unsupported TAR archive(s)",
                    unsupported_archives.len()
                )
            },
        });
    }

    // Get API key from config
    let (api_key, archive_cache_config) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        (
            tmdb::get_tmdb_credential(&config.tmdb_api_key.clone().unwrap_or_default()),
            build_zip_cache_config(&config),
        )
    };

    let image_cache_dir = database::get_image_cache_dir();
    std::fs::create_dir_all(&image_cache_dir).ok();
    let db_path = database::get_database_path();
    let zip_indexing_enabled = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config.zip_indexing_enabled
    };
    let zip_files_detected: Vec<String> = if zip_indexing_enabled {
        files_to_index
            .iter()
            .filter(|file| is_zip_drive_item(file))
            .map(|file| file.name.clone())
            .collect()
    } else {
        Vec::new()
    };
    let zip_access_token = if zip_indexing_enabled && files_to_index.iter().any(is_zip_drive_item) {
        Some(state.gdrive_client.get_access_token().await?)
    } else {
        None
    };

    if !zip_files_detected.is_empty() {
        let archive_name = zip_files_detected.first().map(|name| name.as_str());
        emit_zip_processing_event_from_handle(
            app_handle,
            "detected",
            zip_files_detected.len(),
            archive_name,
            None,
            &format!(
                "Archive{} detected in Google Drive. Processing episode entries...",
                if zip_files_detected.len() == 1 {
                    ""
                } else {
                    "s"
                }
            ),
        );
    }

    // PHASE 1: Add files immediately without metadata
    let phase1_result = {
        let db_path_clone = db_path.clone();
        let files_to_index_clone: Vec<_> = files_to_index
            .iter()
            .map(|f| (f.id.clone(), f.name.clone(), f.parents.clone()))
            .collect();

        tokio::task::spawn_blocking(move || {
            let db = match database::Database::new(&db_path_clone) {
                Ok(d) => d,
                Err(e) => return Err(format!("Failed to open database: {}", e)),
            };

            let mut indexed_items: Vec<(
                i64,
                String,
                String,
                bool,
                Option<i32>,
                Option<i32>,
                String,
                Option<i32>,
            )> = Vec::new();
            let mut skipped_count = 0;
            let mut movies_count = 0;
            let mut tv_count = 0;
            let mut entry_counter = 0usize;
            let mut tv_show_cache: std::collections::HashMap<String, i64> =
                std::collections::HashMap::new();

            for (file_id, file_name, parents) in files_to_index_clone {
                if db.cloud_file_exists(&file_id) {
                    skipped_count += 1;
                    continue;
                }

                if let Ok(Some(_)) = db.get_media_by_file_path(&file_name) {
                    skipped_count += 1;
                    continue;
                }

                let folder_id = parents
                    .as_ref()
                    .and_then(|p| p.first())
                    .cloned()
                    .unwrap_or_default();

                let pseudo_file = gdrive::DriveItem {
                    id: file_id.clone(),
                    name: file_name.clone(),
                    mime_type: if file_name.to_ascii_lowercase().ends_with(".zip") {
                        "application/zip".to_string()
                    } else {
                        String::new()
                    },
                    size: None,
                    modified_time: None,
                    parents: parents.clone(),
                    web_content_link: None,
                };

                if is_zip_drive_item(&pseudo_file) {
                    if !zip_indexing_enabled {
                        skipped_count += 1;
                        continue;
                    }

                    let Some(access_token) = zip_access_token.as_deref() else {
                        skipped_count += 1;
                        continue;
                    };

                    match index_zip_archive_without_metadata(
                        &db,
                        access_token,
                        &pseudo_file,
                        &folder_id,
                        &archive_cache_config,
                        &mut tv_show_cache,
                    ) {
                        Ok(items) => {
                            if items.is_empty() {
                                skipped_count += 1;
                            } else {
                                tv_count += items.len();
                                entry_counter += items.len();
                                indexed_items.extend(items);
                            }
                            continue;
                        }
                        Err(error) => {
                            println!("[ZIP] Failed to index '{}': {}", file_name, error);
                            skipped_count += 1;
                            continue;
                        }
                    }
                }

                let parsed = media_manager::parse_cloud_filename(&file_name);
                let is_tv_show = parsed.season.is_some() && parsed.episode.is_some();

                if is_tv_show {
                    let season = parsed.season.unwrap();
                    let episode = parsed.episode.unwrap();
                    let show_title = parsed.title.clone();
                    let show_title_lower = show_title.to_lowercase();

                    let db_show_id = if let Some(&cached_id) = tv_show_cache.get(&show_title_lower)
                    {
                        cached_id
                    } else {
                        let show_id = if let Some(existing_show) =
                            find_existing_cloud_tvshow(&db, &show_title, parsed.year)
                        {
                            existing_show.id
                        } else {
                            let show_path = format!(
                                "gdrive:{}:{}",
                                folder_id,
                                show_title.to_lowercase().replace(" ", "_")
                            );
                            match db.insert_cloud_tvshow(
                                &show_title,
                                None,
                                None,
                                None,
                                None,
                                &show_path,
                                &folder_id,
                                None,
                            ) {
                                Ok(id) => id,
                                Err(_) => continue,
                            }
                        };
                        tv_show_cache.insert(show_title_lower, show_id);
                        show_id
                    };

                    match db.insert_cloud_episode(
                        &show_title,
                        &file_name,
                        db_show_id,
                        season,
                        episode,
                        &file_id,
                        &folder_id,
                        None,
                        None,
                        None,
                    ) {
                        Ok(ep_id) => {
                            indexed_items.push((
                                ep_id,
                                show_title,
                                file_id.clone(),
                                true,
                                Some(season),
                                Some(episode),
                                folder_id,
                                parsed.year,
                            ));
                            tv_count += 1;
                            entry_counter += 1;
                            println!(
                                "[INDEX] #{} TV episode '{}' (db_id: {}, cloud_file_id: {})",
                                entry_counter, file_name, ep_id, file_id
                            );
                        }
                        Err(_) => continue,
                    }
                } else {
                    match db.insert_cloud_movie(
                        &parsed.title,
                        parsed.year,
                        None,
                        None,
                        None,
                        None,
                        &file_name,
                        &file_id,
                        &folder_id,
                        0.0,
                        None,
                    ) {
                        Ok(movie_id) => {
                            indexed_items.push((
                                movie_id,
                                parsed.title,
                                file_id.clone(),
                                false,
                                None,
                                None,
                                folder_id,
                                parsed.year,
                            ));
                            movies_count += 1;
                            entry_counter += 1;
                            println!(
                                "[INDEX] #{} Movie '{}' (db_id: {}, cloud_file_id: {})",
                                entry_counter, file_name, movie_id, file_id
                            );
                        }
                        Err(_) => continue,
                    }
                }
            }

            Ok((indexed_items, skipped_count, movies_count, tv_count))
        })
        .await
        .map_err(|e| format!("Task failed: {}", e))?
    }?;

    let (indexed_items, skipped_count, movies_count, tv_count) = phase1_result;
    let skipped_count = skipped_count + unsupported_archives.len();
    let indexed_count = indexed_items.len();

    if !zip_files_detected.is_empty() {
        let archive_name = zip_files_detected.first().map(|name| name.as_str());
        emit_zip_processing_event_from_handle(
            app_handle,
            "complete",
            zip_files_detected.len(),
            archive_name,
            None,
            &format!(
                "Finished processing {} ZIP archive(s). Episode entries have been added to your library.",
                zip_files_detected.len()
            ),
        );
    }

    // Send a consolidated notification for new items (batched to avoid notification spam)
    if indexed_count > 0 {
        // Group additions by type: TV series (grouped) vs movies
        let mut series_episodes: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        let mut movie_count: usize = 0;
        let mut single_movie_title: Option<String> = None;

        for (_, title, _, is_tv, season, episode, _, _) in &indexed_items {
            if *is_tv {
                // Group by series name. Use format_added_notification for single-episode case.
                *series_episodes.entry(title.clone()).or_insert(0) += 1;
                let _ = (season, episode); // consumed by format_added_notification when needed
            } else {
                movie_count += 1;
                if movie_count == 1 {
                    single_movie_title = Some(title.clone());
                }
            }
        }

        // Build consolidated notification messages
        let mut notification_parts: Vec<String> = Vec::new();

        // TV series summary
        for (series_name, ep_count) in &series_episodes {
            if *ep_count == 1 {
                notification_parts.push(format!("{} (1 episode)", series_name));
            } else {
                notification_parts.push(format!("{} ({} episodes)", series_name, ep_count));
            }
        }

        // Movies summary
        if movie_count == 1 {
            if let Some(ref title) = single_movie_title {
                notification_parts.push(format_added_notification(title, false, None, None));
            }
        } else if movie_count > 1 {
            notification_parts.push(format!("{} movies added to your library", movie_count));
        }

        // Send a single consolidated notification
        if !notification_parts.is_empty() {
            let message = if notification_parts.len() == 1 {
                // Single entry: use the specific message directly
                notification_parts[0].clone()
            } else {
                // Multiple entries: summarise
                format!("{} items added to your library", indexed_count)
            };

            dispatch_notification_from_handle(app_handle, "StreamVault", &message, "success");
        }

        // Emit library-updated if window exists
        if let Some(window) = app_handle.get_window("main") {
            window.emit("library-updated", ()).ok();
        }
    }

    // PHASE 2: Fetch metadata in background (if API key configured)
    if !indexed_items.is_empty() && !api_key.is_empty() {
        let db_path_bg = db_path.clone();
        let image_cache_dir_bg = image_cache_dir.clone();
        let app_handle_clone = app_handle.clone();

        tokio::spawn(async move {
            let _ = tokio::task::spawn_blocking(move || {
                let db = match database::Database::new(&db_path_bg) {
                    Ok(d) => d,
                    Err(_) => return,
                };

                let mut tv_metadata_cache: std::collections::HashMap<
                    String,
                    Option<tmdb::TmdbMetadata>,
                > = std::collections::HashMap::new();
                let mut tv_show_updated: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                let mut season_cache: std::collections::HashMap<
                    (String, i32),
                    Vec<tmdb::TmdbEpisodeInfo>,
                > = std::collections::HashMap::new();

                for (media_id, title, _file_id, is_tv, season_opt, episode_opt, _folder_id, year) in
                    indexed_items
                {
                    if is_tv {
                        let season = season_opt.unwrap_or(1);
                        let episode = episode_opt.unwrap_or(1);
                        let title_lower = title.to_lowercase();

                        let show_meta = if let Some(cached) = tv_metadata_cache.get(&title_lower) {
                            cached.clone()
                        } else {
                            let meta = tmdb::search_metadata(
                                &api_key,
                                &title,
                                "tv",
                                year,
                                &image_cache_dir_bg,
                            )
                            .ok()
                            .flatten();
                            tv_metadata_cache.insert(title_lower.clone(), meta.clone());
                            meta
                        };

                        if let Some(ref meta) = show_meta {
                            if !tv_show_updated.contains(&title_lower) {
                                if let Some(show) = find_existing_cloud_tvshow(&db, &title, None) {
                                    let mut show_meta_to_apply = meta.clone();
                                    show_meta_to_apply.title =
                                        media_manager::prefer_title_with_leading_article(
                                            &title,
                                            &show_meta_to_apply.title,
                                        );
                                    db.update_metadata(show.id, &show_meta_to_apply).ok();
                                }
                                tv_show_updated.insert(title_lower.clone());
                            }

                            if let Some(ref tmdb_id) = meta.tmdb_id {
                                let cache_key = (tmdb_id.clone(), season);
                                let episodes =
                                    if let Some(cached_eps) = season_cache.get(&cache_key) {
                                        cached_eps.clone()
                                    } else {
                                        match tmdb::fetch_season_episodes(
                                            &api_key,
                                            tmdb_id,
                                            season,
                                            &title,
                                            &image_cache_dir_bg,
                                        ) {
                                            Ok(season_info) => {
                                                let eps = season_info.episodes.clone();
                                                season_cache.insert(cache_key.clone(), eps.clone());
                                                eps
                                            }
                                            Err(_) => {
                                                season_cache.insert(cache_key.clone(), Vec::new());
                                                Vec::new()
                                            }
                                        }
                                    };

                                if let Some(ep_info) =
                                    episodes.iter().find(|e| e.episode_number == episode)
                                {
                                    db.update_episode_metadata(
                                        media_id,
                                        Some(&ep_info.name),
                                        ep_info.overview.as_deref(),
                                        ep_info.still_path.as_deref(),
                                    )
                                    .ok();
                                }
                            }
                        }
                    } else {
                        if let Ok(Some(meta)) = tmdb::search_metadata(
                            &api_key,
                            &title,
                            "movie",
                            year,
                            &image_cache_dir_bg,
                        ) {
                            let mut movie_meta = meta;
                            movie_meta.title = media_manager::prefer_title_with_leading_article(
                                &title,
                                &movie_meta.title,
                            );
                            db.update_metadata(media_id, &movie_meta).ok();
                        }
                    }
                }
            })
            .await;

            // Emit library-updated again after metadata fetch
            if let Some(window) = app_handle_clone.get_window("main") {
                window.emit("library-updated", ()).ok();
            }
        });
    }

    if indexed_count > 0 {
        let db_path_merge = database::get_database_path();
        if let Ok(db) = database::Database::new(&db_path_merge) {
            let merged = auto_merge_duplicate_tvshows(&db, "background_check_cloud_changes");
            if merged > 0 {
                if let Some(window) = app_handle.get_window("main") {
                    window.emit("library-updated", ()).ok();
                }
            }
        }
    }

    let total_duration = start_time.elapsed();
    println!(
        "[CLOUD BG] Poll complete: {} indexed, {} skipped ({:?})",
        indexed_count, skipped_count, total_duration
    );

    Ok(CloudIndexResult {
        success: true,
        indexed_count,
        skipped_count,
        movies_count,
        tv_count,
        message: format!("Indexed {} new files", indexed_count),
    })
}

// ============== AUTO-UPDATE COMMANDS ==============

// GitHub PAT for accessing private releases
const GITHUB_RELEASE_TOKEN: &str = ""; // User will provide their PAT
const ALLOWED_REPO: &str = "SlasshyOverhere/StreamVault";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_notes: String,
    pub download_url: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ZipProcessingEventPayload {
    phase: String,
    archive_count: usize,
    archive_name: Option<String>,
    episodes_indexed: Option<usize>,
    message: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: i64,
}

/// Check for updates from GitHub releases
#[tauri::command]
async fn check_for_updates() -> Result<UpdateInfo, String> {
    let current_version = env!("CARGO_PKG_VERSION");
    let repo = "SlasshyOverhere/StreamVault";

    println!(
        "[UPDATE] Checking for updates... Current version: {}",
        current_version
    );

    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);

    let client = reqwest::Client::new();
    let mut request = client
        .get(&url)
        .header("User-Agent", "StreamVault-Updater")
        .header("Accept", "application/vnd.github+json");

    // Add auth header if PAT is configured
    if !GITHUB_RELEASE_TOKEN.is_empty() {
        request = request.header("Authorization", format!("Bearer {}", GITHUB_RELEASE_TOKEN));
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to check for updates: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("GitHub API error ({}): {}", status, error_text));
    }

    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse release: {}", e))?;

    // Extract version from tag (remove 'v' prefix if present)
    let latest_version = release.tag_name.trim_start_matches('v').to_string();

    // Compare versions
    let is_newer = version_compare(&latest_version, current_version);

    // Find Windows installer asset
    let download_url = release
        .assets
        .iter()
        .find(|a| {
            a.name.ends_with(".msi")
                || a.name.ends_with(".exe")
                || a.name.ends_with("_x64-setup.exe")
        })
        .map(|a| a.browser_download_url.clone());

    println!(
        "[UPDATE] Latest version: {} (newer: {})",
        latest_version, is_newer
    );

    Ok(UpdateInfo {
        available: is_newer,
        current_version: current_version.to_string(),
        latest_version,
        release_notes: release.body.unwrap_or_default(),
        download_url,
        published_at: release.published_at,
    })
}

/// Simple version comparison (assumes semver-like versions)
fn version_compare(latest: &str, current: &str) -> bool {
    let parse_version =
        |v: &str| -> Vec<u32> { v.split('.').filter_map(|s| s.parse().ok()).collect() };

    let latest_parts = parse_version(latest);
    let current_parts = parse_version(current);

    for i in 0..3 {
        let l = latest_parts.get(i).copied().unwrap_or(0);
        let c = current_parts.get(i).copied().unwrap_or(0);
        if l > c {
            return true;
        }
        if l < c {
            return false;
        }
    }
    false
}

/// Download update to temp directory
#[tauri::command]
async fn download_update(window: tauri::Window, url: String) -> Result<String, String> {
    use std::io::Write;

    println!("[UPDATE] Downloading update from: {}", url);

    let parsed_url = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;

    if !is_authorized_update_url(&parsed_url, false) {
        return Err("Unauthorized update URL".to_string());
    }

    // Use a custom redirect policy to ensure redirects don't lead to malicious sites
    let custom_policy = reqwest::redirect::Policy::custom(move |attempt| {
        if !is_authorized_update_url(attempt.url(), true) {
            return attempt.error("Unauthorized redirect URL");
        }
        if attempt.previous().len() > 5 {
            return attempt.error("Too many redirects");
        }
        attempt.follow()
    });

    let client = reqwest::Client::builder()
        .redirect(custom_policy)
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    let mut request = client.get(&url);

    // Add auth header if PAT is configured
    if !GITHUB_RELEASE_TOKEN.is_empty() {
        request = request.header("Authorization", format!("Bearer {}", GITHUB_RELEASE_TOKEN));
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to start download: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }

    let total_size = response.content_length().unwrap_or(0);
    let filename = sanitize_update_filename(&parsed_url);
    let staging_dir = updater_staging_root().join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Failed to create updater staging directory: {}", e))?;
    let file_path = staging_dir.join(filename);

    let mut file = std::fs::File::create(&file_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    use futures_util::StreamExt;
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Download error: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Write error: {}", e))?;
        downloaded += chunk.len() as u64;

        // Emit progress event
        if total_size > 0 {
            let progress = (downloaded as f64 / total_size as f64) * 100.0;
            window
                .emit(
                    "update-download-progress",
                    serde_json::json!({
                        "downloaded": downloaded,
                        "total": total_size,
                        "progress": progress
                    }),
                )
                .ok();
        }
    }

    println!("[UPDATE] Download complete: {:?}", file_path);

    Ok(file_path.to_string_lossy().to_string())
}

fn updater_staging_root() -> std::path::PathBuf {
    std::env::temp_dir().join("streamvault-updater")
}

fn is_authorized_update_url(url: &url::Url, is_redirect: bool) -> bool {
    if url.scheme() != "https" {
        return false;
    }

    let Some(host) = url.host_str() else { return false };
    let path = url.path();

    if host == "github.com" {
        return path.starts_with(&format!("/{}", ALLOWED_REPO));
    }

    if host == "api.github.com" {
        return path.starts_with(&format!("/repos/{}", ALLOWED_REPO));
    }

    if is_redirect && (host == "objects.githubusercontent.com" || host.ends_with(".objects.githubusercontent.com")) {
        return true;
    }

    false
}

fn sanitize_update_filename(parsed_url: &url::Url) -> String {
    let fallback = "streamvault-update.bin";
    let Some(raw_filename) = parsed_url
        .path_segments()
        .and_then(|segments| segments.last())
        .filter(|segment| !segment.is_empty())
    else {
        return fallback.to_string();
    };

    let sanitized = raw_filename
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();

    let trimmed = sanitized.trim_matches('.');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn get_valid_installer_path(path_str: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(path_str);

    // Canonicalize resolves symlinks and ../ sequences, and checks if file exists
    let mut canonical_path = path
        .canonicalize()
        .map_err(|e| format!("Invalid installer path: {}", e))?;

    #[cfg(windows)]
    {
        canonical_path = dunce::canonicalize(&canonical_path).unwrap_or(canonical_path);
    }

    let staging_dir = updater_staging_root();
    let mut canonical_staging = staging_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve updater staging directory: {}", e))?;

    #[cfg(windows)]
    {
        canonical_staging = dunce::canonicalize(&canonical_staging).unwrap_or(canonical_staging);
    }

    // Ensure it's inside the app-owned updater staging directory
    if !canonical_path.starts_with(&canonical_staging) {
        return Err("Installer must be located in the updater staging directory".to_string());
    }

    // Check extensions
    let ext = canonical_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    #[cfg(target_os = "windows")]
    if ext != "exe" && ext != "msi" {
        return Err("Only .exe or .msi installers are allowed".to_string());
    }

    #[cfg(target_os = "macos")]
    if ext != "dmg" && ext != "pkg" && ext != "app" {
        return Err("Only .dmg, .pkg, or .app installers are allowed".to_string());
    }

    #[cfg(target_os = "linux")]
    if ext != "deb" && ext != "rpm" && ext != "appimage" {
        return Err("Only .deb, .rpm, or .AppImage installers are allowed".to_string());
    }

    let metadata = std::fs::metadata(&canonical_path)
        .map_err(|e| format!("Failed to inspect installer path: {}", e))?;

    #[cfg(target_os = "macos")]
    if ext == "app" {
        if !metadata.is_dir() {
            return Err("A .app installer must be a directory bundle".to_string());
        }
    } else if !metadata.is_file() {
        return Err("Installer path must point to a file".to_string());
    }

    #[cfg(not(target_os = "macos"))]
    if !metadata.is_file() {
        return Err("Installer path must point to a file".to_string());
    }

    Ok(canonical_path)
}

/// Install update and restart app
#[tauri::command]
async fn install_update(installer_path: String) -> Result<(), String> {
    println!("[UPDATE] Validating installer path before launch");

    let safe_path = get_valid_installer_path(&installer_path)?;
    println!(
        "[UPDATE] Installing update from safe path: {}",
        safe_path.display()
    );

    // Launch the installer securely without tying the child process to this app.
    if let Err(e) = open::that_detached(&safe_path) {
        return Err(format!("Failed to launch installer: {}", e));
    }

    // Exit the app to allow installer to run
    println!("[UPDATE] Exiting app for update installation...");
    std::process::exit(0);
}

/// Get current app version
#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod install_update_tests {
    use super::{get_valid_installer_path, updater_staging_root};
    use std::fs;
    use std::path::{Path, PathBuf};
    use uuid::Uuid;

    #[cfg(target_os = "windows")]
    const TEST_INSTALLER_NAME: &str = "streamvault-update.exe";
    #[cfg(target_os = "macos")]
    const TEST_INSTALLER_NAME: &str = "streamvault-update.pkg";
    #[cfg(target_os = "linux")]
    const TEST_INSTALLER_NAME: &str = "streamvault-update.deb";

    fn remove_test_artifact(path: &Path) {
        if path.is_dir() {
            let _ = fs::remove_dir_all(path);
        } else {
            let _ = fs::remove_file(path);
        }

        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir(parent);
        }
    }

    fn create_temp_installer(name: &str) -> PathBuf {
        let dir =
            updater_staging_root().join(format!("streamvault-installer-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);

        #[cfg(target_os = "macos")]
        if name.ends_with(".app") {
            fs::create_dir_all(&path).unwrap();
            return path;
        }

        fs::write(&path, b"test-installer").unwrap();
        path
    }

    #[test]
    fn accepts_allowed_installer_in_staging_dir() {
        let installer_path = create_temp_installer(TEST_INSTALLER_NAME);
        let validated = get_valid_installer_path(installer_path.to_str().unwrap()).unwrap();
        assert!(validated.starts_with(updater_staging_root()));
        remove_test_artifact(&installer_path);
    }

    #[test]
    fn rejects_disallowed_extension_in_temp_dir() {
        let installer_path = create_temp_installer("streamvault-update.txt");
        let error = get_valid_installer_path(installer_path.to_str().unwrap()).unwrap_err();
        assert!(error.contains("allowed"));
        remove_test_artifact(&installer_path);
    }

    #[test]
    fn rejects_installer_outside_staging_dir() {
        let installer_path = std::env::current_dir()
            .unwrap()
            .join(format!("streamvault-outside-temp-{}", TEST_INSTALLER_NAME));
        fs::write(&installer_path, b"test-installer").unwrap();

        let error = get_valid_installer_path(installer_path.to_str().unwrap()).unwrap_err();
        assert!(error.contains("updater staging directory"));
        remove_test_artifact(&installer_path);
    }
}

// ==================== WATCH TOGETHER COMMANDS ====================

/// Create a Watch Together room
#[tauri::command]
async fn wt_create_room(
    state: State<'_, AppState>,
    window: Window,
    media_id: i64,
    title: String,
    media_match_key: Option<String>,
    nickname: String,
) -> Result<watch_together::RoomInfo, String> {
    let wt = state.watch_together.clone();
    let manager = wt.lock().await;

    // Set up event callback to emit to frontend AND apply sync corrections
    let window_clone = window.clone();
    let wt_ctrl = state.wt_controller.clone();
    manager
        .set_event_callback(move |event| {
            // If this is a state_update, apply sync to MPV controller
            if let watch_together::WatchEvent::StateUpdate {
                position, paused, ..
            } = &event
            {
                let pos = *position;
                let is_paused = *paused;
                let ctrl = wt_ctrl.clone();
                tokio::spawn(async move {
                    let ctrl_guard = ctrl.lock().await;
                    if let Some(ref controller) = *ctrl_guard {
                        if let Err(e) = controller.apply_sync(pos, is_paused).await {
                            println!("[WT] Sync apply error: {}", e);
                        }
                    }
                });
            }
            // Also forward sync_command to MPV controller
            if let watch_together::WatchEvent::SyncCommand { ref command } = event {
                let action = command.action.clone();
                let pos = command.position;
                let ctrl = wt_ctrl.clone();
                tokio::spawn(async move {
                    let ctrl_guard = ctrl.lock().await;
                    if let Some(ref controller) = *ctrl_guard {
                        let (current_pos, current_paused) =
                            controller.get_estimated_position().await;
                        match action.as_str() {
                            "play" | "resume" => {
                                if current_paused {
                                    let _ = controller.set_paused(false).await;
                                }
                                if (pos - current_pos).abs() > 0.12 {
                                    let _ = controller.seek_to(pos).await;
                                }
                            }
                            "pause" => {
                                if !current_paused {
                                    let _ = controller.set_paused(true).await;
                                }
                                if (pos - current_pos).abs() > 0.12 {
                                    let _ = controller.seek_to(pos).await;
                                }
                            }
                            "seek" => {
                                if (pos - current_pos).abs() > 0.05 {
                                    let _ = controller.seek_to(pos).await;
                                }
                            }
                            _ => {}
                        }
                    }
                });
            }
            let _ = window_clone.emit("wt-event", &event);
        })
        .await;

    manager
        .create_room(media_id, title, media_match_key, nickname)
        .await
}

/// Join a Watch Together room
#[tauri::command]
async fn wt_join_room(
    state: State<'_, AppState>,
    window: Window,
    room_code: String,
    media_id: i64,
    media_title: Option<String>,
    media_match_key: Option<String>,
    nickname: String,
) -> Result<watch_together::RoomInfo, String> {
    let wt = state.watch_together.clone();
    let manager = wt.lock().await;

    // Set up event callback with sync corrections
    let window_clone = window.clone();
    let wt_ctrl = state.wt_controller.clone();
    manager
        .set_event_callback(move |event| {
            if let watch_together::WatchEvent::StateUpdate {
                position, paused, ..
            } = &event
            {
                let pos = *position;
                let is_paused = *paused;
                let ctrl = wt_ctrl.clone();
                tokio::spawn(async move {
                    let ctrl_guard = ctrl.lock().await;
                    if let Some(ref controller) = *ctrl_guard {
                        if let Err(e) = controller.apply_sync(pos, is_paused).await {
                            println!("[WT] Sync apply error: {}", e);
                        }
                    }
                });
            }
            if let watch_together::WatchEvent::SyncCommand { ref command } = event {
                let action = command.action.clone();
                let pos = command.position;
                let ctrl = wt_ctrl.clone();
                tokio::spawn(async move {
                    let ctrl_guard = ctrl.lock().await;
                    if let Some(ref controller) = *ctrl_guard {
                        let (current_pos, current_paused) =
                            controller.get_estimated_position().await;
                        match action.as_str() {
                            "play" | "resume" => {
                                if current_paused {
                                    let _ = controller.set_paused(false).await;
                                }
                                if (pos - current_pos).abs() > 0.12 {
                                    let _ = controller.seek_to(pos).await;
                                }
                            }
                            "pause" => {
                                if !current_paused {
                                    let _ = controller.set_paused(true).await;
                                }
                                if (pos - current_pos).abs() > 0.12 {
                                    let _ = controller.seek_to(pos).await;
                                }
                            }
                            "seek" => {
                                if (pos - current_pos).abs() > 0.05 {
                                    let _ = controller.seek_to(pos).await;
                                }
                            }
                            _ => {}
                        }
                    }
                });
            }
            let _ = window_clone.emit("wt-event", &event);
        })
        .await;

    manager
        .join_room(room_code, media_id, media_title, media_match_key, nickname)
        .await
}

/// Leave the current Watch Together room
#[tauri::command]
async fn wt_leave_room(state: State<'_, AppState>) -> Result<(), String> {
    let wt = state.watch_together.clone();
    let manager = wt.lock().await;
    manager.leave_room().await
}

/// Set ready status with video duration
#[tauri::command]
async fn wt_set_ready(state: State<'_, AppState>, duration: f64) -> Result<(), String> {
    let wt = state.watch_together.clone();
    let manager = wt.lock().await;
    manager.set_ready(duration).await
}

/// Start playback (host only)
#[tauri::command]
async fn wt_start_playback(state: State<'_, AppState>) -> Result<(), String> {
    let wt = state.watch_together.clone();
    let manager = wt.lock().await;
    manager.start_playback().await
}

/// Send a sync command
#[tauri::command]
async fn wt_send_sync(
    state: State<'_, AppState>,
    action: String,
    position: f64,
) -> Result<(), String> {
    let wt = state.watch_together.clone();
    let manager = wt.lock().await;
    manager.send_sync(&action, position).await
}

/// Get current room state
#[tauri::command]
async fn wt_get_room_state(
    state: State<'_, AppState>,
) -> Result<Option<watch_together::RoomInfo>, String> {
    let wt = state.watch_together.clone();
    let manager = wt.lock().await;
    Ok(manager.get_room_state().await)
}

/// Check if Watch Together session is active
#[tauri::command]
async fn wt_is_active(state: State<'_, AppState>) -> Result<bool, String> {
    let wt = state.watch_together.clone();
    let manager = wt.lock().await;
    Ok(manager.is_active().await)
}

/// Get local Watch Together client ID for current session
#[tauri::command]
async fn wt_get_client_id(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let wt = state.watch_together.clone();
    let manager = wt.lock().await;
    Ok(manager.get_client_id().await)
}

/// Launch MPV in Watch Together sync mode
#[tauri::command]
async fn wt_launch_mpv(
    state: State<'_, AppState>,
    window: Window,
    media_id: i64,
    session_id: String,
    start_position: f64,
) -> Result<u32, String> {
    // Get media info and config
    let (file_path, mpv_path, is_cloud, cloud_file_id, display_title) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let media = db.get_media_by_id(media_id).map_err(|e| e.to_string())?;
        let config = state.config.lock().map_err(|e| e.to_string())?;
        let mpv = config.mpv_path.clone().unwrap_or_else(|| "mpv".to_string());
        let display_title = build_mpv_display_title(&media);
        (
            media.file_path,
            mpv,
            media.is_cloud.unwrap_or(false),
            media.cloud_file_id,
            display_title,
        )
    };

    let file_or_url = if is_cloud {
        if let Some(file_id) = cloud_file_id {
            let (url, _token) = state
                .gdrive_client
                .get_stream_url(&file_id)
                .await
                .map_err(|e| format!("Failed to get cloud streaming URL: {}", e))?;
            url
        } else {
            return Err("Cloud file has no file ID".to_string());
        }
    } else {
        file_path.ok_or("No file path for local media")?
    };

    let auth_header: Option<String> = if is_cloud {
        state
            .gdrive_client
            .get_access_token()
            .await
            .ok()
            .map(|t| format!("Authorization: Bearer {}", t))
    } else {
        None
    };

    // Determine if host
    let is_host = {
        let wt = state.watch_together.clone();
        let manager = wt.lock().await;
        manager.is_host().await
    };

    // Launch MPV with pipe-based IPC (replaces old file-based approach)
    let (pid, mut controller) = watch_together_mpv::launch_mpv_wt(
        &mpv_path,
        &file_or_url,
        media_id,
        Some(&display_title),
        &session_id,
        start_position,
        auth_header.as_deref(),
        is_host,
    )?;

    // Connect to MPV's named pipe for bidirectional IPC
    controller.connect().await?;

    // Take the event receiver before storing the controller
    let mut event_rx = controller
        .take_event_rx()
        .await
        .ok_or("Failed to get MPV event receiver")?;

    // Store the controller in AppState
    {
        let mut wt_ctrl = state.wt_controller.lock().await;
        *wt_ctrl = Some(controller);
    }

    // Store MPV PID in watch session
    {
        let wt = state.watch_together.clone();
        let manager = wt.lock().await;
        manager.set_mpv_pid(pid).await;
    }

    // Spawn the sync orchestration loop
    let wt_clone = state.watch_together.clone();
    let wt_ctrl = state.wt_controller.clone();
    let session_id_clone = session_id.clone();
    let window_clone = window.clone();

    tokio::spawn(async move {
        let mut state_report_interval =
            tokio::time::interval(std::time::Duration::from_millis(500));
        state_report_interval.tick().await;

        loop {
            tokio::select! {
                // Handle MPV events from the pipe reader
                Some(mpv_event) = event_rx.recv() => {
                    match mpv_event {
                        watch_together_mpv::MpvSyncEvent::PauseChanged { paused, position } => {
                            println!("[WT] MPV pause changed: paused={}, pos={:.2}", paused, position);
                            let action = if paused { "pause" } else { "play" };
                            let manager = wt_clone.lock().await;
                            let _ = manager.send_sync(action, position).await;
                        }
                        watch_together_mpv::MpvSyncEvent::Seeked { position } => {
                            println!("[WT] MPV user seek to {:.2}", position);
                            let manager = wt_clone.lock().await;
                            let _ = manager.send_sync("seek", position).await;
                        }
                        watch_together_mpv::MpvSyncEvent::Ended => {
                            println!("[WT] MPV process ended");
                            watch_together_mpv::cleanup_session(&session_id_clone);
                            let _ = window_clone.emit("wt-mpv-ended", ());
                            // Clear the controller
                            let mut ctrl = wt_ctrl.lock().await;
                            *ctrl = None;
                            break;
                        }
                        watch_together_mpv::MpvSyncEvent::PositionUpdate { .. } => {
                            // Handled internally by the controller's local_state
                        }
                    }
                }

                // Periodic state report to server (Syncplay-style)
                _ = state_report_interval.tick() => {
                    let ctrl = wt_ctrl.lock().await;
                    if let Some(ref controller) = *ctrl {
                        let (pos, paused) = controller.get_estimated_position().await;
                        drop(ctrl);
                        let manager = wt_clone.lock().await;
                        let session = manager.session.lock().await;
                        if let Some(ref session) = *session {
                            let _ = session.send_message(
                                watch_together::ClientMessage::StateReport {
                                    position: pos,
                                    paused,
                                }
                            ).await;
                        }
                    }
                }
            }
        }
    });

    Ok(pid)
}

/// Send a command to MPV in Watch Together mode
#[tauri::command]
async fn wt_send_mpv_command(
    state: State<'_, AppState>,
    session_id: String,
    action: String,
    position: f64,
) -> Result<(), String> {
    let ctrl = state.wt_controller.lock().await;
    if let Some(ref controller) = *ctrl {
        match action.as_str() {
            "play" | "resume" => {
                controller.set_paused(false).await?;
                if position > 0.0 {
                    controller.seek_to(position).await?;
                }
            }
            "pause" => {
                controller.set_paused(true).await?;
            }
            "seek" => {
                controller.seek_to(position).await?;
            }
            _ => {
                return Err(format!("Unknown action: {}", action));
            }
        }
        Ok(())
    } else {
        // Fallback to file-based IPC
        mpv_ipc::send_mpv_sync_command(&session_id, &action, position)
    }
}

async fn run_startup_metadata_enrichment(app_handle: AppHandle) {
    let state = app_handle.state::<AppState>();

    let credential = {
        let config = match state.config.lock() {
            Ok(c) => c,
            Err(e) => {
                println!("[STARTUP] Metadata enrichment skipped (config lock): {}", e);
                return;
            }
        };
        tmdb::get_tmdb_credential(&config.tmdb_api_key.clone().unwrap_or_default())
    };

    let candidates = {
        let db = match state.db.lock() {
            Ok(d) => d,
            Err(e) => {
                println!("[STARTUP] Metadata enrichment skipped (db lock): {}", e);
                return;
            }
        };

        match db.get_media_needing_metadata_enrichment(5000) {
            Ok(rows) => rows,
            Err(e) => {
                println!(
                    "[STARTUP] Failed to load metadata enrichment candidates: {}",
                    e
                );
                return;
            }
        }
    };

    if candidates.is_empty() {
        println!("[STARTUP] Metadata enrichment not needed.");
        return;
    }

    println!(
        "[STARTUP] Metadata enrichment queued for {} item(s)...",
        candidates.len()
    );

    let db_path = database::get_database_path();
    let image_cache_dir = database::get_image_cache_dir();
    let result = tokio::task::spawn_blocking(move || -> Result<(usize, usize, usize), String> {
        let db = database::Database::new(&db_path).map_err(|e| e.to_string())?;
        let mut updated = 0usize;
        let mut failed = 0usize;
        let mut no_match = 0usize;

        for (idx, item) in candidates.iter().enumerate() {
            let tmdb_media_type = if item.media_type == "tvshow" {
                "tv"
            } else {
                "movie"
            };

            let metadata_result = if let Some(ref tid) = item.tmdb_id {
                let cleaned = tid.trim();
                if cleaned.is_empty() {
                    tmdb::search_metadata(
                        &credential,
                        &item.title,
                        tmdb_media_type,
                        item.year,
                        &image_cache_dir,
                    )
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "No TMDB match found".to_string())
                } else {
                    tmdb::fetch_metadata_by_id(
                        &credential,
                        cleaned,
                        tmdb_media_type,
                        &image_cache_dir,
                    )
                    .map_err(|e| e.to_string())
                }
            } else {
                tmdb::search_metadata(
                    &credential,
                    &item.title,
                    tmdb_media_type,
                    item.year,
                    &image_cache_dir,
                )
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "No TMDB match found".to_string())
            };

            match metadata_result {
                Ok(mut metadata) => {
                    metadata.title = media_manager::prefer_title_with_leading_article(
                        &item.title,
                        &metadata.title,
                    );
                    if db.update_metadata(item.id, &metadata).is_ok() {
                        updated += 1;
                    } else {
                        failed += 1;
                    }
                }
                Err(err) => {
                    if err.contains("No TMDB match found") {
                        no_match += 1;
                    } else {
                        failed += 1;
                    }
                }
            }

            if (idx + 1) % 25 == 0 {
                println!(
                    "[STARTUP] Metadata enrichment progress: {}/{}",
                    idx + 1,
                    candidates.len()
                );
            }
        }

        let remaining = db
            .get_media_needing_metadata_enrichment(1)
            .map(|rows| rows.len())
            .unwrap_or(1);

        println!(
            "[STARTUP] Metadata enrichment done. updated={}, failed={}, unmatched={}, remaining={}",
            updated, failed, no_match, remaining
        );

        Ok((updated, failed + no_match, remaining))
    })
    .await;

    let (updated, _not_updated, remaining) = match result {
        Ok(Ok(values)) => values,
        Ok(Err(err)) => {
            println!("[STARTUP] Metadata enrichment failed: {}", err);
            return;
        }
        Err(err) => {
            println!("[STARTUP] Metadata enrichment task join error: {}", err);
            return;
        }
    };

    if updated > 0 {
        if let Some(window) = app_handle.get_window("main") {
            let _ = window.emit(
                "library-updated",
                serde_json::json!({ "type": "metadata-enriched", "updated": updated }),
            );
        }
    }
}

fn main() {
    // Load .env file from project root (for development)
    // This allows setting GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET
    dotenvy::dotenv().ok();

    // Prepare deep link - must be done before building the app
    // This registers the streamvault:// protocol handler
    tauri_plugin_deep_link::prepare("com.streamvault.app");

    // Initialize paths
    let db_path = database::get_database_path();
    let image_cache_dir = database::get_image_cache_dir();

    // Ensure directories exist
    if let Some(parent) = std::path::Path::new(&db_path).parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::create_dir_all(&image_cache_dir).ok();

    // Initialize database
    let db = database::Database::new(&db_path).expect("Failed to initialize database");

    // Load config
    let config = config::load_config().unwrap_or_default();

    // Create app state
    let state = AppState {
        db: Mutex::new(db),
        config: Mutex::new(config.clone()),
        is_scanning: Arc::new(AtomicBool::new(false)),
        active_mpv_sessions: Mutex::new(HashMap::new()),
        active_zip_streams: Mutex::new(HashMap::new()),
        gdrive_client: gdrive::GoogleDriveClient::new(),
        social_auth_client: social_auth::SocialAuthClient::new(),
        watch_together: Arc::new(tokio::sync::Mutex::new(
            watch_together::WatchTogetherManager::new(),
        )),
        wt_controller: Arc::new(tokio::sync::Mutex::new(None)),
    };

    // Create system tray menu
    let show = CustomMenuItem::new("show".to_string(), "Show StreamVault");
    let quit = CustomMenuItem::new("quit".to_string(), "Quit");
    let tray_menu = SystemTrayMenu::new()
        .add_item(show)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);

    let system_tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Another instance tried to start - bring existing window to front
            println!("[SINGLE-INSTANCE] Another instance attempted to start, focusing existing window");
            if let Some(window) = app.get_window("main") {
                window.show().ok();
                window.unminimize().ok();
                window.set_focus().ok();
            } else {
                // Window was destroyed, create a new one
                println!("[SINGLE-INSTANCE] Creating new window...");
                match create_main_window(app) {
                    Ok(window) => {
                        window.set_focus().ok();
                        println!("[SINGLE-INSTANCE] New window created");
                    }
                    Err(e) => {
                        println!("[SINGLE-INSTANCE] Failed to create window: {}", e);
                    }
                }
            }
        }))
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| {
            match event {
                SystemTrayEvent::LeftClick { .. } => {
                    // Show window on left click - create if destroyed
                    match app.get_window("main") {
                        Some(window) => {
                            window.show().ok();
                            window.set_focus().ok();
                        }
                        None => {
                            // Window was destroyed, create a new one
                            println!("[TRAY] Creating new window...");
                            match create_main_window(app) {
                                Ok(window) => {
                                    window.set_focus().ok();
                                    println!("[TRAY] New window created");
                                }
                                Err(e) => {
                                    println!("[TRAY] Failed to create window: {}", e);
                                }
                            }
                        }
                    }
                }
                SystemTrayEvent::MenuItemClick { id, .. } => {
                    match id.as_str() {
                        "show" => {
                            match app.get_window("main") {
                                Some(window) => {
                                    window.show().ok();
                                    window.set_focus().ok();
                                }
                                None => {
                                    // Window was destroyed, create a new one
                                    println!("[TRAY] Creating new window...");
                                    match create_main_window(app) {
                                        Ok(window) => {
                                            window.set_focus().ok();
                                            println!("[TRAY] New window created");
                                        }
                                        Err(e) => {
                                            println!("[TRAY] Failed to create window: {}", e);
                                        }
                                    }
                                }
                            }
                        }
                        "quit" => {
                            std::process::exit(0);
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        })
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--flag1", "--flag2"])))
        .manage(state)
        .setup(|app| {
            // Register deep link handler for OAuth callback
            // The callback page redirects to: streamvault://oauth?code=XXX
            let handle = app.handle();
            tauri_plugin_deep_link::register("streamvault", move |request| {
                println!("[DEEPLINK] Received: {}", request);

                // Parse the deep link URL: streamvault://oauth?code=XXX
                if let Ok(url) = url::Url::parse(&request) {
                    // Look for the authorization code
                    if let Some(code) = url.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.to_string()) {
                        println!("[DEEPLINK] Extracted OAuth code");

                        // Send the code through the channel
                        if let Ok(tx) = OAUTH_CODE_CHANNEL.0.lock() {
                            if let Err(e) = tx.send(code) {
                                println!("[DEEPLINK] Failed to send code: {}", e);
                            }
                        }

                        // Bring the app to front
                        if let Some(window) = handle.get_window("main") {
                            window.show().ok();
                            window.set_focus().ok();
                        }
                    }
                }
            }).ok();

            // Merge any duplicate TV shows on startup
            println!("[STARTUP] Running duplicate TV show merge...");
            let db_path = database::get_database_path();
            if let Ok(startup_db) = database::Database::new(&db_path) {
                if let Err(e) = startup_db.merge_duplicate_tvshows() {
                    println!("[STARTUP] Warning: Failed to merge duplicates: {}", e);
                }
            }

            // Clean up expired cloud cache on startup
            let config = config::load_config().unwrap_or_default();
            if config.cloud_cache_enabled {
                if let Some(ref cache_dir) = config.cloud_cache_dir {
                    println!("[STARTUP] Cleaning up expired cloud cache...");
                    let (deleted, freed) = cleanup_expired_cache(cache_dir, config.cloud_cache_expiry_hours);
                    if deleted > 0 {
                        println!("[STARTUP] Cleaned up {} expired cache files ({:.1} MB)",
                            deleted, freed as f64 / (1024.0 * 1024.0));
                    }
                }
            }

            let zip_cache_config = build_zip_cache_config(&config);
            if let Err(error) = zip_manager::cleanup_stale_zip_cache(&zip_cache_config) {
                println!("[STARTUP] Warning: Failed to clean ZIP cache: {}", error);
            }

            // Start background cloud polling (runs independently of window)
            let app_handle_for_polling = app.handle();
            tauri::async_runtime::spawn(async move {
                background_cloud_poll(app_handle_for_polling).await;
            });

            // One-time metadata enrichment pass for existing libraries.
            let app_handle_for_metadata_enrichment = app.handle();
            tauri::async_runtime::spawn(async move {
                run_startup_metadata_enrichment(app_handle_for_metadata_enrichment).await;
            });

            Ok(())
        })
        .on_page_load(|window, payload| {
            // Inject popup blocking script into every page load
            // This runs at the webview level and can intercept iframe popups
            let url = payload.url();
            println!("[PageLoad] URL: {}", url);

            // Inject comprehensive popup blocking script
            let popup_block_script = r#"
                (function() {
                    // Block window.open
                    const originalOpen = window.open;
                    window.open = function(url, target, features) {
                        console.log('[AdBlocker] Blocked window.open:', url);
                        return null;
                    };

                    // Block popup via addEventListener
                    window.addEventListener('click', function(e) {
                        const target = e.target;
                        if (target && target.tagName === 'A') {
                            const href = target.getAttribute('href');
                            const targetAttr = target.getAttribute('target');
                            if (targetAttr === '_blank' && href && !href.includes('videasy.net')) {
                                console.log('[AdBlocker] Blocked link:', href);
                                e.preventDefault();
                                e.stopPropagation();
                            }
                        }
                    }, true);

                    // Override createElement to intercept dynamic script/iframe ads
                    const originalCreateElement = document.createElement.bind(document);
                    document.createElement = function(tagName) {
                        const element = originalCreateElement(tagName);
                        if (tagName.toLowerCase() === 'iframe') {
                            // Monitor iframe src changes
                            const originalSetAttribute = element.setAttribute.bind(element);
                            element.setAttribute = function(name, value) {
                                if (name === 'src' && value) {
                                    const blockedDomains = ['popads', 'popcash', 'propellerads', 'adsterra', 'exoclick'];
                                    if (blockedDomains.some(d => value.includes(d))) {
                                        console.log('[AdBlocker] Blocked iframe:', value);
                                        return;
                                    }
                                }
                                return originalSetAttribute(name, value);
                            };
                        }
                        return element;
                    };

                    console.log('[AdBlocker] Popup blocking injected');
                })();
            "#;

            window.eval(popup_block_script).ok();
        })
        .on_window_event(|event| {
            match event.event() {
                tauri::WindowEvent::CloseRequested { .. } => {
                    // Let the window close/destroy completely to free RAM
                    // Don't prevent close - we handle app exit separately in .run()
                    println!("[TRAY] Window closing/destroying. Backend will keep running.");
                }
                tauri::WindowEvent::Focused(focused) => {
                    if *focused {
                        // Re-inject popup blocker when window regains focus
                        let window = event.window();
                        window.eval(r#"
                            if (!window.__adBlockerActive) {
                                window.__adBlockerActive = true;
                                const origOpen = window.open;
                                window.open = function(url) {
                                    console.log('[AdBlocker] Blocked popup on focus:', url);
                                    return null;
                                };
                            }
                        "#).ok();
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_library,
            get_library_filtered,
            get_library_stats,
            get_episodes,
            get_watch_history,
            get_watch_history_events,
            remove_from_watch_history,
            remove_watch_history_entry,
            clear_all_watch_history,
            sync_watch_history,
            mark_as_complete,
            // Streaming history commands
            save_streaming_progress,
            get_streaming_history,
            get_streaming_resume_info,
            remove_from_streaming_history,
            clear_all_streaming_history,
            // Social sync commands
            get_watch_stats,
            get_recent_watch_activities,
            // App reset command
            clear_all_app_data,
            cleanup_missing_metadata,
            repair_file_paths,
            // Other commands
            delete_media_files,
            delete_series,
            delete_series_cloud_folder,
            get_episodes_for_delete,
            get_config,
            save_config,
            auto_detect_mpv,
            get_scan_status,
            get_resume_info,
            get_media_info,
            get_archive_playback_assessment,
            get_stream_info,
            get_audio_tracks,
            zip_analyze,
            zip_index_episodes,
            zip_get_stream_info,
            update_progress,
            clear_progress,
            fix_match,
            play_with_mpv,
            play_with_vlc,
            get_mpv_status,
            get_active_mpv_sessions,
            get_cached_image,
            get_cached_image_path,
            read_video_chunk,
            get_video_file_size,
            // Transcoding commands
            check_needs_transcode,
            start_transcode_stream,
            stop_transcode_stream,
            get_stream_info_with_transcode,
            search_tmdb,
            get_movie_details,
            get_tv_details,
            get_tv_season_episodes,
            refresh_series_metadata,
            merge_duplicate_shows,
            // Videasy player commands
            open_videasy_player,
            save_videasy_progress,
            // Google Drive commands
            gdrive_is_connected,
            gdrive_get_access_token,
            gdrive_get_account_info,
            gdrive_get_ai_chat_history,
            gdrive_save_ai_chat_history,
            gdrive_start_auth,
            gdrive_complete_auth,
            gdrive_auth_with_code,
            gdrive_disconnect,
            social_is_connected,
            social_get_access_token,
            social_start_auth,
            social_complete_auth,
            social_disconnect,
            gdrive_list_folders,
            gdrive_list_files,
            gdrive_list_video_files,
            gdrive_get_stream_url,
            gdrive_get_file_metadata,
            gdrive_scan_folder,
            gdrive_delete_folder_media,
            // Cloud folder management
            add_cloud_folder,
            remove_cloud_folder,
            get_cloud_folders,
            scan_all_cloud_folders,
            check_cloud_changes,
            // Cloud cache commands
            get_cloud_cache_info,
            cleanup_cloud_cache,
            clear_cloud_cache,
            // Auto-update commands
            check_for_updates,
            download_update,
            install_update,
            get_app_version,
            // Watch Together commands
            wt_create_room,
            wt_join_room,
            wt_leave_room,
            wt_set_ready,
            wt_start_playback,
            wt_send_sync,
            wt_get_room_state,
            wt_is_active,
            wt_get_client_id,
            wt_launch_mpv,
            wt_send_mpv_command,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // Prevent app from exiting when last window closes
            // This keeps the backend running so we can recreate the window from tray
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
                println!("[TRAY] Exit prevented. App running in background. Click tray to reopen.");
            }
        });
}
