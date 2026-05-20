use crate::{dev_elog, dev_log, gdrive, zip_manager};
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, RANGE};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tiny_http::{Header, Method, Response, Server, StatusCode};
use tokio::runtime::{Builder as TokioRuntimeBuilder, Runtime as TokioRuntime};

const TURBO_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
const TURBO_PREWARM_BYTES: u64 = 8 * 1024 * 1024;
const TURBO_PREFETCH_WINDOW_BYTES: u64 = 64 * 1024 * 1024;
const TURBO_HOT_CACHE_BYTES: u64 = 500 * 1024 * 1024;
const TURBO_MIN_CONNECTIONS: usize = 3;
const TURBO_MAX_CONNECTIONS: usize = 8;
const TURBO_FETCH_RETRIES: usize = 3;
const TURBO_FETCH_TIMEOUT_SECS: u64 = 20;
const TURBO_RATE_LIMIT_BACKOFF_SECS: u64 = 5;

pub const ZIP_PROXY_PORT: u16 = 48621;

#[derive(Debug, Clone)]
pub struct ProxyCacheSpec {
    pub cache_paths: zip_manager::ZipCachePaths,
    pub cache_config: zip_manager::ZipCacheConfig,
    pub start_delay_ms: u64,
    pub throttle_delay_ms: u64,
}

#[derive(Debug, Clone)]
pub enum ProxyAuth {
    GoogleDrive(gdrive::GoogleDriveClient),
    None,
}

#[derive(Debug, Clone)]
pub struct ProxyStreamSpec {
    pub drive_url: String,
    pub auth: ProxyAuth,
    pub byte_start: u64,
    pub byte_end: u64,
    pub content_type: String,
    pub cache_spec: Option<ProxyCacheSpec>,
}

pub struct ZipStreamProxyHandle {
    pub port: u16,
    shutdown_tx: Option<mpsc::Sender<()>>,
    join_handle: Option<JoinHandle<()>>,
    cache_join_handle: Option<JoinHandle<()>>,
    stop_flag: Arc<AtomicBool>,
}

impl ZipStreamProxyHandle {
    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);

        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }

        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }

        if let Some(handle) = self.cache_join_handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for ZipStreamProxyHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone)]
struct TurboProxyState {
    spec: ProxyStreamSpec,
    total_length: u64,
    total_chunks: u64,
    prewarm_chunks: u64,
    prefetch_window_chunks: u64,
    hot_limit_bytes: u64,
    stop_flag: Arc<AtomicBool>,
    cache_spec: ProxyCacheSpec,
    inner: Arc<(Mutex<TurboProxyInner>, Condvar)>,
    http_client: Client,
    cached_token: Arc<Mutex<Option<(String, Instant)>>>,
    first_response_served: Arc<AtomicBool>,
    prewarm_started: Arc<AtomicBool>,
}

struct TurboProxyInner {
    chunks: HashMap<u64, ChunkState>,
    hot_lru: VecDeque<u64>,
    pending_chunks: BTreeSet<u64>,
    hot_bytes: u64,
    contiguous_prefix_bytes: u64,
    in_flight: usize,
    max_parallel: usize,
    paused_until: Option<Instant>,
    rate_limit_count: u64,
}

#[derive(Clone)]
enum ChunkState {
    Fetching,
    Ready(Arc<Vec<u8>>),
    Failed(String),
}

#[derive(Debug)]
enum FetchErrorKind {
    Retriable,
    RateLimited,
    Fatal,
}

#[derive(Debug)]
struct FetchError {
    message: String,
    kind: FetchErrorKind,
}

struct TurboStreamReader {
    turbo: TurboProxyState,
    relative_end: u64,
    position: u64,
    current_chunk_index: Option<u64>,
    current_chunk: Option<Arc<Vec<u8>>>,
}

type RequestFailure = Box<(Option<tiny_http::Request>, String)>;

impl TurboStreamReader {
    fn new(turbo: TurboProxyState, relative_start: u64, relative_end: u64) -> Self {
        let start_chunk = relative_start / TURBO_CHUNK_BYTES;
        turbo.schedule_prefetch_from(start_chunk, true);
        Self {
            turbo,
            relative_end,
            position: relative_start,
            current_chunk_index: None,
            current_chunk: None,
        }
    }
}

impl Read for TurboStreamReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() || self.position > self.relative_end {
            return Ok(0);
        }

        let chunk_index = self.position / TURBO_CHUNK_BYTES;
        let chunk_start = chunk_index * TURBO_CHUNK_BYTES;
        let chunk = if self.current_chunk_index == Some(chunk_index) {
            self.current_chunk
                .as_ref()
                .cloned()
                .ok_or_else(|| std::io::Error::other("Missing in-flight chunk"))?
        } else {
            let chunk = self
                .turbo
                .get_chunk(chunk_index)
                .map_err(std::io::Error::other)?;
            self.current_chunk_index = Some(chunk_index);
            self.current_chunk = Some(chunk.clone());
            self.turbo.schedule_prefetch_from(chunk_index, false);
            chunk
        };

        let within_chunk = (self.position - chunk_start) as usize;
        let remaining_in_chunk = chunk.len().saturating_sub(within_chunk);
        let remaining_in_stream = (self.relative_end - self.position + 1) as usize;
        let to_copy = remaining_in_chunk.min(remaining_in_stream).min(buf.len());

        buf[..to_copy].copy_from_slice(&chunk[within_chunk..within_chunk + to_copy]);
        self.position = self.position.saturating_add(to_copy as u64);
        Ok(to_copy)
    }
}

impl TurboProxyState {
    fn new(
        spec: ProxyStreamSpec,
        cache_spec: ProxyCacheSpec,
        stop_flag: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let total_length = spec
            .byte_end
            .checked_sub(spec.byte_start)
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| "Invalid ZIP byte range".to_string())?;
        let total_chunks = total_length.div_ceil(TURBO_CHUNK_BYTES);
        let contiguous_prefix_bytes = existing_prefix_len(&cache_spec);
        let http_client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(TURBO_FETCH_TIMEOUT_SECS))
            .tcp_nodelay(true)
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

        Ok(Self {
            spec,
            total_length,
            total_chunks,
            prewarm_chunks: TURBO_PREWARM_BYTES.div_ceil(TURBO_CHUNK_BYTES),
            prefetch_window_chunks: TURBO_PREFETCH_WINDOW_BYTES.div_ceil(TURBO_CHUNK_BYTES),
            hot_limit_bytes: TURBO_HOT_CACHE_BYTES,
            stop_flag,
            cache_spec,
            inner: Arc::new((
                Mutex::new(TurboProxyInner {
                    chunks: HashMap::new(),
                    hot_lru: VecDeque::new(),
                    pending_chunks: BTreeSet::new(),
                    hot_bytes: 0,
                    contiguous_prefix_bytes,
                    in_flight: 0,
                    max_parallel: TURBO_MIN_CONNECTIONS,
                    paused_until: None,
                    rate_limit_count: 0,
                }),
                Condvar::new(),
            )),
            http_client,
            cached_token: Arc::new(Mutex::new(None)),
            first_response_served: Arc::new(AtomicBool::new(false)),
            prewarm_started: Arc::new(AtomicBool::new(false)),
        })
    }

    fn start_prewarm(&self) {
        let turbo = self.clone();
        thread::spawn(move || {
            if turbo.cache_spec.start_delay_ms > 0 {
                thread::sleep(Duration::from_millis(turbo.cache_spec.start_delay_ms));
            }
            turbo.schedule_prefetch_from(0, true);
            for chunk_index in 0..turbo.prewarm_chunks.min(turbo.total_chunks) {
                let _ = turbo.get_chunk(chunk_index);
            }
        });
    }

    fn ensure_prewarm_started(&self) {
        if !self.prewarm_started.swap(true, Ordering::Relaxed) {
            dev_log!("[ZIP PROXY] Starting prewarm after first response");
            self.start_prewarm();
        }
    }

    fn get_chunk(&self, chunk_index: u64) -> Result<Arc<Vec<u8>>, String> {
        if chunk_index >= self.total_chunks {
            return Err(format!("Chunk {} is out of bounds", chunk_index));
        }

        loop {
            if self.stop_flag.load(Ordering::Relaxed) {
                return Err("ZIP proxy stopped".to_string());
            }

            let disk_ready = {
                let (lock, _) = &*self.inner;
                let mut inner = lock.lock().map_err(|e| e.to_string())?;

                match inner.chunks.get(&chunk_index).cloned() {
                    Some(ChunkState::Ready(bytes)) => {
                        inner.touch_hot(chunk_index);
                        return Ok(bytes);
                    }
                    Some(ChunkState::Failed(message)) => {
                        inner.chunks.remove(&chunk_index);
                        return Err(message);
                    }
                    Some(ChunkState::Fetching) => false,
                    None => {
                        if self.is_chunk_on_disk(inner.contiguous_prefix_bytes, chunk_index) {
                            true
                        } else {
                            inner.pending_chunks.insert(chunk_index);
                            self.maybe_spawn_fetch_locked(&mut inner);
                            false
                        }
                    }
                }
            };

            if disk_ready {
                let bytes = self.read_chunk_from_disk(chunk_index)?;
                let (lock, _) = &*self.inner;
                let mut inner = lock.lock().map_err(|e| e.to_string())?;
                let bytes = Arc::new(bytes);
                inner.insert_hot(chunk_index, bytes.clone(), self.hot_limit_bytes);
                return Ok(bytes);
            }

            let (lock, cvar) = &*self.inner;
            let inner = lock.lock().map_err(|e| e.to_string())?;
            let _ = cvar
                .wait_timeout(inner, Duration::from_millis(250))
                .map_err(|e| e.to_string())?;
        }
    }

    fn schedule_prefetch_from(&self, chunk_index: u64, prioritize_current: bool) {
        let start = chunk_index.min(self.total_chunks.saturating_sub(1));
        let end = (start + self.prefetch_window_chunks).min(self.total_chunks);
        let (lock, _) = &*self.inner;
        if let Ok(mut inner) = lock.lock() {
            if prioritize_current {
                inner.pending_chunks.insert(start);
            }
            for idx in start..end {
                if inner.chunks.contains_key(&idx) {
                    continue;
                }
                if self.is_chunk_on_disk(inner.contiguous_prefix_bytes, idx) {
                    continue;
                }
                inner.pending_chunks.insert(idx);
            }
            self.maybe_spawn_fetch_locked(&mut inner);
        }
    }

    fn maybe_spawn_fetch_locked(&self, inner: &mut TurboProxyInner) {
        if self.stop_flag.load(Ordering::Relaxed) {
            return;
        }

        if let Some(paused_until) = inner.paused_until {
            if paused_until > Instant::now() {
                return;
            }
            inner.paused_until = None;
            dev_log!("[ZIP PROXY] Rate limit backoff expired, resuming fetches");
        }

        while inner.in_flight < inner.max_parallel {
            let Some(next_chunk) = inner.pending_chunks.pop_first() else {
                break;
            };

            if inner.chunks.contains_key(&next_chunk)
                || self.is_chunk_on_disk(inner.contiguous_prefix_bytes, next_chunk)
            {
                continue;
            }

            inner.chunks.insert(next_chunk, ChunkState::Fetching);
            inner.in_flight += 1;

            let turbo = self.clone();
            thread::spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    turbo.fetch_chunk_worker(next_chunk);
                }));
                if let Err(panic_err) = result {
                    dev_elog!("[ZIP PROXY] Fetch worker panicked: {:?}", panic_err);
                }
            });

            let effective_delay = if inner.rate_limit_count > 0 {
                (inner.rate_limit_count * 50).min(500)
            } else {
                self.cache_spec.throttle_delay_ms
            };

            if effective_delay > 0 {
                thread::sleep(Duration::from_millis(effective_delay));
            }
        }
    }

    fn fetch_chunk_worker(&self, chunk_index: u64) {
        let result = self.fetch_chunk_bytes_with_retries(chunk_index);
        let (lock, cvar) = &*self.inner;
        let mut inner = match lock.lock() {
            Ok(inner) => inner,
            Err(error) => {
                dev_elog!("[ZIP PROXY] Failed to lock turbo cache state: {}", error);
                return;
            }
        };

        inner.in_flight = inner.in_flight.saturating_sub(1);

        let writes = match result {
            Ok(bytes) => {
                inner.rate_limit_count = 0;
                if inner.max_parallel < TURBO_MAX_CONNECTIONS {
                    inner.max_parallel += 1;
                }
                let bytes = Arc::new(bytes);
                inner.insert_hot(chunk_index, bytes.clone(), self.hot_limit_bytes);
                self.collect_pending_writes(&mut inner)
            }
            Err(error) => {
                if matches!(error.kind, FetchErrorKind::RateLimited) {
                    inner.rate_limit_count = inner.rate_limit_count.saturating_add(1);
                    let double_count = inner.rate_limit_count.min(6);
                    let backoff_secs = (TURBO_RATE_LIMIT_BACKOFF_SECS as u64)
                        .saturating_mul(1u64 << double_count)
                        .min(120);
                    let jitter = 0.75
                        + (((chunk_index.wrapping_mul(2654435761) ^ (inner.rate_limit_count * 0x9e3779b9))
                            % 100)
                            as f64)
                            / 200.0;
                    let backoff = Duration::from_secs_f64(backoff_secs as f64 * jitter);
                    inner.max_parallel = std::cmp::max(1, inner.max_parallel / 2);
                    inner.paused_until = Some(Instant::now() + backoff);
                    dev_log!(
                        "[ZIP PROXY] Rate limited (count={}), backing off {:?}, max_parallel={}",
                        inner.rate_limit_count,
                        backoff,
                        inner.max_parallel,
                    );
                } else if inner.max_parallel > TURBO_MIN_CONNECTIONS {
                    inner.max_parallel -= 1;
                }
                inner.chunks.insert(chunk_index, ChunkState::Failed(error.message));
                Vec::new()
            }
        };

        let has_writes = !writes.is_empty();
        let total_written: u64 = writes.iter().map(|(_, d)| d.len() as u64).sum();

        // Drop the lock before disk I/O
        drop(inner);

        // Write pending chunks to disk without holding the lock
        for (offset, data) in &writes {
            if let Err(error) = append_bytes_at_offset(
                &self.cache_spec.cache_paths.temp_path,
                *offset,
                data,
            ) {
                dev_elog!("[ZIP PROXY] Failed to persist turbo cache chunk: {}", error);
            }
        }

        // Re-acquire lock to update contiguous prefix and check finalization
        let (lock, cvar) = &*self.inner;
        let mut inner = match lock.lock() {
            Ok(inner) => inner,
            Err(error) => {
                dev_elog!("[ZIP PROXY] Failed to re-lock turbo cache state: {}", error);
                return;
            }
        };

        if has_writes {
            inner.contiguous_prefix_bytes = inner.contiguous_prefix_bytes.saturating_add(total_written);

            let prefix = inner.contiguous_prefix_bytes;
            if prefix >= self.total_length {
                if let Err(error) = zip_manager::finalize_stream_cache_target(
                    &self.cache_spec.cache_paths,
                    &self.cache_spec.cache_config,
                ) {
                    dev_elog!("[ZIP PROXY] Failed to finalize turbo cache target: {:?}", error);
                }
            }
            inner.evict_hot_if_needed(self.hot_limit_bytes, prefix);
        }

        self.maybe_spawn_fetch_locked(&mut inner);
        cvar.notify_all();
    }

    fn fetch_chunk_bytes_with_retries(&self, chunk_index: u64) -> Result<Vec<u8>, FetchError> {
        let (chunk_start, chunk_end) = self.chunk_relative_bounds(chunk_index);
        let upstream_start = self.spec.byte_start + chunk_start;
        let upstream_end = self.spec.byte_start + chunk_end;

        let mut exhausted_token = false;

        for attempt in 0..TURBO_FETCH_RETRIES {
            if self.stop_flag.load(Ordering::Relaxed) {
                return Err(FetchError {
                    message: "ZIP proxy stopped".to_string(),
                    kind: FetchErrorKind::Fatal,
                });
            }

            let access_token = self.resolve_or_refresh_token(exhausted_token).map_err(|error| {
                FetchError {
                    message: error,
                    kind: FetchErrorKind::Fatal,
                }
            })?;

            let mut request = self
                .http_client
                .get(&self.spec.drive_url)
                .header(RANGE, format!("bytes={}-{}", upstream_start, upstream_end));
            if !access_token.is_empty() {
                request = request.header(AUTHORIZATION, format!("Bearer {}", access_token));
            }

            match request.send() {
                Ok(response) => {
                    let status = response.status();
                    if status.as_u16() == 429 {
                        return Err(FetchError {
                            message: format!("Upstream rate limited chunk {}", chunk_index),
                            kind: FetchErrorKind::RateLimited,
                        });
                    }

                    if status.as_u16() == 401 || status.as_u16() == 403 {
                        exhausted_token = true;
                        if attempt + 1 < TURBO_FETCH_RETRIES {
                            continue;
                        }
                    }

                    let response = response.error_for_status().map_err(|error| FetchError {
                        message: format!("Upstream request failed for chunk {}: {}", chunk_index, error),
                        kind: if attempt + 1 == TURBO_FETCH_RETRIES {
                            FetchErrorKind::Fatal
                        } else {
                            FetchErrorKind::Retriable
                        },
                    })?;

                    let bytes = response.bytes().map_err(|error| FetchError {
                        message: format!("Failed reading chunk {} bytes: {}", chunk_index, error),
                        kind: if attempt + 1 == TURBO_FETCH_RETRIES {
                            FetchErrorKind::Fatal
                        } else {
                            FetchErrorKind::Retriable
                        },
                    })?;

                    if bytes.is_empty() {
                        return Err(FetchError {
                            message: format!("Chunk {} returned zero bytes", chunk_index),
                            kind: FetchErrorKind::Fatal,
                        });
                    }

                    return Ok(bytes.to_vec());
                }
                Err(error) => {
                    let kind = classify_reqwest_error(&error, attempt + 1 == TURBO_FETCH_RETRIES);
                    if matches!(kind, FetchErrorKind::RateLimited) {
                        return Err(FetchError {
                            message: format!(
                                "Upstream throttled while fetching chunk {}: {}",
                                chunk_index, error
                            ),
                            kind,
                        });
                    }

                    if attempt + 1 == TURBO_FETCH_RETRIES {
                        return Err(FetchError {
                            message: format!(
                                "Failed to fetch chunk {} after {} attempts: {}",
                                chunk_index,
                                TURBO_FETCH_RETRIES,
                                error
                            ),
                            kind,
                        });
                    }
                }
            }
        }

        Err(FetchError {
            message: format!("Failed to fetch chunk {}", chunk_index),
            kind: FetchErrorKind::Fatal,
        })
    }

    fn resolve_or_refresh_token(&self, force_refresh: bool) -> Result<String, String> {
        match &self.spec.auth {
            ProxyAuth::None => Ok(String::new()),
            ProxyAuth::GoogleDrive(client) => {
                let mut cached = self.cached_token.lock().map_err(|e| e.to_string())?;
                if !force_refresh {
                    if let Some((token, resolved_at)) = cached.clone() {
                        if resolved_at.elapsed() < Duration::from_secs(45 * 60) {
                            return Ok(token);
                        }
                    }
                }
                let runtime = build_auth_runtime(&self.spec.auth)?;
                let runtime = runtime.ok_or_else(|| "Missing auth runtime".to_string())?;
                let token = runtime.block_on(client.get_access_token())?;
                *cached = Some((token.clone(), Instant::now()));
                Ok(token)
            }
        }
    }

    fn collect_pending_writes(&self, inner: &mut TurboProxyInner) -> Vec<(u64, Vec<u8>)> {
        let mut writes = Vec::new();
        let mut next_offset = inner.contiguous_prefix_bytes;
        loop {
            if next_offset >= self.total_length {
                break;
            }

            let next_chunk = next_offset / TURBO_CHUNK_BYTES;
            let Some(ChunkState::Ready(bytes)) = inner.chunks.get(&next_chunk).cloned() else {
                break;
            };

            let expected_start = next_chunk * TURBO_CHUNK_BYTES;
            if expected_start != next_offset {
                break;
            }

            writes.push((next_offset, bytes.as_slice().to_vec()));
            next_offset = next_offset.saturating_add(bytes.len() as u64);
        }
        writes
    }

    fn is_chunk_on_disk(&self, contiguous_prefix_bytes: u64, chunk_index: u64) -> bool {
        let (chunk_start, chunk_end) = self.chunk_relative_bounds(chunk_index);
        contiguous_prefix_bytes > chunk_start && contiguous_prefix_bytes > chunk_end
    }

    fn read_chunk_from_disk(&self, chunk_index: u64) -> Result<Vec<u8>, String> {
        let cache_path = select_readable_cache_path(&self.cache_spec)
            .ok_or_else(|| "ZIP cache file not available".to_string())?;
        let (chunk_start, chunk_end) = self.chunk_relative_bounds(chunk_index);
        let expected_len = (chunk_end - chunk_start + 1) as usize;
        let mut file = File::open(&cache_path).map_err(|error| {
            format!(
                "Failed to open cache file '{}' for chunk {}: {}",
                cache_path.display(),
                chunk_index,
                error
            )
        })?;
        file.seek(SeekFrom::Start(chunk_start))
            .map_err(|error| format!("Failed to seek cache file '{}': {}", cache_path.display(), error))?;
        let mut buffer = vec![0u8; expected_len];
        file.read_exact(&mut buffer)
            .map_err(|error| format!("Failed to read cache chunk {}: {}", chunk_index, error))?;
        Ok(buffer)
    }

    fn chunk_relative_bounds(&self, chunk_index: u64) -> (u64, u64) {
        let start = chunk_index.saturating_mul(TURBO_CHUNK_BYTES);
        let end = start.saturating_add(TURBO_CHUNK_BYTES).saturating_sub(1).min(self.total_length.saturating_sub(1));
        (start, end)
    }
}

impl TurboProxyInner {
    fn touch_hot(&mut self, chunk_index: u64) {
        if let Some(position) = self.hot_lru.iter().position(|value| *value == chunk_index) {
            self.hot_lru.remove(position);
        }
        self.hot_lru.push_back(chunk_index);
    }

    fn insert_hot(&mut self, chunk_index: u64, bytes: Arc<Vec<u8>>, hot_limit_bytes: u64) {
        let previous_len = match self.chunks.get(&chunk_index) {
            Some(ChunkState::Ready(existing)) => existing.len() as u64,
            _ => 0,
        };

        self.chunks.insert(chunk_index, ChunkState::Ready(bytes.clone()));
        self.hot_bytes = self.hot_bytes.saturating_sub(previous_len);
        self.hot_bytes = self.hot_bytes.saturating_add(bytes.len() as u64);
        self.touch_hot(chunk_index);
        self.evict_hot_if_needed(hot_limit_bytes, self.contiguous_prefix_bytes);
    }

    fn evict_hot_if_needed(&mut self, hot_limit_bytes: u64, contiguous_prefix_bytes: u64) {
        while self.hot_bytes > hot_limit_bytes {
            let Some(oldest_chunk) = self.hot_lru.pop_front() else {
                break;
            };

            let can_evict = match self.chunks.get(&oldest_chunk) {
                Some(ChunkState::Ready(bytes)) => {
                    let chunk_end = ((oldest_chunk + 1) * TURBO_CHUNK_BYTES)
                        .saturating_sub(1)
                        .min(contiguous_prefix_bytes.saturating_sub(1));
                    contiguous_prefix_bytes > oldest_chunk * TURBO_CHUNK_BYTES
                        && chunk_end + 1 >= ((oldest_chunk + 1) * TURBO_CHUNK_BYTES)
                        && bytes.len() as u64 <= self.hot_bytes
                }
                _ => false,
            };

            if !can_evict {
                self.hot_lru.push_back(oldest_chunk);
                break;
            }

            if let Some(ChunkState::Ready(bytes)) = self.chunks.remove(&oldest_chunk) {
                self.hot_bytes = self.hot_bytes.saturating_sub(bytes.len() as u64);
            }
        }
    }
}

pub fn start_proxy(spec: ProxyStreamSpec) -> Result<ZipStreamProxyHandle, String> {
    let server =
        Server::http("127.0.0.1:0").map_err(|e| format!("Failed to start proxy: {}", e))?;
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        #[cfg(unix)]
        tiny_http::ListenAddr::Unix(_) => {
            return Err("Unexpected UNIX socket for ZIP proxy".to_string());
        }
    };

    let (shutdown_tx, shutdown_rx) = mpsc::channel();
    let server = Arc::new(server);
    let server_for_thread = server.clone();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_for_server = stop_flag.clone();
    let spec_for_server = spec.clone();
    let turbo_state = match spec.cache_spec.clone() {
        Some(cache_spec) => Some(TurboProxyState::new(
            spec.clone(),
            cache_spec,
            stop_flag.clone(),
        )?),
        None => None,
    };

    let join_handle = thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let client = match Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(300))
                .tcp_nodelay(true)
                .build()
            {
                Ok(client) => client,
                Err(error) => {
                    eprintln!("[ZIP PROXY] Failed to build HTTP client: {}", error);
                    return;
                }
            };

            loop {
                if stop_flag_for_server.load(Ordering::Relaxed) || shutdown_rx.try_recv().is_ok() {
                    server_for_thread.unblock();
                    break;
                }

                let request = match server_for_thread.recv_timeout(Duration::from_millis(250)) {
                    Ok(Some(request)) => request,
                    Ok(None) => continue,
                    Err(error) => {
                        eprintln!("[ZIP PROXY] Server receive error: {}", error);
                        break;
                    }
                };

                let client_for_request = client.clone();
                let spec_for_request = spec_for_server.clone();
                let stop_flag_for_request = stop_flag_for_server.clone();
                let turbo_for_request = turbo_state.clone();

                thread::spawn(move || {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        if stop_flag_for_request.load(Ordering::Relaxed) {
                            return;
                        }

                        let auth_runtime = match build_auth_runtime(&spec_for_request.auth) {
                            Ok(runtime) => runtime,
                            Err(error) => {
                                eprintln!("[ZIP PROXY] Failed to build auth runtime: {}", error);
                                if let Err(response_error) = respond_with_internal_error(
                                    request,
                                    "Failed to build auth runtime",
                                ) {
                                    eprintln!(
                                        "[ZIP PROXY] Failed to send 500 response: {}",
                                        response_error
                                    );
                                }
                                return;
                            }
                        };

                        if let Err(error) = handle_request(
                            request,
                            &client_for_request,
                            &spec_for_request,
                            &auth_runtime,
                            turbo_for_request.as_ref(),
                        ) {
                            let (request, error) = *error;
                            eprintln!("[ZIP PROXY] Request failed: {}", error);
                            if let Some(request) = request {
                                if let Err(response_error) = respond_with_internal_error(
                                    request,
                                    "ZIP proxy request failed",
                                ) {
                                    eprintln!(
                                        "[ZIP PROXY] Failed to send 500 response: {}",
                                        response_error
                                    );
                                }
                            }
                        }
                    }));
                    if let Err(panic_err) = result {
                        eprintln!("[ZIP PROXY] Request handler panicked: {:?}", panic_err);
                    }
                });
            }
        }));
        if let Err(panic_err) = result {
            eprintln!("[ZIP PROXY] Server thread panicked: {:?}", panic_err);
        }
    });

    Ok(ZipStreamProxyHandle {
        port,
        shutdown_tx: Some(shutdown_tx),
        join_handle: Some(join_handle),
        cache_join_handle: None,
        stop_flag,
    })
}

fn handle_request(
    request: tiny_http::Request,
    client: &Client,
    spec: &ProxyStreamSpec,
    auth_runtime: &Option<TokioRuntime>,
    turbo_state: Option<&TurboProxyState>,
) -> Result<(), RequestFailure> {
    let started_at = Instant::now();
    let mut request = Some(request);

    if request.as_ref().map(|request| request.url()) != Some("/stream") {
        request
            .take()
            .expect("request should be present before responding")
            .respond(Response::from_string("Not Found").with_status_code(StatusCode(404)))
            .map_err(|e| (None, e.to_string()))?;
        return Ok(());
    }

    match request
        .as_ref()
        .expect("request should be present while handling method")
        .method()
    {
        Method::Get | Method::Head => {}
        _ => {
            request
                .take()
                .expect("request should be present before responding")
                .respond(Response::empty(StatusCode(405)))
                .map_err(|e| (None, e.to_string()))?;
            return Ok(());
        }
    }

    let episode_length = spec
        .byte_end
        .checked_sub(spec.byte_start)
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| {
            (
                request.take(),
                "Invalid ZIP byte range".to_string(),
            )
        })?;

    let requested_range = match extract_range_header(
        request
            .as_ref()
            .expect("request should be present while parsing range"),
        episode_length,
    ) {
        Ok(range) => range,
        Err(error) => {
            let response = Response::empty(StatusCode(416)).with_header(make_header(
                "Content-Range",
                &format!("bytes */{}", episode_length),
            )
            .map_err(|header_error| (request.take(), header_error))?);
            request
                .take()
                .expect("request should be present before responding")
                .respond(response)
                .map_err(|e| (None, e.to_string()))?;
            return Err(Box::new((None, error)));
        }
    };

    let (relative_start, relative_end) = requested_range.unwrap_or((0, episode_length - 1));
    let response_status = if requested_range.is_some() { 206 } else { 200 };
    let body_length = (relative_end - relative_start + 1) as usize;
    let headers = build_response_headers(
        &spec.content_type,
        relative_start,
        relative_end,
        episode_length,
        body_length,
        requested_range.is_some(),
    )
    .map_err(|error| (request.take(), error))?;

    let method = match request
        .as_ref()
        .expect("request should be present for logging")
        .method()
    {
        Method::Get => "GET",
        Method::Head => "HEAD",
        _ => "OTHER",
    };
    let url = request
        .as_ref()
        .expect("request should be present for logging")
        .url()
        .to_string();

    dev_log!(
        "[ZIP PROXY] {} {} range={:?} resolved={}..{} len={} turbo={}",
        method,
        url,
        requested_range,
        relative_start,
        relative_end,
        body_length,
        turbo_state.is_some()
    );

    if matches!(
        request
            .as_ref()
            .expect("request should be present for HEAD check")
            .method(),
        Method::Head
    ) {
        let response = headers.into_iter().fold(
            Response::empty(StatusCode(response_status)),
            |response, header| response.with_header(header),
        );
        request
            .take()
            .expect("request should be present before responding")
            .respond(response)
            .map_err(|e| (None, e.to_string()))?;
        return Ok(());
    }

    if let Some(turbo) = turbo_state {
        if turbo.first_response_served.swap(true, Ordering::Relaxed) {
            let reader: Box<dyn Read + Send> = Box::new(TurboStreamReader::new(
                turbo.clone(),
                relative_start,
                relative_end,
            ));
            let response = Response::new(
                StatusCode(response_status),
                headers,
                reader,
                Some(body_length),
                None,
            )
            .with_chunked_threshold(usize::MAX);
            request
                .take()
                .expect("request should be present before responding")
                .respond(response.boxed())
                .map_err(|e| (None, e.to_string()))?;
            dev_log!(
                "[ZIP PROXY] Served turbo response in {} ms (turbo-cached)",
                started_at.elapsed().as_millis()
            );
            return Ok(());
        }
        dev_log!(
            "[ZIP PROXY] First request: streaming directly while turbo cache fills in background"
        );
    }

    let upstream_start = spec.byte_start + relative_start;
    let upstream_end = spec.byte_start + relative_end;

    let should_start_prewarm = turbo_state.is_some() && !turbo_state.unwrap().prewarm_started.load(Ordering::Relaxed);

    let (access_token, upstream) = if let Some(turbo) = turbo_state {
        // Use the turbo proxy's shared client and cached token for the first request,
        // so the prewarm and first request share a connection pool and token cache.
        let fetch_client = &turbo.http_client;
        let token_start = Instant::now();
        let token = turbo.resolve_or_refresh_token(false).map_err(|e| {
            dev_elog!("[ZIP PROXY] Direct token resolve failed: {}", e);
            e
        }).unwrap_or_default();
        dev_log!("[ZIP PROXY] Resolved auth token in {} ms", token_start.elapsed().as_millis());

        let mut gdrive_req = fetch_client
            .get(&spec.drive_url)
            .header(RANGE, format!("bytes={}-{}", upstream_start, upstream_end));
        if !token.is_empty() {
            gdrive_req = gdrive_req.header(AUTHORIZATION, format!("Bearer {}", token));
        }
        let upstream = gdrive_req
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|error| (request.take(), format!("Upstream request failed: {}", error)))?;
        (token, upstream)
    } else {
        let token = resolve_access_token(spec, auth_runtime)
            .map_err(|error| (request.take(), error))?;
        let mut gdrive_req = client
            .get(&spec.drive_url)
            .header(RANGE, format!("bytes={}-{}", upstream_start, upstream_end));
        if !token.is_empty() {
            gdrive_req = gdrive_req.header(AUTHORIZATION, format!("Bearer {}", token));
        }
        let upstream = gdrive_req
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|error| (request.take(), format!("Upstream request failed: {}", error)))?;
        (token, upstream)
    };

    dev_log!(
        "[ZIP PROXY] GDrive first byte fetched (token={}) in {} ms — now streaming to MPV",
        if access_token.is_empty() { "none" } else { "ok" },
        started_at.elapsed().as_millis()
    );

    let response = Response::new(
        StatusCode(response_status),
        headers,
        upstream,
        Some(body_length),
        None,
    )
    .with_chunked_threshold(usize::MAX);
    request
        .take()
        .expect("request should be present before responding")
        .respond(response.boxed())
        .map_err(|e| (None, e.to_string()))?;

    if should_start_prewarm {
        if let Some(turbo) = turbo_state {
            turbo.ensure_prewarm_started();
        }
    }

    dev_log!(
        "[ZIP PROXY] Streamed upstream response in {} ms (total)",
        started_at.elapsed().as_millis()
    );
    Ok(())
}

fn respond_with_internal_error(request: tiny_http::Request, message: &str) -> Result<(), String> {
    request
        .respond(Response::from_string(message).with_status_code(StatusCode(500)))
        .map_err(|error| error.to_string())
}

fn existing_prefix_len(cache_spec: &ProxyCacheSpec) -> u64 {
    if let Ok(metadata) = fs::metadata(&cache_spec.cache_paths.cache_path) {
        if metadata.is_file() && metadata.len() >= cache_spec.cache_paths.expected_size {
            return cache_spec.cache_paths.expected_size;
        }
    }

    match fs::metadata(&cache_spec.cache_paths.temp_path) {
        Ok(metadata) if metadata.is_file() => metadata.len().min(cache_spec.cache_paths.expected_size),
        _ => 0,
    }
}

fn select_readable_cache_path(cache_spec: &ProxyCacheSpec) -> Option<PathBuf> {
    if let Ok(metadata) = fs::metadata(&cache_spec.cache_paths.cache_path) {
        if metadata.is_file() && metadata.len() >= cache_spec.cache_paths.expected_size {
            return Some(cache_spec.cache_paths.cache_path.clone());
        }
    }

    if let Ok(metadata) = fs::metadata(&cache_spec.cache_paths.temp_path) {
        if metadata.is_file() && metadata.len() > 0 {
            return Some(cache_spec.cache_paths.temp_path.clone());
        }
    }

    None
}

fn append_bytes_at_offset(path: &Path, offset: u64, bytes: &[u8]) -> Result<(), String> {
    let mut writer = OpenOptions::new()
        .create(true)
        .write(true)
        .read(true)
        .truncate(false)
        .open(path)
        .map_err(|error| format!("Failed to open cache file '{}': {}", path.display(), error))?;
    writer
        .seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Failed to seek cache file '{}': {}", path.display(), error))?;
    writer
        .write_all(bytes)
        .map_err(|error| format!("Failed to write cache file '{}': {}", path.display(), error))?;
    writer
        .flush()
        .map_err(|error| format!("Failed to flush cache file '{}': {}", path.display(), error))
}

fn classify_reqwest_error(error: &reqwest::Error, last_attempt: bool) -> FetchErrorKind {
    if error.is_timeout() || error.is_connect() || error.is_request() {
        if last_attempt {
            FetchErrorKind::Fatal
        } else {
            FetchErrorKind::Retriable
        }
    } else {
        FetchErrorKind::Fatal
    }
}

fn extract_range_header(
    request: &tiny_http::Request,
    total_length: u64,
) -> Result<Option<(u64, u64)>, String> {
    let header = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Range"));

    let Some(header) = header else {
        return Ok(None);
    };

    let value = header.value.as_str();
    let range = value
        .strip_prefix("bytes=")
        .ok_or_else(|| "Unsupported range header".to_string())?;

    let (start_raw, end_raw) = range
        .split_once('-')
        .ok_or_else(|| "Invalid range header".to_string())?;

    if start_raw.is_empty() {
        let suffix = end_raw
            .parse::<u64>()
            .map_err(|_| "Invalid range suffix".to_string())?;
        if suffix == 0 || suffix > total_length {
            return Err("Invalid range suffix".to_string());
        }
        return Ok(Some((total_length - suffix, total_length - 1)));
    }

    let start = start_raw
        .parse::<u64>()
        .map_err(|_| "Invalid range start".to_string())?;
    let end = if end_raw.is_empty() {
        total_length - 1
    } else {
        end_raw
            .parse::<u64>()
            .map_err(|_| "Invalid range end".to_string())?
    };

    if start > end || end >= total_length {
        return Err("Range out of bounds".to_string());
    }

    Ok(Some((start, end)))
}

fn make_header(name: &str, value: &str) -> Result<Header, String> {
    Header::from_bytes(name.as_bytes(), value.as_bytes())
        .map_err(|_| format!("Invalid header: {}", name))
}

fn build_response_headers(
    content_type: &str,
    relative_start: u64,
    relative_end: u64,
    total_length: u64,
    body_length: usize,
    is_partial: bool,
) -> Result<Vec<Header>, String> {
    let mut headers = vec![
        make_header("Content-Type", content_type)?,
        make_header("Content-Length", &body_length.to_string())?,
        make_header("Accept-Ranges", "bytes")?,
        make_header("Connection", "keep-alive")?,
    ];

    if is_partial {
        headers.push(make_header(
            "Content-Range",
            &format!("bytes {}-{}/{}", relative_start, relative_end, total_length),
        )?);
    }

    Ok(headers)
}

pub fn localhost_stream_url(port: u16) -> String {
    format!("http://127.0.0.1:{}/stream", port)
}

pub fn build_proxy_spec(
    drive_url: String,
    gdrive_client: gdrive::GoogleDriveClient,
    stream_info: &zip_manager::ZipStreamInfo,
    cache_spec: Option<ProxyCacheSpec>,
) -> ProxyStreamSpec {
    ProxyStreamSpec {
        drive_url,
        auth: ProxyAuth::GoogleDrive(gdrive_client),
        byte_start: stream_info.byte_start,
        byte_end: stream_info.byte_end,
        content_type: stream_info.content_type.clone(),
        cache_spec,
    }
}

pub fn build_file_proxy_spec(
    drive_url: String,
    gdrive_client: gdrive::GoogleDriveClient,
    file_size: u64,
    content_type: String,
) -> ProxyStreamSpec {
    ProxyStreamSpec {
        drive_url,
        auth: ProxyAuth::GoogleDrive(gdrive_client),
        byte_start: 0,
        byte_end: file_size.saturating_sub(1),
        content_type,
        cache_spec: None,
    }
}

pub fn build_direct_link_proxy_spec(
    url: String,
    stream_info: &zip_manager::ZipStreamInfo,
    cache_spec: Option<ProxyCacheSpec>,
) -> ProxyStreamSpec {
    ProxyStreamSpec {
        drive_url: url,
        auth: ProxyAuth::None,
        byte_start: stream_info.byte_start,
        byte_end: stream_info.byte_end,
        content_type: stream_info.content_type.clone(),
        cache_spec,
    }
}

fn build_auth_runtime(auth: &ProxyAuth) -> Result<Option<TokioRuntime>, String> {
    match auth {
        ProxyAuth::GoogleDrive(_) => TokioRuntimeBuilder::new_current_thread()
            .enable_all()
            .build()
            .map(Some)
            .map_err(|error| error.to_string()),
        ProxyAuth::None => Ok(None),
    }
}

fn resolve_access_token(
    spec: &ProxyStreamSpec,
    auth_runtime: &Option<TokioRuntime>,
) -> Result<String, String> {
    match &spec.auth {
        ProxyAuth::GoogleDrive(client) => auth_runtime
            .as_ref()
            .ok_or_else(|| "Missing auth runtime for Google Drive proxy".to_string())?
            .block_on(client.get_access_token()),
        ProxyAuth::None => Ok(String::new()),
    }
}
