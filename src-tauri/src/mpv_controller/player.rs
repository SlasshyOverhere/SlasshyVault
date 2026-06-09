use std::sync::Arc;
use std::thread;
use flume::{Receiver, Sender};
use libmpv2::{events::EventContext, Format, Mpv, SetData};
use libmpv2::events::{Event, PropertyData};

use crate::mpv_controller::communication::{prop_format_from_name, InMsg, PropVal};

struct ObserveProperty {
    name: String,
    format: Format,
}

/// Wraps a shared mpv handle with event + message threads.
pub struct PlayerInstance {
    mpv: Arc<Mpv>,
    pub cmd_tx: Sender<String>,
    pub player_rx: Receiver<String>,
}

impl PlayerInstance {
    /// Create mpv with HWND rendering (Windows).
    /// Spawns event thread (mpv → UI) and message thread (UI → mpv).
    pub fn new(hwnd: isize) -> Result<Self, String> {
        let mpv = Mpv::with_initializer(|_init| Ok(()))
            .map_err(|e| format!("mpv_create_or_initialize failed: {e}"))?;

        mpv.set_property("title", "SlasshyVault")
            .map_err(|e| format!("title: {e}"))?;
        mpv.set_property("audio-client-name", "SlasshyVault")
            .map_err(|e| format!("audio-client-name: {e}"))?;
        mpv.set_property("terminal", "yes")
            .map_err(|e| format!("terminal: {e}"))?;
        mpv.set_property("msg-level", "all=no,cplayer=debug")
            .map_err(|e| format!("msg-level: {e}"))?;
        mpv.set_property("quiet", "yes")
            .map_err(|e| format!("quiet: {e}"))?;
        // cache properties omitted — some builds reject them after init
        mpv.set_property("audio-fallback-to-null", "yes")
            .map_err(|e| format!("audio-fallback-to-null: {e}"))?;
        mpv.set_property("wid", hwnd as i64)
            .map_err(|e| format!("wid: {e}"))?;
        mpv.set_property("hwdec", "auto")
            .map_err(|e| format!("hwdec: {e}"))?;
        mpv.set_property("osc", false)
            .ok();
        // Keep keybindings defined but they won't fire without focus on the child HWND.
        // React handles keyboard input and sends commands via IPC.
        mpv.set_property("input-default-bindings", false)
            .ok();

        let mpv = Arc::new(mpv);

        let (in_tx, in_rx) = flume::unbounded::<String>();
        let (out_tx, out_rx) = flume::unbounded::<String>();
        let (obs_tx, obs_rx) = flume::unbounded::<ObserveProperty>();

        // --- Event Thread (mpv → UI) ---
        let mpv_event = Arc::clone(&mpv);
        let out_tx_event = out_tx.clone();
        thread::spawn(move || {
            let mut ctx = EventContext::new(mpv_event.ctx);
            ctx.disable_deprecated_events()
                .expect("failed to disable deprecated MPV events");

            loop {
                for ObserveProperty { name, format } in obs_rx.drain() {
                    ctx.observe_property(&name, format, 0)
                        .expect("failed to observe MPV property");
                }

                let event = match ctx.wait_event(-1.) {
                    Some(Ok(e)) => e,
                    Some(Err(e)) => {
                        eprintln!("[mpv event] error: {e:?}");
                        continue;
                    }
                    None => continue,
                };

                let response = match &event {
                    Event::PropertyChange { name, change, .. } => {
                        Some(serde_json::json!([
                            "mpv-prop-change",
                            { "name": name, "data": property_data_to_json(change) }
                        ]))
                    }
                    Event::EndFile(reason) => {
                        let reason_str = match *reason {
                            libmpv2::mpv_end_file_reason::Error => "error",
                            libmpv2::mpv_end_file_reason::Quit => "quit",
                            _ => "other",
                        };
                        Some(serde_json::json!([
                            "mpv-event-ended",
                            { "reason": reason_str }
                        ]))
                    }
                    Event::Shutdown => break,
                    _ => None,
                };

                if let Some(payload) = response {
                    if out_tx_event.send(payload.to_string()).is_err() {
                        break;
                    }
                }
            }
        });

        // --- Message Thread (UI → mpv) ---
        let mpv_cmd = Arc::clone(&mpv);
        let obs_tx_cmd = obs_tx.clone();
        thread::spawn(move || {
            fn wake_up(mpv: &Mpv) {
                unsafe { libmpv2_sys::mpv_wakeup(mpv.ctx.as_ptr()) }
            }

            fn send_command(mpv: &Mpv, cmd: &str, args: &[&str]) {
                if let Err(e) = mpv.command(cmd, args) {
                    eprintln!("[mpv command] {cmd} failed: {e}");
                }
            }

            fn set_property_typed<T: SetData>(mpv: &Mpv, name: &str, value: T) {
                if let Err(e) = mpv.set_property(name, value) {
                    eprintln!("[mpv set_property] {name} failed: {e}");
                }
            }

            fn set_property_string(mpv: &Mpv, name: &str, value: &str) {
                if let Err(e) = mpv.set_property(name, value) {
                    eprintln!("[mpv set_property] {name} failed: {e}");
                }
            }

            for msg in in_rx.iter() {
                let parsed: InMsg = match serde_json::from_str(&msg) {
                    Ok(m) => m,
                    Err(e) => {
                        eprintln!("[mpv] cannot parse InMsg: {e}");
                        continue;
                    }
                };

                match parsed {
                    InMsg::ObserveProp(name) => {
                        let fmt = prop_format_from_name(&name);
                        obs_tx_cmd.send(ObserveProperty { name, format: fmt }).ok();
                        wake_up(&mpv_cmd);
                    }
                    InMsg::SetProp(name, value) => {
                        match value {
                            PropVal::Bool(v) => set_property_typed(&mpv_cmd, &name, v),
                            PropVal::Num(v) => set_property_typed(&mpv_cmd, &name, v),
                            PropVal::Str(v) => {
                                let v = if name == "vo" {
                                    let mut v = v;
                                    if !v.is_empty() && !v.ends_with(',') {
                                        v.push(',');
                                    }
                                    v.push_str("gpu-next,");
                                    v
                                } else {
                                    v
                                };
                                set_property_string(&mpv_cmd, &name, &v);
                            }
                        }
                    }
                    InMsg::Command(cmd, args) => {
                        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
                        send_command(&mpv_cmd, &cmd, &arg_refs);
                    }
                }
            }
        });

        Ok(PlayerInstance { mpv, cmd_tx: in_tx, player_rx: out_rx })
    }

    pub fn cmd_tx(&self) -> Sender<String> {
        self.cmd_tx.clone()
    }

    pub fn player_rx(&self) -> Receiver<String> {
        self.player_rx.clone()
    }
}

fn property_data_to_json(data: &PropertyData) -> serde_json::Value {
    match data {
        PropertyData::Flag(v) => serde_json::Value::Bool(*v),
        PropertyData::Int64(v) => serde_json::Number::from_f64(*v as f64)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        PropertyData::Double(v) => serde_json::Number::from_f64(*v)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        PropertyData::Str(s) => serde_json::Value::String(s.to_string()),
        _ => serde_json::Value::Null,
    }
}
