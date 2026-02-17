#[path = "../watch_together.rs"]
mod watch_together;

use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::{sleep, Instant};
use watch_together::{ClientMessage, WatchEvent, WatchTogetherManager};

#[derive(Clone, Debug)]
struct TimedEvent {
    at: Instant,
    event: WatchEvent,
}

struct EventInbox {
    name: String,
    rx: mpsc::UnboundedReceiver<TimedEvent>,
    backlog: Vec<TimedEvent>,
}

impl EventInbox {
    fn new(name: &str, rx: mpsc::UnboundedReceiver<TimedEvent>) -> Self {
        Self {
            name: name.to_string(),
            rx,
            backlog: Vec::new(),
        }
    }

    async fn wait_for<F>(
        &mut self,
        label: &str,
        timeout_ms: u64,
        mut predicate: F,
    ) -> Result<TimedEvent, String>
    where
        F: FnMut(&TimedEvent) -> bool,
    {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if let Some(idx) = self.backlog.iter().position(|evt| predicate(evt)) {
                return Ok(self.backlog.remove(idx));
            }

            let now = Instant::now();
            if now >= deadline {
                let tail = self
                    .backlog
                    .iter()
                    .rev()
                    .take(6)
                    .map(|e| event_name(&e.event))
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(format!(
                    "[{}] timeout waiting for {}. recent=[{}]",
                    self.name, label, tail
                ));
            }

            let remaining = deadline.saturating_duration_since(now);
            let recv_result = tokio::time::timeout(remaining, self.rx.recv()).await;
            match recv_result {
                Ok(Some(evt)) => {
                    if predicate(&evt) {
                        return Ok(evt);
                    }
                    self.backlog.push(evt);
                    if self.backlog.len() > 2000 {
                        self.backlog.remove(0);
                    }
                }
                Ok(None) => {
                    return Err(format!("[{}] event channel closed", self.name));
                }
                Err(_) => {
                    return Err(format!("[{}] timeout waiting for {}", self.name, label));
                }
            }
        }
    }
}

fn event_name(event: &WatchEvent) -> &'static str {
    match event {
        WatchEvent::RoomUpdated { .. } => "room_updated",
        WatchEvent::SyncCommand { .. } => "sync_command",
        WatchEvent::ParticipantChanged { .. } => "participant_changed",
        WatchEvent::PlaybackStarted { .. } => "playback_started",
        WatchEvent::Error { .. } => "error",
        WatchEvent::Disconnected => "disconnected",
        WatchEvent::StateUpdate { .. } => "state_update",
    }
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

#[derive(Debug)]
struct Stats {
    count: usize,
    min: f64,
    avg: f64,
    p95: f64,
    p99: f64,
    max: f64,
}

fn summarize(samples: &[f64]) -> Result<Stats, String> {
    if samples.is_empty() {
        return Err("no samples collected".to_string());
    }
    let mut values = samples.to_vec();
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let sum: f64 = values.iter().sum();
    let idx95 = ((values.len() as f64 - 1.0) * 0.95).round() as usize;
    let idx99 = ((values.len() as f64 - 1.0) * 0.99).round() as usize;
    Ok(Stats {
        count: values.len(),
        min: values[0],
        avg: sum / values.len() as f64,
        p95: values[idx95.min(values.len() - 1)],
        p99: values[idx99.min(values.len() - 1)],
        max: values[values.len() - 1],
    })
}

async fn send_state_report(
    manager: &WatchTogetherManager,
    position: f64,
    paused: bool,
) -> Result<(), String> {
    let guard = manager.session.lock().await;
    if let Some(session) = guard.as_ref() {
        session
            .send_message(ClientMessage::StateReport { position, paused })
            .await
    } else {
        Err("no active session for state report".to_string())
    }
}

async fn wait_until_all_ready(
    manager: &WatchTogetherManager,
    timeout_ms: u64,
) -> Result<(), String> {
    let start = Instant::now();
    loop {
        if let Some(room) = manager.get_room_state().await {
            if room.participants.len() >= 2 && room.participants.iter().all(|p| p.is_ready) {
                return Ok(());
            }
        }
        if start.elapsed() > Duration::from_millis(timeout_ms) {
            return Err("timeout waiting for all participants ready".to_string());
        }
        sleep(Duration::from_millis(80)).await;
    }
}

async fn wait_until_host(
    manager: &WatchTogetherManager,
    expected_host_id: &str,
    timeout_ms: u64,
) -> Result<(), String> {
    let start = Instant::now();
    loop {
        if let Some(room) = manager.get_room_state().await {
            if room.host_id == expected_host_id {
                return Ok(());
            }
        }
        if start.elapsed() > Duration::from_millis(timeout_ms) {
            return Err("timeout waiting for expected host id".to_string());
        }
        sleep(Duration::from_millis(100)).await;
    }
}

async fn measure_latency(
    sender: &WatchTogetherManager,
    receiver_inbox: &mut EventInbox,
    sender_id: &str,
    rounds: usize,
    start_position: f64,
) -> Result<Vec<f64>, String> {
    let mut samples = Vec::with_capacity(rounds);
    let mut position = start_position;
    for i in 0..rounds {
        position += 1.7;
        let action = if i % 3 == 0 {
            "seek"
        } else if i % 3 == 1 {
            "pause"
        } else {
            "play"
        };
        let sent_at = Instant::now();
        sender.send_sync(action, position).await?;
        let event = receiver_inbox
            .wait_for("sync command", 7000, |evt| {
                if let WatchEvent::SyncCommand { command } = &evt.event {
                    command.from.as_deref() == Some(sender_id)
                        && command.action == action
                        && (command.position - position).abs() < 0.01
                } else {
                    false
                }
            })
            .await?;
        samples.push(ms(event.at.duration_since(sent_at)));
        sleep(Duration::from_millis(25)).await;
    }
    Ok(samples)
}

async fn measure_concurrent_latency(
    host: &WatchTogetherManager,
    guest: &WatchTogetherManager,
    host_inbox: &mut EventInbox,
    guest_inbox: &mut EventInbox,
    host_id: &str,
    guest_id: &str,
    rounds: usize,
    start_position: f64,
) -> Result<(Vec<f64>, Vec<f64>), String> {
    let mut host_to_guest = Vec::with_capacity(rounds);
    let mut guest_to_host = Vec::with_capacity(rounds);
    let mut base = start_position;

    for i in 0..rounds {
        base += 2.2;
        let action = if i % 2 == 0 { "seek" } else { "play" };
        let host_position = base + 0.1;
        let guest_position = base + 0.2;

        let host_sent = Instant::now();
        host.send_sync(action, host_position).await?;
        let guest_sent = Instant::now();
        guest.send_sync(action, guest_position).await?;

        let guest_received = guest_inbox
            .wait_for("guest concurrent sync", 7000, |evt| {
                if let WatchEvent::SyncCommand { command } = &evt.event {
                    command.from.as_deref() == Some(host_id)
                        && command.action == action
                        && (command.position - host_position).abs() < 0.01
                } else {
                    false
                }
            })
            .await?;

        let host_received = host_inbox
            .wait_for("host concurrent sync", 7000, |evt| {
                if let WatchEvent::SyncCommand { command } = &evt.event {
                    command.from.as_deref() == Some(guest_id)
                        && command.action == action
                        && (command.position - guest_position).abs() < 0.01
                } else {
                    false
                }
            })
            .await?;

        host_to_guest.push(ms(guest_received.at.duration_since(host_sent)));
        guest_to_host.push(ms(host_received.at.duration_since(guest_sent)));
        sleep(Duration::from_millis(20)).await;
    }

    Ok((host_to_guest, guest_to_host))
}

fn parse_arg_usize(key: &str, default: usize) -> usize {
    for arg in std::env::args() {
        if let Some(rest) = arg.strip_prefix(&format!("--{}=", key)) {
            if let Ok(v) = rest.parse::<usize>() {
                return v;
            }
        }
    }
    default
}

fn parse_arg_f64(key: &str, default: f64) -> f64 {
    for arg in std::env::args() {
        if let Some(rest) = arg.strip_prefix(&format!("--{}=", key)) {
            if let Ok(v) = rest.parse::<f64>() {
                return v;
            }
        }
    }
    default
}

async fn run() -> Result<(), String> {
    let rounds = parse_arg_usize("rounds", 30);
    let concurrent_rounds = parse_arg_usize("concurrent-rounds", 20);
    let p95_limit_ms = parse_arg_f64("p95-limit-ms", 550.0);
    let max_limit_ms = parse_arg_f64("max-limit-ms", 1300.0);
    let media_id = 424242_i64;

    println!(
        "[tauri-wan] config rounds={} concurrent_rounds={} p95_limit_ms={} max_limit_ms={}",
        rounds, concurrent_rounds, p95_limit_ms, max_limit_ms
    );

    let host = WatchTogetherManager::new();
    let guest = WatchTogetherManager::new();

    let (host_tx, host_rx) = mpsc::unbounded_channel::<TimedEvent>();
    host.set_event_callback(move |event| {
        let _ = host_tx.send(TimedEvent {
            at: Instant::now(),
            event,
        });
    })
    .await;
    let mut host_inbox = EventInbox::new("host", host_rx);

    let (guest_tx, guest_rx) = mpsc::unbounded_channel::<TimedEvent>();
    guest.set_event_callback(move |event| {
        let _ = guest_tx.send(TimedEvent {
            at: Instant::now(),
            event,
        });
    })
    .await;
    let mut guest_inbox = EventInbox::new("guest", guest_rx);

    let host_room = host
        .create_room(media_id, "WAN E2E Movie".to_string(), "Host".to_string())
        .await?;
    let room_code = host_room.code.clone();
    let host_id = host_room.host_id.clone();

    let guest_room = guest
        .join_room(room_code.clone(), media_id, "Guest".to_string())
        .await?;
    let guest_id = guest_room
        .participants
        .iter()
        .find(|p| p.nickname == "Guest")
        .map(|p| p.id.clone())
        .ok_or_else(|| "guest id not found in room participants".to_string())?;

    host.set_ready(3600.0).await?;
    guest.set_ready(3600.0).await?;
    wait_until_all_ready(&host, 10000).await?;

    host.start_playback().await?;

    host_inbox
        .wait_for("host playback_started", 7000, |evt| {
            matches!(evt.event, WatchEvent::PlaybackStarted { .. })
        })
        .await?;
    guest_inbox
        .wait_for("guest playback_started", 7000, |evt| {
            matches!(evt.event, WatchEvent::PlaybackStarted { .. })
        })
        .await?;

    let mut pos = 12.0;
    for _ in 0..8 {
        pos += 0.3;
        send_state_report(&host, pos, false).await?;
        send_state_report(&guest, pos + 0.04, false).await?;
        sleep(Duration::from_millis(140)).await;
    }

    let mut state_update_times = Vec::new();
    for _ in 0..6 {
        let evt = guest_inbox
            .wait_for("guest state_update", 7000, |evt| {
                matches!(evt.event, WatchEvent::StateUpdate { .. })
            })
            .await?;
        state_update_times.push(evt.at);
    }
    let mut state_intervals = Vec::new();
    for pair in state_update_times.windows(2) {
        state_intervals.push(ms(pair[1].duration_since(pair[0])));
    }
    if let Some(max_interval) = state_intervals
        .iter()
        .copied()
        .fold(None, |acc: Option<f64>, v| Some(acc.map_or(v, |a| a.max(v))))
    {
        if max_interval > 2200.0 {
            return Err(format!(
                "state_update stalled too long (max interval {:.1}ms)",
                max_interval
            ));
        }
    }

    let host_to_guest = measure_latency(&host, &mut guest_inbox, &host_id, rounds, pos + 20.0).await?;
    let guest_to_host = measure_latency(&guest, &mut host_inbox, &guest_id, rounds, pos + 50.0).await?;
    let (concurrent_h2g, concurrent_g2h) = measure_concurrent_latency(
        &host,
        &guest,
        &mut host_inbox,
        &mut guest_inbox,
        &host_id,
        &guest_id,
        concurrent_rounds,
        pos + 80.0,
    )
    .await?;

    let h2g_stats = summarize(&host_to_guest)?;
    let g2h_stats = summarize(&guest_to_host)?;
    let c_h2g_stats = summarize(&concurrent_h2g)?;
    let c_g2h_stats = summarize(&concurrent_g2h)?;

    println!(
        "[tauri-wan] host->guest ms count={} min={:.1} avg={:.1} p95={:.1} p99={:.1} max={:.1}",
        h2g_stats.count, h2g_stats.min, h2g_stats.avg, h2g_stats.p95, h2g_stats.p99, h2g_stats.max
    );
    println!(
        "[tauri-wan] guest->host ms count={} min={:.1} avg={:.1} p95={:.1} p99={:.1} max={:.1}",
        g2h_stats.count, g2h_stats.min, g2h_stats.avg, g2h_stats.p95, g2h_stats.p99, g2h_stats.max
    );
    println!(
        "[tauri-wan] concurrent host->guest ms count={} min={:.1} avg={:.1} p95={:.1} p99={:.1} max={:.1}",
        c_h2g_stats.count, c_h2g_stats.min, c_h2g_stats.avg, c_h2g_stats.p95, c_h2g_stats.p99, c_h2g_stats.max
    );
    println!(
        "[tauri-wan] concurrent guest->host ms count={} min={:.1} avg={:.1} p95={:.1} p99={:.1} max={:.1}",
        c_g2h_stats.count, c_g2h_stats.min, c_g2h_stats.avg, c_g2h_stats.p95, c_g2h_stats.p99, c_g2h_stats.max
    );

    for (label, stats) in [
        ("host->guest", &h2g_stats),
        ("guest->host", &g2h_stats),
        ("concurrent host->guest", &c_h2g_stats),
        ("concurrent guest->host", &c_g2h_stats),
    ] {
        if stats.p95 > p95_limit_ms {
            return Err(format!(
                "{} p95 too high: {:.1}ms > {:.1}ms",
                label, stats.p95, p95_limit_ms
            ));
        }
        if stats.max > max_limit_ms {
            return Err(format!(
                "{} max too high: {:.1}ms > {:.1}ms",
                label, stats.max, max_limit_ms
            ));
        }
    }

    host.leave_room().await?;
    wait_until_host(&guest, &guest_id, 10000).await?;
    guest.leave_room().await?;

    println!("[tauri-wan] PASS - Tauri-core WAN sync test completed");
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("[tauri-wan] FAIL - {}", err);
        std::process::exit(1);
    }
}
