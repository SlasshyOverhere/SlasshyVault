// MPV Progress Tracking Module
// Uses a watch-later style approach with a temp file that MPV updates via script

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

const AUTO_MARK_WATCHED_THRESHOLD_RATIO: f64 = 0.93;

/// Calculate dynamic demuxer cache size for a given target buffer duration.
/// Falls back to 200 MiB if file size or duration is unknown.
fn calculate_dynamic_demuxer_bytes(file_size_bytes: Option<i64>, duration_seconds: Option<f64>, target_secs: f64) -> String {
    const MIN_BYTES: u64 = 50 * 1024 * 1024;       // 50 MiB floor
    const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;  // 2 GiB ceiling
    const FALLBACK: &str = "200MiB";

    let (Some(size), Some(duration)) = (file_size_bytes, duration_seconds) else {
        return FALLBACK.to_string();
    };
    if duration <= 0.0 || size <= 0 {
        return FALLBACK.to_string();
    }

    let bytes_per_sec = (size as f64) / duration;
    let target = (bytes_per_sec * target_secs) as u64;
    let clamped = target.clamp(MIN_BYTES, MAX_BYTES);

    format!("{}MiB", clamped / (1024 * 1024))
}

/// Progress info saved/loaded from temp file
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MpvProgressInfo {
    pub position: f64,
    pub duration: f64,
    pub paused: bool,
    pub eof_reached: bool,
    pub quit_time: Option<i64>,
}

/// Get the path to the progress tracking directory
fn get_progress_dir() -> PathBuf {
    let app_data = crate::database::get_app_data_dir();
    app_data.join("mpv_progress")
}

/// Get progress file path for a media item
fn get_progress_file_path(media_id: i64) -> PathBuf {
    get_progress_dir().join(format!("{}.json", media_id))
}

/// Get the Lua script content that MPV will use to save progress
fn get_lua_script_content(progress_file: &str) -> String {
    // Use forward slashes for Lua to avoid backslash escaping hell
    let clean_path = progress_file.replace("\\", "/");

    format!(
        r#"
-- SlasshyVault Progress Tracker for MPV
-- Saves playback position to a JSON file periodically and on quit

local progress_file = "{}"
local save_interval = 2 -- seconds

local last_duration = 0
local last_position = 0

local function get_progress_data()
    local pos = mp.get_property_number("time-pos")
    local duration = mp.get_property_number("duration")
    local paused = mp.get_property_bool("pause") or false
    local eof = mp.get_property_bool("eof-reached") or false
    
    -- Robust duration handling
    if duration and duration > 0 then
        last_duration = duration
    end
    local d_to_save = duration
    if not d_to_save or d_to_save <= 0 then d_to_save = last_duration end
    
    -- Robust position handling
    -- Update last_position only if we have a valid current position
    if pos and pos > 0 then
        last_position = pos
    end
    
    -- If current position is missing (e.g. during shutdown), use last known
    local p_to_save = pos
    if not p_to_save or p_to_save <= 0 then p_to_save = last_position end
    
    -- Sanity check: don't save position > duration
    if d_to_save > 0 and p_to_save > d_to_save then
        p_to_save = d_to_save
    end
    
    return string.format(
        '{{"position":%.3f,"duration":%.3f,"paused":%s,"eof_reached":%s,"quit_time":%d}}',
        p_to_save,
        d_to_save,
        paused and "true" or "false",
        eof and "true" or "false",
        os.time()
    )
end

local function save_progress()
    -- Get data (will use fallbacks if properties are unavailable)
    local duration = mp.get_property_number("duration") or last_duration
    
    -- Safety: never save if we don't know the duration yet
    if not duration or duration <= 0 then return end

    local data = get_progress_data()
    local file = io.open(progress_file, "w")
    if file then
        file:write(data)
        file:close()
    end
end

-- Periodic save timer
local timer = mp.add_periodic_timer(save_interval, save_progress)

-- Save on pause/unpause
mp.observe_property("pause", "bool", function(name, value)
    save_progress()
end)

-- Save on seek
mp.register_event("seek", save_progress)

-- Save on quit - most important!
mp.register_event("shutdown", function()
    -- During shutdown, properties might be unavailable, so our 
    -- get_progress_data() function will rely on last_position/last_duration
    save_progress()
end)

-- Save when file ends
mp.register_event("end-file", function(event)
    save_progress()
end)

-- Initial save
mp.register_event("file-loaded", function()
    -- Wait a bit for duration to be available
    mp.add_timeout(1, save_progress)
end)

mp.msg.info("SlasshyVault progress tracker loaded.")
"#,
        clean_path
    )
}

/// Create the Lua script file for MPV
fn create_lua_script(media_id: i64) -> Result<PathBuf, String> {
    let progress_dir = get_progress_dir();
    fs::create_dir_all(&progress_dir)
        .map_err(|e| format!("Failed to create progress dir: {}", e))?;

    let script_path = progress_dir.join(format!("tracker_{}.lua", media_id));
    let progress_file = get_progress_file_path(media_id);

    let script_content = get_lua_script_content(&progress_file.to_string_lossy());

    let mut file = fs::File::create(&script_path)
        .map_err(|e| format!("Failed to create Lua script: {}", e))?;
    file.write_all(script_content.as_bytes())
        .map_err(|e| format!("Failed to write Lua script: {}", e))?;

    // Restrict file permissions: owner read/write only
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o600)) {
            println!("[MPV] Warning: Failed to set Lua script permissions: {}", e);
        }
    }

    Ok(script_path)
}

/// Read last saved progress for a media item
pub fn read_mpv_progress(media_id: i64) -> Option<MpvProgressInfo> {
    let progress_file = get_progress_file_path(media_id);

    if !progress_file.exists() {
        return None;
    }

    let content = fs::read_to_string(&progress_file).ok()?;
    serde_json::from_str(&content).ok()
}

/// Clear saved progress for a media item
pub fn clear_mpv_progress(media_id: i64) {
    let progress_file = get_progress_file_path(media_id);
    let script_file = get_progress_dir().join(format!("tracker_{}.lua", media_id));

    let _ = fs::remove_file(progress_file);
    let _ = fs::remove_file(script_file);
}

/// Result of launching MPV with tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MpvLaunchResult {
    pub success: bool,
    pub error: Option<String>,
    pub final_position: Option<f64>,
    pub final_duration: Option<f64>,
    pub completed: bool,
}

/// Cloud cache settings for MPV disk caching
#[derive(Debug, Clone)]
pub struct CloudCacheSettings {
    pub enabled: bool,
    pub cache_dir: String,
    pub max_size_mb: u32,
}

/// Check if a cached video file exists for a media item
pub fn get_cached_video_path(cache_dir: &str, media_id: i64) -> Option<String> {
    let media_cache_dir = std::path::Path::new(cache_dir).join(format!("media_{}", media_id));

    if !media_cache_dir.exists() {
        return None;
    }

    // Look for video file in cache directory
    if let Ok(entries) = std::fs::read_dir(&media_cache_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() {
                // Check if it's a video file (has reasonable size)
                if let Ok(metadata) = path.metadata() {
                    // Consider files > 1MB as valid cached videos
                    if metadata.len() > 1_000_000 {
                        return Some(path.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    None
}

/// Launch MPV with progress tracking
/// `auth_header` is optional and used for cloud files (e.g., "Authorization: Bearer xxx")
/// `cache_settings` is optional and enables disk-based caching for cloud streams
pub fn launch_mpv_with_tracking(
    mpv_path: &str,
    file_or_url: &str,
    media_id: i64,
    display_title: Option<&str>,
    start_position: f64,
    auth_header: Option<&str>,
    cache_settings: Option<&CloudCacheSettings>,
    audio_language: Option<&str>,
    subtitle_language: Option<&str>,
    ipc_server: Option<&str>,
    file_size_bytes: Option<i64>,
    duration_seconds: Option<f64>,
) -> Result<u32, String> {
    crate::config::validate_executable_path(mpv_path, "mpv")?;

    // Remove stale progress from previous sessions so frontend startup checks
    // only react to the new MPV instance once it has actually loaded media.
    clear_mpv_progress(media_id);

    println!("[MPV] ========== LAUNCHING MPV ==========");
    println!("[MPV] Media ID: {}", media_id);
    println!("[MPV] MPV Path: {}", mpv_path);
    println!("[MPV] Source: {}", file_or_url);
    println!("[MPV] Is URL: {}", file_or_url.starts_with("http"));
    println!("[MPV] Has auth header: {}", auth_header.is_some());
    println!(
        "[MPV] Disk cache: {}",
        cache_settings.map(|c| c.enabled).unwrap_or(false)
    );
    println!("[MPV] Start position: {:.2}s", start_position);
    println!(
        "[MPV] Audio language preference: {}",
        audio_language.unwrap_or("MPV default")
    );
    println!(
        "[MPV] Subtitle language preference: {}",
        subtitle_language.unwrap_or("MPV default")
    );
    println!(
        "[MPV] Display title: {}",
        display_title.unwrap_or("MPV default")
    );

    // Only verify file exists for local files (not URLs)
    let is_url = file_or_url.starts_with("http://") || file_or_url.starts_with("https://");
    if !is_url && !std::path::Path::new(file_or_url).exists() {
        return Err(format!("File does not exist: {}", file_or_url));
    }

    // Check if we have a cached version of this cloud video
    let (actual_source, use_cached) = if is_url {
        if let Some(cache) = cache_settings {
            if cache.enabled && !cache.cache_dir.is_empty() {
                if let Some(cached_path) = get_cached_video_path(&cache.cache_dir, media_id) {
                    println!("[MPV] Using cached video: {}", cached_path);
                    (cached_path, true)
                } else {
                    (file_or_url.to_string(), false)
                }
            } else {
                (file_or_url.to_string(), false)
            }
        } else {
            (file_or_url.to_string(), false)
        }
    } else {
        (file_or_url.to_string(), false)
    };
    let is_local_zip_proxy =
        actual_source.starts_with("http://127.0.0.1:") && actual_source.ends_with("/stream");
    let is_local_url_proxy =
        actual_source.starts_with("http://127.0.0.1:") || actual_source.starts_with("http://localhost:");

    // Create the Lua tracking script
    let script_path = create_lua_script(media_id)?;
    println!("[MPV] Created tracking script at: {:?}", script_path);

    // Build MPV command
    let mut cmd = std::process::Command::new(mpv_path);

    // Add the tracking script
    let script_arg = format!("--script={}", script_path.to_string_lossy());
    cmd.arg(&script_arg);

    if let Some(title) = display_title
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        cmd.arg(format!("--force-media-title={}", title));
    }

    if is_url {
        cmd.arg("--force-window=immediate");
    }

    // Add start position if resuming
    if start_position > 0.0 {
        cmd.arg(format!("--start={}", start_position as i64));
    }

    // Security enhancement: Validate user-provided audio language parameters
    if let Some(language) = audio_language.filter(|value| !value.trim().is_empty()) {
        let trimmed = language.trim();
        if let Some(track_id) = trimmed.strip_prefix("aid:") {
            let id = track_id.trim();
            // Validate track_id is alphanumeric (auto, no, or numeric)
            if id == "auto" || id == "no" || id.chars().all(|c| c.is_ascii_digit()) {
                cmd.arg(format!("--aid={}", id));
            } else {
                println!("[MPV] Security warning: Rejected invalid aid parameter");
            }
        } else {
            // Validate alang is alphanumeric and specific separators
            if trimmed
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == ',' || c == '_')
            {
                cmd.arg(format!("--alang={}", trimmed));
            } else {
                println!("[MPV] Security warning: Rejected invalid alang parameter");
            }
        }
    }

    if let Some(language) = subtitle_language.filter(|value| !value.trim().is_empty()) {
        let trimmed = language.trim();
        if let Some(track_id) = trimmed.strip_prefix("sid:") {
            let id = track_id.trim();
            if id == "auto" || id == "no" || id.chars().all(|c| c.is_ascii_digit()) {
                cmd.arg(format!("--sid={}", id));
            } else {
                println!("[MPV] Security warning: Rejected invalid sid parameter");
            }
        } else {
            if trimmed
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == ',' || c == '_')
            {
                cmd.arg(format!("--slang={}", trimmed));
            } else {
                println!("[MPV] Security warning: Rejected invalid slang parameter");
            }
        }
    }

    // Security enhancement: Validate user-provided IPC server path
    if let Some(ipc_path) = ipc_server.filter(|value| !value.trim().is_empty()) {
        let path = ipc_path.trim();
        // Allow valid path characters (alphanumeric, slash, backslash, dot, hyphen, underscore, colon for Windows drives/pipes)
        if path.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || c == '/'
                || c == '\\'
                || c == '.'
                || c == '-'
                || c == '_'
                || c == ':'
        }) {
            cmd.arg(format!("--input-ipc-server={}", path));
        } else {
            println!("[MPV] Security warning: Rejected invalid ipc server path");
        }
    }

    // Add HTTP headers for cloud streaming (Google Drive auth) - only if streaming from URL.
// MPV reliably applies the inline form here; the temp header file path was not being honored.
    if !use_cached {
        if let Some(header) = auth_header {
            cmd.arg(format!("--http-header-fields={}", header));
            println!("[MPV] Added inline HTTP header for authentication");
        }
    }

    // Options
    cmd.arg("--save-position-on-quit=no");

    // For URLs (not cached), add streaming/caching options
    if is_url && !use_cached {
        cmd.arg("--keep-open=yes");
        // Longer timeout for any localhost-backed proxy (remote proxy, ZIP proxy, or direct local proxy URL)
        if is_local_zip_proxy || is_local_url_proxy {
            cmd.arg("--network-timeout=120");
        } else {
            cmd.arg("--network-timeout=30");
        }

        if is_local_zip_proxy {
            cmd.arg("--cache-pause=no");
            cmd.arg("--cache-pause-wait=0");
        } else {
            cmd.arg("--cache-pause-wait=10");
        }

        // Check if disk caching is enabled - use stream-record for persistent caching
        if let Some(cache) = cache_settings {
            if cache.enabled && !cache.cache_dir.is_empty() {
                // Create media-specific cache subdirectory
                let media_cache_dir =
                    std::path::Path::new(&cache.cache_dir).join(format!("media_{}", media_id));

                if std::fs::create_dir_all(&media_cache_dir).is_ok() {
                    let cache_file = media_cache_dir.join("video.mp4");
                    if !cache_file.exists() {
                        cmd.arg(format!("--stream-record={}", cache_file.to_string_lossy()));
                        println!("[MPV] Recording stream to: {}", cache_file.display());
                    }

                    println!(
                        "[MPV] Disk cache enabled: {} (max {}MB)",
                        media_cache_dir.display(),
                        cache.max_size_mb
                    );
                } else {
                    println!("[MPV] Warning: Failed to create cache dir: {}", media_cache_dir.display());
                }
            }
        }

        // Always set cache options for URL sources
        cmd.arg("--cache=yes");
        if is_local_zip_proxy {
            let dynamic_bytes = calculate_dynamic_demuxer_bytes(file_size_bytes, duration_seconds, 120.0);
            cmd.arg(format!("--demuxer-max-bytes={}", dynamic_bytes));
            // Back buffer: ~30 seconds of video
            let back_bytes = calculate_dynamic_demuxer_bytes(
                file_size_bytes,
                duration_seconds,
                30.0,
            );
            cmd.arg(format!("--demuxer-max-back-bytes={}", back_bytes));
            cmd.arg("--demuxer-readahead-secs=30");
            println!("[MPV] Using dynamic cache profile for ZIP proxy (forward={}, back={})", dynamic_bytes, back_bytes);
        } else {
            cmd.arg("--demuxer-max-bytes=500MiB");
            cmd.arg("--demuxer-max-back-bytes=100MiB");
        }
    }

    // For .part files (progressive download), enable cache so MPV can handle the growing file
    if !is_url && file_or_url.ends_with(".part") {
        cmd.arg("--cache=yes");
        cmd.arg("--demuxer-max-bytes=150MiB");
        cmd.arg("--demuxer-max-back-bytes=30MiB");
        cmd.arg("--demuxer-readahead-secs=180");
        cmd.arg("--cache-pause=no");
        println!("[MPV] Progressive playback mode: caching enabled for .part file");
    }

    // Security enhancement: Add the -- separator to prevent argument injection
    cmd.arg("--");

    // Add the file/URL to play
    cmd.arg(&actual_source);

    // Debug: log the program name only (not full args which may contain tokens via header file paths)
    #[cfg(debug_assertions)]
    println!("[MPV] Command program: {:?}", cmd.get_program());

    // Hide console window on Windows - but keep stderr/stdout for debugging
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    // Let MPV inherit stdout/stderr so we can see errors in the console
    cmd.stdout(std::process::Stdio::inherit());
    cmd.stderr(std::process::Stdio::inherit());

    // Spawn MPV process
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start MPV: {}", e))?;

    let pid = child.id();
    println!("[MPV] Started with PID: {}", pid);

    Ok(pid)
}

/// Check if MPV process is still running
pub fn is_mpv_running(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };

        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if handle == 0 {
                return false;
            }
            let result = WaitForSingleObject(handle, 0);
            CloseHandle(handle);
            result == WAIT_TIMEOUT
        }
    }

    #[cfg(not(windows))]
    {
        use std::process::Command;
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Monitor MPV playback and update database when it exits
/// This should be called in a background thread after launching MPV
pub fn monitor_mpv_and_save_progress(
    db: &crate::database::Database,
    media_id: i64,
    pid: u32,
) -> MpvLaunchResult {
    println!(
        "[MPV] Monitoring MPV process {} for media {}",
        pid, media_id
    );

    // Wait for MPV to exit
    while is_mpv_running(pid) {
        std::thread::sleep(Duration::from_millis(500));

        // Periodically check progress and save to database
        if let Some(progress) = read_mpv_progress(media_id) {
            if progress.duration > 0.0 {
                // Save to database
                if let Err(e) = db.update_progress(media_id, progress.position, progress.duration) {
                    println!("[MPV] Failed to update progress during playback: {}", e);
                }
            }
        }
    }

    // MPV has exited - give it a moment to flush the final save
    std::thread::sleep(Duration::from_millis(300));

    // Read final progress
    let final_progress = read_mpv_progress(media_id);

    let result = if let Some(progress) = final_progress {
        println!(
            "[MPV] Final progress: {:.2}s / {:.2}s (EOF: {})",
            progress.position, progress.duration, progress.eof_reached
        );

        // Save final progress to database, but ONLY if we have a valid duration
        // This prevents overwriting valid progress with 0s if MPV crashed or didn't load the file
        if progress.duration > 0.0 {
            if let Err(e) = db.update_progress(media_id, progress.position, progress.duration) {
                println!("[MPV] Failed to save final progress: {}", e);
            }
        } else {
            println!("[MPV] Warning: Invalid duration (0.0), skipping final DB update to preserve existing data");
        }

        let completed = if progress.duration > 0.0 {
            (progress.position / progress.duration) > AUTO_MARK_WATCHED_THRESHOLD_RATIO
                || progress.eof_reached
        } else {
            false
        };

        MpvLaunchResult {
            success: true,
            error: None,
            final_position: Some(progress.position),
            final_duration: Some(progress.duration),
            completed,
        }
    } else {
        println!("[MPV] No progress data found after MPV exit");
        MpvLaunchResult {
            success: true,
            error: None,
            final_position: None,
            final_duration: None,
            completed: false,
        }
    };

    // Clean up the Lua script (keep progress file for debugging)
    let script_file = get_progress_dir().join(format!("tracker_{}.lua", media_id));
    let _ = fs::remove_file(script_file);

    result
}

/// Poll for MPV progress (for real-time updates if needed)
pub fn poll_mpv_progress(media_id: i64) -> Option<MpvProgressInfo> {
    read_mpv_progress(media_id)
}

// ==================== WATCH TOGETHER SYNC ====================

/// Get the path for Watch Together sync files
fn get_sync_dir() -> PathBuf {
    let app_data = crate::database::get_app_data_dir();
    app_data.join("wt_sync")
}

/// Get sync command file path (for sending commands TO MPV)
fn get_sync_command_file(session_id: &str) -> PathBuf {
    get_sync_dir().join(format!("cmd_{}.json", session_id))
}

/// Get sync event file path (for receiving events FROM MPV)
fn get_sync_event_file(session_id: &str) -> PathBuf {
    get_sync_dir().join(format!("evt_{}.json", session_id))
}

/// Sync event from MPV
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MpvSyncEvent {
    pub event_type: String, // "play", "pause", "seek"
    pub position: f64,
    pub timestamp: i64,
}

/// Sync command to MPV
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MpvSyncCommand {
    pub action: String, // "play", "pause", "seek"
    pub position: f64,
    pub processed: bool,
}

/// Get the Lua script content for Watch Together sync mode
fn get_sync_lua_script_content(
    progress_file: &str,
    event_file: &str,
    command_file: &str,
) -> String {
    let clean_progress = progress_file.replace("\\", "/");
    let clean_event = event_file.replace("\\", "/");
    let clean_command = command_file.replace("\\", "/");

    format!(
        r#"
-- SlasshyVault Watch Together Sync Script for MPV
-- Handles bidirectional sync: captures user actions and applies remote commands

local progress_file = "{}"
local event_file = "{}"
local command_file = "{}"
local save_interval = 2
local command_check_interval = 0.5

local last_duration = 0
local last_position = 0
local ignore_next_event = false
local last_command_time = 0

-- JSON encode helper (simple implementation)
local function json_encode(data)
    if type(data) == "table" then
        local result = "{{"
        local first = true
        for k, v in pairs(data) do
            if not first then result = result .. "," end
            result = result .. '"' .. k .. '":'
            if type(v) == "string" then
                result = result .. '"' .. v .. '"'
            elseif type(v) == "number" then
                result = result .. tostring(v)
            elseif type(v) == "boolean" then
                result = result .. (v and "true" or "false")
            end
            first = false
        end
        return result .. "}}"
    end
    return "{{}}"
end

-- Write sync event to file
local function write_event(event_type, position)
    if ignore_next_event then
        ignore_next_event = false
        return
    end

    local data = json_encode({{
        event_type = event_type,
        position = position or mp.get_property_number("time-pos") or 0,
        timestamp = os.time()
    }})

    local file = io.open(event_file, "w")
    if file then
        file:write(data)
        file:close()
    end
end

-- Read and process sync command from file
local function check_command()
    local file = io.open(command_file, "r")
    if not file then return end

    local content = file:read("*all")
    file:close()

    if not content or content == "" then return end

    -- Simple JSON parse for our command format
    local action = content:match('"action"%s*:%s*"([^"]+)"')
    local position = content:match('"position"%s*:%s*([%d%.]+)')
    local processed = content:match('"processed"%s*:%s*true')

    if processed then return end
    if not action then return end

    position = tonumber(position) or 0

    -- Mark as processed
    local new_content = content:gsub('"processed"%s*:%s*false', '"processed":true')
    local wfile = io.open(command_file, "w")
    if wfile then
        wfile:write(new_content)
        wfile:close()
    end

    -- Apply the command
    ignore_next_event = true

    if action == "play" then
        mp.set_property_bool("pause", false)
        if math.abs((mp.get_property_number("time-pos") or 0) - position) > 2 then
            mp.set_property_number("time-pos", position)
        end
    elseif action == "pause" then
        mp.set_property_bool("pause", true)
    elseif action == "seek" then
        mp.set_property_number("time-pos", position)
    end

    mp.msg.info("Applied sync command: " .. action .. " at " .. position)
end

-- Progress tracking (same as regular script)
local function get_progress_data()
    local pos = mp.get_property_number("time-pos")
    local duration = mp.get_property_number("duration")
    local paused = mp.get_property_bool("pause") or false
    local eof = mp.get_property_bool("eof-reached") or false

    if duration and duration > 0 then last_duration = duration end
    local d_to_save = duration
    if not d_to_save or d_to_save <= 0 then d_to_save = last_duration end

    if pos and pos > 0 then last_position = pos end
    local p_to_save = pos
    if not p_to_save or p_to_save <= 0 then p_to_save = last_position end

    if d_to_save > 0 and p_to_save > d_to_save then p_to_save = d_to_save end

    return string.format(
        '{{"position":%.3f,"duration":%.3f,"paused":%s,"eof_reached":%s,"quit_time":%d}}',
        p_to_save, d_to_save,
        paused and "true" or "false",
        eof and "true" or "false",
        os.time()
    )
end

local function save_progress()
    local duration = mp.get_property_number("duration") or last_duration
    if not duration or duration <= 0 then return end

    local data = get_progress_data()
    local file = io.open(progress_file, "w")
    if file then
        file:write(data)
        file:close()
    end
end

-- Timers
mp.add_periodic_timer(save_interval, save_progress)
mp.add_periodic_timer(command_check_interval, check_command)

-- Event handlers for user actions
mp.observe_property("pause", "bool", function(name, value)
    save_progress()
    if value then
        write_event("pause", nil)
    else
        write_event("play", nil)
    end
end)

-- Debounced seek: rapid seeks (e.g. scrubbing) only emit one event after 150ms quiet
local seek_timer = nil
mp.register_event("seek", function()
    save_progress()
    if seek_timer then
        seek_timer:kill()
    end
    seek_timer = mp.add_timeout(0.15, function()
        write_event("seek", nil)
        seek_timer = nil
    end)
end)

mp.register_event("shutdown", save_progress)
mp.register_event("end-file", save_progress)
mp.register_event("file-loaded", function()
    mp.add_timeout(1, save_progress)
end)

mp.msg.info("SlasshyVault Watch Together sync script loaded.")
"#,
        clean_progress, clean_event, clean_command
    )
}

/// Create the Lua script file for Watch Together sync mode
fn create_sync_lua_script(media_id: i64, session_id: &str) -> Result<PathBuf, String> {
    let progress_dir = get_progress_dir();
    let sync_dir = get_sync_dir();
    fs::create_dir_all(&progress_dir)
        .map_err(|e| format!("Failed to create progress dir: {}", e))?;
    fs::create_dir_all(&sync_dir).map_err(|e| format!("Failed to create sync dir: {}", e))?;

    let script_path = sync_dir.join(format!("sync_{}.lua", session_id));
    let progress_file = get_progress_file_path(media_id);
    let event_file = get_sync_event_file(session_id);
    let command_file = get_sync_command_file(session_id);

    let script_content = get_sync_lua_script_content(
        &progress_file.to_string_lossy(),
        &event_file.to_string_lossy(),
        &command_file.to_string_lossy(),
    );

    let mut file = fs::File::create(&script_path)
        .map_err(|e| format!("Failed to create sync Lua script: {}", e))?;
    file.write_all(script_content.as_bytes())
        .map_err(|e| format!("Failed to write sync Lua script: {}", e))?;

    // Restrict file permissions: owner read/write only
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o600)) {
            println!("[MPV] Warning: Failed to set sync Lua script permissions: {}", e);
        }
    }

    Ok(script_path)
}

/// Launch MPV in Watch Together sync mode
pub fn launch_mpv_with_sync(
    mpv_path: &str,
    file_or_url: &str,
    media_id: i64,
    session_id: &str,
    start_position: f64,
    auth_header: Option<&str>,
) -> Result<u32, String> {
    crate::config::validate_executable_path(mpv_path, "mpv")?;

    println!("[MPV-SYNC] ========== LAUNCHING MPV (WATCH TOGETHER) ==========");
    println!("[MPV-SYNC] Media ID: {}", media_id);
    println!("[MPV-SYNC] Session ID: {}", session_id);
    println!("[MPV-SYNC] Source: {}", file_or_url);
    println!("[MPV-SYNC] Start position: {:.2}s", start_position);

    // Verify file exists for local files
    let is_url = file_or_url.starts_with("http://") || file_or_url.starts_with("https://");
    if !is_url && !std::path::Path::new(file_or_url).exists() {
        return Err(format!("File does not exist: {}", file_or_url));
    }

    // Create the sync Lua script
    let script_path = create_sync_lua_script(media_id, session_id)?;
    println!("[MPV-SYNC] Created sync script at: {:?}", script_path);

    // Initialize command file
    let command_file = get_sync_command_file(session_id);
    let _ = fs::write(
        &command_file,
        r#"{"action":"","position":0,"processed":true}"#,
    );

    // Build MPV command
    let mut cmd = std::process::Command::new(mpv_path);

    cmd.arg(format!("--script={}", script_path.to_string_lossy()));

    if start_position > 0.0 {
        cmd.arg(format!("--start={}", start_position as i64));
    }

    if let Some(header) = auth_header {
cmd.arg(format!("--http-header-fields={}", header));
    }

    cmd.arg(file_or_url);
    cmd.arg("--save-position-on-quit=no");
    cmd.arg("--keep-open=no");

    if is_url {
        cmd.arg("--demuxer-max-bytes=500MiB");
        cmd.arg("--demuxer-max-back-bytes=100MiB");
        cmd.arg("--cache=yes");
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    cmd.stdout(std::process::Stdio::inherit());
    cmd.stderr(std::process::Stdio::inherit());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start MPV: {}", e))?;

    let pid = child.id();
    println!("[MPV-SYNC] Started with PID: {}", pid);

    Ok(pid)
}

/// Send a sync command to MPV
pub fn send_mpv_sync_command(session_id: &str, action: &str, position: f64) -> Result<(), String> {
    let command_file = get_sync_command_file(session_id);

    let command = MpvSyncCommand {
        action: action.to_string(),
        position,
        processed: false,
    };

    let json = serde_json::to_string(&command)
        .map_err(|e| format!("Failed to serialize command: {}", e))?;

    fs::write(&command_file, json).map_err(|e| format!("Failed to write command file: {}", e))?;

    println!("[MPV-SYNC] Sent command: {} at {:.2}s", action, position);
    Ok(())
}

/// Read sync event from MPV
pub fn read_mpv_sync_event(session_id: &str) -> Option<MpvSyncEvent> {
    let event_file = get_sync_event_file(session_id);

    if !event_file.exists() {
        return None;
    }

    let content = fs::read_to_string(&event_file).ok()?;
    let event: MpvSyncEvent = serde_json::from_str(&content).ok()?;

    // Clear the event file after reading
    let _ = fs::remove_file(&event_file);

    Some(event)
}

/// Clean up sync files for a session
pub fn cleanup_sync_files(session_id: &str) {
    let sync_dir = get_sync_dir();
    let _ = fs::remove_file(sync_dir.join(format!("sync_{}.lua", session_id)));
    let _ = fs::remove_file(get_sync_command_file(session_id));
    let _ = fs::remove_file(get_sync_event_file(session_id));
}
