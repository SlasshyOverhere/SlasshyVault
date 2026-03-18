use crate::zip_manager;
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, RANGE};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tiny_http::{Header, Method, Response, Server, StatusCode};

const STORE_CACHE_CHUNK_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ProxyCacheSpec {
    pub cache_paths: zip_manager::ZipCachePaths,
    pub cache_config: zip_manager::ZipCacheConfig,
    pub start_delay_ms: u64,
    pub throttle_delay_ms: u64,
}

#[derive(Debug, Clone)]
pub struct ProxyStreamSpec {
    pub drive_url: String,
    pub access_token: String,
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

    let join_handle = thread::spawn(move || {
        let client = match Client::builder().timeout(Duration::from_secs(60)).build() {
            Ok(client) => client,
            Err(error) => {
                println!("[ZIP PROXY] Failed to build HTTP client: {}", error);
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
                    println!("[ZIP PROXY] Server receive error: {}", error);
                    break;
                }
            };

            if let Err(error) = handle_request(request, &client, &spec_for_server) {
                println!("[ZIP PROXY] Request failed: {}", error);
            }
        }
    });

    let cache_join_handle = spec.cache_spec.clone().map(|cache_spec| {
        let stop_flag_for_cache = stop_flag.clone();
        let spec_for_cache = spec.clone();

        thread::spawn(move || {
            background_cache_store(&spec_for_cache, &cache_spec, &stop_flag_for_cache);
        })
    });

    Ok(ZipStreamProxyHandle {
        port,
        shutdown_tx: Some(shutdown_tx),
        join_handle: Some(join_handle),
        cache_join_handle,
        stop_flag,
    })
}

fn handle_request(
    request: tiny_http::Request,
    client: &Client,
    spec: &ProxyStreamSpec,
) -> Result<(), String> {
    if request.url() != "/stream" {
        request
            .respond(Response::from_string("Not Found").with_status_code(StatusCode(404)))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    match request.method() {
        Method::Get | Method::Head => {}
        _ => {
            request
                .respond(Response::empty(StatusCode(405)))
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    let episode_length = spec
        .byte_end
        .checked_sub(spec.byte_start)
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| "Invalid ZIP byte range".to_string())?;

    let requested_range = match extract_range_header(&request, episode_length) {
        Ok(range) => range,
        Err(error) => {
            let response = Response::empty(StatusCode(416)).with_header(make_header(
                "Content-Range",
                &format!("bytes */{}", episode_length),
            )?);
            request.respond(response).map_err(|e| e.to_string())?;
            return Err(error);
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
    )?;

    if let Some(cache_spec) = spec.cache_spec.as_ref() {
        if matches!(request.method(), Method::Head) {
            let response = headers.into_iter().fold(
                Response::empty(StatusCode(response_status)),
                |response, header| response.with_header(header),
            );
            request.respond(response).map_err(|e| e.to_string())?;
            return Ok(());
        }

        if let Some((cache_path, cached_prefix_len)) = cached_source_info(cache_spec) {
            if cached_prefix_len > relative_start {
                let mut file = File::open(&cache_path).map_err(|error| {
                    format!(
                        "Failed to open cache file '{}': {}",
                        cache_path.display(),
                        error
                    )
                })?;
                file.seek(SeekFrom::Start(relative_start))
                    .map_err(|error| {
                        format!(
                            "Failed to seek cache file '{}': {}",
                            cache_path.display(),
                            error
                        )
                    })?;

                let local_available_len = cached_prefix_len
                    .saturating_sub(relative_start)
                    .min(body_length as u64);

                if local_available_len == body_length as u64 {
                    let response = Response::new(
                        StatusCode(response_status),
                        headers,
                        file.take(body_length as u64),
                        Some(body_length),
                        None,
                    )
                    .with_chunked_threshold(usize::MAX);

                    request
                        .respond(response.boxed())
                        .map_err(|e| e.to_string())?;
                    return Ok(());
                }

                let upstream_start = spec.byte_start + relative_start + local_available_len;
                let upstream_end = spec.byte_start + relative_end;
                let upstream = client
                    .get(&spec.drive_url)
                    .header(AUTHORIZATION, format!("Bearer {}", spec.access_token))
                    .header(RANGE, format!("bytes={}-{}", upstream_start, upstream_end))
                    .send()
                    .and_then(|response| response.error_for_status())
                    .map_err(|error| format!("Drive request failed: {}", error))?;

                let hybrid_reader: Box<dyn Read + Send> =
                    Box::new(file.take(local_available_len).chain(upstream));
                let response = Response::new(
                    StatusCode(response_status),
                    headers,
                    hybrid_reader,
                    Some(body_length),
                    None,
                )
                .with_chunked_threshold(usize::MAX);

                request
                    .respond(response.boxed())
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
    }

    let upstream_start = spec.byte_start + relative_start;
    let upstream_end = spec.byte_start + relative_end;
    let upstream = client
        .get(&spec.drive_url)
        .header(AUTHORIZATION, format!("Bearer {}", spec.access_token))
        .header(RANGE, format!("bytes={}-{}", upstream_start, upstream_end))
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("Drive request failed: {}", error))?;

    if matches!(request.method(), Method::Head) {
        let response = headers.into_iter().fold(
            Response::empty(StatusCode(response_status)),
            |response, header| response.with_header(header),
        );
        request.respond(response).map_err(|e| e.to_string())
    } else {
        let response = Response::new(
            StatusCode(response_status),
            headers,
            upstream,
            Some(body_length),
            None,
        )
        .with_chunked_threshold(usize::MAX);
        request.respond(response.boxed()).map_err(|e| e.to_string())
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
) -> Result<Vec<Header>, String> {
    Ok(vec![
        make_header("Content-Type", content_type)?,
        make_header(
            "Content-Range",
            &format!("bytes {}-{}/{}", relative_start, relative_end, total_length),
        )?,
        make_header("Content-Length", &body_length.to_string())?,
        make_header("Accept-Ranges", "bytes")?,
        make_header("Connection", "keep-alive")?,
    ])
}

fn select_cached_source(cache_spec: &ProxyCacheSpec, relative_end: u64) -> Option<PathBuf> {
    if let Ok(metadata) = fs::metadata(&cache_spec.cache_paths.cache_path) {
        if metadata.is_file() && metadata.len() >= cache_spec.cache_paths.expected_size {
            if relative_end < metadata.len() {
                return Some(cache_spec.cache_paths.cache_path.clone());
            }
        }
    }

    if let Ok(metadata) = fs::metadata(&cache_spec.cache_paths.temp_path) {
        if metadata.is_file() && relative_end < metadata.len() {
            return Some(cache_spec.cache_paths.temp_path.clone());
        }
    }

    None
}

fn cached_source_info(cache_spec: &ProxyCacheSpec) -> Option<(PathBuf, u64)> {
    if let Ok(metadata) = fs::metadata(&cache_spec.cache_paths.cache_path) {
        if metadata.is_file() && metadata.len() >= cache_spec.cache_paths.expected_size {
            return Some((cache_spec.cache_paths.cache_path.clone(), metadata.len()));
        }
    }

    if let Ok(metadata) = fs::metadata(&cache_spec.cache_paths.temp_path) {
        if metadata.is_file() && metadata.len() > 0 {
            return Some((
                cache_spec.cache_paths.temp_path.clone(),
                metadata.len().min(cache_spec.cache_paths.expected_size),
            ));
        }
    }

    None
}

fn background_cache_store(
    spec: &ProxyStreamSpec,
    cache_spec: &ProxyCacheSpec,
    stop_flag: &AtomicBool,
) {
    if cache_spec.start_delay_ms > 0 {
        let mut remaining_delay = cache_spec.start_delay_ms;
        while remaining_delay > 0 && !stop_flag.load(Ordering::Relaxed) {
            let sleep_ms = remaining_delay.min(250);
            thread::sleep(Duration::from_millis(sleep_ms));
            remaining_delay = remaining_delay.saturating_sub(sleep_ms);
        }
    }

    if stop_flag.load(Ordering::Relaxed) {
        return;
    }

    if let Ok(metadata) = fs::metadata(&cache_spec.cache_paths.cache_path) {
        if metadata.is_file() && metadata.len() == cache_spec.cache_paths.expected_size {
            return;
        }
    }

    let mut downloaded = match fs::metadata(&cache_spec.cache_paths.temp_path) {
        Ok(metadata)
            if metadata.is_file() && metadata.len() <= cache_spec.cache_paths.expected_size =>
        {
            metadata.len()
        }
        Ok(_) => {
            let _ = fs::remove_file(&cache_spec.cache_paths.temp_path);
            0
        }
        Err(_) => 0,
    };

    if downloaded == cache_spec.cache_paths.expected_size {
        if let Err(error) = zip_manager::finalize_stream_cache_target(
            &cache_spec.cache_paths,
            &cache_spec.cache_config,
        ) {
            println!("[ZIP CACHE] Failed to finalize cached stream: {:?}", error);
        }
        return;
    }

    let client = match Client::builder().timeout(Duration::from_secs(300)).build() {
        Ok(client) => client,
        Err(error) => {
            println!(
                "[ZIP CACHE] Failed to build cache downloader client: {}",
                error
            );
            return;
        }
    };

    let mut writer = match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&cache_spec.cache_paths.temp_path)
    {
        Ok(file) => file,
        Err(error) => {
            println!(
                "[ZIP CACHE] Failed to open temp cache file '{}': {}",
                cache_spec.cache_paths.temp_path.display(),
                error
            );
            return;
        }
    };

    while downloaded < cache_spec.cache_paths.expected_size && !stop_flag.load(Ordering::Relaxed) {
        let chunk_end = (downloaded + STORE_CACHE_CHUNK_BYTES - 1)
            .min(cache_spec.cache_paths.expected_size - 1);
        let upstream_start = spec.byte_start + downloaded;
        let upstream_end = spec.byte_start + chunk_end;

        let mut response = match client
            .get(&spec.drive_url)
            .header(AUTHORIZATION, format!("Bearer {}", spec.access_token))
            .header(RANGE, format!("bytes={}-{}", upstream_start, upstream_end))
            .send()
            .and_then(|response| response.error_for_status())
        {
            Ok(response) => response,
            Err(error) => {
                println!("[ZIP CACHE] Failed to download cache chunk: {}", error);
                break;
            }
        };

        let copied = match std::io::copy(&mut response, &mut writer) {
            Ok(copied) => copied,
            Err(error) => {
                println!("[ZIP CACHE] Failed to write cache chunk: {}", error);
                break;
            }
        };

        if copied == 0 {
            println!("[ZIP CACHE] Cache downloader received zero bytes, stopping");
            break;
        }

        downloaded = downloaded.saturating_add(copied);
        if let Err(error) = writer.flush() {
            println!("[ZIP CACHE] Failed to flush cache file: {}", error);
            break;
        }

        if cache_spec.throttle_delay_ms > 0 && downloaded < cache_spec.cache_paths.expected_size {
            thread::sleep(Duration::from_millis(cache_spec.throttle_delay_ms));
        }
    }

    if downloaded == cache_spec.cache_paths.expected_size {
        match zip_manager::finalize_stream_cache_target(
            &cache_spec.cache_paths,
            &cache_spec.cache_config,
        ) {
            Ok(path) => println!("[ZIP CACHE] Completed store cache: {}", path),
            Err(error) => println!("[ZIP CACHE] Failed to finalize cached stream: {:?}", error),
        }
    } else if stop_flag.load(Ordering::Relaxed) {
        println!(
            "[ZIP CACHE] Stopped store cache download at {} / {} bytes",
            downloaded, cache_spec.cache_paths.expected_size
        );
    }
}

pub fn localhost_stream_url(port: u16) -> String {
    format!("http://127.0.0.1:{}/stream", port)
}

pub fn build_proxy_spec(
    drive_url: String,
    access_token: String,
    stream_info: &zip_manager::ZipStreamInfo,
    cache_spec: Option<ProxyCacheSpec>,
) -> ProxyStreamSpec {
    ProxyStreamSpec {
        drive_url,
        access_token,
        byte_start: stream_info.byte_start,
        byte_end: stream_info.byte_end,
        content_type: stream_info.content_type.clone(),
        cache_spec,
    }
}
