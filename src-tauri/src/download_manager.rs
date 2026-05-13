use crate::database::get_app_data_dir;
use crate::gdrive;
use futures_util::stream::{FuturesUnordered, StreamExt};
use reqwest::header::{AUTHORIZATION, RANGE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Manager};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;
use uuid::Uuid;

pub const DOWNLOAD_EVENT: &str = "download-job-updated";
const DEFAULT_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const DEFAULT_CONCURRENCY: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJobSnapshot {
    pub id: String,
    pub media_id: i64,
    pub title: String,
    pub file_name: String,
    pub target_path: String,
    pub status: String,
    pub progress: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bytes_per_second: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
    pub error: Option<String>,
    pub source_kind: String,
    pub source_exists: bool,
    pub target_exists: bool,
}

struct DownloadJobRecord {
    snapshot: DownloadJobSnapshot,
    cancel_flag: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct DownloadManager {
    jobs: Arc<Mutex<HashMap<String, DownloadJobRecord>>>,
}

#[derive(Clone)]
pub struct ParallelDownloadRequest {
    pub media_id: i64,
    pub title: String,
    pub file_name: String,
    pub target_path: PathBuf,
    pub file_id: String,
    pub range_start: u64,
    pub total_bytes: u64,
    pub source_kind: String,
    pub chunk_bytes: u64,
    pub concurrency: usize,
}

#[derive(Clone)]
pub struct LocalCopyRequest {
    pub media_id: i64,
    pub title: String,
    pub file_name: String,
    pub target_path: PathBuf,
    pub source_path: PathBuf,
    pub total_bytes: u64,
    pub source_kind: String,
}

impl DownloadManager {
    pub fn load() -> Self {
        let mut jobs = HashMap::new();

        if let Ok(raw) = fs::read_to_string(download_jobs_path()) {
            if let Ok(stored_jobs) = serde_json::from_str::<Vec<DownloadJobSnapshot>>(&raw) {
                for mut snapshot in stored_jobs {
                    if matches!(
                        snapshot.status.as_str(),
                        "queued" | "preparing" | "downloading"
                    ) {
                        snapshot.status = "failed".to_string();
                        snapshot.error = Some(
                            "Download was interrupted because the app was closed or refreshed."
                                .to_string(),
                        );
                        snapshot.speed_bytes_per_second = None;
                    }

                    jobs.insert(
                        snapshot.id.clone(),
                        DownloadJobRecord {
                            snapshot,
                            cancel_flag: Arc::new(AtomicBool::new(false)),
                        },
                    );
                }
            }
        }

        startup_cleanup_orphaned_parts();

        Self {
            jobs: Arc::new(Mutex::new(jobs)),
        }
    }

    pub fn list_jobs(&self) -> Vec<DownloadJobSnapshot> {
        let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        let mut snapshots = jobs
            .values()
            .map(|record| record.snapshot.clone())
            .collect::<Vec<_>>();
        snapshots.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        snapshots
    }

    pub fn create_job(
        &self,
        media_id: i64,
        title: String,
        file_name: String,
        target_path: PathBuf,
        total_bytes: u64,
        source_kind: String,
    ) -> (DownloadJobSnapshot, Arc<AtomicBool>) {
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let snapshot = DownloadJobSnapshot {
            id: id.clone(),
            media_id,
            title,
            file_name,
            target_path: target_path.to_string_lossy().to_string(),
            status: "queued".to_string(),
            progress: 0.0,
            downloaded_bytes: 0,
            total_bytes,
            speed_bytes_per_second: None,
            created_at: now.clone(),
            updated_at: now,
            error: None,
            source_kind,
            source_exists: true,
            target_exists: false,
        };
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let record = DownloadJobRecord {
            snapshot: snapshot.clone(),
            cancel_flag: cancel_flag.clone(),
        };
        {
            self.jobs.lock().unwrap_or_else(|e| e.into_inner()).insert(id, record);
        }
        self.persist_jobs();
        (snapshot, cancel_flag)
    }

    pub fn cancel_job(&self, job_id: &str) -> Result<DownloadJobSnapshot, String> {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        let record = jobs
            .get_mut(job_id)
            .ok_or_else(|| "Download job not found".to_string())?;
        record.cancel_flag.store(true, Ordering::Relaxed);
        if matches!(record.snapshot.status.as_str(), "queued" | "preparing" | "downloading") {
            record.snapshot.status = "cancelled".to_string();
            record.snapshot.updated_at = chrono::Utc::now().to_rfc3339();
        }
        let snapshot = record.snapshot.clone();
        drop(jobs);
        self.persist_jobs();
        Ok(snapshot)
    }

    pub fn delete_job(&self, job_id: &str) -> Result<(), String> {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        jobs.remove(job_id).ok_or_else(|| "Download job not found".to_string())?;
        drop(jobs);
        self.persist_jobs();
        Ok(())
    }

    pub fn clear_history(&self) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        jobs.retain(|_, record| {
            matches!(
                record.snapshot.status.as_str(),
                "queued" | "preparing" | "downloading"
            )
        });
        drop(jobs);
        self.persist_jobs();
    }

    pub fn get_job(&self, job_id: &str) -> Option<DownloadJobSnapshot> {
        let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        jobs.get(job_id).map(|record| record.snapshot.clone())
    }

    pub fn update_job<F>(&self, job_id: &str, mut update: F) -> Option<DownloadJobSnapshot>
    where
        F: FnMut(&mut DownloadJobSnapshot),
    {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        let record = jobs.get_mut(job_id)?;
        update(&mut record.snapshot);
        record.snapshot.updated_at = chrono::Utc::now().to_rfc3339();
        let snapshot = record.snapshot.clone();
        drop(jobs);
        self.persist_jobs();
        Some(snapshot)
    }

    fn persist_jobs(&self) {
        let snapshots = {
            let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
            jobs.values()
                .map(|record| record.snapshot.clone())
                .collect::<Vec<_>>()
        };

        let path = download_jobs_path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        if let Ok(serialized) = serde_json::to_string_pretty(&snapshots) {
            let _ = fs::write(path, serialized);
        }
    }
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::load()
    }
}

pub fn default_downloads_dir() -> PathBuf {
    dirs::download_dir()
        .unwrap_or_else(|| get_app_data_dir().join("downloads"))
        .join("StreamVault")
}

fn download_jobs_path() -> PathBuf {
    get_app_data_dir().join("download_jobs.json")
}

pub fn sanitize_download_filename(raw: &str, fallback: &str) -> String {
    let sanitized = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ' ' | '(' | ')') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();

    let trimmed = sanitized.trim().trim_matches('.');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn unique_target_path(dir: &Path, file_name: &str) -> PathBuf {
    let base = Path::new(file_name);
    let stem = base
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let ext = base.extension().and_then(|value| value.to_str());

    let mut candidate = dir.join(file_name);
    let mut index = 1usize;
    while candidate.exists() {
        let next_name = match ext {
            Some(ext) if !ext.is_empty() => format!("{stem} ({index}).{ext}"),
            _ => format!("{stem} ({index})"),
        };
        candidate = dir.join(next_name);
        index += 1;
    }
    candidate
}

pub fn emit_job_update(app_handle: &AppHandle, snapshot: &DownloadJobSnapshot) {
    let _ = app_handle.emit_all(DOWNLOAD_EVENT, snapshot.clone());
}

pub fn start_parallel_download(
    app_handle: AppHandle,
    manager: DownloadManager,
    gdrive_client: gdrive::GoogleDriveClient,
    request: ParallelDownloadRequest,
) -> DownloadJobSnapshot {
    let chunk_bytes = request.chunk_bytes.max(1024 * 1024);
    let concurrency = request.concurrency.max(1);
    let (snapshot, cancel_flag) = manager.create_job(
        request.media_id,
        request.title.clone(),
        request.file_name.clone(),
        request.target_path.clone(),
        request.total_bytes,
        request.source_kind.clone(),
    );
    let job_id = snapshot.id.clone();
    emit_job_update(&app_handle, &snapshot);

    tokio::spawn(async move {
        if let Some(snapshot) = manager.update_job(&job_id, |job| {
            job.status = "preparing".to_string();
        }) {
            emit_job_update(&app_handle, &snapshot);
        }

        if let Some(parent) = request.target_path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                fail_job(
                    &app_handle,
                    &manager,
                    &job_id,
                    format!("Failed to create download directory: {}", error),
                );
                return;
            }
        }

        let temp_path = request.target_path.with_extension(format!(
            "{}.part",
            request
                .target_path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("download")
        ));

        if let Err(error) = prepare_temp_file(&temp_path, request.total_bytes) {
            fail_job(
                &app_handle,
                &manager,
                &job_id,
                format!("Failed to prepare temp file: {}", error),
            );
            return;
        }

        if let Some(snapshot) = manager.update_job(&job_id, |job| {
            job.status = "downloading".to_string();
        }) {
            emit_job_update(&app_handle, &snapshot);
        }

        let total_bytes = request.total_bytes;
        let started_at = Instant::now();
        let downloaded_bytes = Arc::new(AtomicU64::new(0));
        let semaphore = Arc::new(Semaphore::new(concurrency));
        let http_client = reqwest::Client::new();
        let stream_url = gdrive_client.build_stream_url(&request.file_id);
        let chunk_ranges = build_chunk_ranges(total_bytes, chunk_bytes);
        let mut tasks = FuturesUnordered::new();

        for (relative_start, relative_end) in chunk_ranges {
            let semaphore = semaphore.clone();
            let app_handle = app_handle.clone();
            let manager = manager.clone();
            let gdrive_client = gdrive_client.clone();
            let job_id = job_id.clone();
            let temp_path = temp_path.clone();
            let cancel_flag = cancel_flag.clone();
            let downloaded_bytes = downloaded_bytes.clone();
            let stream_url = stream_url.clone();
            let http_client = http_client.clone();
            let absolute_start = request.range_start + relative_start;
            let absolute_end = request.range_start + relative_end;

            tasks.push(tokio::spawn(async move {
                let _permit = semaphore.acquire_owned().await.map_err(|error| error.to_string())?;
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err("cancelled".to_string());
                }

                let expected_len = relative_end - relative_start + 1;
                let mut attempt = 0u32;
                loop {
                    attempt += 1;
                    if cancel_flag.load(Ordering::Relaxed) {
                        return Err("cancelled".to_string());
                    }

                    let access_token = gdrive_client.get_access_token().await?;
                    let response = http_client
                        .get(&stream_url)
                        .header(AUTHORIZATION, format!("Bearer {}", access_token))
                        .header(RANGE, format!("bytes={}-{}", absolute_start, absolute_end))
                        .send()
                        .await
                        .map_err(|error| error.to_string())?;

                    let response = response
                        .error_for_status()
                        .map_err(|error| error.to_string())?;

                    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
                    if bytes.len() as u64 != expected_len {
                        if attempt < 3 {
                            tokio::time::sleep(std::time::Duration::from_millis(250 * attempt as u64))
                                .await;
                            continue;
                        }
                        return Err(format!(
                            "Incomplete chunk download: expected {} bytes, got {}",
                            expected_len,
                            bytes.len()
                        ));
                    }

                    write_chunk(&temp_path, relative_start, bytes.as_ref())?;
                    let total_downloaded =
                        downloaded_bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed)
                            + bytes.len() as u64;
                    let elapsed = started_at.elapsed().as_secs_f64().max(0.001);
                    if let Some(snapshot) = manager.update_job(&job_id, |job| {
                        job.downloaded_bytes = total_downloaded;
                        job.progress =
                            ((total_downloaded as f64 / job.total_bytes.max(1) as f64) * 100.0)
                                .clamp(0.0, 100.0);
                        job.speed_bytes_per_second = Some(total_downloaded as f64 / elapsed);
                    }) {
                        emit_job_update(&app_handle, &snapshot);
                    }
                    return Ok::<(), String>(());
                }
            }));
        }

        let mut failure: Option<String> = None;
        while let Some(result) = tasks.next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) if error == "cancelled" => {
                    failure = Some(error);
                    break;
                }
                Ok(Err(error)) => {
                    failure = Some(error);
                    break;
                }
                Err(error) => {
                    failure = Some(error.to_string());
                    break;
                }
            }
        }

        if cancel_flag.load(Ordering::Relaxed) || matches!(failure.as_deref(), Some("cancelled")) {
            let _ = fs::remove_file(&temp_path);
            if let Some(snapshot) = manager.update_job(&job_id, |job| {
                job.status = "cancelled".to_string();
            }) {
                emit_job_update(&app_handle, &snapshot);
            }
            return;
        }

        if let Some(error) = failure {
            let _ = fs::remove_file(&temp_path);
            fail_job(&app_handle, &manager, &job_id, error);
            return;
        }

        if let Err(error) = fs::rename(&temp_path, &request.target_path) {
            let _ = fs::remove_file(&temp_path);
            fail_job(
                &app_handle,
                &manager,
                &job_id,
                format!("Failed to finalize download: {}", error),
            );
            return;
        }

        if let Some(snapshot) = manager.update_job(&job_id, |job| {
            job.status = "completed".to_string();
            job.downloaded_bytes = job.total_bytes;
            job.progress = 100.0;
            job.target_exists = true;
            job.speed_bytes_per_second = None;
        }) {
            emit_job_update(&app_handle, &snapshot);
        }
    });

    snapshot
}

pub fn start_local_copy(
    app_handle: AppHandle,
    manager: DownloadManager,
    request: LocalCopyRequest,
) -> DownloadJobSnapshot {
    let (snapshot, cancel_flag) = manager.create_job(
        request.media_id,
        request.title.clone(),
        request.file_name.clone(),
        request.target_path.clone(),
        request.total_bytes,
        request.source_kind.clone(),
    );
    let job_id = snapshot.id.clone();
    emit_job_update(&app_handle, &snapshot);

    tokio::spawn(async move {
        run_local_copy_job(app_handle, manager, job_id, cancel_flag, request).await;
    });

    snapshot
}

pub async fn run_local_copy_job(
    app_handle: AppHandle,
    manager: DownloadManager,
    job_id: String,
    cancel_flag: Arc<AtomicBool>,
    request: LocalCopyRequest,
) {
    if let Some(snapshot) = manager.update_job(&job_id, |job| {
        job.status = "preparing".to_string();
    }) {
        emit_job_update(&app_handle, &snapshot);
    }

    if let Some(parent) = request.target_path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            fail_job(
                &app_handle,
                &manager,
                &job_id,
                format!("Failed to create download directory: {}", error),
            );
            return;
        }
    }

    let temp_path = request.target_path.with_extension(format!(
        "{}.part",
        request
            .target_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
    ));

    let mut source = match File::open(&request.source_path).await {
        Ok(file) => file,
        Err(error) => {
            fail_job(
                &app_handle,
                &manager,
                &job_id,
                format!("Failed to open source file: {}", error),
            );
            return;
        }
    };

    let mut destination = match tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&temp_path)
        .await
    {
        Ok(file) => file,
        Err(error) => {
            fail_job(
                &app_handle,
                &manager,
                &job_id,
                format!("Failed to create target file: {}", error),
            );
            return;
        }
    };

    if let Some(snapshot) = manager.update_job(&job_id, |job| {
        job.status = "downloading".to_string();
    }) {
        emit_job_update(&app_handle, &snapshot);
    }

    let mut buffer = vec![0u8; (2 * 1024 * 1024) as usize];
    let mut copied = 0u64;
    let started_at = Instant::now();

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = tokio::fs::remove_file(&temp_path).await;
            if let Some(snapshot) = manager.update_job(&job_id, |job| {
                job.status = "cancelled".to_string();
            }) {
                emit_job_update(&app_handle, &snapshot);
            }
            return;
        }

        let read = match source.read(&mut buffer).await {
            Ok(read) => read,
            Err(error) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                fail_job(
                    &app_handle,
                    &manager,
                    &job_id,
                    format!("Failed to read source file: {}", error),
                );
                return;
            }
        };

        if read == 0 {
            break;
        }

        if let Err(error) = destination.write_all(&buffer[..read]).await {
            let _ = tokio::fs::remove_file(&temp_path).await;
            fail_job(
                &app_handle,
                &manager,
                &job_id,
                format!("Failed to write target file: {}", error),
            );
            return;
        }

        copied = copied.saturating_add(read as u64);
        let elapsed = started_at.elapsed().as_secs_f64().max(0.001);
        if let Some(snapshot) = manager.update_job(&job_id, |job| {
            job.downloaded_bytes = copied;
            job.progress = ((copied as f64 / job.total_bytes.max(1) as f64) * 100.0)
                .clamp(0.0, 100.0);
            job.speed_bytes_per_second = Some(copied as f64 / elapsed);
        }) {
            emit_job_update(&app_handle, &snapshot);
        }
    }

    drop(destination);
    if let Err(error) = tokio::fs::rename(&temp_path, &request.target_path).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        fail_job(
            &app_handle,
            &manager,
            &job_id,
            format!("Failed to finalize copied download: {}", error),
        );
        return;
    }

    if let Some(snapshot) = manager.update_job(&job_id, |job| {
        job.status = "completed".to_string();
        job.downloaded_bytes = job.total_bytes;
        job.progress = 100.0;
        job.target_exists = true;
        job.speed_bytes_per_second = None;
    }) {
        emit_job_update(&app_handle, &snapshot);
    }
}

fn build_chunk_ranges(total_bytes: u64, chunk_bytes: u64) -> Vec<(u64, u64)> {
    let mut ranges = Vec::new();
    let mut start = 0u64;
    while start < total_bytes {
        let end = (start + chunk_bytes - 1).min(total_bytes - 1);
        ranges.push((start, end));
        start = end + 1;
    }
    ranges
}

fn prepare_temp_file(path: &Path, total_bytes: u64) -> Result<(), String> {
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.set_len(total_bytes).map_err(|error| error.to_string())
}

fn write_chunk(path: &Path, offset: u64, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())
}

fn fail_job(
    app_handle: &AppHandle,
    manager: &DownloadManager,
    job_id: &str,
    error: String,
) {
    if let Some(snapshot) = manager.update_job(job_id, |job| {
        job.status = "failed".to_string();
        job.error = Some(error.clone());
    }) {
        emit_job_update(app_handle, &snapshot);
    }
}

fn startup_cleanup_orphaned_parts() {
    let downloads_dir = default_downloads_dir();
    if let Ok(entries) = std::fs::read_dir(&downloads_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("part") {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

pub fn default_parallel_chunk_bytes() -> u64 {
    DEFAULT_CHUNK_BYTES
}

pub fn default_parallel_concurrency() -> usize {
    DEFAULT_CONCURRENCY
}
