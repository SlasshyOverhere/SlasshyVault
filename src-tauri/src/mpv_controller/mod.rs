use std::thread;
use flume::{Receiver, Sender};
use tauri::{AppHandle, Manager, State};

pub mod communication;
pub mod player;
pub mod window;

use player::PlayerInstance;

/// Tauri-managed state for the native libmpv player.
/// mpv renders directly into the main Tauri window (behind the WebView2).
pub struct MpvController {
    pub cmd_tx: Option<Sender<String>>,
    pub player_rx: Option<Receiver<String>>,
    pub main_hwnd: isize,
    pub is_enabled: bool,
}

impl MpvController {
    pub fn new(app: &AppHandle) -> Self {
        let main_window = match app.get_window("main") {
            Some(w) => w,
            None => {
                eprintln!("[MPV-NATIVE] main window not found, native player disabled");
                return MpvController { cmd_tx: None, player_rx: None, main_hwnd: 0, is_enabled: false };
            }
        };

        let main_hwnd = main_window.hwnd().map(|h| h.0 as isize).unwrap_or(0);

        // Store overlay as managed state for easy access (commands still reference it)
        let _ = app.manage(window::VideoOverlay::create(main_hwnd));

        let mpv = match PlayerInstance::new(main_hwnd) {
            Ok(instance) => instance,
            Err(e) => {
                eprintln!("[MPV-NATIVE] failed to initialize mpv player: {e}, native player disabled");
                return MpvController { cmd_tx: None, player_rx: None, main_hwnd, is_enabled: false };
            }
        };

        let cmd_tx = mpv.cmd_tx();
        let player_rx = mpv.player_rx();

        let app_handle = app.clone();
        let rx = player_rx.clone();
        thread::spawn(move || {
            for msg in rx.iter() {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&msg) {
                    app_handle.emit_all("mpv-event", payload).ok();
                }
            }
        });

        MpvController { cmd_tx: Some(cmd_tx), player_rx: Some(player_rx), main_hwnd, is_enabled: true }
    }

    pub fn send(&self, json: String) -> Result<(), String> {
        self.cmd_tx.as_ref()
            .ok_or_else(|| "Native MPV player is not available".to_string())?
            .send(json)
            .map_err(|e| e.to_string())
    }
}

// ============================================================================
// Tauri Command Handlers
// ============================================================================

/// Load a media URL into the native libmpv player.
#[tauri::command]
pub fn native_mpv_load(
    state: State<'_, MpvController>,
    url: String,
    start_time: Option<f64>,
    hwdec: Option<bool>,
) -> Result<(), String> {
    state.send(serde_json::json!(["stop", []]).to_string())?;

    let hwdec_val = if hwdec.unwrap_or(true) { "auto-copy" } else { "no" };
    state.send(serde_json::json!(["hwdec", hwdec_val]).to_string())?;

    if let Some(time) = start_time {
        if time > 0.0 {
            state.send(serde_json::json!(["loadfile", [url, "replace", format!("start=+{}", time as i64)]]).to_string())?;
        } else {
            state.send(serde_json::json!(["loadfile", [url]]).to_string())?;
        }
    } else {
        state.send(serde_json::json!(["loadfile", [url]]).to_string())?;
    }

    state.send(serde_json::json!(["pause", false]).to_string())?;

    Ok(())
}

/// Pause or resume native playback.
#[tauri::command]
pub fn native_mpv_pause(state: State<'_, MpvController>, paused: bool) -> Result<(), String> {
    state.send(serde_json::json!(["pause", paused]).to_string())
}

/// Seek to a position in seconds.
#[tauri::command]
pub fn native_mpv_seek(state: State<'_, MpvController>, position: f64) -> Result<(), String> {
    state.send(serde_json::json!(["time-pos", position]).to_string())
}

/// Set volume (0-100).
#[tauri::command]
pub fn native_mpv_set_volume(state: State<'_, MpvController>, volume: f64) -> Result<(), String> {
    state.send(serde_json::json!(["volume", volume]).to_string())?;
    state.send(serde_json::json!(["mute", false]).to_string())
}

/// Set a generic mpv property on the native player.
#[tauri::command]
pub fn native_mpv_set_property(
    state: State<'_, MpvController>,
    name: String,
    value: serde_json::Value,
) -> Result<(), String> {
    state.send(serde_json::json!([name, value]).to_string())
}

/// Start observing an mpv property on the native player.
#[tauri::command]
pub fn native_mpv_observe_property(
    state: State<'_, MpvController>,
    name: String,
) -> Result<(), String> {
    state.send(serde_json::Value::String(name).to_string())
}

/// Stop native playback.
#[tauri::command]
pub fn native_mpv_stop(state: State<'_, MpvController>) -> Result<(), String> {
    state.send(serde_json::json!(["stop", []]).to_string())
}
