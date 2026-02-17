// Watch Together Module
// Synchronized MPV playback across remote users via WebSocket relay

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, RwLock};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::{client::IntoClientRequest, protocol::Message}};
use uuid::Uuid;

// Backend server URL - reads from env var, falls back to production
fn get_relay_server_url() -> String {
    std::env::var("STREAMVAULT_WS_URL")
        .unwrap_or_else(|_| {
            if cfg!(debug_assertions) {
                "ws://localhost:3001/ws/watchtogether".to_string()
            } else {
                "wss://streamvault-backend-server.onrender.com/ws/watchtogether".to_string()
            }
        })
}

// Room code characters (no ambiguous chars like I/1/O/0)
const CODE_CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Generate a 6-character room code
pub fn generate_room_code() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
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

/// Sync command types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action")]
pub enum SyncAction {
    #[serde(rename = "play")]
    Play { position: f64 },
    #[serde(rename = "pause")]
    Pause { position: f64 },
    #[serde(rename = "seek")]
    Seek { position: f64 },
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
        nickname: String,
        client_id: String,
    },
    #[serde(rename = "join")]
    Join {
        room_code: String,
        nickname: String,
        client_id: String,
        media_id: i64,
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
    StateReport {
        position: f64,
        paused: bool,
    },
    /// Pong response for RTT measurement
    #[serde(rename = "pong_report")]
    PongReport {
        ping_id: String,
        rtt: f64,
    },
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
    Ping {
        ping_id: String,
        server_time: i64,
    },
    #[serde(rename = "pong")]
    Pong {
        ping_id: String,
        server_time: i64,
        your_rtt: f64,
    },
    #[serde(rename = "heartbeat_ack")]
    HeartbeatAck { timestamp: i64 },
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

    /// Get current room info
    pub async fn get_room_info(&self) -> Option<RoomInfo> {
        self.room_info.read().await.clone()
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
        
        request.headers_mut().remove("Sec-WebSocket-Extensions");

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
            nickname,
            client_id: client_id.clone(),
        };

        let msg_json = serde_json::to_string(&create_msg)
            .map_err(|e| format!("Failed to serialize message: {}", e))?;

        write
            .send(Message::Text(msg_json))
            .await
            .map_err(|e| format!("Failed to send create message: {}", e))?;

        // Wait for room_created response
        let room_result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            async {
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
            }
        )
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
                        // Send ping as raw JSON (not through ClientMessage enum to keep it simple)
                        let ping_json = serde_json::json!({
                            "type": "ping",
                            "ping_id": ping_id,
                        });
                        let _ = write.send(Message::Text(ping_json.to_string())).await;
                    }
                    // Handle shutdown
                    _ = shutdown_rx.recv() => {
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

        request.headers_mut().remove("Sec-WebSocket-Extensions");

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
            nickname,
            client_id: client_id.clone(),
            media_id,
        };

        let msg_json = serde_json::to_string(&join_msg)
            .map_err(|e| format!("Failed to serialize message: {}", e))?;

        write
            .send(Message::Text(msg_json))
            .await
            .map_err(|e| format!("Failed to send join message: {}", e))?;

        // Wait for room_joined response
        let room_result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            async {
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
            }
        )
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
                        let ping_json = serde_json::json!({
                            "type": "ping",
                            "ping_id": ping_id,
                        });
                        let _ = write.send(Message::Text(ping_json.to_string())).await;
                    }
                    _ = shutdown_rx.recv() => {
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
            ServerMessage::Sync { command, from, timestamp, is_echo } => {
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
            ServerMessage::StateUpdate { position, paused, your_rtt, participants, .. } => {
                // Emit state_update for the sync engine in main.rs to apply
                emit(WatchEvent::StateUpdate {
                    position,
                    paused,
                    your_rtt,
                    participants,
                }).await;
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
                    let _ = command_tx.send(ClientMessage::PongReport {
                        ping_id,
                        rtt: rtt_ms,
                    }).await;
                }
            }
            ServerMessage::ParticipantJoined { participant } => {
                let mut info = room_info.write().await;
                if let Some(ref mut room) = *info {
                    if let Some(existing) = room.participants.iter_mut().find(|p| p.id == participant.id) {
                        *existing = participant;
                    } else {
                        room.participants.push(participant);
                    }
                    emit(WatchEvent::ParticipantChanged { room: room.clone() }).await;
                }
            }
            ServerMessage::ParticipantLeft { participant_id, room } => {
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
            ServerMessage::ParticipantReady { participant_id, duration } => {
                let mut info = room_info.write().await;
                if let Some(ref mut room) = *info {
                    if let Some(p) = room.participants.iter_mut().find(|p| p.id == participant_id) {
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
            session.send_message(ClientMessage::Ready { duration }).await?;
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
            session.send_message(ClientMessage::Sync { command }).await?;
            Ok(())
        } else {
            Err("No active session".to_string())
        }
    }

    /// Get current room state
    pub async fn get_room_state(&self) -> Option<RoomInfo> {
        let session_guard = self.session.lock().await;

        if let Some(session) = session_guard.as_ref() {
            session.get_room_info().await.map(Self::normalize_room)
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
