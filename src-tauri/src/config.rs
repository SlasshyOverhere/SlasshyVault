use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::database::{get_app_data_dir, get_config_path};

/// Filename for the bundled MPV RAR archive in the repo
const BUNDLED_MPV_RAR_FILENAME: &str = "slasshyvault-mpv.rar";

/// Name of the temporary downloaded RAR file
const BUNDLED_MPV_RAR_TEMP_NAME: &str = "slasshyvault-mpv.rar";

/// GitHub repository slug and branch
const GITHUB_REPO: &str = "SlasshyOverhere/SlasshyVault";
const GITHUB_BRANCH: &str = "main";

/// Relative path to the bundled MPV archive in the repo
const BUNDLED_MPV_REPO_PATH: &str = "mpv-player/slasshyvault-mpv.rar";

/// Returns the download URL for the bundled MPV archive from the GitHub repo.
/// Uses media.githubusercontent.com to resolve Git LFS objects.
pub fn get_bundled_mpv_download_url() -> String {
    format!(
        "https://media.githubusercontent.com/media/{}/{}/{}",
        GITHUB_REPO, GITHUB_BRANCH, BUNDLED_MPV_REPO_PATH
    )
}

/// Returns the directory where bundled MPV is stored/extracted in app data
pub fn get_bundled_mpv_dir() -> PathBuf {
    get_app_data_dir().join("mpv_bundled")
}

/// Returns the temp path for the downloaded RAR file before extraction
pub fn get_bundled_mpv_rar_temp_path() -> PathBuf {
    get_bundled_mpv_dir().join(BUNDLED_MPV_RAR_TEMP_NAME)
}

/// Search for mpv.exe inside the extracted bundled directory (recursive)
pub fn get_bundled_mpv_path() -> PathBuf {
    let dir = get_bundled_mpv_dir();
    if !dir.exists() {
        return dir.join("mpv.exe");
    }
    find_mpv_recursive(&dir).unwrap_or_else(|| dir.join("mpv.exe"))
}

fn find_mpv_recursive(dir: &Path) -> Option<PathBuf> {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = find_mpv_recursive(&path) {
                    return Some(found);
                }
            } else if path.is_file() {
                let name = path.file_stem()?.to_str()?;
                if name.eq_ignore_ascii_case("mpv") || name.eq_ignore_ascii_case("slasshyvault-mpv") {
                    let ext = path.extension()?.to_str()?;
                    if ext.eq_ignore_ascii_case("exe") {
                        return Some(path);
                    }
                }
            }
        }
    }
    None
}

/// Check if bundled MPV executable exists in app data (after extraction)
pub fn bundled_mpv_exists() -> bool {
    get_bundled_mpv_path().exists()
}

/// Remove the entire installed bundled MPV directory (for reinstallation)
pub fn remove_bundled_mpv() -> Result<(), String> {
    let dir = get_bundled_mpv_dir();
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| format!("Failed to remove bundled MPV directory: {}", e))?;
        println!("[MPV-BUNDLED] Removed bundled MPV directory {:?}", dir);
    }
    Ok(())
}

/// Common locations where MPV might be installed on Windows
const MPV_SEARCH_PATHS: &[&str] = &[
    // Common installation directories
    "C:\\Program Files\\mpv\\mpv.exe",
    "C:\\Program Files (x86)\\mpv\\mpv.exe",
    "C:\\Program Files\\mpv.net\\mpv.exe",
    "C:\\Program Files (x86)\\mpv.net\\mpv.exe",
    // Scoop installations
    "C:\\Users\\*\\scoop\\apps\\mpv\\current\\mpv.exe",
    "C:\\Users\\*\\scoop\\shims\\mpv.exe",
    // Chocolatey
    "C:\\ProgramData\\chocolatey\\bin\\mpv.exe",
    // Portable installations (common locations)
    "C:\\mpv\\mpv.exe",
    "C:\\Tools\\mpv\\mpv.exe",
    "D:\\mpv\\mpv.exe",
    "D:\\Tools\\mpv\\mpv.exe",
    // User profile locations
    "C:\\Users\\*\\AppData\\Local\\Programs\\mpv\\mpv.exe",
    "C:\\Users\\*\\mpv\\mpv.exe",
];

/// Search for mpv.exe on the system
/// Returns the path if found, None otherwise
pub fn find_mpv_executable() -> Option<String> {
    println!("[MPV] Searching for mpv.exe on the system...");

    // First, check bundled MPV (so the app prefers its own copy)
    if bundled_mpv_exists() {
        let path = get_bundled_mpv_path().to_string_lossy().to_string();
        println!("[MPV] Found bundled mpv at: {}", path);
        return Some(path);
    }

    // Then, check if mpv is in PATH (fastest check)
    let mut where_cmd = Command::new("where");
    where_cmd.arg("mpv.exe");
    apply_hidden_process_flags(&mut where_cmd);
    if let Ok(output) = where_cmd.output() {
        if output.status.success() {
            if let Ok(path) = String::from_utf8(output.stdout) {
                let path = path.lines().next().unwrap_or("").trim();
                if !path.is_empty() && Path::new(path).exists() {
                    println!("[MPV] Found mpv in PATH: {}", path);
                    return Some(path.to_string());
                }
            }
        }
    }

    // Check common installation paths
    for pattern in MPV_SEARCH_PATHS {
        if pattern.contains('*') {
            // Handle wildcard patterns (for user-specific paths)
            if let Some(found) = expand_and_check_pattern(pattern) {
                println!("[MPV] Found mpv at: {}", found);
                return Some(found);
            }
        } else if Path::new(pattern).exists() {
            println!("[MPV] Found mpv at: {}", pattern);
            return Some(pattern.to_string());
        }
    }

    // Deep search in Program Files directories
    let search_roots = [
        "C:\\Program Files",
        "C:\\Program Files (x86)",
        "C:\\",
        "D:\\",
    ];

    for root in search_roots {
        if let Some(found) = search_directory_for_mpv(root, 3) {
            println!("[MPV] Found mpv via deep search: {}", found);
            return Some(found);
        }
    }

    println!("[MPV] mpv.exe not found on the system");
    None
}

pub fn apply_hidden_process_flags(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
}

/// Expand wildcard patterns and check if mpv exists
fn expand_and_check_pattern(pattern: &str) -> Option<String> {
    // Handle patterns like "C:\Users\*\scoop\..."
    if let Some(star_pos) = pattern.find('*') {
        let prefix = &pattern[..star_pos];
        let suffix = &pattern[star_pos + 1..];

        if let Ok(entries) = fs::read_dir(prefix) {
            for entry in entries.filter_map(|e| e.ok()) {
                let full_path = format!("{}{}", entry.path().display(), suffix);
                let path = Path::new(&full_path);
                if path.exists() {
                    let canonical = path.canonicalize().ok()?;
                    return Some(canonical.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

/// Recursively search a directory for mpv.exe (with depth limit)
fn search_directory_for_mpv(dir: &str, max_depth: u32) -> Option<String> {
    if max_depth == 0 {
        return None;
    }

    let dir_path = Path::new(dir);
    if !dir_path.exists() || !dir_path.is_dir() {
        return None;
    }

    // Check if mpv.exe is directly in this directory
    let mpv_path = dir_path.join("mpv.exe");
    if mpv_path.exists() {
        return Some(mpv_path.to_string_lossy().to_string());
    }

    // Also check for mpv/mpv.exe subdirectory
    let mpv_subdir = dir_path.join("mpv").join("mpv.exe");
    if mpv_subdir.exists() {
        return Some(mpv_subdir.to_string_lossy().to_string());
    }

    // Search subdirectories (only look in likely directories to avoid slow scans)
    let likely_subdirs = [
        "mpv", "mpv.net", "video", "media", "players", "tools", "portable", "apps",
    ];

    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let entry_name = entry.file_name().to_string_lossy().to_lowercase();

            // Only recurse into likely directories or if at top level
            if max_depth >= 2 || likely_subdirs.iter().any(|&s| entry_name.contains(s)) {
                if let Some(found) =
                    search_directory_for_mpv(&entry.path().to_string_lossy(), max_depth - 1)
                {
                    return Some(found);
                }
            }
        }
    }

    None
}

/// Validates an executable path to ensure it points to the expected binary.
/// This prevents arbitrary command execution vulnerabilities where a malicious
/// user might set the path to a different executable (like cmd.exe or calc.exe).
pub fn validate_executable_path(path: &str, expected_name: &str) -> Result<(), String> {
    if path.is_empty() {
        return Ok(());
    }

    let path = Path::new(path);
    let canonical = path.canonicalize().map_err(|e| format!("Invalid executable path: {}", e))?;

    // Extract the file stem (filename without extension)
    let file_stem = canonical
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("Invalid executable path: {}", path.display()))?;

    let stem_lower = file_stem.to_lowercase();
    let expected_lower = expected_name.to_lowercase();

    // Also accept "slasshyvault-mpv" when expecting "mpv" (bundled variant)
    let valid = stem_lower == expected_lower
        || (expected_lower == "mpv" && stem_lower == "slasshyvault-mpv");

    if !valid {
        return Err(format!(
            "Security violation: Executable name must be '{}' or '{}.exe', but got '{}'",
            expected_name, expected_name, file_stem
        ));
    }

    Ok(())
}

/// Auto-detect and save MPV path if not already configured
pub fn auto_detect_mpv(config: &mut Config) -> Option<String> {
    // If already configured and exists, use it
    if let Some(ref path) = config.mpv_path {
        if Path::new(path).exists() {
            println!("[MPV] Using configured path: {}", path);
            return Some(path.clone());
        }
        println!(
            "[MPV] Configured path doesn't exist: {}, searching...",
            path
        );
    }

    // Auto-detect
    if let Some(found_path) = find_mpv_executable() {
        config.mpv_path = Some(found_path.clone());
        // Save to config file
        if let Err(e) = save_config(config) {
            println!(
                "[MPV] Warning: Failed to save detected path to config: {}",
                e
            );
        } else {
            println!("[MPV] Saved detected path to config: {}", found_path);
        }
        return Some(found_path);
    }

    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub mpv_path: Option<String>,
    #[serde(default)]
    pub vlc_path: Option<String>,
    #[serde(default)]
    pub ffprobe_path: Option<String>,
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
    #[serde(default)]
    pub tmdb_api_key: Option<String>,
    #[serde(default)]
    pub omdb_api_key: Option<String>,
    // Cloud cache settings
    #[serde(default)]
    pub cloud_cache_enabled: bool,
    #[serde(default)]
    pub cloud_cache_dir: Option<String>,
    #[serde(default = "default_cloud_cache_max_mb")]
    pub cloud_cache_max_mb: u32,
    #[serde(default = "default_cloud_cache_expiry_hours")]
    pub cloud_cache_expiry_hours: u32,
    // Cloud auto-scan interval in minutes (default 5 minutes)
    #[serde(default = "default_cloud_scan_interval_minutes")]
    pub cloud_scan_interval_minutes: u32,
    #[serde(default = "default_zip_indexing_enabled")]
    pub zip_indexing_enabled: bool,
    #[serde(default)]
    pub zip_cache_dir: Option<String>,
    #[serde(default = "default_zip_cache_max_gb")]
    pub zip_cache_max_gb: u32,
    #[serde(default = "default_zip_cache_expiry_days")]
    pub zip_cache_expiry_days: u32,
    #[serde(default = "default_notifications_enabled")]
    pub notifications_enabled: bool,
    // Dev mode: override the backend URL (e.g. http://localhost:3001)
    // All auth, TMDB proxy, and WebSocket URLs are derived from this
    #[serde(default)]
    pub dev_backend_url: Option<String>,
}

fn default_cloud_cache_max_mb() -> u32 {
    1024 // 1GB per movie
}

fn default_cloud_cache_expiry_hours() -> u32 {
    24 // Clean up after 24 hours
}

fn default_cloud_scan_interval_minutes() -> u32 {
    5 // Scan every 5 minutes by default
}

fn default_zip_indexing_enabled() -> bool {
    true
}

fn default_zip_cache_max_gb() -> u32 {
    20
}

fn default_zip_cache_expiry_days() -> u32 {
    7
}

fn default_notifications_enabled() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Config {
            mpv_path: None,
            vlc_path: None,
            ffprobe_path: None,
            ffmpeg_path: None,
            tmdb_api_key: None,
            omdb_api_key: None,
            cloud_cache_enabled: false,
            cloud_cache_dir: None,
            cloud_cache_max_mb: 1024,
            cloud_cache_expiry_hours: 24,
            cloud_scan_interval_minutes: 5,
            zip_indexing_enabled: true,
            zip_cache_dir: None,
            zip_cache_max_gb: 20,
            zip_cache_expiry_days: 7,
            notifications_enabled: true,
            dev_backend_url: None,
        }
    }
}

pub fn load_config() -> Result<Config, Box<dyn std::error::Error>> {
    let config_path = get_config_path();

    if !std::path::Path::new(&config_path).exists() {
        let default_config = Config::default();
        save_config(&default_config)?;
        return Ok(default_config);
    }

    let mut file = match fs::File::open(&config_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[CONFIG] Failed to open config file: {}. Recreating with defaults.", e);
            heal_corrupted_config(&config_path);
            return Ok(Config::default());
        }
    };
    let mut contents = String::new();
    if file.read_to_string(&mut contents).is_err() {
        eprintln!("[CONFIG] Failed to read config file. Recreating with defaults.");
        heal_corrupted_config(&config_path);
        return Ok(Config::default());
    }

    let mut config: Config = match serde_json::from_str(&contents) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[CONFIG] Corrupted config ({:?}), backing up and recreating with defaults.", e);
            heal_corrupted_config(&config_path);
            Config::default()
        }
    };
    // Apply validation bounds
    config.cloud_cache_max_mb = config.cloud_cache_max_mb.min(100000);
    config.zip_cache_max_gb = config.zip_cache_max_gb.min(500);
    config.cloud_scan_interval_minutes = config.cloud_scan_interval_minutes.max(1);
    Ok(config)
}

fn heal_corrupted_config(config_path: &str) {
    let backup = format!("{}.corrupted", config_path);
    let _ = fs::rename(config_path, &backup);
    eprintln!("[CONFIG] Corrupted config backed up to: {}", backup);
    if let Err(e) = save_config(&Config::default()) {
        eprintln!("[CONFIG] Failed to create default config: {}", e);
    } else {
        eprintln!("[CONFIG] Created fresh default config.");
    }
}

pub fn save_config(config: &Config) -> Result<(), Box<dyn std::error::Error>> {
    let config_path = get_config_path();

    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(&config_path).parent() {
        fs::create_dir_all(parent)?;
    }

    let json = serde_json::to_string_pretty(config)?;
    let mut file = fs::File::create(&config_path)?;
    file.write_all(json.as_bytes())?;

    Ok(())
}
