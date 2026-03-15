use crate::zip_manager;
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, RANGE};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tiny_http::{Header, Method, Response, Server, StatusCode};

#[derive(Debug, Clone)]
pub struct ProxyStreamSpec {
    pub drive_url: String,
    pub access_token: String,
    pub byte_start: u64,
    pub byte_end: u64,
    pub content_type: String,
}

pub struct ZipStreamProxyHandle {
    pub port: u16,
    shutdown_tx: Option<mpsc::Sender<()>>,
    join_handle: Option<JoinHandle<()>>,
}

impl ZipStreamProxyHandle {
    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }

        if let Some(handle) = self.join_handle.take() {
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

    let join_handle = thread::spawn(move || {
        let client = match Client::builder().timeout(Duration::from_secs(60)).build() {
            Ok(client) => client,
            Err(error) => {
                println!("[ZIP PROXY] Failed to build HTTP client: {}", error);
                return;
            }
        };

        loop {
            if shutdown_rx.try_recv().is_ok() {
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

            if let Err(error) = handle_request(request, &client, &spec) {
                println!("[ZIP PROXY] Request failed: {}", error);
            }
        }
    });

    Ok(ZipStreamProxyHandle {
        port,
        shutdown_tx: Some(shutdown_tx),
        join_handle: Some(join_handle),
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
    let upstream_start = spec.byte_start + relative_start;
    let upstream_end = spec.byte_start + relative_end;
    let response_status = if requested_range.is_some() { 206 } else { 200 };
    let body_length = (relative_end - relative_start + 1) as usize;

    let upstream = client
        .get(&spec.drive_url)
        .header(AUTHORIZATION, format!("Bearer {}", spec.access_token))
        .header(RANGE, format!("bytes={}-{}", upstream_start, upstream_end))
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("Drive request failed: {}", error))?;

    let headers = vec![
        make_header("Content-Type", &spec.content_type)?,
        make_header(
            "Content-Range",
            &format!(
                "bytes {}-{}/{}",
                relative_start, relative_end, episode_length
            ),
        )?,
        make_header("Content-Length", &body_length.to_string())?,
        make_header("Accept-Ranges", "bytes")?,
        make_header("Connection", "keep-alive")?,
    ];

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

pub fn localhost_stream_url(port: u16) -> String {
    format!("http://127.0.0.1:{}/stream", port)
}

pub fn build_proxy_spec(
    drive_url: String,
    access_token: String,
    stream_info: &zip_manager::ZipStreamInfo,
) -> ProxyStreamSpec {
    ProxyStreamSpec {
        drive_url,
        access_token,
        byte_start: stream_info.byte_start,
        byte_end: stream_info.byte_end,
        content_type: stream_info.content_type.clone(),
    }
}
