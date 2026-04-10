/// Auto-Update Test Suite
/// This binary tests the complete auto-update flow using real GitHub API calls
/// to ensure the validation logic works correctly with actual release data.

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct GitHubRelease {
    tag_name: String,
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

const ALLOWED_REPO: &str = "SlasshyOverhere/StreamVault";

fn is_authorized_update_url(url: &url::Url, is_redirect: bool) -> bool {
    if url.scheme() != "https" {
        println!("[TEST-SECURITY] ❌ Rejected non-HTTPS URL: {}", url);
        return false;
    }

    let Some(host) = url.host_str() else {
        println!("[TEST-SECURITY] ❌ Rejected URL with no host: {}", url);
        return false
    };

    let path = url.path();
    println!("[TEST-SECURITY] Validating - Host: {}, Path: {}, Redirect: {}", host, path, is_redirect);

    // Allow GitHub main domain for release downloads
    if host == "github.com" {
        let allowed = path.starts_with(&format!("/{}", ALLOWED_REPO));
        if !allowed {
            println!("[TEST-SECURITY] ❌ GitHub path not authorized: {}", path);
        } else {
            println!("[TEST-SECURITY] ✅ GitHub path authorized");
        }
        return allowed;
    }

    // Allow GitHub API domain
    if host == "api.github.com" {
        let allowed = path.starts_with(&format!("/repos/{}", ALLOWED_REPO));
        if !allowed {
            println!("[TEST-SECURITY] ❌ API path not authorized: {}", path);
        } else {
            println!("[TEST-SECURITY] ✅ API path authorized");
        }
        return allowed;
    }

    // Allow GitHub's CDN domains for asset downloads
    if host == "objects.githubusercontent.com"
        || host.ends_with(".objects.githubusercontent.com")
        || host == "github-production-release-asset-2e65be.s3.amazonaws.com"
        || host.ends_with(".githubusercontent.com")
        || (host.ends_with(".amazonaws.com") && path.contains("/github-production-release-asset-")) {
        println!("[TEST-SECURITY] ✅ Allowing GitHub CDN host: {}", host);
        return true;
    }

    // For redirects, allow GitHub-related domains
    if is_redirect {
        let is_github_related = host.contains("github")
            || host.contains("githubusercontent")
            || host.contains("amazonaws.com");

        if is_github_related {
            println!("[TEST-SECURITY] ✅ Allowing GitHub-related redirect: {}", host);
            return true;
        }
    }

    println!("[TEST-SECURITY] ❌ Rejected: {} (redirect={})", url, is_redirect);
    false
}

async fn test_check_for_updates() -> Result<(), String> {
    println!("\n========================================");
    println!("TEST 1: Check for Updates (Real API Call)");
    println!("========================================\n");

    let repo = "SlasshyOverhere/StreamVault";
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);

    println!("API URL: {}", url);

    // Validate URL before making request
    let parsed_url = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    if !is_authorized_update_url(&parsed_url, false) {
        return Err("API URL validation failed!".to_string());
    }

    println!("✅ API URL validation passed\n");

    let client = reqwest::Client::builder()
        .user_agent("StreamVault-Updater-Test")
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    println!("Sending request to GitHub API...");
    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("❌ Network error: {}", e))?;

    let status = response.status();
    println!("Response status: {}\n", status);

    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("❌ API error ({}): {}", status, error_text));
    }

    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse JSON: {}", e))?;

    println!("Latest version: {}", release.tag_name);
    println!("Total assets: {}\n", release.assets.len());

    // Find Windows installer
    let installer_asset = release
        .assets
        .iter()
        .find(|a| {
            a.name.ends_with(".exe") || a.name.ends_with(".msi")
        });

    match installer_asset {
        Some(asset) => {
            println!("✅ Found Windows installer:");
            println!("   Name: {}", asset.name);
            println!("   Size: {:.2} MB", asset.size as f64 / 1024.0 / 1024.0);
            println!("   URL: {}\n", asset.browser_download_url);

            // Validate the download URL
            let download_url = url::Url::parse(&asset.browser_download_url)
                .map_err(|e| format!("Invalid download URL: {}", e))?;

            if !is_authorized_update_url(&download_url, false) {
                return Err(format!("❌ Download URL validation failed: {}", asset.browser_download_url));
            }

            println!("✅ Download URL validation passed\n");
            Ok(())
        },
        None => {
            println!("❌ No Windows installer (.exe/.msi) found in release!");
            println!("Available assets:");
            for asset in &release.assets {
                println!("   - {} ({})", asset.name, asset.browser_download_url);
            }
            Err("No Windows installer found".to_string())
        }
    }
}

async fn test_download_installer(download_url: String) -> Result<(), String> {
    println!("\n========================================");
    println!("TEST 2: Download Installer");
    println!("========================================\n");

    println!("Download URL: {}", download_url);

    let parsed_url = url::Url::parse(&download_url)
        .map_err(|e| format!("Invalid URL: {}", e))?;

    if !is_authorized_update_url(&parsed_url, false) {
        return Err("Download URL validation failed!".to_string());
    }

    println!("✅ Initial URL validation passed\n");

    // Set up redirect tracking
    let redirect_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let redirect_count_clone = redirect_count.clone();

    let custom_policy = reqwest::redirect::Policy::custom(move |attempt| {
        let count = redirect_count_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        println!("[REDIRECT #{}] From: {} → To: {}", count + 1, attempt.previous().last().unwrap_or(&attempt.url()), attempt.url());

        if !is_authorized_update_url(attempt.url(), true) {
            println!("❌ Redirect blocked by security policy\n");
            return attempt.error("Unauthorized redirect URL");
        }

        if attempt.previous().len() > 5 {
            println!("❌ Too many redirects (>5)\n");
            return attempt.error("Too many redirects");
        }

        println!("✅ Redirect allowed\n");
        attempt.follow()
    });

    let client = reqwest::Client::builder()
        .redirect(custom_policy)
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    println!("Starting download...");
    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("❌ Download failed: {}", e))?;

    let status = response.status();
    println!("Response status: {}", status);

    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("❌ Download error ({}): {}", status, error_text));
    }

    let total_size = response.content_length().unwrap_or(0);
    println!("File size: {:.2} MB", total_size as f64 / 1024.0 / 1024.0);

    // Download a small chunk to verify it works
    let bytes = response.bytes().await.map_err(|e| format!("❌ Read error: {}", e))?;
    println!("Downloaded {} bytes successfully", bytes.len());

    println!("\n✅ Download test PASSED!\n");
    Ok(())
}

async fn run_all_tests() -> Result<(), String> {
    println!("\n╔═══════════════════════════════════════════╗");
    println!("║     STREAMVAULT AUTO-UPDATE TEST SUITE                   ║");
    println!("╚═══════════════════════════════════════════╝\n");

    // Test 1: Check for updates
    match test_check_for_updates().await {
        Ok(_) => println!("✅ TEST 1 PASSED: Update check successful"),
        Err(e) => {
            println!("❌ TEST 1 FAILED: {}", e);
            return Err(e);
        }
    }

    // Fetch the actual release to get the dynamic download URL
    println!("\nFetching latest release to get actual download URL...");
    let repo = "SlasshyOverhere/StreamVault";
    let api_url = format!("https://api.github.com/repos/{}/releases/latest", repo);

    let client = reqwest::Client::builder()
        .user_agent("StreamVault-Updater-Test")
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    let response = client
        .get(&api_url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("❌ Failed to fetch release: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("❌ Failed to fetch release ({}): {}", status, error_text));
    }

    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse release: {}", e))?;

    let installer_asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with(".exe") || a.name.ends_with(".msi"))
        .ok_or("No Windows installer found in release")?;

    let download_url = installer_asset.browser_download_url.clone();
    println!("✅ Using real download URL from release: {}", download_url);

    // Test 2: Download installer
    match test_download_installer(download_url).await {
        Ok(_) => println!("✅ TEST 2 PASSED: Download successful"),
        Err(e) => {
            println!("❌ TEST 2 FAILED: {}", e);
            return Err(e);
        }
    }

    println!("\n╔═══════════════════════════════════════════╗");
    println!("║           ALL TESTS PASSED! ✅                            ║");
    println!("╚═══════════════════════════╝\n");

    Ok(())
}

#[tokio::main]
async fn main() {
    println!("Starting auto-update test suite...\n");

    match run_all_tests().await {
        Ok(_) => {
            println!("All tests completed successfully!");
            std::process::exit(0);
        }
        Err(e) => {
            eprintln!("\n❌ Test suite failed: {}", e);
            std::process::exit(1);
        }
    }
}
