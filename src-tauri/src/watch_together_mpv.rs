// Watch Together MPV Controller
// Uses MPV's JSON-IPC for real-time bidirectional sync like Syncplay

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, RwLock};

// Syncplay-inspired sync thresholds (in seconds)
const SEEK_THRESHOLD: f64 = 2.0; // Seek if drift exceeds this threshold
const SLOWDOWN_KICKIN: f64 = 0.35; // Start gentle speed correction for smaller drift
const SLOWDOWN_RESET: f64 = 0.1; // Reset speed when drift < 0.1s
const SLOWDOWN_RATE: f64 = 0.95; // Slow to 95% speed (Syncplay: 0.95)
const SPEEDUP_RATE: f64 = 1.05; // Speed up to 105% to catch up
const REWIND_THRESHOLD: f64 = 4.0; // Rewind if too far ahead (Syncplay: 4.0)
const FASTFORWARD_THRESHOLD: f64 = 5.0; // Fast-forward if too far behind (Syncplay: 5.0)
const SEEK_COOLDOWN_MS: u64 = 1200; // Prevent repeated seek spam on noisy updates
const COMMAND_POSITION_EPSILON: f64 = 0.05; // Skip redundant seeks that can suppress real user events

/// MPV IPC command
#[derive(Debug, Clone, Serialize)]
pub struct MpvCommand {
    command: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<u64>,
}

/// MPV IPC response
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct MpvResponse {
    pub data: Option<serde_json::Value>,
    pub error: String,
    pub request_id: Option<u64>,
}

/// MPV event from observe_property or other events
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct MpvEvent {
    pub event: Option<String>,
    #[serde(default)]
    pub id: Option<u64>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
    // Response fields
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub request_id: Option<u64>,
}

/// Player state for sync
#[derive(Debug, Clone)]
pub struct PlayerState {
    pub position: f64,
    pub duration: f64,
    pub paused: bool,
    pub speed: f64,
    pub last_update: std::time::Instant,
}

impl Default for PlayerState {
    fn default() -> Self {
        Self {
            position: 0.0,
            duration: 0.0,
            paused: true,
            speed: 1.0,
            last_update: std::time::Instant::now(),
        }
    }
}

/// Sync event types emitted by the controller
#[derive(Debug, Clone)]
pub enum MpvSyncEvent {
    /// User paused/unpaused locally
    PauseChanged { paused: bool, position: f64 },
    /// User seeked locally
    Seeked { position: f64 },
    /// MPV process ended
    Ended,
    /// Position updated (from observe_property)
    PositionUpdate { position: f64 },
}

/// Participant ready state for OSD display
#[derive(Debug, Clone, Serialize)]
pub struct ParticipantState {
    pub nickname: String,
    pub ready: bool,
    pub position: f64,
}

/// Sync controller for a Watch Together session
pub struct WatchTogetherController {
    pub session_id: String,
    pub pipe_name: String,
    pub is_host: bool,
    pub local_state: Arc<RwLock<PlayerState>>,
    pub participants: Arc<Mutex<HashMap<String, ParticipantState>>>,
    /// Channel to send commands to the pipe writer task
    cmd_tx: Option<mpsc::Sender<String>>,
    /// Channel to receive sync events from the pipe reader task
    event_rx: Arc<Mutex<Option<mpsc::Receiver<MpvSyncEvent>>>>,
    /// Monotonic request ID counter for MPV commands
    next_request_id: Arc<AtomicU64>,
    /// Whether the controller is connected
    connected: Arc<AtomicBool>,
    /// Counter for ignoring echo events (Syncplay's ignoringOnTheFly)
    pub ignoring_on_the_fly: Arc<AtomicU64>,
    /// Last time we performed a seek-based correction
    last_seek_correction: Arc<Mutex<Option<std::time::Instant>>>,
}

impl WatchTogetherController {
    pub fn new(session_id: &str, is_host: bool) -> Self {
        // Sanitize session_id to prevent path traversal or invalid pipe names
        let safe_session_id: String = session_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        let pipe_name = format!("\\\\.\\pipe\\mpv-wt-{}", safe_session_id);
        Self {
            session_id: safe_session_id,
            pipe_name,
            is_host,
            local_state: Arc::new(RwLock::new(PlayerState::default())),
            participants: Arc::new(Mutex::new(HashMap::new())),
            cmd_tx: None,
            event_rx: Arc::new(Mutex::new(None)),
            next_request_id: Arc::new(AtomicU64::new(1)),
            connected: Arc::new(AtomicBool::new(false)),
            ignoring_on_the_fly: Arc::new(AtomicU64::new(0)),
            last_seek_correction: Arc::new(Mutex::new(None)),
        }
    }

    /// Get the IPC pipe argument for MPV
    pub fn get_ipc_arg(&self) -> String {
        format!("--input-ipc-server={}", self.pipe_name)
    }

    /// Connect to MPV's IPC pipe and start async reader/writer tasks
    #[cfg(windows)]
    pub async fn connect(&mut self) -> Result<(), String> {
        use std::io::{BufRead, BufReader, Write};
        use std::os::windows::io::FromRawHandle;
        use std::time::Duration;
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        };

        // Wait for MPV to create the pipe
        let mut file = None;
        for _ in 0..50 {
            let wide_name: Vec<u16> = self
                .pipe_name
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();

            let handle = unsafe {
                CreateFileW(
                    wide_name.as_ptr(),
                    0x80000000 | 0x40000000, // GENERIC_READ | GENERIC_WRITE
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    0,
                    0,
                )
            };

            if handle != INVALID_HANDLE_VALUE {
                file = Some(unsafe {
                    std::fs::File::from_raw_handle(handle as *mut std::ffi::c_void)
                });
                println!("[WT-MPV] Connected to pipe: {}", self.pipe_name);
                break;
            }

            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let pipe_file =
            file.ok_or_else(|| format!("Failed to connect to MPV pipe: {}", self.pipe_name))?;

        // Clone the file handle for reading (we need separate read/write handles)
        let read_file = pipe_file
            .try_clone()
            .map_err(|e| format!("Failed to clone pipe handle: {}", e))?;
        let write_file = pipe_file;

        // Create channels
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<String>(64);
        let (event_tx, event_rx) = mpsc::channel::<MpvSyncEvent>(64);

        self.cmd_tx = Some(cmd_tx);
        *self.event_rx.lock().await = Some(event_rx);
        self.connected.store(true, Ordering::SeqCst);

        let local_state = self.local_state.clone();
        let connected = self.connected.clone();
        let ignoring = self.ignoring_on_the_fly.clone();

        // Spawn writer task - sends commands to MPV pipe
        let write_connected = connected.clone();
        tokio::task::spawn_blocking(move || {
            let mut writer = write_file;
            loop {
                match cmd_rx.blocking_recv() {
                    Some(cmd) => {
                        if let Err(e) = writeln!(writer, "{}", cmd) {
                            println!("[WT-MPV] Write error: {}", e);
                            write_connected.store(false, Ordering::SeqCst);
                            break;
                        }
                    }
                    None => break, // Channel closed
                }
            }
            println!("[WT-MPV] Writer task ended");
        });

        // Spawn reader task - reads responses/events from MPV pipe
        tokio::task::spawn_blocking(move || {
            let reader = BufReader::new(read_file);
            let mut last_position = 0.0f64;
            let mut last_paused = true;
            let mut pending_user_seek = false;

            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        if text.is_empty() {
                            continue;
                        }

                        // Try to parse as a JSON message from MPV
                        if let Ok(event) = serde_json::from_str::<MpvEvent>(&text) {
                            // Handle property-change events (from observe_property)
                            if event.event.as_deref() == Some("property-change") {
                                match event.name.as_deref() {
                                    Some("time-pos") => {
                                        if let Some(serde_json::Value::Number(n)) = &event.data {
                                            if let Some(pos) = n.as_f64() {
                                                // Update local state
                                                let state = local_state.clone();
                                                let rt = tokio::runtime::Handle::try_current();
                                                if let Ok(rt) = rt {
                                                    rt.block_on(async {
                                                        let mut s = state.write().await;
                                                        s.position = pos;
                                                        s.last_update = std::time::Instant::now();
                                                    });
                                                }
                                                last_position = pos;
                                                if pending_user_seek {
                                                    pending_user_seek = false;
                                                    let _ = event_tx.blocking_send(
                                                        MpvSyncEvent::Seeked { position: pos },
                                                    );
                                                }
                                            }
                                        }
                                    }
                                    Some("pause") => {
                                        if let Some(serde_json::Value::Bool(paused)) = &event.data {
                                            let paused = *paused;
                                            let state = local_state.clone();
                                            let rt = tokio::runtime::Handle::try_current();
                                            if let Ok(rt) = rt {
                                                rt.block_on(async {
                                                    let mut s = state.write().await;
                                                    s.paused = paused;
                                                    s.last_update = std::time::Instant::now();
                                                });
                                            }

                                            // Only emit event if this is a USER action (not echo)
                                            let ign = ignoring.load(Ordering::SeqCst);
                                            if ign > 0 {
                                                ignoring.fetch_sub(1, Ordering::SeqCst);
                                            } else if paused != last_paused {
                                                let _ = event_tx.blocking_send(
                                                    MpvSyncEvent::PauseChanged {
                                                        paused,
                                                        position: last_position,
                                                    },
                                                );
                                            }
                                            last_paused = paused;
                                        }
                                    }
                                    Some("duration") => {
                                        if let Some(serde_json::Value::Number(n)) = &event.data {
                                            if let Some(dur) = n.as_f64() {
                                                let state = local_state.clone();
                                                let rt = tokio::runtime::Handle::try_current();
                                                if let Ok(rt) = rt {
                                                    rt.block_on(async {
                                                        let mut s = state.write().await;
                                                        s.duration = dur;
                                                    });
                                                }
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            } else if event.event.as_deref() == Some("seek") {
                                // Seek event can fire before time-pos updates. We defer emission
                                // until the next time-pos property change for an accurate position.
                                let ign = ignoring.load(Ordering::SeqCst);
                                if ign > 0 {
                                    ignoring.fetch_sub(1, Ordering::SeqCst);
                                } else {
                                    pending_user_seek = true;
                                }
                            } else if event.event.as_deref() == Some("shutdown")
                                || event.event.as_deref() == Some("end-file")
                            {
                                let _ = event_tx.blocking_send(MpvSyncEvent::Ended);
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        println!("[WT-MPV] Read error: {}", e);
                        connected.store(false, Ordering::SeqCst);
                        let _ = event_tx.blocking_send(MpvSyncEvent::Ended);
                        break;
                    }
                }
            }
            println!("[WT-MPV] Reader task ended");
        });

        // Wait a bit for MPV to be ready, then set up property observation
        tokio::time::sleep(Duration::from_millis(500)).await;

        // Observe properties for real-time updates
        self.observe_property(1, "time-pos").await?;
        self.observe_property(2, "pause").await?;
        self.observe_property(3, "duration").await?;

        Ok(())
    }

    #[cfg(not(windows))]
    pub async fn connect(&mut self) -> Result<(), String> {
        Err("Non-Windows platforms not yet supported".to_string())
    }

    /// Take the event receiver (can only be called once)
    pub async fn take_event_rx(&self) -> Option<mpsc::Receiver<MpvSyncEvent>> {
        self.event_rx.lock().await.take()
    }

    /// Send a raw JSON command string to MPV
    async fn send_raw(&self, json: String) -> Result<(), String> {
        if let Some(tx) = &self.cmd_tx {
            tx.send(json)
                .await
                .map_err(|e| format!("Failed to send command: {}", e))
        } else {
            Err("Not connected to MPV".to_string())
        }
    }

    /// Send a command to MPV
    pub async fn send_command(&self, command: Vec<serde_json::Value>) -> Result<(), String> {
        let cmd = MpvCommand {
            command,
            request_id: None,
        };
        let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
        self.send_raw(json).await
    }

    /// Send a command with a request_id
    pub async fn send_command_with_id(
        &self,
        command: Vec<serde_json::Value>,
    ) -> Result<u64, String> {
        let id = self.next_request_id.fetch_add(1, Ordering::SeqCst);
        let cmd = MpvCommand {
            command,
            request_id: Some(id),
        };
        let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
        self.send_raw(json).await?;
        Ok(id)
    }

    /// Observe a property for changes
    pub async fn observe_property(&self, id: u64, property: &str) -> Result<(), String> {
        self.send_command(vec!["observe_property".into(), id.into(), property.into()])
            .await
    }

    /// Set pause state (with echo prevention)
    pub async fn set_paused(&self, paused: bool) -> Result<(), String> {
        let state = self.local_state.read().await;
        if state.paused == paused {
            return Ok(());
        }
        drop(state);

        self.ignoring_on_the_fly.fetch_add(1, Ordering::SeqCst);
        self.send_command(vec!["set_property".into(), "pause".into(), paused.into()])
            .await?;

        let mut state = self.local_state.write().await;
        state.paused = paused;
        state.last_update = std::time::Instant::now();
        Ok(())
    }

    /// Seek to position (with echo prevention)
    pub async fn seek_to(&self, position: f64) -> Result<(), String> {
        let state = self.local_state.read().await;
        let estimated_position = if state.paused {
            state.position
        } else {
            state.position + (state.last_update.elapsed().as_secs_f64() * state.speed)
        };
        if (estimated_position - position).abs() < COMMAND_POSITION_EPSILON {
            return Ok(());
        }
        drop(state);

        self.ignoring_on_the_fly.fetch_add(1, Ordering::SeqCst);
        self.send_command(vec![
            "set_property".into(),
            "time-pos".into(),
            position.into(),
        ])
        .await?;

        let mut state = self.local_state.write().await;
        state.position = position;
        state.last_update = std::time::Instant::now();
        Ok(())
    }

    /// Set playback speed
    pub async fn set_speed(&self, speed: f64) -> Result<(), String> {
        self.send_command(vec!["set_property".into(), "speed".into(), speed.into()])
            .await
    }

    /// Show OSD message in MPV
    pub async fn show_osd(&self, message: &str, duration_ms: u64) -> Result<(), String> {
        self.send_command(vec![
            "show-text".into(),
            message.into(),
            (duration_ms as i64).into(),
        ])
        .await
    }

    /// Get estimated current position (accounting for elapsed time since last update)
    pub async fn get_estimated_position(&self) -> (f64, bool) {
        let state = self.local_state.read().await;
        let elapsed = state.last_update.elapsed().as_secs_f64();
        let pos = if state.paused {
            state.position
        } else {
            state.position + (elapsed * state.speed)
        };
        (pos, state.paused)
    }

    async fn should_seek_now(&self) -> bool {
        let now = std::time::Instant::now();
        let mut last_seek = self.last_seek_correction.lock().await;
        if let Some(last) = *last_seek {
            if now.duration_since(last).as_millis() < SEEK_COOLDOWN_MS as u128 {
                return false;
            }
        }
        *last_seek = Some(now);
        true
    }

    /// Apply sync correction based on server-provided authoritative position
    /// This implements Syncplay's drift correction algorithm
    pub async fn apply_sync(
        &self,
        server_position: f64,
        server_paused: bool,
    ) -> Result<(), String> {
        let state = self.local_state.write().await;
        let elapsed = state.last_update.elapsed().as_secs_f64();
        let estimated_position = if state.paused {
            state.position
        } else {
            state.position + (elapsed * state.speed)
        };

        let diff = estimated_position - server_position;

        // Apply pause state change
        if server_paused != state.paused {
            drop(state); // Release lock before sending command
            self.set_paused(server_paused).await?;
            let mut state = self.local_state.write().await;
            state.paused = server_paused;
            state.last_update = std::time::Instant::now();

            // If unpausing, also sync position
            if !server_paused && diff.abs() > SLOWDOWN_RESET {
                drop(state);
                self.seek_to(server_position).await?;
                let mut state = self.local_state.write().await;
                state.position = server_position;
                state.speed = 1.0;
                state.last_update = std::time::Instant::now();
            }
            return Ok(());
        }

        // Position sync - Syncplay-style tiered correction
        if diff > REWIND_THRESHOLD || diff < -FASTFORWARD_THRESHOLD {
            // Very large drift - hard seek immediately
            drop(state);
            if !self.should_seek_now().await {
                return Ok(());
            }
            println!(
                "[WT-MPV] Hard seek: drift={:.3}s, target={:.2}s",
                diff, server_position
            );
            self.seek_to(server_position).await?;
            self.set_speed(1.0).await?;
            let mut state = self.local_state.write().await;
            state.position = server_position;
            state.speed = 1.0;
            state.last_update = std::time::Instant::now();
        } else if diff.abs() > SEEK_THRESHOLD {
            // Medium drift - seek to correct position
            drop(state);
            if !self.should_seek_now().await {
                return Ok(());
            }
            println!("[WT-MPV] Seek correction: drift={:.3}s", diff);
            self.seek_to(server_position).await?;
            self.set_speed(1.0).await?;
            let mut state = self.local_state.write().await;
            state.position = server_position;
            state.speed = 1.0;
            state.last_update = std::time::Instant::now();
        } else if diff > SLOWDOWN_KICKIN {
            // We're ahead - slow down gradually (Syncplay approach)
            if (state.speed - SLOWDOWN_RATE).abs() > 0.001 {
                println!("[WT-MPV] Slowing down: drift={:.3}s", diff);
                drop(state);
                self.set_speed(SLOWDOWN_RATE).await?;
                let mut state = self.local_state.write().await;
                state.speed = SLOWDOWN_RATE;
                state.last_update = std::time::Instant::now();
            }
        } else if diff < -SLOWDOWN_KICKIN {
            // We're behind - speed up gradually
            if (state.speed - SPEEDUP_RATE).abs() > 0.001 {
                println!("[WT-MPV] Speeding up: drift={:.3}s", diff);
                drop(state);
                self.set_speed(SPEEDUP_RATE).await?;
                let mut state = self.local_state.write().await;
                state.speed = SPEEDUP_RATE;
                state.last_update = std::time::Instant::now();
            }
        } else if diff.abs() < SLOWDOWN_RESET && (state.speed - 1.0).abs() > 0.001 {
            // We're close enough - reset to normal speed
            drop(state);
            self.set_speed(1.0).await?;
            let mut state = self.local_state.write().await;
            state.speed = 1.0;
            state.last_update = std::time::Instant::now();
        }

        Ok(())
    }

    /// Check if connected
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }
}

/// Launch MPV with Watch Together IPC support
pub fn launch_mpv_wt(
    mpv_path: &str,
    file_or_url: &str,
    media_id: i64,
    display_title: Option<&str>,
    session_id: &str,
    start_position: f64,
    auth_header: Option<&str>,
    is_host: bool,
) -> Result<(u32, WatchTogetherController), String> {
    crate::config::validate_executable_path(mpv_path, "mpv")?;

    println!("[WT-MPV] ========== LAUNCHING MPV (WATCH TOGETHER v2) ==========");
    println!("[WT-MPV] Media ID: {}", media_id);
    println!("[WT-MPV] Session ID: {}", session_id);
    println!("[WT-MPV] Is Host: {}", is_host);
    println!("[WT-MPV] Source: {}", file_or_url);
    println!(
        "[WT-MPV] Display title: {}",
        display_title.unwrap_or("MPV default")
    );

    let is_url = file_or_url.starts_with("http://") || file_or_url.starts_with("https://");
    if !is_url && !std::path::Path::new(file_or_url).exists() {
        return Err(format!("File does not exist: {}", file_or_url));
    }

    // Create controller
    let controller = WatchTogetherController::new(session_id, is_host);

    // Build MPV command
    let mut cmd = std::process::Command::new(mpv_path);

    // IPC for bidirectional communication via named pipe
    cmd.arg(controller.get_ipc_arg());

    if let Some(title) = display_title.map(str::trim).filter(|value| !value.is_empty()) {
        cmd.arg(format!("--force-media-title={}", title));
    }

    // Start position
    if start_position > 0.0 {
        cmd.arg(format!("--start={}", start_position as i64));
    }

    // Start paused - will unpause when everyone is ready
    cmd.arg("--pause=yes");

    // Auth header for cloud files
    if let Some(header) = auth_header {
        cmd.arg(format!("--http-header-fields={}", header));
    }

    // Standard options
    cmd.arg("--save-position-on-quit=no");
    cmd.arg("--keep-open=no");
    cmd.arg("--osd-level=1");

    // Cloud streaming options
    if is_url {
        cmd.arg("--demuxer-max-bytes=500MiB");
        cmd.arg("--demuxer-max-back-bytes=100MiB");
        cmd.arg("--cache=yes");
    }

    // Security enhancement: Use -- separator to prevent argument injection
    cmd.arg("--");

    // Media file/URL
    cmd.arg(file_or_url);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd.stdout(std::process::Stdio::inherit());
    cmd.stderr(std::process::Stdio::inherit());

    println!("[WT-MPV] Command: {:?}", cmd);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start MPV: {}", e))?;
    let pid = child.id();

    println!("[WT-MPV] Started with PID: {}", pid);

    Ok((pid, controller))
}

/// Cleanup session files
pub fn cleanup_session(session_id: &str) {
    let app_data = crate::database::get_app_data_dir();
    let wt_dir = app_data.join("wt_sync");
    let _ = fs::remove_file(wt_dir.join(format!("state_{}.json", session_id)));
    let _ = fs::remove_file(wt_dir.join(format!("wt_{}.lua", session_id)));
}
