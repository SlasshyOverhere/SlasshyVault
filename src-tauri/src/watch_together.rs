// Watch Together Module
// Synchronized MPV playback across remote users via WebSocket relay

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, RwLock};
use dirs;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, protocol::Message},
};
use uuid::Uuid;

// Backend server URL - reads from env var, config file override, falls back to production
fn get_relay_server_url() -> String {
    if let Ok(ws_url) = std::env::var("STREAMVAULT_WS_URL") {
        let trimmed = ws_url.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }

    // Check media_config.json for dev_backend_url override
    let config_dir = if cfg!(debug_assertions) { "SlasshyVault-Dev" } else { "SlasshyVault" };
    if let Some(config_path) = dirs::data_dir().map(|d| d.join(config_dir).join("media_config.json")) {
        if let Ok(contents) = std::fs::read_to_string(&config_path) {
            if let Ok(config) = serde_json::from_str::<serde_json::Value>(&contents) {
                if let Some(backend_url) = config.get("dev_backend_url").and_then(|v| v.as_str()) {
                    let trimmed = backend_url.trim().trim_end_matches('/').to_string();
                    if !trimmed.is_empty() {
                        // Convert http:// -> ws:// and https:// -> wss://
                        let ws_url = trimmed
                            .replace("https://", "wss://")
                            .replace("http://", "ws://");
                        return format!("{}/ws/watchtogether", ws_url);
                    }
                }
            }
        }
    }

    "wss://slasshyvault.onrender.com/ws/watchtogether".to_string()
}

// Room code characters (no ambiguous chars like I/1/O/0)
const CODE_CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Generate a 6-character room code
pub fn generate_room_code() -> String {
    use rand::rngs::OsRng;
    use rand::Rng;
    let mut rng = OsRng;
    (0..6)
        .map(|_| {
            let idx = rng.gen_range(0..CODE_CHARS.len());
            CODE_CHARS[idx] as char
        })
        .collect()
}

/// Participant in a watch room
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Participant {
    pub id: String,
    pub nickname: String,
    pub is_host: bool,
    pub is_ready: bool,
    pub duration: Option<f64>,
}

/// Room information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomInfo {
    pub code: String,
    pub host_id: String,
    pub media_title: String,
    pub media_id: i64,
    pub participants: Vec<Participant>,
    #[serde(default)]
    pub is_playing: bool,
    #[serde(default)]
    pub state: Option<String>,
    pub current_position: f64,
}

/// Sync command with metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncCommand {
    pub action: String,
    pub position: f64,
    pub from: Option<String>,
    pub timestamp: Option<i64>,
}

/// Messages sent from client to server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "create")]
    Create {
        media_title: String,
        media_id: i64,
        media_match_key: Option<String>,
        nickname: String,
        client_id: String,
    },
    #[serde(rename = "join")]
    Join {
        room_code: String,
        nickname: String,
        client_id: String,
        media_id: i64,
        media_title: Option<String>,
        media_match_key: Option<String>,
    },
    #[serde(rename = "ready")]
    Ready { duration: f64 },
    #[serde(rename = "sync")]
    Sync { command: SyncCommand },
    #[serde(rename = "start")]
    Start,
    #[serde(rename = "leave")]
    Leave,
    #[serde(rename = "heartbeat")]
    Heartbeat,
    /// Periodic state report (Syncplay-style) - sent every ~1s
    #[serde(rename = "state_report")]
    StateReport { position: f64, paused: bool },
    /// Pong response for RTT measurement
    #[serde(rename = "pong_report")]
    PongReport { ping_id: String, rtt: f64 },
    /// LBAS: Client reports buffering state
    #[serde(rename = "buffering_started")]
    BufferingStarted { position: f64 },
}

/// Participant sync info from server state_update
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParticipantSyncInfo {
    pub id: String,
    pub nickname: String,
    pub position: f64,
    pub paused: bool,
    pub rtt: i64,
}

/// Messages received from server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "room_created")]
    RoomCreated { room: RoomInfo },
    #[serde(rename = "room_joined")]
    RoomJoined { room: RoomInfo },
    #[serde(rename = "room_state")]
    RoomState { room: RoomInfo },
    #[serde(rename = "sync")]
    Sync {
        command: SyncCommand,
        from: String,
        timestamp: i64,
        #[serde(default)]
        is_echo: bool,
    },
    #[serde(rename = "participant_joined")]
    ParticipantJoined { participant: Participant },
    #[serde(rename = "participant_left")]
    ParticipantLeft {
        participant_id: String,
        #[serde(default)]
        room: Option<RoomInfo>,
    },
    #[serde(rename = "participant_ready")]
    ParticipantReady {
        participant_id: String,
        duration: f64,
    },
    #[serde(rename = "playback_started")]
    PlaybackStarted { position: f64 },
    #[serde(rename = "error")]
    Error { message: String },
    /// Periodic state update from server with authoritative position
    #[serde(rename = "state_update")]
    StateUpdate {
        position: f64,
        paused: bool,
        server_time: i64,
        your_rtt: f64,
        #[serde(default)]
        participants: Vec<ParticipantSyncInfo>,
    },
    /// Ping from server for RTT measurement
    #[serde(rename = "ping")]
    Ping { ping_id: String, server_time: i64 },
    #[serde(rename = "pong")]
    Pong {
        ping_id: String,
        server_time: i64,
        your_rtt: f64,
    },
    #[serde(rename = "heartbeat_ack")]
    HeartbeatAck { timestamp: i64 },
    /// LBAS: Server instructs all clients to prepare for playback
    #[serde(rename = "prepare")]
    Prepare { position: f64, pre_buffer_target: u32 },
    /// LBAS: Server schedules collective resume at a specific timestamp
    #[serde(rename = "play_at")]
    PlayAt { position: f64, play_at_timestamp: f64 },
    /// LBAS: Server resumes playback after all participants recovered from buffering
    #[serde(rename = "sync_resume")]
    SyncResume { position: f64, play_at_timestamp: f64 },
    /// LBAS: Server pauses playback due to a buffering participant
    #[serde(rename = "pause")]
    Pause { reason: String, triggered_by: String },
}

/// Watch session state
#[derive(Debug)]
pub struct WatchSession {
    pub client_id: String,
    pub room_info: Arc<RwLock<Option<RoomInfo>>>,
    pub is_host: bool,
    pub media_id: i64,
    pub mpv_pid: Option<u32>,
    command_tx: Option<mpsc::Sender<ClientMessage>>,
    shutdown_tx: Option<mpsc::Sender<()>>,
}

impl WatchSession {
    pub fn new(media_id: i64, is_host: bool) -> Self {
        Self {
            client_id: Uuid::new_v4().to_string(),
            room_info: Arc::new(RwLock::new(None)),
            is_host,
            media_id,
            mpv_pid: None,
            command_tx: None,
            shutdown_tx: None,
        }
    }

    /// Send a message to the relay server
    pub async fn send_message(&self, msg: ClientMessage) -> Result<(), String> {
        if let Some(tx) = &self.command_tx {
            tx.send(msg)
                .await
                .map_err(|e| format!("Failed to send message: {}", e))
        } else {
            Err("Not connected to server".to_string())
        }
    }

    /// Read current room state without cloning
    pub async fn read_room_info<F, R>(&self, f: F) -> R
    where
        F: FnOnce(Option<&RoomInfo>) -> R,
    {
        let guard = self.room_info.read().await;
        f(guard.as_ref())
    }
}

/// Watch Together manager
pub struct WatchTogetherManager {
    pub session: Arc<Mutex<Option<WatchSession>>>,
    event_callback: Arc<Mutex<Option<Box<dyn Fn(WatchEvent) + Send + Sync>>>>,
}

/// Events emitted to the frontend
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum WatchEvent {
    #[serde(rename = "room_updated")]
    RoomUpdated { room: RoomInfo },
    #[serde(rename = "sync_command")]
    SyncCommand { command: SyncCommand },
    #[serde(rename = "participant_changed")]
    ParticipantChanged { room: RoomInfo },
    #[serde(rename = "playback_started")]
    PlaybackStarted { position: f64 },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "disconnected")]
    Disconnected,
    /// Server authoritative position update (for sync engine)
    #[serde(rename = "state_update")]
    StateUpdate {
        position: f64,
        paused: bool,
        your_rtt: f64,
        participants: Vec<ParticipantSyncInfo>,
    },
    /// LBAS: Server instructs client to prepare for playback
    #[serde(rename = "prepare")]
    Prepare { position: f64, pre_buffer_target: u32 },
    /// LBAS: Server schedules collective resume
    #[serde(rename = "play_at")]
    PlayAt { position: f64, play_at_timestamp: f64 },
    /// LBAS: Server resumes after buffering recovery
    #[serde(rename = "sync_resume")]
    SyncResume { position: f64, play_at_timestamp: f64 },
    /// LBAS: Server pauses due to buffering
    #[serde(rename = "pause")]
    Pause { reason: String, triggered_by: String },
    /// Show OSD message inside MPV player (like Syncplay)
    #[serde(rename = "show_osd")]
    ShowOsd { message: String, duration_ms: u64 },
}

impl WatchTogetherManager {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
            event_callback: Arc::new(Mutex::new(None)),
        }
    }

    fn normalize_room(mut room: RoomInfo) -> RoomInfo {
        if !room.is_playing {
            if let Some(state) = room.state.as_deref() {
                if state == "playing" {
                    room.is_playing = true;
                }
            }
        }
        room
    }

    /// Set the event callback for frontend notifications
    pub async fn set_event_callback<F>(&self, callback: F)
    where
        F: Fn(WatchEvent) + Send + Sync + 'static,
    {
        let mut cb = self.event_callback.lock().await;
        *cb = Some(Box::new(callback));
    }

    /// Emit an event to the frontend
    async fn emit_event(&self, event: WatchEvent) {
        if let Some(callback) = self.event_callback.lock().await.as_ref() {
            callback(event);
        }
    }

    /// Create a new room
    pub async fn create_room(
        &self,
        media_id: i64,
        media_title: String,
        media_match_key: Option<String>,
        nickname: String,
    ) -> Result<RoomInfo, String> {
        let mut session_guard = self.session.lock().await;

        // Close existing session if any
        if session_guard.is_some() {
            drop(session_guard);
            self.leave_room().await?;
            session_guard = self.session.lock().await;
        }

        let mut session = WatchSession::new(media_id, true);
        let client_id = session.client_id.clone();
        let room_info = session.room_info.clone();

        // Connect to WebSocket server
        let relay_url = get_relay_server_url();
        println!("[WT] Connecting to relay server: {}", relay_url);

        let mut request = relay_url
            .into_client_request()
            .map_err(|e| format!("Invalid WebSocket URL: {}", e))?;

        filter_websocket_extensions(&mut request);

        let (ws_stream, _) = connect_async(request)
            .await
            .map_err(|e| {
                eprintln!("[WT] Connection error details: {} (url: ...)", e);
                format!("Could not connect to Watch Together server. Please check your internet connection and try again. ({})", e)
            })?;

        let (mut write, mut read) = ws_stream.split();

        // Create channels for communication
        let (command_tx, mut command_rx) = mpsc::channel::<ClientMessage>(32);
        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

        session.command_tx = Some(command_tx.clone());
        session.shutdown_tx = Some(shutdown_tx);

        // Send create room message
        let create_msg = ClientMessage::Create {
            media_title: media_title.clone(),
            media_id,
            media_match_key,
            nickname: nickname.chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).take(30).collect::<String>(),
            client_id: client_id.clone(),
        };

        let msg_json = serde_json::to_string(&create_msg)
            .map_err(|e| format!("Failed to serialize message: {}", e))?;

        write
            .send(Message::Text(msg_json))
            .await
            .map_err(|e| format!("Failed to send create message: {}", e))?;

        // Wait for room_created response
        let room_result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(server_msg) = serde_json::from_str::<ServerMessage>(&text) {
                            match server_msg {
                                ServerMessage::RoomCreated { room } => {
                                    return Ok(Self::normalize_room(room));
                                }
                                ServerMessage::Error { message } => {
                                    return Err(message);
                                }
                                _ => continue,
                            }
                        }
                    }
                    Err(e) => return Err(format!("WebSocket error: {}", e)),
                    _ => continue,
                }
            }
            Err("Connection closed".to_string())
        })
        .await
        .map_err(|_| "Timeout waiting for room creation".to_string())??;

        // Store room info
        {
            let mut info = room_info.write().await;
            *info = Some(room_result.clone());
        }

        // Spawn background task to handle messages
        let event_callback = self.event_callback.clone();
        let room_info_clone = room_info.clone();
        let ping_times: Arc<Mutex<std::collections::HashMap<String, std::time::Instant>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let command_tx_clone = command_tx.clone();

        tokio::spawn(async move {
            let mut ping_counter: u64 = 0;
            let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(3));
            ping_interval.tick().await; // Skip first immediate tick

            loop {
                tokio::select! {
                    // Handle incoming messages from server
                    msg = read.next() => {
                        match msg {
                            Some(Ok(Message::Text(text))) => {
                                if let Ok(server_msg) = serde_json::from_str::<ServerMessage>(&text) {
                                    Self::handle_server_message(
                                        server_msg,
                                        &room_info_clone,
                                        &event_callback,
                                        &command_tx_clone,
                                        &ping_times,
                                    ).await;
                                }
                            }
                            Some(Ok(Message::Close(_))) | None => {
                                if let Some(callback) = event_callback.lock().await.as_ref() {
                                    callback(WatchEvent::Disconnected);
                                }
                                break;
                            }
                            _ => continue,
                        }
                    }
                    // Handle outgoing messages
                    Some(client_msg) = command_rx.recv() => {
                        if let Ok(json) = serde_json::to_string(&client_msg) {
                            let _ = write.send(Message::Text(json)).await;
                        }
                    }
                    // Periodic ping for RTT measurement
                    _ = ping_interval.tick() => {
                        ping_counter += 1;
                        let ping_id = format!("client-{}", ping_counter);
                        ping_times.lock().await.insert(ping_id.clone(), std::time::Instant::now());
                        // Cleanup ping entries older than 30s
                        {
                            let mut times = ping_times.lock().await;
                            let cutoff = std::time::Instant::now() - std::time::Duration::from_secs(30);
                            times.retain(|_, v| *v > cutoff);
                        }
                        // Send ping as raw JSON (not through ClientMessage enum to keep it simple)
                        let ping_json = serde_json::json!({
                            "type": "ping",
                            "ping_id": ping_id,
                        });
                        let _ = write.send(Message::Text(ping_json.to_string())).await;
                    }
                    // Handle shutdown
                    _ = shutdown_rx.recv() => {
                        // Send Leave before Close to ensure clean server-side departure
                        let leave_json = serde_json::json!({"type": "leave"});
                        let _ = write.send(Message::Text(leave_json.to_string())).await;
                        let _ = write.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
        });

        *session_guard = Some(session);
        Ok(room_result)
    }

    /// Join an existing room
    pub async fn join_room(
        &self,
        room_code: String,
        media_id: i64,
        media_title: Option<String>,
        media_match_key: Option<String>,
        nickname: String,
    ) -> Result<RoomInfo, String> {
        let mut session_guard = self.session.lock().await;

        // Close existing session if any
        if session_guard.is_some() {
            drop(session_guard);
            self.leave_room().await?;
            session_guard = self.session.lock().await;
        }

        let mut session = WatchSession::new(media_id, false);
        let client_id = session.client_id.clone();
        let room_info = session.room_info.clone();

        // Connect to WebSocket server
        let relay_url = get_relay_server_url();
        println!("[WT] Connecting to relay server: {}", relay_url);

        let mut request = relay_url
            .into_client_request()
            .map_err(|e| format!("Invalid WebSocket URL: {}", e))?;

        filter_websocket_extensions(&mut request);

        let (ws_stream, _) = connect_async(request)
            .await
            .map_err(|e| format!("Failed to connect to relay server: {}", e))?;

        let (mut write, mut read) = ws_stream.split();

        // Create channels
        let (command_tx, mut command_rx) = mpsc::channel::<ClientMessage>(32);
        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

        session.command_tx = Some(command_tx.clone());
        session.shutdown_tx = Some(shutdown_tx);

        // Send join message
        let join_msg = ClientMessage::Join {
            room_code: room_code.to_uppercase(),
            nickname: nickname.chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).take(30).collect::<String>(),
            client_id: client_id.clone(),
            media_id,
            media_title,
            media_match_key,
        };

        let msg_json = serde_json::to_string(&join_msg)
            .map_err(|e| format!("Failed to serialize message: {}", e))?;

        write
            .send(Message::Text(msg_json))
            .await
            .map_err(|e| format!("Failed to send join message: {}", e))?;

        // Wait for room_joined response
        let room_result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(server_msg) = serde_json::from_str::<ServerMessage>(&text) {
                            match server_msg {
                                ServerMessage::RoomJoined { room } => {
                                    return Ok(Self::normalize_room(room));
                                }
                                ServerMessage::Error { message } => {
                                    return Err(message);
                                }
                                _ => continue,
                            }
                        }
                    }
                    Err(e) => return Err(format!("WebSocket error: {}", e)),
                    _ => continue,
                }
            }
            Err("Connection closed".to_string())
        })
        .await
        .map_err(|_| "Timeout waiting for room join".to_string())??;

        // Store room info
        {
            let mut info = room_info.write().await;
            *info = Some(room_result.clone());
        }

        // Spawn background task
        let event_callback = self.event_callback.clone();
        let room_info_clone = room_info.clone();
        let ping_times: Arc<Mutex<std::collections::HashMap<String, std::time::Instant>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let command_tx_clone = command_tx.clone();

        tokio::spawn(async move {
            let mut ping_counter: u64 = 0;
            let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(3));
            ping_interval.tick().await; // Skip first immediate tick

            loop {
                tokio::select! {
                    msg = read.next() => {
                        match msg {
                            Some(Ok(Message::Text(text))) => {
                                if let Ok(server_msg) = serde_json::from_str::<ServerMessage>(&text) {
                                    Self::handle_server_message(
                                        server_msg,
                                        &room_info_clone,
                                        &event_callback,
                                        &command_tx_clone,
                                        &ping_times,
                                    ).await;
                                }
                            }
                            Some(Ok(Message::Close(_))) | None => {
                                if let Some(callback) = event_callback.lock().await.as_ref() {
                                    callback(WatchEvent::Disconnected);
                                }
                                break;
                            }
                            _ => continue,
                        }
                    }
                    Some(client_msg) = command_rx.recv() => {
                        if let Ok(json) = serde_json::to_string(&client_msg) {
                            let _ = write.send(Message::Text(json)).await;
                        }
                    }
                    // Periodic ping for RTT measurement
                    _ = ping_interval.tick() => {
                        ping_counter += 1;
                        let ping_id = format!("client-{}", ping_counter);
                        ping_times.lock().await.insert(ping_id.clone(), std::time::Instant::now());
                        // Cleanup ping entries older than 30s
                        {
                            let mut times = ping_times.lock().await;
                            let cutoff = std::time::Instant::now() - std::time::Duration::from_secs(30);
                            times.retain(|_, v| *v > cutoff);
                        }
                        let ping_json = serde_json::json!({
                            "type": "ping",
                            "ping_id": ping_id,
                        });
                        let _ = write.send(Message::Text(ping_json.to_string())).await;
                    }
                    _ = shutdown_rx.recv() => {
                        // Send Leave before Close to ensure clean server-side departure
                        let leave_json = serde_json::json!({"type": "leave"});
                        let _ = write.send(Message::Text(leave_json.to_string())).await;
                        let _ = write.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
        });

        *session_guard = Some(session);
        Ok(room_result)
    }

    /// Handle incoming server messages
    async fn handle_server_message(
        msg: ServerMessage,
        room_info: &Arc<RwLock<Option<RoomInfo>>>,
        event_callback: &Arc<Mutex<Option<Box<dyn Fn(WatchEvent) + Send + Sync>>>>,
        command_tx: &mpsc::Sender<ClientMessage>,
        ping_times: &Arc<Mutex<std::collections::HashMap<String, std::time::Instant>>>,
    ) {
        let emit = |event: WatchEvent| {
            let cb = event_callback.clone();
            async move {
                if let Some(callback) = cb.lock().await.as_ref() {
                    callback(event);
                }
            }
        };

        match msg {
            ServerMessage::RoomState { room } => {
                let room = Self::normalize_room(room);
                {
                    let mut info = room_info.write().await;
                    *info = Some(room.clone());
                }
                emit(WatchEvent::RoomUpdated { room }).await;
            }
            ServerMessage::Sync {
                command,
                from,
                timestamp,
                is_echo,
            } => {
                // Skip echo messages (our own sync commands reflected back)
                if is_echo {
                    return;
                }
                let cmd = SyncCommand {
                    action: command.action,
                    position: command.position,
                    from: Some(from),
                    timestamp: Some(timestamp),
                };
                emit(WatchEvent::SyncCommand { command: cmd }).await;
            }
            ServerMessage::StateUpdate {
                position,
                paused,
                your_rtt,
                participants,
                ..
            } => {
                // Emit state_update for the sync engine in main.rs to apply
                emit(WatchEvent::StateUpdate {
                    position,
                    paused,
                    your_rtt,
                    participants,
                })
                .await;
            }
            ServerMessage::Ping { .. } => {
                // Ignore server-side pings here. RTT is measured via our own client ping -> server pong cycle.
            }
            ServerMessage::Pong { ping_id, .. } => {
                // We sent a ping and got a pong back - calculate RTT
                let mut times = ping_times.lock().await;
                if let Some(sent_at) = times.remove(&ping_id) {
                    let rtt_ms = sent_at.elapsed().as_secs_f64() * 1000.0;
                    // Report our measured RTT to the server
                    let _ = command_tx
                        .send(ClientMessage::PongReport {
                            ping_id,
                            rtt: rtt_ms,
                        })
                        .await;
                }
            }
            ServerMessage::ParticipantJoined { participant } => {
                let mut info = room_info.write().await;
                if let Some(ref mut room) = *info {
                    if let Some(existing) = room
                        .participants
                        .iter_mut()
                        .find(|p| p.id == participant.id)
                    {
                        *existing = participant;
                    } else {
                        room.participants.push(participant);
                    }
                    emit(WatchEvent::ParticipantChanged { room: room.clone() }).await;
                }
            }
            ServerMessage::ParticipantLeft {
                participant_id,
                room,
            } => {
                let mut info = room_info.write().await;
                if let Some(snapshot) = room {
                    let normalized = Self::normalize_room(snapshot);
                    *info = Some(normalized.clone());
                    emit(WatchEvent::ParticipantChanged { room: normalized }).await;
                } else if let Some(ref mut room) = *info {
                    room.participants.retain(|p| p.id != participant_id);
                    emit(WatchEvent::ParticipantChanged { room: room.clone() }).await;
                }
            }
            ServerMessage::ParticipantReady {
                participant_id,
                duration,
            } => {
                let mut info = room_info.write().await;
                if let Some(ref mut room) = *info {
                    if let Some(p) = room
                        .participants
                        .iter_mut()
                        .find(|p| p.id == participant_id)
                    {
                        p.is_ready = true;
                        p.duration = Some(duration);
                    }
                    emit(WatchEvent::ParticipantChanged { room: room.clone() }).await;
                }
            }
            ServerMessage::PlaybackStarted { position } => {
                let mut info = room_info.write().await;
                if let Some(ref mut room) = *info {
                    room.is_playing = true;
                    room.state = Some("playing".to_string());
                    room.current_position = position;
                }
                emit(WatchEvent::PlaybackStarted { position }).await;
            }
            ServerMessage::Error { message } => {
                emit(WatchEvent::Error { message }).await;
            }
            ServerMessage::Prepare { position, pre_buffer_target } => {
                emit(WatchEvent::Prepare { position, pre_buffer_target }).await;
                emit(WatchEvent::ShowOsd {
                    message: format!("Pre-buffering {}s for smooth playback...", pre_buffer_target),
                    duration_ms: 3000,
                }).await;
            }
            ServerMessage::PlayAt { position, play_at_timestamp } => {
                emit(WatchEvent::PlayAt { position, play_at_timestamp }).await;
                emit(WatchEvent::ShowOsd {
                    message: "Starting synchronized playback".to_string(),
                    duration_ms: 3000,
                }).await;
            }
            ServerMessage::SyncResume { position, play_at_timestamp } => {
                emit(WatchEvent::SyncResume { position, play_at_timestamp }).await;
                emit(WatchEvent::ShowOsd {
                    message: "Resuming sync — all participants ready".to_string(),
                    duration_ms: 2000,
                }).await;
            }
            ServerMessage::Pause { reason, triggered_by } => {
                let tid = triggered_by.clone();
                let nickname = {
                    let info = room_info.read().await;
                    info.as_ref().and_then(|r| r.participants.iter().find(|p| p.id == tid).map(|p| p.nickname.clone()))
                        .unwrap_or_else(|| triggered_by.clone())
                };
                if reason == "buffering" {
                    emit(WatchEvent::ShowOsd {
                        message: format!("{} is buffering...", nickname),
                        duration_ms: 3000,
                    }).await;
                }
                emit(WatchEvent::Pause { reason, triggered_by }).await;
            }
            _ => {}
        }
    }

    /// Leave the current room
    pub async fn leave_room(&self) -> Result<(), String> {
        let mut session_guard = self.session.lock().await;

        if let Some(session) = session_guard.take() {
            // Send leave message
            if let Some(tx) = &session.command_tx {
                let _ = tx.send(ClientMessage::Leave).await;
                // Keep socket alive long enough for Leave to reach relay on higher-latency links.
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
            }

            // Trigger shutdown
            if let Some(shutdown_tx) = session.shutdown_tx {
                let _ = shutdown_tx.send(()).await;
            }
        }

        Ok(())
    }

    /// Set ready status
    pub async fn set_ready(&self, duration: f64) -> Result<(), String> {
        let session_guard = self.session.lock().await;

        if let Some(session) = session_guard.as_ref() {
            session
                .send_message(ClientMessage::Ready { duration })
                .await?;
            Ok(())
        } else {
            Err("No active session".to_string())
        }
    }

    /// Start playback (host only)
    pub async fn start_playback(&self) -> Result<(), String> {
        let session_guard = self.session.lock().await;

        if let Some(session) = session_guard.as_ref() {
            let am_host = if let Some(room) = session.room_info.read().await.as_ref() {
                room.host_id == session.client_id
            } else {
                session.is_host
            };

            if !am_host {
                return Err("Only the host can start playback".to_string());
            }
            session.send_message(ClientMessage::Start).await?;
            Ok(())
        } else {
            Err("No active session".to_string())
        }
    }

    /// Send a sync command
    pub async fn send_sync(&self, action: &str, position: f64) -> Result<(), String> {
        let session_guard = self.session.lock().await;

        if let Some(session) = session_guard.as_ref() {
            let command = SyncCommand {
                action: action.to_string(),
                position,
                from: None,
                timestamp: None,
            };
            session
                .send_message(ClientMessage::Sync { command })
                .await?;
            Ok(())
        } else {
            Err("No active session".to_string())
        }
    }

    /// Get current room state
    pub async fn get_room_state(&self) -> Option<RoomInfo> {
        let session_guard = self.session.lock().await;

        if let Some(session) = session_guard.as_ref() {
            session.read_room_info(|info| info.cloned().map(Self::normalize_room)).await
        } else {
            None
        }
    }

    /// Check if we're in an active session
    pub async fn is_active(&self) -> bool {
        self.session.lock().await.is_some()
    }

    /// Check if we're the host
    pub async fn is_host(&self) -> bool {
        if let Some(session) = self.session.lock().await.as_ref() {
            if let Some(room) = session.room_info.read().await.as_ref() {
                room.host_id == session.client_id
            } else {
                session.is_host
            }
        } else {
            false
        }
    }

    /// Get the current session client ID
    pub async fn get_client_id(&self) -> Option<String> {
        self.session
            .lock()
            .await
            .as_ref()
            .map(|session| session.client_id.clone())
    }

    /// Set the MPV process ID for the session
    pub async fn set_mpv_pid(&self, pid: u32) {
        if let Some(session) = self.session.lock().await.as_mut() {
            session.mpv_pid = Some(pid);
        }
    }

    /// Get the MPV process ID
    pub async fn get_mpv_pid(&self) -> Option<u32> {
        if let Some(session) = self.session.lock().await.as_ref() {
            session.mpv_pid
        } else {
            None
        }
    }
}

impl Default for WatchTogetherManager {
    fn default() -> Self {
        Self::new()
    }
}

fn filter_websocket_extensions(
    request: &mut http::Request<()>,
) {
    if let Some(extensions) = request.headers().get("Sec-WebSocket-Extensions") {
        let filtered: String = extensions
            .to_str()
            .unwrap_or("")
            .split(',')
            .filter_map(|ext| {
                let trimmed = ext.trim();
                if trimmed.is_empty() || trimmed.starts_with("permessage-deflate") {
                    None
                } else {
                    Some(trimmed)
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        request.headers_mut().remove("Sec-WebSocket-Extensions");
        if !filtered.is_empty() {
            if let Ok(header_val) = filtered.try_into() {
                request.headers_mut().insert("Sec-WebSocket-Extensions", header_val);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── generate_room_code ──

    #[test]
    fn room_code_is_6_chars() {
        let code = generate_room_code();
        assert_eq!(code.len(), 6);
    }

    #[test]
    fn room_code_is_alphanumeric_subset() {
        let code = generate_room_code();
        for ch in code.chars() {
            assert!(
                CODE_CHARS.contains(&(ch as u8)),
                "char '{}' not in CODE_CHARS",
                ch
            );
        }
    }

    #[test]
    fn room_codes_are_unique_over_many_calls() {
        let mut codes = std::collections::HashSet::new();
        for _ in 0..200 {
            codes.insert(generate_room_code());
        }
        // 200 calls, pool of 32^6 = ~1B codes — all should be unique
        assert_eq!(codes.len(), 200);
    }

    // ── Participant ──

    #[test]
    fn participant_serialization_roundtrip() {
        let p = Participant {
            id: "abc".into(),
            nickname: "Nick".into(),
            is_host: true,
            is_ready: false,
            duration: Some(123.4),
        };
        let json = serde_json::to_string(&p).unwrap();
        let back: Participant = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "abc");
        assert_eq!(back.nickname, "Nick");
        assert!(back.is_host);
        assert!(!back.is_ready);
        assert_eq!(back.duration, Some(123.4));
    }

    // ── RoomInfo ──

    #[test]
    fn room_info_serialization_roundtrip() {
        let r = RoomInfo {
            code: "ABC123".into(),
            host_id: "h1".into(),
            media_title: "Movie".into(),
            media_id: 42,
            participants: vec![],
            is_playing: false,
            state: None,
            current_position: 0.0,
        };
        let json = serde_json::to_string(&r).unwrap();
        let back: RoomInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.code, "ABC123");
        assert_eq!(back.media_id, 42);
        assert!(!back.is_playing);
    }

    #[test]
    fn room_info_state_defaults() {
        // is_playing and state should default when missing from JSON
        let json = r#"{"code":"X","host_id":"h","media_title":"T","media_id":1,"participants":[],"current_position":0.0}"#;
        let r: RoomInfo = serde_json::from_str(json).unwrap();
        assert!(!r.is_playing);
        assert!(r.state.is_none());
        assert_eq!(r.current_position, 0.0);
    }

    // ── SyncCommand ──

    #[test]
    fn sync_command_serialization_roundtrip() {
        let cmd = SyncCommand {
            action: "pause".into(),
            position: 42.5,
            from: Some("user1".into()),
            timestamp: Some(1234567890),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let back: SyncCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(back.action, "pause");
        assert_eq!(back.position, 42.5);
        assert_eq!(back.from, Some("user1".into()));
    }

    // ── ClientMessage enum ──

    #[test]
    fn client_message_create_serializes_tag() {
        let msg = ClientMessage::Create {
            media_title: "Test".into(),
            media_id: 1,
            media_match_key: None,
            nickname: "Nick".into(),
            client_id: "cid".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"create""#));
    }

    #[test]
    fn client_message_join_serializes_tag() {
        let msg = ClientMessage::Join {
            room_code: "ABC".into(),
            nickname: "Nick".into(),
            client_id: "cid".into(),
            media_id: 1,
            media_title: None,
            media_match_key: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"join""#));
    }

    // ── ServerMessage enum ──

    #[test]
    fn server_message_deserialize_room_created() {
        let json = r#"{"type":"room_created","room":{"code":"X","host_id":"h","media_title":"T","media_id":1,"participants":[],"current_position":0.0}}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::RoomCreated { room } => assert_eq!(room.code, "X"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_error() {
        let json = r#"{"type":"error","message":"boom"}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::Error { message } => assert_eq!(message, "boom"),
            _ => panic!("wrong variant"),
        }
    }

    // ── WatchEvent enum ──

    #[test]
    fn watch_event_serializes_tags() {
        let ev = WatchEvent::Disconnected;
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"disconnected""#));

        let ev2 = WatchEvent::ShowOsd {
            message: "hi".into(),
            duration_ms: 3000,
        };
        let json2 = serde_json::to_string(&ev2).unwrap();
        assert!(json2.contains(r#""type":"show_osd""#));
    }

    // ── ParticipantSyncInfo ──

    #[test]
    fn participant_sync_info_roundtrip() {
        let psi = ParticipantSyncInfo {
            id: "u1".into(),
            nickname: "Alice".into(),
            position: 10.0,
            paused: false,
            rtt: 50,
        };
        let json = serde_json::to_string(&psi).unwrap();
        let back: ParticipantSyncInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.rtt, 50);
    }

    // ── WatchSession::new ──

    #[test]
    fn session_new_defaults() {
        let s = WatchSession::new(42, true);
        assert_eq!(s.media_id, 42);
        assert!(s.is_host);
        assert!(!s.client_id.is_empty());
        assert!(s.mpv_pid.is_none());
        assert!(s.command_tx.is_none());
        assert!(s.shutdown_tx.is_none());
    }

    #[test]
    fn session_new_not_host() {
        let s = WatchSession::new(1, false);
        assert!(!s.is_host);
    }

    // ── WatchTogetherManager::new / Default ──

    #[tokio::test]
    async fn manager_new_starts_empty() {
        let m = WatchTogetherManager::new();
        assert!(!m.is_active().await);
        assert!(!m.is_host().await);
        assert!(m.get_client_id().await.is_none());
        assert!(m.get_room_state().await.is_none());
        assert!(m.get_mpv_pid().await.is_none());
    }

    #[tokio::test]
    async fn manager_default_trait() {
        let m = WatchTogetherManager::default();
        assert!(!m.is_active().await);
    }

    // ── Helper to inject a session with channels ──

    async fn make_manager_with_session(is_host: bool) -> (WatchTogetherManager, mpsc::Receiver<ClientMessage>) {
        let m = WatchTogetherManager::new();
        let (tx, rx) = mpsc::channel::<ClientMessage>(32);
        let (_, shutdown_rx_unused) = mpsc::channel::<()>(1);
        // keep shutdown_rx_unused alive so we don't accidentally use it
        drop(shutdown_rx_unused);

        let mut session = WatchSession::new(99, is_host);
        session.command_tx = Some(tx);

        let mut guard = m.session.lock().await;
        *guard = Some(session);
        drop(guard);

        (m, rx)
    }

    // ── is_active / get_client_id after injecting session ──

    #[tokio::test]
    async fn is_active_true_when_session_exists() {
        let (m, _rx) = make_manager_with_session(true).await;
        assert!(m.is_active().await);
    }

    #[tokio::test]
    async fn get_client_id_returns_uuid() {
        let (m, _rx) = make_manager_with_session(false).await;
        let cid = m.get_client_id().await;
        assert!(cid.is_some());
        // valid UUID format
        assert!(uuid::Uuid::parse_str(&cid.unwrap()).is_ok());
    }

    // ── is_host ──

    #[tokio::test]
    async fn is_host_without_room_info_falls_back_to_session_flag() {
        let (m, _rx) = make_manager_with_session(true).await;
        // No room_info set, should fall back to session.is_host
        assert!(m.is_host().await);
    }

    #[tokio::test]
    async fn is_host_false_for_joiner() {
        let (m, _rx) = make_manager_with_session(false).await;
        assert!(!m.is_host().await);
    }

    // ── set_mpv_pid / get_mpv_pid ──

    #[tokio::test]
    async fn set_and_get_mpv_pid() {
        let (m, _rx) = make_manager_with_session(true).await;
        assert!(m.get_mpv_pid().await.is_none());
        m.set_mpv_pid(1234).await;
        assert_eq!(m.get_mpv_pid().await, Some(1234));
    }

    #[tokio::test]
    async fn set_mpv_pid_noop_when_no_session() {
        let m = WatchTogetherManager::new();
        m.set_mpv_pid(999).await; // should not panic
        assert!(m.get_mpv_pid().await.is_none());
    }

    // ── set_ready ──

    #[tokio::test]
    async fn set_ready_sends_message() {
        let (m, mut rx) = make_manager_with_session(true).await;
        m.set_ready(120.0).await.unwrap();
        let msg = rx.recv().await.unwrap();
        match msg {
            ClientMessage::Ready { duration } => assert_eq!(duration, 120.0),
            _ => panic!("expected Ready"),
        }
    }

    #[tokio::test]
    async fn set_ready_fails_without_session() {
        let m = WatchTogetherManager::new();
        assert!(m.set_ready(1.0).await.is_err());
    }

    // ── start_playback ──

    #[tokio::test]
    async fn start_playback_host_sends_start() {
        let (m, mut rx) = make_manager_with_session(true).await;
        m.start_playback().await.unwrap();
        let msg = rx.recv().await.unwrap();
        assert!(matches!(msg, ClientMessage::Start));
    }

    #[tokio::test]
    async fn start_playback_non_host_fails() {
        let (m, _rx) = make_manager_with_session(false).await;
        let err = m.start_playback().await.unwrap_err();
        assert!(err.contains("host"));
    }

    #[tokio::test]
    async fn start_playback_fails_without_session() {
        let m = WatchTogetherManager::new();
        assert!(m.start_playback().await.is_err());
    }

    // ── send_sync ──

    #[tokio::test]
    async fn send_sync_sends_command() {
        let (m, mut rx) = make_manager_with_session(true).await;
        m.send_sync("play", 10.5).await.unwrap();
        let msg = rx.recv().await.unwrap();
        match msg {
            ClientMessage::Sync { command } => {
                assert_eq!(command.action, "play");
                assert_eq!(command.position, 10.5);
                assert!(command.from.is_none());
                assert!(command.timestamp.is_none());
            }
            _ => panic!("expected Sync"),
        }
    }

    #[tokio::test]
    async fn send_sync_fails_without_session() {
        let m = WatchTogetherManager::new();
        assert!(m.send_sync("pause", 0.0).await.is_err());
    }

    // ── leave_room ──

    #[tokio::test]
    async fn leave_room_clears_session() {
        let (m, _rx) = make_manager_with_session(true).await;
        assert!(m.is_active().await);
        m.leave_room().await.unwrap();
        assert!(!m.is_active().await);
    }

    #[tokio::test]
    async fn leave_room_noop_when_no_session() {
        let m = WatchTogetherManager::new();
        m.leave_room().await.unwrap(); // should not panic or error
        assert!(!m.is_active().await);
    }

    // ── get_room_state ──

    #[tokio::test]
    async fn get_room_state_none_when_no_room_info() {
        let (m, _rx) = make_manager_with_session(true).await;
        // session exists but room_info is None
        assert!(m.get_room_state().await.is_none());
    }

    #[tokio::test]
    async fn get_room_state_returns_room_when_set() {
        let (m, _rx) = make_manager_with_session(true).await;
        let room = RoomInfo {
            code: "TEST1".into(),
            host_id: "h1".into(),
            media_title: "Test Movie".into(),
            media_id: 10,
            participants: vec![],
            is_playing: false,
            state: Some("playing".to_string()),
            current_position: 0.0,
        };
        // Write room info into the session
        {
            let guard = m.session.lock().await;
            let session = guard.as_ref().unwrap();
            let mut info = session.room_info.write().await;
            *info = Some(room.clone());
        }

        let state = m.get_room_state().await.unwrap();
        assert_eq!(state.code, "TEST1");
        // normalize_room should set is_playing=true when state=="playing"
        assert!(state.is_playing);
    }

    // ── normalize_room ──

    #[test]
    fn normalize_room_sets_is_playing_from_state() {
        let room = RoomInfo {
            code: "X".into(),
            host_id: "h".into(),
            media_title: "T".into(),
            media_id: 1,
            participants: vec![],
            is_playing: false,
            state: Some("playing".into()),
            current_position: 0.0,
        };
        let normalized = WatchTogetherManager::normalize_room(room);
        assert!(normalized.is_playing);
    }

    #[test]
    fn normalize_room_keeps_is_playing_false_for_non_playing_state() {
        let room = RoomInfo {
            code: "X".into(),
            host_id: "h".into(),
            media_title: "T".into(),
            media_id: 1,
            participants: vec![],
            is_playing: false,
            state: Some("paused".into()),
            current_position: 0.0,
        };
        let normalized = WatchTogetherManager::normalize_room(room);
        assert!(!normalized.is_playing);
    }

    #[test]
    fn normalize_room_keeps_is_playing_false_when_state_none() {
        let room = RoomInfo {
            code: "X".into(),
            host_id: "h".into(),
            media_title: "T".into(),
            media_id: 1,
            participants: vec![],
            is_playing: false,
            state: None,
            current_position: 0.0,
        };
        let normalized = WatchTogetherManager::normalize_room(room);
        assert!(!normalized.is_playing);
    }

    // ── is_host with room_info set ──

    #[tokio::test]
    async fn is_host_checks_room_info_host_id() {
        let (m, _rx) = make_manager_with_session(true).await;
        let client_id = m.get_client_id().await.unwrap();

        let room = RoomInfo {
            code: "R1".into(),
            host_id: client_id.clone(),
            media_title: "T".into(),
            media_id: 1,
            participants: vec![],
            is_playing: false,
            state: None,
            current_position: 0.0,
        };
        {
            let guard = m.session.lock().await;
            let session = guard.as_ref().unwrap();
            let mut info = session.room_info.write().await;
            *info = Some(room);
        }

        assert!(m.is_host().await);
    }

    #[tokio::test]
    async fn is_host_false_when_different_host_id() {
        let (m, _rx) = make_manager_with_session(true).await;

        let room = RoomInfo {
            code: "R1".into(),
            host_id: "someone_else".into(),
            media_title: "T".into(),
            media_id: 1,
            participants: vec![],
            is_playing: false,
            state: None,
            current_position: 0.0,
        };
        {
            let guard = m.session.lock().await;
            let session = guard.as_ref().unwrap();
            let mut info = session.room_info.write().await;
            *info = Some(room);
        }

        assert!(!m.is_host().await);
    }

    // ── filter_websocket_extensions ──

    #[test]
    fn filter_removes_permessage_deflate() {
        let mut req = http::Request::builder()
            .uri("ws://localhost")
            .header("Sec-WebSocket-Extensions", "permessage-deflate, foo")
            .body(())
            .unwrap();
        filter_websocket_extensions(&mut req);
        let val = req.headers().get("Sec-WebSocket-Extensions").unwrap().to_str().unwrap();
        assert_eq!(val, "foo");
    }

    #[test]
    fn filter_removes_header_when_only_deflate() {
        let mut req = http::Request::builder()
            .uri("ws://localhost")
            .header("Sec-WebSocket-Extensions", "permessage-deflate")
            .body(())
            .unwrap();
        filter_websocket_extensions(&mut req);
        assert!(req.headers().get("Sec-WebSocket-Extensions").is_none());
    }

    #[test]
    fn filter_noop_when_no_header() {
        let mut req = http::Request::builder()
            .uri("ws://localhost")
            .body(())
            .unwrap();
        filter_websocket_extensions(&mut req);
        assert!(req.headers().get("Sec-WebSocket-Extensions").is_none());
    }

    // ── WatchSession::read_room_info ──

    #[tokio::test]
    async fn read_room_info_none_initially() {
        let s = WatchSession::new(1, false);
        let result: Option<String> = s.read_room_info(|info| info.map(|r| r.code.clone())).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn read_room_info_some_after_set() {
        let s = WatchSession::new(1, true);
        {
            let mut info = s.room_info.write().await;
            *info = Some(RoomInfo {
                code: "CODE1".into(),
                host_id: "h".into(),
                media_title: "T".into(),
                media_id: 1,
                participants: vec![],
                is_playing: false,
                state: None,
                current_position: 0.0,
            });
        }
        let code = s.read_room_info(|info| info.map(|r| r.code.clone())).await;
        assert_eq!(code, Some("CODE1".into()));
    }

    // ── WatchSession::send_message without command_tx ──

    #[tokio::test]
    async fn send_message_fails_when_no_tx() {
        let s = WatchSession::new(1, false);
        let err = s.send_message(ClientMessage::Heartbeat).await.unwrap_err();
        assert!(err.contains("Not connected"));
    }

    // ── CODE_CHARS sanity ──

    #[test]
    fn code_chars_has_no_ambiguous_chars() {
        let ambiguous = b"Il1O0";
        for &ch in ambiguous {
            assert!(
                !CODE_CHARS.contains(&ch),
                "ambiguous char '{}' found in CODE_CHARS",
                ch as char
            );
        }
    }

    #[test]
    fn code_chars_length() {
        assert_eq!(CODE_CHARS.len(), 32);
    }

    // ── ClientMessage all variants serialization ──

    #[test]
    fn client_message_ready_serializes_tag() {
        let msg = ClientMessage::Ready { duration: 90.0 };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"ready""#));
        assert!(json.contains("90"));
    }

    #[test]
    fn client_message_sync_serializes_tag() {
        let msg = ClientMessage::Sync {
            command: SyncCommand {
                action: "pause".into(),
                position: 5.0,
                from: None,
                timestamp: None,
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"sync""#));
        assert!(json.contains("pause"));
    }

    #[test]
    fn client_message_start_serializes_tag() {
        let json = serde_json::to_string(&ClientMessage::Start).unwrap();
        assert!(json.contains(r#""type":"start""#));
    }

    #[test]
    fn client_message_leave_serializes_tag() {
        let json = serde_json::to_string(&ClientMessage::Leave).unwrap();
        assert!(json.contains(r#""type":"leave""#));
    }

    #[test]
    fn client_message_heartbeat_serializes_tag() {
        let json = serde_json::to_string(&ClientMessage::Heartbeat).unwrap();
        assert!(json.contains(r#""type":"heartbeat""#));
    }

    #[test]
    fn client_message_state_report_serializes() {
        let msg = ClientMessage::StateReport {
            position: 42.0,
            paused: false,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"state_report""#));
        assert!(json.contains("42"));
        assert!(json.contains("false"));
    }

    #[test]
    fn client_message_pong_report_serializes() {
        let msg = ClientMessage::PongReport {
            ping_id: "client-1".into(),
            rtt: 25.5,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"pong_report""#));
        assert!(json.contains("client-1"));
    }

    #[test]
    fn client_message_buffering_started_serializes() {
        let msg = ClientMessage::BufferingStarted { position: 10.0 };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"buffering_started""#));
    }

    // ── ServerMessage deserialization for more variants ──

    #[test]
    fn server_message_deserialize_room_joined() {
        let json = r#"{"type":"room_joined","room":{"code":"J1","host_id":"h","media_title":"T","media_id":1,"participants":[],"current_position":0.0}}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::RoomJoined { room } => assert_eq!(room.code, "J1"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_room_state() {
        let json = r#"{"type":"room_state","room":{"code":"RS","host_id":"h","media_title":"T","media_id":1,"participants":[],"is_playing":true,"state":"playing","current_position":5.0}}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::RoomState { room } => {
                assert_eq!(room.code, "RS");
                assert!(room.is_playing);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_participant_joined() {
        let json = r#"{"type":"participant_joined","participant":{"id":"u1","nickname":"Bob","is_host":false,"is_ready":false,"duration":null}}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::ParticipantJoined { participant } => {
                assert_eq!(participant.id, "u1");
                assert_eq!(participant.nickname, "Bob");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_participant_left_with_room() {
        let json = r#"{"type":"participant_left","participant_id":"u2","room":{"code":"X","host_id":"h","media_title":"T","media_id":1,"participants":[],"current_position":0.0}}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::ParticipantLeft { participant_id, room } => {
                assert_eq!(participant_id, "u2");
                assert!(room.is_some());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_participant_left_without_room() {
        let json = r#"{"type":"participant_left","participant_id":"u3"}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::ParticipantLeft { participant_id, room } => {
                assert_eq!(participant_id, "u3");
                assert!(room.is_none());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_participant_ready() {
        let json = r#"{"type":"participant_ready","participant_id":"u1","duration":120.0}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::ParticipantReady { participant_id, duration } => {
                assert_eq!(participant_id, "u1");
                assert_eq!(duration, 120.0);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_playback_started() {
        let json = r#"{"type":"playback_started","position":0.0}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::PlaybackStarted { position } => assert_eq!(position, 0.0),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_state_update() {
        let json = r#"{"type":"state_update","position":42.5,"paused":false,"server_time":1234567890,"your_rtt":15.0,"participants":[]}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::StateUpdate { position, paused, your_rtt, participants, .. } => {
                assert_eq!(position, 42.5);
                assert!(!paused);
                assert_eq!(your_rtt, 15.0);
                assert!(participants.is_empty());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_ping() {
        let json = r#"{"type":"ping","ping_id":"srv-1","server_time":999}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::Ping { ping_id, server_time } => {
                assert_eq!(ping_id, "srv-1");
                assert_eq!(server_time, 999);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_pong() {
        let json = r#"{"type":"pong","ping_id":"c-1","server_time":100,"your_rtt":12.0}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::Pong { ping_id, your_rtt, .. } => {
                assert_eq!(ping_id, "c-1");
                assert_eq!(your_rtt, 12.0);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_heartbeat_ack() {
        let json = r#"{"type":"heartbeat_ack","timestamp":42}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::HeartbeatAck { timestamp } => assert_eq!(timestamp, 42),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_prepare() {
        let json = r#"{"type":"prepare","position":10.0,"pre_buffer_target":3}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::Prepare { position, pre_buffer_target } => {
                assert_eq!(position, 10.0);
                assert_eq!(pre_buffer_target, 3);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_play_at() {
        let json = r#"{"type":"play_at","position":10.0,"play_at_timestamp":1700000000.0}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::PlayAt { position, play_at_timestamp } => {
                assert_eq!(position, 10.0);
                assert_eq!(play_at_timestamp, 1700000000.0);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_sync_resume() {
        let json = r#"{"type":"sync_resume","position":10.0,"play_at_timestamp":1700000000.0}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::SyncResume { position, play_at_timestamp } => {
                assert_eq!(position, 10.0);
                assert_eq!(play_at_timestamp, 1700000000.0);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_pause() {
        let json = r#"{"type":"pause","reason":"buffering","triggered_by":"u1"}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::Pause { reason, triggered_by } => {
                assert_eq!(reason, "buffering");
                assert_eq!(triggered_by, "u1");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_message_deserialize_sync_with_echo() {
        let json = r#"{"type":"sync","command":{"action":"play","position":5.0},"from":"u1","timestamp":100,"is_echo":true}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::Sync { is_echo, .. } => assert!(is_echo),
            _ => panic!("wrong variant"),
        }
    }

    // ── WatchEvent all variant serialization ──

    #[test]
    fn watch_event_room_updated_serializes() {
        let room = RoomInfo {
            code: "X".into(),
            host_id: "h".into(),
            media_title: "T".into(),
            media_id: 1,
            participants: vec![],
            is_playing: false,
            state: None,
            current_position: 0.0,
        };
        let ev = WatchEvent::RoomUpdated { room };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"room_updated""#));
    }

    #[test]
    fn watch_event_sync_command_serializes() {
        let ev = WatchEvent::SyncCommand {
            command: SyncCommand {
                action: "pause".into(),
                position: 10.0,
                from: None,
                timestamp: None,
            },
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"sync_command""#));
    }

    #[test]
    fn watch_event_participant_changed_serializes() {
        let room = RoomInfo {
            code: "X".into(),
            host_id: "h".into(),
            media_title: "T".into(),
            media_id: 1,
            participants: vec![],
            is_playing: false,
            state: None,
            current_position: 0.0,
        };
        let ev = WatchEvent::ParticipantChanged { room };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"participant_changed""#));
    }

    #[test]
    fn watch_event_playback_started_serializes() {
        let ev = WatchEvent::PlaybackStarted { position: 0.0 };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"playback_started""#));
    }

    #[test]
    fn watch_event_error_serializes() {
        let ev = WatchEvent::Error { message: "boom".into() };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"error""#));
        assert!(json.contains("boom"));
    }

    #[test]
    fn watch_event_state_update_serializes() {
        let ev = WatchEvent::StateUpdate {
            position: 5.0,
            paused: false,
            your_rtt: 20.0,
            participants: vec![],
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"state_update""#));
    }

    #[test]
    fn watch_event_prepare_serializes() {
        let ev = WatchEvent::Prepare {
            position: 10.0,
            pre_buffer_target: 3,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"prepare""#));
    }

    #[test]
    fn watch_event_play_at_serializes() {
        let ev = WatchEvent::PlayAt {
            position: 10.0,
            play_at_timestamp: 1700000000.0,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"play_at""#));
    }

    #[test]
    fn watch_event_sync_resume_serializes() {
        let ev = WatchEvent::SyncResume {
            position: 10.0,
            play_at_timestamp: 1700000000.0,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"sync_resume""#));
    }

    #[test]
    fn watch_event_pause_serializes() {
        let ev = WatchEvent::Pause {
            reason: "buffering".into(),
            triggered_by: "u1".into(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"pause""#));
    }

    // ── normalize_room edge cases ──

    #[test]
    fn normalize_room_already_playing_stays_playing() {
        let room = RoomInfo {
            code: "X".into(),
            host_id: "h".into(),
            media_title: "T".into(),
            media_id: 1,
            participants: vec![],
            is_playing: true,
            state: Some("playing".into()),
            current_position: 0.0,
        };
        let normalized = WatchTogetherManager::normalize_room(room);
        assert!(normalized.is_playing);
    }

    // ── WatchSession::send_message with tx ──

    #[tokio::test]
    async fn send_message_succeeds_with_tx() {
        let (tx, mut rx) = mpsc::channel::<ClientMessage>(1);
        let mut s = WatchSession::new(1, false);
        s.command_tx = Some(tx);

        s.send_message(ClientMessage::Heartbeat).await.unwrap();
        let msg = rx.recv().await.unwrap();
        assert!(matches!(msg, ClientMessage::Heartbeat));
    }

    // ── set_event_callback and emit_event ──

    #[tokio::test]
    async fn set_event_callback_and_emit() {
        let m = WatchTogetherManager::new();
        let received = Arc::new(tokio::sync::Mutex::new(Vec::<WatchEvent>::new()));
        let received_clone = received.clone();

        m.set_event_callback(move |event| {
            let _r = received_clone.clone();
            // We can't await in a sync callback, but we can check the event type
            // by matching on it
            let _ = event; // event is received
        }).await;

        // The callback was set; verify it's Some
        let cb = m.event_callback.lock().await;
        assert!(cb.is_some());
    }

    #[tokio::test]
    async fn emit_event_without_callback_does_not_panic() {
        let m = WatchTogetherManager::new();
        // No callback set — emit should be a no-op
        m.emit_event(WatchEvent::Disconnected).await;
    }

    // ── get_room_state with normalize_room applied ──

    #[tokio::test]
    async fn get_room_state_normalizes_is_playing() {
        let (m, _rx) = make_manager_with_session(true).await;
        let room = RoomInfo {
            code: "N1".into(),
            host_id: "h".into(),
            media_title: "T".into(),
            media_id: 1,
            participants: vec![],
            is_playing: false,
            state: Some("playing".to_string()),
            current_position: 0.0,
        };
        {
            let guard = m.session.lock().await;
            let session = guard.as_ref().unwrap();
            let mut info = session.room_info.write().await;
            *info = Some(room);
        }

        let state = m.get_room_state().await.unwrap();
        assert!(state.is_playing, "normalize_room should set is_playing from state");
    }
}
