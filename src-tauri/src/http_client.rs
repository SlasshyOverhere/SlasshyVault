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
        .pool_max_idle_per_host(0)
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
        .pool_max_idle_per_host(0)
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
        .pool_max_idle_per_host(0)
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
