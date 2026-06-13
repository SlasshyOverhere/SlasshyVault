/// Shared, lazily-initialized HTTP blocking clients.
///
/// In reqwest 0.12 the blocking `Client` internally creates a tokio runtime.
/// When such a client is created *and dropped* inside `tokio::task::spawn_blocking`,
/// the internal runtime's `Drop` tries to `block_on()` while already inside a
/// tokio runtime context — and panics.
///
/// By keeping the clients in `LazyLock` statics they are:
///   • built exactly once (on whichever thread first accesses them),
///   • never dropped (they are `'static`),
///   • safe to `.clone()` (cheap `Arc` bump) from any thread, including
///     `spawn_blocking` pool threads.
use std::sync::LazyLock;

/// Standard client for general API requests (30 s timeout, HTTP/1.1 only).
static SHARED_CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .pool_max_idle_per_host(10)
        .tcp_keepalive(std::time::Duration::from_secs(20))
        .tcp_nodelay(true)
        .http1_only()
        .user_agent("SlasshyVault/1.0")
        .gzip(true)
        .deflate(true)
        .build()
        .expect("Failed to build shared HTTP client")
});

/// Quick client for latency-sensitive operations (10 s timeout, HTTP/1.1 only).
static QUICK_CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .connect_timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(5))
        .pool_max_idle_per_host(10)
        .tcp_keepalive(std::time::Duration::from_secs(15))
        .tcp_nodelay(true)
        .http1_only()
        .user_agent("SlasshyVault/1.0")
        .gzip(true)
        .deflate(true)
        .build()
        .expect("Failed to build quick HTTP client")
});

/// Long-timeout client for archive / large-file operations (300 s timeout).
static LONG_CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .connect_timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .pool_max_idle_per_host(10)
        .tcp_keepalive(std::time::Duration::from_secs(60))
        .tcp_nodelay(true)
        .http1_only()
        .user_agent("SlasshyVault/1.0")
        .gzip(true)
        .deflate(true)
        .build()
        .expect("Failed to build long HTTP client")
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
