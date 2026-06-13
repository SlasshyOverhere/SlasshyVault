use std::collections::HashMap;
use std::io::BufReader;
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Response, Server};

// Store active transcoding sessions
lazy_static::lazy_static! {
    static ref TRANSCODE_SESSIONS: Arc<Mutex<HashMap<u64, TranscodeSession>>> = Arc::new(Mutex::new(HashMap::new()));
    static ref SESSION_COUNTER: Arc<Mutex<u64>> = Arc::new(Mutex::new(0));
}

pub struct TranscodeSession {
    pub ffmpeg_process: Option<Child>,
    pub server_port: u16,
    pub file_path: String,
}

impl Drop for TranscodeSession {
    fn drop(&mut self) {
        if let Some(ref mut process) = self.ffmpeg_process {
            let _ = process.kill();
        }
    }
}

/// Check if a video file needs transcoding for HTML5 playback
pub fn needs_transcoding(file_path: &str) -> bool {
    let ext = file_path.split('.').last().unwrap_or("").to_lowercase();

    // These formats/containers typically need transcoding for HTML5
    matches!(
        ext.as_str(),
        "mkv"
            | "avi"
            | "wmv"
            | "flv"
            | "mov"
            | "m2ts"
            | "ts"
            | "vob"
            | "divx"
            | "xvid"
            | "rmvb"
            | "rm"
    )
}

/// Find an available port for the transcoding server
fn find_available_port() -> Option<u16> {
    // Try ports in range 9000-9100
    for port in 9000..9100 {
        if TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

/// Start transcoding a video file and return a local HTTP URL
pub fn start_transcode(
    ffmpeg_path: &str,
    file_path: &str,
    start_time: Option<f64>,
) -> Result<(u64, String), String> {
    crate::config::validate_executable_path(ffmpeg_path, "ffmpeg")?;

    if !std::path::Path::new(ffmpeg_path).exists() {
        return Err("FFmpeg not found. Please configure FFmpeg path in Settings.".to_string());
    }

    if !std::path::Path::new(file_path).exists() {
        return Err(format!("Video file not found: {}", file_path));
    }

    let port = find_available_port()
        .ok_or_else(|| "No available port for transcoding server".to_string())?;

    // Create session ID
    let session_id = {
        let mut counter = SESSION_COUNTER.lock().map_err(|e| e.to_string())?;
        *counter += 1;
        *counter
    };

    // Build FFmpeg command for HLS output (most compatible for streaming)
    // We'll use fragmented MP4 for better seeking support
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
    ];

    // Add start time if resuming
    if let Some(time) = start_time {
        if time > 0.0 {
            args.push("-ss".to_string());
            args.push(format!("{:.2}", time));
        }
    }

    args.extend(vec![
        "-i".to_string(),
        file_path.to_string(),
        // Video: transcode to H.264 baseline for maximum compatibility
        "-c:v".to_string(),
        "libx264".to_string(),
        "-preset".to_string(),
        "ultrafast".to_string(),
        "-tune".to_string(),
        "zerolatency".to_string(),
        "-profile:v".to_string(),
        "baseline".to_string(),
        "-level".to_string(),
        "3.0".to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        // Scale down if too large (max 1080p)
        "-vf".to_string(),
        "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease".to_string(),
        // Audio: transcode to AAC stereo
        "-c:a".to_string(),
        "aac".to_string(),
        "-ac".to_string(),
        "2".to_string(),
        "-b:a".to_string(),
        "192k".to_string(),
        // Output format: fragmented MP4 for streaming
        "-f".to_string(),
        "mp4".to_string(),
        "-movflags".to_string(),
        "frag_keyframe+empty_moov+faststart".to_string(),
        // Output to pipe
        "pipe:1".to_string(),
    ]);

    println!("[TRANSCODE] Starting FFmpeg with args: {:?}", args);

    let mut ffmpeg_cmd = Command::new(ffmpeg_path);
    crate::config::apply_hidden_process_flags(&mut ffmpeg_cmd);
    let ffmpeg_process = ffmpeg_cmd
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start FFmpeg: {}", e))?;

    let session = TranscodeSession {
        ffmpeg_process: Some(ffmpeg_process),
        server_port: port,
        file_path: file_path.to_string(),
    };

    // Store session
    {
        let mut sessions = TRANSCODE_SESSIONS.lock().map_err(|e| e.to_string())?;
        sessions.insert(session_id, session);
    }

    // Start HTTP server in background thread
    let file_path_clone = file_path.to_string();
    let ffmpeg_path_clone = ffmpeg_path.to_string();
    let start_time_clone = start_time;

    let session_id_for_cleanup = session_id;
    std::thread::spawn(move || {
        run_transcode_server(port, &ffmpeg_path_clone, &file_path_clone, start_time_clone);
        // Clean up the session entry when the server exits (natural completion or error)
        let mut sessions = TRANSCODE_SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut session) = sessions.remove(&session_id_for_cleanup) {
            if let Some(ref mut process) = session.ffmpeg_process {
                let _ = process.kill();
            }
            println!("[TRANSCODE] Auto-cleaned session {} after server exit", session_id_for_cleanup);
        }
    });

    // Small delay to let server start
    std::thread::sleep(std::time::Duration::from_millis(500));

    let url = format!("http://127.0.0.1:{}/stream.mp4", port);
    println!("[TRANSCODE] Started session {} at {}", session_id, url);

    Ok((session_id, url))
}

/// Run the transcoding HTTP server
fn run_transcode_server(port: u16, ffmpeg_path: &str, file_path: &str, start_time: Option<f64>) {
    let server = match Server::http(format!("127.0.0.1:{}", port)) {
        Ok(s) => s,
        Err(e) => {
            println!("[TRANSCODE] Failed to start server: {}", e);
            return;
        }
    };

    println!("[TRANSCODE] Server listening on port {}", port);

    for request in server.incoming_requests() {
        let url = request.url();
        println!("[TRANSCODE] Request: {} {}", request.method(), url);

        if url.starts_with("/stream") {
            // Validate ffmpeg path before executing
            if let Err(e) = crate::config::validate_executable_path(ffmpeg_path, "ffmpeg") {
                println!("[TRANSCODE] Validation failed: {}", e);
                let response = Response::from_string(format!("FFmpeg validation error: {}", e))
                    .with_status_code(500);
                let _ = request.respond(response);
                break;
            }

            // Start FFmpeg and stream output
            let mut args = vec!["-hide_banner", "-loglevel", "warning"];

            let start_str;
            if let Some(time) = start_time {
                if time > 0.0 {
                    start_str = format!("{:.2}", time);
                    args.push("-ss");
                    args.push(&start_str);
                }
            }

            args.extend(vec![
                "-i",
                file_path,
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-tune",
                "zerolatency",
                "-profile:v",
                "baseline",
                "-level",
                "3.0",
                "-pix_fmt",
                "yuv420p",
                "-vf",
                "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease",
                "-c:a",
                "aac",
                "-ac",
                "2",
                "-b:a",
                "192k",
                "-f",
                "mp4",
                "-movflags",
                "frag_keyframe+empty_moov+faststart",
                "pipe:1",
            ]);

            let mut ffmpeg_cmd = Command::new(ffmpeg_path);
            crate::config::apply_hidden_process_flags(&mut ffmpeg_cmd);
            match ffmpeg_cmd
                .args(&args)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(mut child) => {
                    if let Some(stdout) = child.stdout.take() {
                        let content_type =
                            Header::from_bytes(&b"Content-Type"[..], &b"video/mp4"[..]).unwrap();

                        let reader = BufReader::new(stdout);
                        let response = Response::new(
                            tiny_http::StatusCode(200),
                            vec![content_type],
                            reader,
                            None,
                            None,
                        );

                        if let Err(e) = request.respond(response) {
                            println!("[TRANSCODE] Failed to send response: {}", e);
                        }
                    }
                    let _ = child.wait();
                }
                Err(e) => {
                    println!("[TRANSCODE] Failed to start FFmpeg: {}", e);
                    let response =
                        Response::from_string(format!("FFmpeg error: {}", e)).with_status_code(500);
                    let _ = request.respond(response);
                }
            }

            // Only handle one request then exit
            break;
        } else {
            let response = Response::from_string("Not found").with_status_code(404);
            let _ = request.respond(response);
        }
    }

    println!("[TRANSCODE] Server on port {} shutting down", port);
}

/// Stop a transcoding session
pub fn stop_transcode(session_id: u64) -> Result<(), String> {
    let mut sessions = TRANSCODE_SESSIONS.lock().map_err(|e| e.to_string())?;

    if let Some(mut session) = sessions.remove(&session_id) {
        if let Some(ref mut process) = session.ffmpeg_process {
            let _ = process.kill();
        }
        println!("[TRANSCODE] Stopped session {}", session_id);
    }

    Ok(())
}

/// Stop all transcoding sessions
pub fn stop_all_transcodes() -> Result<(), String> {
    let mut sessions = TRANSCODE_SESSIONS.lock().map_err(|e| e.to_string())?;

    for (id, mut session) in sessions.drain() {
        if let Some(ref mut process) = session.ffmpeg_process {
            let _ = process.kill();
        }
        println!("[TRANSCODE] Stopped session {}", id);
    }

    Ok(())
}
