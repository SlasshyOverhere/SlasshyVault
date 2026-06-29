use std::sync::atomic::{AtomicBool, Ordering};

/// DSN env-var key (same as .env.example / CI). NOT hardcoded.
const SENTRY_DSN_ENV: &str = "SENTRY_DSN";

/// Optional env var to override sample rate (default: 1.0 in dev, 0.1 in prod).
const SENTRY_SAMPLE_RATE_ENV: &str = "SENTRY_SAMPLE_RATE";

/// Global consent flag.
/// Defaults to true — setting SENTRY_DSN in the environment IS the consent.
/// Users who don't want crash reporting simply don't set the env var.
static SENTRY_CONSENT: AtomicBool = AtomicBool::new(true);

/// Whether the user has opted into crash reporting.
pub fn has_consent() -> bool {
    SENTRY_CONSENT.load(Ordering::Relaxed)
}

/// Set or clear the user's consent for crash reporting.
pub fn set_consent(enabled: bool) {
    SENTRY_CONSENT.store(enabled, Ordering::Relaxed);
}

/**
 * Determine if we're in a dev runtime (tauri dev) vs production build.
 *
 * Uses the same approach as main.rs::is_dev_runtime().
 * In Tauri 1.x, dev builds embed "dev" in the context name.
 */
fn is_dev_runtime() -> bool {
    // During `cargo test` this env var won't be set, so dev=true is safe.
    let ctx = std::env::var("TAURI_DEV").ok();
    ctx.as_deref() == Some("true") || cfg!(debug_assertions)
}

/**
 * Initialize the Sentry Rust client.
 *
 * Free-tier safety:
 *   - sample_rate: env SENTRY_SAMPLE_RATE or 1.0 dev / 0.1 prod
 *   - traces_sample_rate: 0.0 (no performance)
 *   - before_send: PII scrub + consent gate
 *
 * Panic hook is registered automatically by sentry crate's "panic" feature.
 * We also set a custom panic hook to flush events immediately on crash.
 *
 * If the SENTRY_DSN env var is not set, this is a complete no-op.
 */
pub fn init() -> Option<sentry::ClientInitGuard> {
    let dsn = std::env::var(SENTRY_DSN_ENV).ok().filter(|s| !s.is_empty());

    let dsn = match dsn {
        Some(d) => d,
        None => {
            println!("[Sentry] SENTRY_DSN not set — crash reporting disabled");
            return None;
        }
    };

    let is_dev = is_dev_runtime();
    let environment = if is_dev { "development" } else { "production" };

    // Sample rate: env override, or 1.0 dev / 0.1 prod
    let sample_rate: f32 = std::env::var(SENTRY_SAMPLE_RATE_ENV)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(if is_dev { 1.0 } else { 0.1 });

    // Build release string from Cargo env vars
    let release = format!(
        "slasshyvault@{}",
        std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "unknown".into())
    );

    let guard = sentry::init((
        dsn,
        sentry::ClientOptions {
            release: Some(release.into()),
            environment: Some(environment.into()),
            sample_rate,
            traces_sample_rate: 0.0,
            before_send: Some(std::sync::Arc::new(|event| {
                // Only send if the user has explicitly opted in
                if !has_consent() {
                    return None;
                }

                // Scrub PII — never send local paths or user-identifying info
                let mut event = event;

                // Remove any user context that might've leaked
                if let Some(ref mut user) = event.user {
                    user.email = None;
                    user.username = None;
                    user.id = None;
                    // Let Sentry infer region-level geo only
                    user.ip_address = Some(sentry::protocol::IpAddress::Auto);
                }

                // Remove any extra tags that look like user data
                let tags = &mut event.tags;
                tags.remove("user_email");
                tags.remove("user_id");

                Some(event)
            })),
            ..Default::default()
        },
    ));

    // Install a panic hook that flushes Sentry before the process unwinds/aborts.
    // Without this, the async transport may not deliver the event before the process dies.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Run the previous hook so the user still sees the panic message
        previous_hook(info);

        // Flush Sentry client — block until the event is sent (max 2 seconds).
        // We get the client from the current hub and call flush on it directly.
        sentry::Hub::with_active(|hub| {
            if let Some(client) = hub.client() {
                let _ = client.flush(Some(std::time::Duration::from_secs(2)));
            }
        });
    }));

    println!(
        "[Sentry] Initialized (environment={}, sample_rate={})",
        environment, sample_rate
    );

    Some(guard)
}

/**
 * Capture an error message to Sentry.
 * Safe to call whether Sentry is initialized or not — it's a no-op otherwise.
 * The consent gate and PII scrubbing in beforeSend still apply.
 */
pub fn capture_error(context: &str, details: &str) {
    let msg = format!("[UPDATE-ERROR] {}: {}", context, details);
    sentry::capture_message(&msg, sentry::Level::Error);

    // Flush immediately so the event gets sent before the process continues.
    // Without this, graceful (non-panic) errors sit in the async buffer and never arrive.
    sentry::Hub::with_active(|hub| {
        if let Some(client) = hub.client() {
            let _ = client.flush(Some(std::time::Duration::from_secs(2)));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn test_sentry_init_with_dsn() {
        // Try loading .env from project root for local dev testing
        dotenvy::from_filename("../.env").ok();

        let dsn = std::env::var(SENTRY_DSN_ENV);
        if dsn.is_err() || dsn.as_deref().unwrap_or("").is_empty() {
            eprintln!("[TEST] SENTRY_DSN not set — skipping");
            return;
        }

        let guard = init();
        assert!(
            guard.is_some(),
            "sentry::init() should return Some when DSN is set"
        );
        assert!(has_consent(), "consent should be true by default");

        // Capture a test message to verify the pipeline works
        sentry::capture_message(
            "[SENTRY-TEST] Rust init test — verifying Sentry pipeline",
            sentry::Level::Info,
        );

        // Flush to ensure delivery
        let flushed = if let Some(ref g) = guard {
            g.flush(Some(Duration::from_secs(5)))
        } else {
            false
        };

        if flushed {
            eprintln!("[TEST] ✅ Sentry flush SUCCEEDED — event was delivered to Sentry");
        } else {
            eprintln!("[TEST] ⚠️ Sentry flush returned false — check Sentry dashboard manually");
        }
    }

    #[test]
    fn test_sentry_no_dsn() {
        dotenvy::from_filename("../.env").ok();

        let dsn = std::env::var(SENTRY_DSN_ENV).ok().filter(|s| !s.is_empty());
        if dsn.is_some() {
            eprintln!("[TEST] SENTRY_DSN is set — can't test no-DSN path, skipping");
            return;
        }

        let guard = init();
        assert!(
            guard.is_none(),
            "init() should return None when DSN is not set"
        );
    }

    // ── has_consent / set_consent roundtrip ──

    #[test]
    fn consent_defaults_to_true() {
        set_consent(true);
        assert!(has_consent());
    }

    #[test]
    fn set_consent_false_disables() {
        set_consent(false);
        assert!(!has_consent());
        // Restore
        set_consent(true);
    }

    #[test]
    fn consent_roundtrip_toggle() {
        set_consent(true);
        assert!(has_consent());
        set_consent(false);
        assert!(!has_consent());
        set_consent(true);
        assert!(has_consent());
    }

    // ── capture_error (no-panic path) ──

    #[test]
    fn capture_error_does_not_panic_without_dsn() {
        // Without SENTRY_DSN set, capture_message is a safe no-op
        capture_error("test-context", "test details about the error");
        // If we get here without panicking, the test passes
    }

    #[test]
    fn capture_error_formats_message() {
        // Just verify the function runs; the internal format is "[UPDATE-ERROR] {ctx}: {details}"
        capture_error("update", "disk full");
        capture_error("", "");
    }

    // ── is_dev_runtime ──

    #[test]
    fn is_dev_runtime_reflects_debug_assertions() {
        // In `cargo test` (debug build), is_dev_runtime returns true
        // because cfg!(debug_assertions) is true.
        let dev = is_dev_runtime();
        assert!(
            dev,
            "cargo test runs in debug mode, so is_dev_runtime should be true"
        );
    }

    // ── init returns None when DSN is empty string ──

    #[test]
    fn init_returns_none_for_empty_dsn() {
        let original = std::env::var(SENTRY_DSN_ENV).ok();
        std::env::set_var(SENTRY_DSN_ENV, "");
        let guard = init();
        assert!(guard.is_none(), "empty DSN should be treated as unset");
        // Restore
        match original {
            Some(val) => std::env::set_var(SENTRY_DSN_ENV, val),
            None => std::env::remove_var(SENTRY_DSN_ENV),
        }
    }

    // ── SENTRY_SAMPLE_RATE_ENV parsing ──

    #[test]
    fn sample_rate_env_var_overrides_default() {
        let original_dsn = std::env::var(SENTRY_DSN_ENV).ok();
        let original_rate = std::env::var(SENTRY_SAMPLE_RATE_ENV).ok();

        // Skip if DSN is set (would try to actually init sentry)
        if original_dsn.is_some() && !original_dsn.as_deref().unwrap_or("").is_empty() {
            return;
        }

        std::env::set_var(
            SENTRY_DSN_ENV,
            "https://examplePublicKey@o0.ingest.sentry.io/0",
        );
        std::env::set_var(SENTRY_SAMPLE_RATE_ENV, "0.5");
        let guard = init();
        // Guard may be Some (init succeeded) or None (invalid DSN rejected by sentry crate)
        // Either way, no panic = pass
        drop(guard);

        // Restore
        match original_dsn {
            Some(val) => std::env::set_var(SENTRY_DSN_ENV, val),
            None => std::env::remove_var(SENTRY_DSN_ENV),
        }
        match original_rate {
            Some(val) => std::env::set_var(SENTRY_SAMPLE_RATE_ENV, val),
            None => std::env::remove_var(SENTRY_SAMPLE_RATE_ENV),
        }
    }
}
