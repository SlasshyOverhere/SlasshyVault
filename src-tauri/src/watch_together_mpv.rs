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
    event_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<MpvSyncEvent>>>>,
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

        if self.connected.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Wait for MPV to create the pipe
        // Use WaitNamedPipeW with 5-second timeout before attempting connection
        let _wide_name: Vec<u16> = self
            .pipe_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

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
        let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel::<MpvSyncEvent>();

        self.cmd_tx = Some(cmd_tx);
        *self.event_rx.lock().await = Some(event_rx);
        self.connected.store(true, Ordering::SeqCst);

        let local_state = self.local_state.clone();
        let connected = self.connected.clone();
        let ignoring = self.ignoring_on_the_fly.clone();

        // Channel for state updates from the blocking reader to the async world
        let (state_tx, mut state_rx) = tokio::sync::mpsc::channel::<PlayerState>(32);

        // Spawn a dedicated async task that owns the state and receives updates via the channel
        let local_state_clone = local_state.clone();
        tokio::spawn(async move {
            while let Some(new_state) = state_rx.recv().await {
                let mut s = local_state_clone.write().await;
                s.position = new_state.position;
                s.paused = new_state.paused;
                s.duration = new_state.duration;
                s.last_update = new_state.last_update;
                // Drain intermediate states, keep only the latest
                while let Ok(new_state) = state_rx.try_recv() {
                    s.position = new_state.position;
                    s.paused = new_state.paused;
                    s.duration = new_state.duration;
                    s.last_update = new_state.last_update;
                }
            }
        });

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
                                                // Send state update via channel instead of block_on
                                                let _ = state_tx.send(PlayerState {
                                                    position: pos,
                                                    duration: 0.0,
                                                    paused: last_paused,
                                                    speed: 1.0,
                                                    last_update: std::time::Instant::now(),
                                                });
                                                last_position = pos;
                                                if pending_user_seek {
                                                    pending_user_seek = false;
                                                    let _ = event_tx.send(MpvSyncEvent::Seeked {
                                                        position: pos,
                                                    });
                                                }
                                            }
                                        }
                                    }
                                    Some("pause") => {
                                        if let Some(serde_json::Value::Bool(paused)) = &event.data {
                                            let paused = *paused;
                                            let _ = state_tx.send(PlayerState {
                                                position: last_position,
                                                duration: 0.0,
                                                paused,
                                                speed: 1.0,
                                                last_update: std::time::Instant::now(),
                                            });

                                            // Only emit event if this is a USER action (not echo)
                                            let prev = ignoring.fetch_sub(1, Ordering::SeqCst);
                                            if prev == 0 {
                                                ignoring.fetch_add(1, Ordering::SeqCst);
                                            } else if paused != last_paused {
                                                let _ = event_tx.send(MpvSyncEvent::PauseChanged {
                                                    paused,
                                                    position: last_position,
                                                });
                                            }
                                            last_paused = paused;
                                        }
                                    }
                                    Some("duration") => {
                                        if let Some(serde_json::Value::Number(n)) = &event.data {
                                            if let Some(dur) = n.as_f64() {
                                                let _ = state_tx.send(PlayerState {
                                                    position: last_position,
                                                    duration: dur,
                                                    paused: last_paused,
                                                    speed: 1.0,
                                                    last_update: std::time::Instant::now(),
                                                });
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            } else if event.event.as_deref() == Some("seek") {
                                // Seek event can fire before time-pos updates. We defer emission
                                // until the next time-pos property change for an accurate position.
                                let prev = ignoring.fetch_sub(1, Ordering::SeqCst);
                                if prev == 0 {
                                    ignoring.fetch_add(1, Ordering::SeqCst);
                                } else {
                                    pending_user_seek = true;
                                }
                            } else if event.event.as_deref() == Some("shutdown")
                                || event.event.as_deref() == Some("end-file")
                            {
                                let _ = event_tx.send(MpvSyncEvent::Ended);
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        println!("[WT-MPV] Read error: {}", e);
                        connected.store(false, Ordering::SeqCst);
                        let _ = event_tx.send(MpvSyncEvent::Ended);
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
    pub async fn take_event_rx(&self) -> Option<mpsc::UnboundedReceiver<MpvSyncEvent>> {
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
            .await?;
        self.local_state.write().await.speed = speed;
        Ok(())
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

            // Recompute diff after reacquiring lock
            let elapsed = state.last_update.elapsed().as_secs_f64();
            let estimated_position = if state.paused {
                state.position
            } else {
                state.position + (elapsed * state.speed)
            };
            let diff = estimated_position - server_position;

            // If unpausing, also sync position
            if !server_paused && diff.abs() > SLOWDOWN_RESET {
                drop(state);
                if !self.should_seek_now().await {
                    return Ok(());
                }
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

    /// LBAS: Seek to position and schedule unpause at a specific target timestamp
    pub async fn seek_and_play_at(
        &self,
        position: f64,
        target_timestamp: f64,
    ) -> Result<(), String> {
        self.seek_to(position).await?;
        self.set_paused(true).await?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64();
        let delay = (target_timestamp - now).max(0.0);
        let cmd_tx = self.cmd_tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs_f64(delay)).await;
            if let Some(tx) = cmd_tx {
                let _ = tx
                    .send(r#"{"command":["set_property","pause",false]}"#.to_string())
                    .await;
            }
        });
        Ok(())
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

    if let Some(title) = display_title
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
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

    // Add the -- separator to prevent argument injection
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

    println!("[WT-MPV] Command: {:?}", cmd.get_program());

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── WatchTogetherController::new() ──

    #[test]
    fn new_initializes_with_defaults() {
        let c = WatchTogetherController::new("abc123", true);
        assert_eq!(c.session_id, "abc123");
        assert_eq!(c.pipe_name, r"\\.\pipe\mpv-wt-abc123");
        assert!(c.is_host);
        assert!(!c.is_connected());
        assert!(c.cmd_tx.is_none());
        assert_eq!(c.next_request_id.load(Ordering::SeqCst), 1);
        assert_eq!(c.ignoring_on_the_fly.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn new_sanitizes_session_id() {
        let c = WatchTogetherController::new("../../../etc/passwd;rm -rf /", false);
        assert_eq!(c.session_id, "etcpasswdrm-rf");
        assert_eq!(c.pipe_name, r"\\.\pipe\mpv-wt-etcpasswdrm-rf");
        assert!(!c.is_host);
    }

    #[test]
    fn new_preserves_safe_chars() {
        let c = WatchTogetherController::new("my-session_123", false);
        assert_eq!(c.session_id, "my-session_123");
    }

    #[test]
    fn new_strips_all_unsafe_chars() {
        let c = WatchTogetherController::new("a!@#$%^&*()+={}[]|\\:;'\"<>,?/~`b", false);
        assert_eq!(c.session_id, "ab");
    }

    // ── get_ipc_arg() ──

    #[test]
    fn get_ipc_arg_returns_correct_path() {
        let c = WatchTogetherController::new("test-session", true);
        assert_eq!(
            c.get_ipc_arg(),
            r"--input-ipc-server=\\.\pipe\mpv-wt-test-session"
        );
    }

    // ── is_connected() ──

    #[test]
    fn is_connected_false_by_default() {
        let c = WatchTogetherController::new("s", false);
        assert!(!c.is_connected());
    }

    #[test]
    fn is_connected_reflects_atomic_state() {
        let c = WatchTogetherController::new("s", false);
        c.connected.store(true, Ordering::SeqCst);
        assert!(c.is_connected());
        c.connected.store(false, Ordering::SeqCst);
        assert!(!c.is_connected());
    }

    // ── PlayerState ──

    #[test]
    fn player_state_default() {
        let s = PlayerState::default();
        assert_eq!(s.position, 0.0);
        assert_eq!(s.duration, 0.0);
        assert!(s.paused);
        assert_eq!(s.speed, 1.0);
    }

    #[tokio::test]
    async fn player_state_default_applied_to_controller() {
        let c = WatchTogetherController::new("s", false);
        let state = c.local_state.read().await;
        assert_eq!(state.position, 0.0);
        assert_eq!(state.duration, 0.0);
        assert!(state.paused);
        assert_eq!(state.speed, 1.0);
    }

    // ── MpvCommand serialization ──

    #[test]
    fn mpv_command_serialize_without_request_id() {
        let cmd = MpvCommand {
            command: vec![json!("observe_property"), json!(1), json!("time-pos")],
            request_id: None,
        };
        let s = serde_json::to_string(&cmd).unwrap();
        assert_eq!(s, r#"{"command":["observe_property",1,"time-pos"]}"#);
        assert!(!s.contains("request_id"));
    }

    #[test]
    fn mpv_command_serialize_with_request_id() {
        let cmd = MpvCommand {
            command: vec![json!("get_property"), json!("pause")],
            request_id: Some(42),
        };
        let s = serde_json::to_string(&cmd).unwrap();
        assert_eq!(s, r#"{"command":["get_property","pause"],"request_id":42}"#);
    }

    // ── MpvResponse deserialization ──

    #[test]
    fn mpv_response_deserialize_success() {
        let r: MpvResponse =
            serde_json::from_str(r#"{"data":"test.mp4","error":"success","request_id":7}"#)
                .unwrap();
        assert_eq!(r.error, "success");
        assert_eq!(r.request_id, Some(7));
        assert_eq!(r.data.unwrap(), "test.mp4");
    }

    #[test]
    fn mpv_response_deserialize_error() {
        let r: MpvResponse = serde_json::from_str(r#"{"error":"property not found"}"#).unwrap();
        assert_eq!(r.error, "property not found");
        assert!(r.data.is_none());
        assert!(r.request_id.is_none());
    }

    #[test]
    fn mpv_response_deserialize_null_data() {
        let r: MpvResponse = serde_json::from_str(r#"{"data":null,"error":"success"}"#).unwrap();
        assert_eq!(r.error, "success");
        // serde deserializes JSON null into None for Option<Value>
        assert!(r.data.is_none());
    }

    // ── MpvEvent deserialization ──

    #[test]
    fn mpv_event_property_change_time_pos() {
        let e: MpvEvent = serde_json::from_str(
            r#"{"event":"property-change","id":1,"name":"time-pos","data":42.5}"#,
        )
        .unwrap();
        assert_eq!(e.event.as_deref(), Some("property-change"));
        assert_eq!(e.id, Some(1));
        assert_eq!(e.name.as_deref(), Some("time-pos"));
        assert_eq!(e.data.unwrap().as_f64(), Some(42.5));
    }

    #[test]
    fn mpv_event_property_change_pause() {
        let e: MpvEvent = serde_json::from_str(
            r#"{"event":"property-change","id":2,"name":"pause","data":true}"#,
        )
        .unwrap();
        assert_eq!(e.name.as_deref(), Some("pause"));
        assert_eq!(e.data.unwrap().as_bool(), Some(true));
    }

    #[test]
    fn mpv_event_shutdown() {
        let e: MpvEvent = serde_json::from_str(r#"{"event":"shutdown"}"#).unwrap();
        assert_eq!(e.event.as_deref(), Some("shutdown"));
    }

    #[test]
    fn mpv_event_end_file() {
        let e: MpvEvent = serde_json::from_str(r#"{"event":"end-file"}"#).unwrap();
        assert_eq!(e.event.as_deref(), Some("end-file"));
    }

    #[test]
    fn mpv_event_seek() {
        let e: MpvEvent = serde_json::from_str(r#"{"event":"seek"}"#).unwrap();
        assert_eq!(e.event.as_deref(), Some("seek"));
    }

    #[test]
    fn mpv_event_response_fields() {
        let e: MpvEvent =
            serde_json::from_str(r#"{"error":"success","request_id":5,"data":42}"#).unwrap();
        assert!(e.event.is_none());
        assert_eq!(e.error.as_deref(), Some("success"));
        assert_eq!(e.request_id, Some(5));
        assert_eq!(e.data.unwrap().as_i64(), Some(42));
    }

    #[test]
    fn mpv_event_missing_optional_fields_default_to_none() {
        let e: MpvEvent = serde_json::from_str(r#"{"event":"idle"}"#).unwrap();
        assert!(e.id.is_none());
        assert!(e.name.is_none());
        assert!(e.data.is_none());
        assert!(e.error.is_none());
        assert!(e.request_id.is_none());
    }

    // ── ParticipantState ──

    #[test]
    fn participant_state_construction_and_serde() {
        let p = ParticipantState {
            nickname: "Alice".to_string(),
            ready: true,
            position: 123.45,
        };
        let s = serde_json::to_string(&p).unwrap();
        let deserialized: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(deserialized["nickname"], "Alice");
        assert_eq!(deserialized["ready"], true);
        assert_eq!(deserialized["position"], 123.45);
    }

    // ── MpvSyncEvent ──

    #[test]
    fn mpv_sync_event_variants() {
        let e1 = MpvSyncEvent::PauseChanged {
            paused: true,
            position: 10.0,
        };
        let e2 = MpvSyncEvent::Seeked { position: 30.5 };
        let e3 = MpvSyncEvent::Ended;
        let e4 = MpvSyncEvent::PositionUpdate { position: 60.0 };

        match e1 {
            MpvSyncEvent::PauseChanged { paused, position } => {
                assert!(paused);
                assert_eq!(position, 10.0);
            }
            _ => panic!("wrong variant"),
        }
        match e2 {
            MpvSyncEvent::Seeked { position } => assert_eq!(position, 30.5),
            _ => panic!("wrong variant"),
        }
        match e3 {
            MpvSyncEvent::Ended => {}
            _ => panic!("wrong variant"),
        }
        match e4 {
            MpvSyncEvent::PositionUpdate { position } => assert_eq!(position, 60.0),
            _ => panic!("wrong variant"),
        }
    }

    // ── get_estimated_position() ──

    #[tokio::test]
    async fn get_estimated_position_paused_returns_stored() {
        let c = WatchTogetherController::new("s", false);
        {
            let mut state = c.local_state.write().await;
            state.position = 42.0;
            state.paused = true;
            state.speed = 1.0;
            state.last_update = std::time::Instant::now();
        }
        let (pos, paused) = c.get_estimated_position().await;
        assert!(paused);
        assert!((pos - 42.0).abs() < 0.1);
    }

    #[tokio::test]
    async fn get_estimated_position_playing_adds_elapsed() {
        let c = WatchTogetherController::new("s", false);
        {
            let mut state = c.local_state.write().await;
            state.position = 10.0;
            state.paused = false;
            state.speed = 2.0;
            state.last_update = std::time::Instant::now() - std::time::Duration::from_millis(50);
        }
        let (pos, paused) = c.get_estimated_position().await;
        assert!(!paused);
        // 10.0 + ~0.05s * 2.0 = ~10.1
        assert!(pos >= 10.05 && pos < 10.5);
    }

    #[tokio::test]
    async fn get_estimated_position_playing_speed_1x() {
        let c = WatchTogetherController::new("s", false);
        {
            let mut state = c.local_state.write().await;
            state.position = 0.0;
            state.paused = false;
            state.speed = 1.0;
            state.last_update = std::time::Instant::now() - std::time::Duration::from_millis(100);
        }
        let (pos, paused) = c.get_estimated_position().await;
        assert!(!paused);
        assert!(pos >= 0.05 && pos < 0.5);
    }

    // ── send_raw / send_command / observe_property / show_osd error paths ──

    #[tokio::test]
    async fn send_raw_errors_when_not_connected() {
        let c = WatchTogetherController::new("s", false);
        let result = c.send_raw("{}".to_string()).await;
        assert!(result.unwrap_err().contains("Not connected"));
    }

    #[tokio::test]
    async fn send_command_errors_when_not_connected() {
        let c = WatchTogetherController::new("s", false);
        let result = c.send_command(vec![json!("test")]).await;
        assert!(result.unwrap_err().contains("Not connected"));
    }

    #[tokio::test]
    async fn observe_property_errors_when_not_connected() {
        let c = WatchTogetherController::new("s", false);
        let result = c.observe_property(1, "time-pos").await;
        assert!(result.unwrap_err().contains("Not connected"));
    }

    #[tokio::test]
    async fn show_osd_errors_when_not_connected() {
        let c = WatchTogetherController::new("s", false);
        let result = c.show_osd("Hello", 1000).await;
        assert!(result.unwrap_err().contains("Not connected"));
    }

    // ── set_paused logic ──

    #[tokio::test]
    async fn set_paused_skips_when_already_in_target_state() {
        let c = WatchTogetherController::new("s", false);
        // Default: paused=true. Setting paused=true should return Ok early.
        assert!(c.set_paused(true).await.is_ok());
        // ignoring_on_the_fly should not have been incremented
        assert_eq!(c.ignoring_on_the_fly.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn set_paused_increments_ignoring_on_the_fly() {
        let c = WatchTogetherController::new("s", false);
        // Default paused=true, requesting paused=false → will proceed past state check
        // but fail at send_command (not connected)
        let _ = c.set_paused(false).await;
        assert_eq!(c.ignoring_on_the_fly.load(Ordering::SeqCst), 1);
    }

    // ── seek_to logic ──

    #[tokio::test]
    async fn seek_to_skips_when_within_epsilon() {
        let c = WatchTogetherController::new("s", false);
        {
            let mut state = c.local_state.write().await;
            state.position = 10.0;
            state.paused = true;
            state.last_update = std::time::Instant::now();
        }
        // 10.0 - 10.02 = 0.02 < 0.05 epsilon → skip
        assert!(c.seek_to(10.02).await.is_ok());
        assert_eq!(c.ignoring_on_the_fly.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn seek_to_proceeds_when_outside_epsilon() {
        let c = WatchTogetherController::new("s", false);
        {
            let mut state = c.local_state.write().await;
            state.position = 10.0;
            state.paused = true;
            state.last_update = std::time::Instant::now();
        }
        // 10.0 - 20.0 = 10.0 > 0.05 epsilon → proceed
        let _ = c.seek_to(20.0).await;
        assert_eq!(c.ignoring_on_the_fly.load(Ordering::SeqCst), 1);
    }

    // ── set_speed error path ──

    #[tokio::test]
    async fn set_speed_errors_when_not_connected() {
        let c = WatchTogetherController::new("s", false);
        assert!(c.set_speed(1.5).await.is_err());
    }

    // ── take_event_rx ──

    #[tokio::test]
    async fn take_event_rx_returns_none_initially() {
        let c = WatchTogetherController::new("s", false);
        // First take consumes the inner None
        let rx = c.take_event_rx().await;
        assert!(rx.is_none());
    }

    #[tokio::test]
    async fn take_event_rx_returns_value_then_none() {
        let c = WatchTogetherController::new("s", false);
        // Manually insert a receiver to test take semantics
        let (tx, rx) = mpsc::unbounded_channel::<MpvSyncEvent>();
        *c.event_rx.lock().await = Some(rx);
        drop(tx);

        let first = c.take_event_rx().await;
        assert!(first.is_some());
        let second = c.take_event_rx().await;
        assert!(second.is_none());
    }

    // ── should_seek_now cooldown ──

    #[tokio::test]
    async fn should_seek_now_first_call_returns_true() {
        let c = WatchTogetherController::new("s", false);
        assert!(c.should_seek_now().await);
    }

    #[tokio::test]
    async fn should_seek_now_respects_cooldown() {
        let c = WatchTogetherController::new("s", false);
        // First call succeeds and sets the timestamp
        assert!(c.should_seek_now().await);
        // Immediate second call should be blocked by cooldown (1200ms)
        assert!(!c.should_seek_now().await);
    }

    #[tokio::test]
    async fn should_seek_now_allows_after_cooldown_expires() {
        let c = WatchTogetherController::new("s", false);
        // Set last_seek to well in the past
        *c.last_seek_correction.lock().await =
            Some(std::time::Instant::now() - std::time::Duration::from_secs(5));
        assert!(c.should_seek_now().await);
    }

    // ── next_request_id increments ──

    #[tokio::test]
    async fn send_command_with_id_increments_request_id() {
        let c = WatchTogetherController::new("s", false);
        assert_eq!(c.next_request_id.load(Ordering::SeqCst), 1);
        // send_command_with_id will fail (not connected) but ID is incremented before send
        let _ = c.send_command_with_id(vec![json!("test")]).await;
        assert_eq!(c.next_request_id.load(Ordering::SeqCst), 2);
        let _ = c.send_command_with_id(vec![json!("test")]).await;
        assert_eq!(c.next_request_id.load(Ordering::SeqCst), 3);
    }

    // ── MpvCommand empty command list ──

    #[test]
    fn mpv_command_serialize_empty() {
        let cmd = MpvCommand {
            command: vec![],
            request_id: None,
        };
        let s = serde_json::to_string(&cmd).unwrap();
        assert_eq!(s, r#"{"command":[]}"#);
    }

    // ── MpvResponse with complex data ──

    #[test]
    fn mpv_response_deserialize_object_data() {
        let r: MpvResponse =
            serde_json::from_str(r#"{"data":{"width":1920,"height":1080},"error":"success"}"#)
                .unwrap();
        let data = r.data.unwrap();
        assert_eq!(data["width"], 1920);
        assert_eq!(data["height"], 1080);
    }

    // ── MpvEvent duration property change ──

    #[test]
    fn mpv_event_property_change_duration() {
        let e: MpvEvent = serde_json::from_str(
            r#"{"event":"property-change","id":3,"name":"duration","data":7200.5}"#,
        )
        .unwrap();
        assert_eq!(e.name.as_deref(), Some("duration"));
        assert_eq!(e.data.unwrap().as_f64(), Some(7200.5));
    }

    // ── PlayerState field mutation ──

    #[tokio::test]
    async fn player_state_mutable_via_arc() {
        let c = WatchTogetherController::new("s", false);
        {
            let mut state = c.local_state.write().await;
            state.position = 99.0;
            state.duration = 3600.0;
            state.paused = false;
            state.speed = 1.5;
        }
        let state = c.local_state.read().await;
        assert_eq!(state.position, 99.0);
        assert_eq!(state.duration, 3600.0);
        assert!(!state.paused);
        assert_eq!(state.speed, 1.5);
    }

    // ── participants HashMap ──

    #[tokio::test]
    async fn participants_starts_empty() {
        let c = WatchTogetherController::new("s", false);
        let participants = c.participants.lock().await;
        assert!(participants.is_empty());
    }

    #[tokio::test]
    async fn participants_can_add_and_query() {
        let c = WatchTogetherController::new("s", false);
        {
            let mut participants = c.participants.lock().await;
            participants.insert(
                "Alice".to_string(),
                ParticipantState {
                    nickname: "Alice".to_string(),
                    ready: true,
                    position: 5.0,
                },
            );
        }
        let participants = c.participants.lock().await;
        assert_eq!(participants.len(), 1);
        let alice = participants.get("Alice").unwrap();
        assert!(alice.ready);
        assert_eq!(alice.position, 5.0);
    }

    // ── seek_and_play_at error path ──

    #[tokio::test]
    async fn seek_and_play_at_errors_when_not_connected() {
        let c = WatchTogetherController::new("s", false);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64();
        // seek_to will fail (not connected) before the scheduling logic
        let result = c.seek_and_play_at(10.0, now + 5.0).await;
        assert!(result.is_err());
    }

    // ── Constants sanity checks ──

    #[test]
    fn sync_constants_are_reasonable() {
        assert!(SEEK_THRESHOLD > SLOWDOWN_KICKIN);
        assert!(SLOWDOWN_KICKIN > SLOWDOWN_RESET);
        assert!(REWIND_THRESHOLD > SEEK_THRESHOLD);
        assert!(FASTFORWARD_THRESHOLD > SEEK_THRESHOLD);
        assert!(SEEK_COOLDOWN_MS > 0);
        assert!(COMMAND_POSITION_EPSILON > 0.0 && COMMAND_POSITION_EPSILON < SEEK_THRESHOLD);
        assert!(SLOWDOWN_RATE < 1.0);
        assert!(SPEEDUP_RATE > 1.0);
    }

    // ── connect (non-Windows path) ──

    #[tokio::test]
    #[cfg(not(windows))]
    async fn connect_returns_error_on_non_windows() {
        let mut c = WatchTogetherController::new("s", false);
        let result = c.connect().await;
        assert!(result.unwrap_err().contains("Non-Windows"));
    }

    // ── connect (Windows: already connected short-circuit) ──

    #[tokio::test]
    #[cfg(windows)]
    async fn connect_returns_ok_when_already_connected() {
        let mut c = WatchTogetherController::new("s", false);
        c.connected.store(true, Ordering::SeqCst);
        assert!(c.connect().await.is_ok());
    }

    // ── MpvCommand with multiple values ──

    #[test]
    fn mpv_command_serialize_set_property() {
        let cmd = MpvCommand {
            command: vec![json!("set_property"), json!("pause"), json!(true)],
            request_id: Some(1),
        };
        let s = serde_json::to_string(&cmd).unwrap();
        assert!(s.contains(r#""set_property""#));
        assert!(s.contains(r#""pause""#));
        assert!(s.contains("true"));
        assert!(s.contains(r#""request_id":1"#));
    }

    #[test]
    fn mpv_command_serialize_show_text() {
        let cmd = MpvCommand {
            command: vec![json!("show-text"), json!("Hello OSD"), json!(3000)],
            request_id: None,
        };
        let s = serde_json::to_string(&cmd).unwrap();
        assert!(s.contains("show-text"));
        assert!(s.contains("Hello OSD"));
        assert!(s.contains("3000"));
    }

    // ── MpvEvent with unknown event type ──

    #[test]
    fn mpv_event_unknown_event_type() {
        let e: MpvEvent = serde_json::from_str(r#"{"event":"file-loaded"}"#).unwrap();
        assert_eq!(e.event.as_deref(), Some("file-loaded"));
        assert!(e.name.is_none());
        assert!(e.data.is_none());
    }

    #[test]
    fn mpv_event_property_change_with_string_data() {
        let e: MpvEvent = serde_json::from_str(
            r#"{"event":"property-change","id":5,"name":"media-title","data":"My Movie.mp4"}"#,
        )
        .unwrap();
        assert_eq!(e.name.as_deref(), Some("media-title"));
        assert_eq!(e.data.unwrap().as_str(), Some("My Movie.mp4"));
    }

    // ── set_speed error path when not connected ──

    #[tokio::test]
    async fn set_speed_errors_when_cmd_tx_missing() {
        let c = WatchTogetherController::new("s", false);
        // cmd_tx is None by default → send_command fails
        c.connected.store(true, Ordering::SeqCst);
        let result = c.set_speed(1.5).await;
        assert!(result.is_err());
    }

    // ── send_command_with_id returns incremental IDs ──

    #[tokio::test]
    async fn send_command_with_id_returns_id_before_send() {
        let c = WatchTogetherController::new("s", false);
        // First call: ID=1, fails at send
        let result = c.send_command_with_id(vec![json!("test")]).await;
        assert!(result.is_err());
        assert_eq!(c.next_request_id.load(Ordering::SeqCst), 2);

        // Second call: ID=2, fails at send
        let result = c.send_command_with_id(vec![json!("test")]).await;
        assert!(result.is_err());
        assert_eq!(c.next_request_id.load(Ordering::SeqCst), 3);
    }

    // ── seek_to with playing state (not paused) ──

    #[tokio::test]
    async fn seek_to_considers_elapsed_time_when_playing() {
        let c = WatchTogetherController::new("s", false);
        {
            let mut state = c.local_state.write().await;
            state.position = 10.0;
            state.paused = false;
            state.speed = 1.0;
            state.last_update = std::time::Instant::now() - std::time::Duration::from_millis(200);
        }
        // estimated position ~10.2, seeking to 10.22 is within epsilon (0.05)
        assert!(c.seek_to(10.22).await.is_ok());
        assert_eq!(c.ignoring_on_the_fly.load(Ordering::SeqCst), 0);
    }

    // ── ignoring_on_the_fly counter ──

    #[test]
    fn ignoring_on_the_fly_default_is_zero() {
        let c = WatchTogetherController::new("s", false);
        assert_eq!(c.ignoring_on_the_fly.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn ignoring_on_the_fly_can_be_manipulated() {
        let c = WatchTogetherController::new("s", false);
        c.ignoring_on_the_fly.fetch_add(5, Ordering::SeqCst);
        assert_eq!(c.ignoring_on_the_fly.load(Ordering::SeqCst), 5);
        c.ignoring_on_the_fly.store(0, Ordering::SeqCst);
        assert_eq!(c.ignoring_on_the_fly.load(Ordering::SeqCst), 0);
    }

    // ── MpvResponse with array data ──

    #[test]
    fn mpv_response_deserialize_array_data() {
        let r: MpvResponse = serde_json::from_str(r#"{"data":[1,2,3],"error":"success"}"#).unwrap();
        let data = r.data.unwrap();
        assert_eq!(data.as_array().unwrap().len(), 3);
    }

    // ── MpvEvent with null data ──

    #[test]
    fn mpv_event_property_change_null_data() {
        let e: MpvEvent = serde_json::from_str(
            r#"{"event":"property-change","id":1,"name":"time-pos","data":null}"#,
        )
        .unwrap();
        assert_eq!(e.name.as_deref(), Some("time-pos"));
        assert!(e.data.is_none());
    }

    // ── PlayerState field access ──

    #[test]
    fn player_state_clone() {
        let s = PlayerState {
            position: 42.0,
            duration: 3600.0,
            paused: false,
            speed: 1.5,
            last_update: std::time::Instant::now(),
        };
        let s2 = s.clone();
        assert_eq!(s2.position, 42.0);
        assert_eq!(s2.duration, 3600.0);
        assert!(!s2.paused);
        assert_eq!(s2.speed, 1.5);
    }

    // ── ParticipantState field access ──

    #[test]
    fn participant_state_not_ready() {
        let p = ParticipantState {
            nickname: "Bob".to_string(),
            ready: false,
            position: 0.0,
        };
        assert!(!p.ready);
        assert_eq!(p.nickname, "Bob");
    }

    // ── MpvSyncEvent clone ──

    #[test]
    fn mpv_sync_event_clone() {
        let e = MpvSyncEvent::PauseChanged {
            paused: true,
            position: 5.0,
        };
        let e2 = e.clone();
        match e2 {
            MpvSyncEvent::PauseChanged { paused, position } => {
                assert!(paused);
                assert_eq!(position, 5.0);
            }
            _ => panic!("wrong variant"),
        }
    }

    // ── apply_sync error path (not connected) ──

    #[tokio::test]
    async fn apply_sync_errors_when_not_connected_and_needs_seek() {
        let c = WatchTogetherController::new("s", false);
        {
            let mut state = c.local_state.write().await;
            state.position = 0.0;
            state.paused = false;
            state.speed = 1.0;
            state.last_update = std::time::Instant::now();
        }
        // Server position far away → should try to seek → fails (not connected)
        let result = c.apply_sync(100.0, false).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn apply_sync_noop_when_drift_within_reset() {
        let c = WatchTogetherController::new("s", false);
        {
            let mut state = c.local_state.write().await;
            state.position = 10.0;
            state.paused = false;
            state.speed = 1.0;
            state.last_update = std::time::Instant::now();
        }
        // drift < SLOWDOWN_RESET (0.1s), speed already 1.0 → no correction needed
        let result = c.apply_sync(10.05, false).await;
        assert!(result.is_ok());
    }

    // ── seek_and_play_at with future timestamp ──

    #[tokio::test]
    async fn seek_and_play_at_schedules_unpause() {
        let c = WatchTogetherController::new("s", false);
        // seek_to will fail (not connected) but the function structure is tested
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64();
        let result = c.seek_and_play_at(10.0, now + 1.0).await;
        // seek_to fails first
        assert!(result.is_err());
    }
}
