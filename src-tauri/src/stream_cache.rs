use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::config::Config;
use crate::database::get_app_data_dir;
use tauri::{AppHandle, Manager};

const CACHE_EVENT: &str = "remote-cache-progress";
const CHUNK_SIZE: u64 = 8 * 1024 * 1024;
const CONCURRENCY: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CacheState {
    Idle,
    Downloading(f64),
    Complete,
    Cancelled,
    Failed(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatus {
    pub cache_key: String,
    pub state: CacheState,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bytes_per_second: f64,
    pub target_path: String,
}

pub struct ActiveCache {
    pub cancel_flag: Arc<AtomicBool>,
    pub status: CacheStatus,
}

#[derive(Clone)]
pub struct CacheManager {
    active: Arc<Mutex<HashMap<String, ActiveCache>>>,
}

impl CacheManager {
    pub fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Lock the active cache map for direct read/write access.
    pub fn lock_active(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, ActiveCache>>, String> {
        self.active.lock().map_err(|e| e.to_string())
    }

    pub fn cache_dir(config: &Config) -> PathBuf {
        match config.zip_cache_dir.as_deref() {
            Some(d) if !d.is_empty() => {
                let p = PathBuf::from(d);
                let _ = fs::create_dir_all(&p);
                p
            }
            _ => {
                let p = get_app_data_dir().join("stream_cache");
                let _ = fs::create_dir_all(&p);
                p
            }
        }
    }

    pub fn is_cache_dir_set(config: &Config) -> bool {
        config.zip_cache_dir.as_deref().map_or(false, |d| !d.is_empty())
    }

    pub fn start(
        &self,
        app_handle: AppHandle,
        config: Config,
        url: String,
        cache_key: String,
        total_bytes: i64,
        title: String,
    ) -> Result<(), String> {
        let mut active = self.active.lock().map_err(|e| e.to_string())?;

        if active.contains_key(&cache_key) {
            return Err("Cache already active for this item".to_string());
        }

        let cache_dir = Self::cache_dir(&config);
        let file_name = sanitize_filename(&title);
        let target_path = cache_dir.join(format!("{}_{}.mkv", cache_key, file_name));
        let temp_path = target_path.with_extension("mkv.part");

        let cancel_flag = Arc::new(AtomicBool::new(false));
        let status = CacheStatus {
            cache_key: cache_key.clone(),
            state: CacheState::Idle,
            downloaded_bytes: 0,
            total_bytes: total_bytes as u64,
            speed_bytes_per_second: 0.0,
            target_path: target_path.to_string_lossy().to_string(),
        };

        active.insert(
            cache_key.clone(),
            ActiveCache {
                cancel_flag: cancel_flag.clone(),
                status: status.clone(),
            },
        );
        drop(active);

        let manager = self.clone();
        let cache_key_clone = cache_key.clone();
        let job_cancel = cancel_flag.clone();

        tokio::spawn(async move {
            if let Err(e) = run_cache_job(
                &manager,
                &app_handle,
                &cache_key_clone,
                &url,
                &target_path,
                &temp_path,
                total_bytes as u64,
                job_cancel,
            )
            .await
            {
                let mut active = manager.active.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(entry) = active.get_mut(&cache_key_clone) {
                    entry.status.state = CacheState::Failed(e.clone());
                    entry.status.downloaded_bytes = entry.status.total_bytes;
                }
                drop(active);
                let _ = app_handle.emit_all(CACHE_EVENT, &CacheStatus {
                    cache_key: cache_key_clone,
                    state: CacheState::Failed(e),
                    downloaded_bytes: 0,
                    total_bytes: total_bytes as u64,
                    speed_bytes_per_second: 0.0,
                    target_path: String::new(),
                });
            }
        });

        Ok(())
    }

    pub fn stop(&self, cache_key: &str) -> Result<(), String> {
        let active = self.active.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = active.get(cache_key) {
            entry.cancel_flag.store(true, Ordering::Relaxed);
            if let CacheState::Downloading(_) = entry.status.state {
                // will be picked up by the task loop
            }
            Ok(())
        } else {
            Err("No active cache for this key".to_string())
        }
    }

    pub fn status(&self, cache_key: &str) -> Option<CacheStatus> {
        let active = self.active.lock().ok()?;
        active.get(cache_key).map(|e| e.status.clone())
    }

    pub fn all_status(&self) -> Vec<CacheStatus> {
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        active.values().map(|e| e.status.clone()).collect()
    }

    pub fn cleanup(&self, cache_key: &str) -> Result<(), String> {
        let active = self.active.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = active.get(cache_key) {
            entry.cancel_flag.store(true, Ordering::Relaxed);
            let path = &entry.status.target_path;
            let _ = fs::remove_file(path);
            let _ = fs::remove_file(path.replace(".mkv", ".mkv.part"));
        }
        drop(active);

        let mut active = self.active.lock().map_err(|e| e.to_string())?;
        active.remove(cache_key);
        Ok(())
    }

    pub fn cleanup_all(&self) -> Result<(), String> {
        let keys: Vec<String> = {
            let active = self.active.lock().map_err(|e| e.to_string())?;
            active.keys().cloned().collect()
        };
        for key in keys {
            let _ = self.cleanup(&key);
        }
        Ok(())
    }

    pub fn auto_cleanup_old(config: &Config) {
        let expiry_hours = config.cloud_cache_expiry_hours.max(1) as u64;
        let cache_dir = Self::cache_dir(config);
        if !cache_dir.exists() {
            return;
        }

        let now = std::time::SystemTime::now();
        if let Ok(entries) = fs::read_dir(&cache_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "mkv").unwrap_or(false)
                    || path
                        .extension()
                        .map(|e| e == "part")
                        .unwrap_or(false)
                {
                    if let Ok(metadata) = fs::metadata(&path) {
                        if let Ok(modified) = metadata.modified() {
                            if let Ok(duration) = now.duration_since(modified) {
                                if duration.as_secs() > expiry_hours * 3600 {
                                    let _ = fs::remove_file(&path);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

impl Default for CacheManager {
    fn default() -> Self {
        Self::new()
    }
}

async fn run_cache_job(
    manager: &CacheManager,
    app_handle: &AppHandle,
    cache_key: &str,
    url: &str,
    target_path: &PathBuf,
    temp_path: &PathBuf,
    total_bytes: u64,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create cache dir: {}", e))?;
    }

    // Prepare temp file with pre-allocation
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(temp_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
    file.set_len(total_bytes)
        .map_err(|e| format!("Failed to allocate temp file: {}", e))?;
    drop(file);

    let started_at = Instant::now();
    let downloaded = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let http_client = reqwest::Client::new();

    let chunk_count = (total_bytes + CHUNK_SIZE - 1) / CHUNK_SIZE;
    let semaphore = Arc::new(tokio::sync::Semaphore::new(CONCURRENCY));

    let mut handles = Vec::new();
    for chunk_idx in 0..chunk_count {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }

        let range_start = chunk_idx * CHUNK_SIZE;
        let range_end = ((chunk_idx + 1) * CHUNK_SIZE - 1).min(total_bytes - 1);
        let client = http_client.clone();
        let url = url.to_string();
        let temp = temp_path.clone();
        let downloaded = downloaded.clone();
        let cancel = cancel_flag.clone();
        let app = app_handle.clone();
        let mgr = manager.clone();
        let key = cache_key.to_string();
        let total = total_bytes;
        let started = started_at;
        let sem = semaphore.clone();

        let handle = tokio::spawn(async move {
            let _permit = sem.acquire_owned().await.map_err(|e| e.to_string())?;

            if cancel.load(Ordering::Relaxed) {
                return Err::<(), String>("cancelled".to_string());
            }

            let response = client
                .get(&url)
                .header("Range", format!("bytes={}-{}", range_start, range_end))
                .send()
                .await
                .map_err(|e| format!("HTTP error: {}", e))?
                .error_for_status()
                .map_err(|e| format!("HTTP status: {}", e))?;

            let bytes = response
                .bytes()
                .await
                .map_err(|e| format!("Read error: {}", e))?;

            if bytes.len() as u64 != (range_end - range_start + 1) {
                return Err(format!(
                    "Chunk size mismatch: expected {}, got {}",
                    range_end - range_start + 1,
                    bytes.len()
                ));
            }

            // Write chunk to temp file
            let mut file = OpenOptions::new()
                .write(true)
                .open(&temp)
                .map_err(|e| format!("File error: {}", e))?;
            file.seek(SeekFrom::Start(range_start))
                .map_err(|e| format!("Seek error: {}", e))?;
            file.write_all(&bytes)
                .map_err(|e| format!("Write error: {}", e))?;
            drop(file);

            let total_dl = downloaded.fetch_add(bytes.len() as u64, Ordering::Relaxed) + bytes.len() as u64;
            let elapsed = started.elapsed().as_secs_f64().max(0.001);
            let speed = total_dl as f64 / elapsed;

            if let Ok(mut active) = mgr.active.lock() {
                if let Some(entry) = active.get_mut(&key) {
                    entry.status.downloaded_bytes = total_dl;
                    entry.status.speed_bytes_per_second = speed;
                    entry.status.state = CacheState::Downloading((total_dl as f64 / total.max(1) as f64) * 100.0);
                    let status = entry.status.clone();
                    drop(active);
                    let _ = app.emit_all(CACHE_EVENT, &status);
                }
            }

            Ok(())
        });

        handles.push(handle);
    }

    // Wait for all chunks
    for handle in handles {
        match handle.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) if e == "cancelled" => {
                let _ = fs::remove_file(temp_path);
                return Err("cancelled".to_string());
            }
            Ok(Err(e)) => {
                let _ = fs::remove_file(temp_path);
                return Err(e);
            }
            Err(e) => {
                let _ = fs::remove_file(temp_path);
                return Err(format!("Task join error: {}", e));
            }
        }

        if cancel_flag.load(Ordering::Relaxed) {
            let _ = fs::remove_file(temp_path);
            return Err("cancelled".to_string());
        }
    }

    // Rename temp to final
    fs::rename(temp_path, target_path).map_err(|e| format!("Rename error: {}", e))?;

    let elapsed = started_at.elapsed().as_secs_f64().max(0.001);
    let speed = total_bytes as f64 / elapsed;

    if let Ok(mut active) = manager.active.lock() {
        if let Some(entry) = active.get_mut(cache_key) {
            entry.status.state = CacheState::Complete;
            entry.status.downloaded_bytes = total_bytes;
            entry.status.speed_bytes_per_second = speed;
            let status = entry.status.clone();
            drop(active);
            let _ = app_handle.emit_all(CACHE_EVENT, &status);
        }
    }

    Ok(())
}

fn sanitize_filename(title: &str) -> String {
    title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}
