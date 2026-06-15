// ponytail: base builder avoids 35 lines of builder-chain duplication
use std::sync::LazyLock;

fn make_client(timeout: u64, connect: u64, keepalive: u64, label: &str) -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout))
        .connect_timeout(std::time::Duration::from_secs(connect))
        .redirect(reqwest::redirect::Policy::limited(5))
        .pool_max_idle_per_host(10)
        .tcp_keepalive(std::time::Duration::from_secs(keepalive))
        .tcp_nodelay(true)
        .http1_only()
        .user_agent("SlasshyVault/1.0")
        .gzip(true)
        .deflate(true)
        .build()
        .expect(label)
}

/// Standard client for general API requests (30 s timeout).
static SHARED_CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
    make_client(30, 15, 20, "Failed to build shared HTTP client")
});

/// Quick client for latency-sensitive operations (10 s timeout).
static QUICK_CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
    make_client(10, 10, 15, "Failed to build quick HTTP client")
});

/// Long-timeout client for archive / large-file operations (300 s timeout).
static LONG_CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
    make_client(300, 30, 60, "Failed to build long HTTP client")
});

/// Return a reference to the shared 30 s-timeout client.
pub fn shared_client() -> &'static reqwest::blocking::Client {
    &SHARED_CLIENT
}

/// Return a reference to the quick 10 s-timeout client.
pub fn quick_client() -> &'static reqwest::blocking::Client {
    &QUICK_CLIENT
}

/// Return a reference to the long 300 s-timeout client.
pub fn long_client() -> &'static reqwest::blocking::Client {
    &LONG_CLIENT
}

/// Proxy download client (1-hour timeout, .no_proxy() for Windows system proxy bypass).
/// ponytail: LazyLock avoids reqwest 0.12 per-build tokio runtime hang.
static PROXY_CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(3600))
        .redirect(reqwest::redirect::Policy::limited(5))
        .gzip(true)
        .deflate(true)
        .build()
        .expect("Failed to build proxy HTTP client")
});

/// Return a reference to the proxy download client.
pub fn proxy_client() -> &'static reqwest::blocking::Client {
    &PROXY_CLIENT
}

/// Make a raw HTTP GET request to a local server using TCP.
/// Bypasses reqwest's loopback restriction. Returns the response body as a String.
pub fn local_http_get(url: &str) -> Result<String, String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    let host = parsed.host_str().ok_or("No host in URL")?;
    let port = parsed.port_or_known_default().unwrap_or(80);
    let path = if parsed.path().is_empty() { "/" } else { parsed.path() };
    let query = parsed.query().map(|q| format!("?{}", q)).unwrap_or_default();
    let addr = format!("{}:{}", host, port);

    let mut stream = TcpStream::connect(&addr)
        .map_err(|e| format!("Failed to connect to {}: {}", addr, e))?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .map_err(|e| format!("Failed to set timeout: {}", e))?;

    let request = format!(
        "GET {}{} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAccept: application/json\r\n\r\n",
        path, query, if port == 80 { host.to_string() } else { format!("{}:{}", host, port) }
    );

    stream.write_all(request.as_bytes())
        .map_err(|e| format!("Failed to send request: {}", e))?;

    let mut response = Vec::new();
    stream.read_to_end(&mut response)
        .map_err(|e| format!("Failed to read response: {}", e))?;

    let response_str = String::from_utf8_lossy(&response);
    let body_start = response_str.find("\r\n\r\n")
        .ok_or("Invalid HTTP response")?;
    let body = &response_str[body_start + 4..];

    // Check status code
    let status_line = response_str.lines().next().unwrap_or("");
    if !status_line.contains("200") {
        return Err(format!("HTTP error: {}", status_line));
    }

    Ok(body.to_string())
}

/// Make a raw HTTP GET request to a local server using TCP, returning a streaming reader.
/// Returns (content_length, reader) where reader yields the response body bytes.
/// Bypasses reqwest's loopback restriction for streaming large files.
pub fn local_http_get_raw(url: &str) -> Result<(u64, std::io::BufReader<std::net::TcpStream>), String> {
    use std::io::{BufRead, Read, Write};
    use std::net::TcpStream;

    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    let host = parsed.host_str().ok_or("No host in URL")?;
    let port = parsed.port_or_known_default().unwrap_or(80);
    let path = if parsed.path().is_empty() { "/" } else { parsed.path() };
    let query = parsed.query().map(|q| format!("?{}", q)).unwrap_or_default();
    let addr = format!("{}:{}", host, port);

    let mut stream = TcpStream::connect(&addr)
        .map_err(|e| format!("Failed to connect to {}: {}", addr, e))?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(3600)))
        .map_err(|e| format!("Failed to set timeout: {}", e))?;

    let request = format!(
        "GET {}{} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAccept: */*\r\n\r\n",
        path, query, if port == 80 { host.to_string() } else { format!("{}:{}", host, port) }
    );

    stream.write_all(request.as_bytes())
        .map_err(|e| format!("Failed to send request: {}", e))?;

    // Read headers line by line
    let mut reader = std::io::BufReader::new(stream);
    let mut content_length: u64 = 0;
    let mut status_ok = false;

    loop {
        let mut header_line = String::new();
        reader.read_line(&mut header_line)
            .map_err(|e| format!("Failed to read header: {}", e))?;
        let trimmed = header_line.trim();

        if trimmed.is_empty() {
            break; // End of headers
        }

        // Check status
        if trimmed.starts_with("HTTP/") {
            status_ok = trimmed.contains("200") || trimmed.contains("206");
        }

        // Parse Content-Length
        if let Some(val) = trimmed.strip_prefix("Content-Length:").or_else(|| trimmed.strip_prefix("content-length:")) {
            content_length = val.trim().parse().unwrap_or(0);
        }
    }

    if !status_ok {
        return Err("HTTP error (non-200/206 status)".to_string());
    }

    Ok((content_length, reader))
}
