use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

// In-memory cache for stream results (5 minute TTL)
const STREAM_CACHE_TTL: Duration = Duration::from_secs(300);

struct CacheEntry {
    streams: Vec<RemoteStream>,
    fetched_at: Instant,
}

static STREAM_CACHE: Mutex<Option<HashMap<String, CacheEntry>>> = Mutex::new(None);

fn get_cached_streams(key: &str) -> Option<Vec<RemoteStream>> {
    let cache = STREAM_CACHE.lock().ok()?;
    let cache = cache.as_ref()?;
    let entry = cache.get(key)?;
    if entry.fetched_at.elapsed() < STREAM_CACHE_TTL {
        Some(entry.streams.clone())
    } else {
        None
    }
}

fn set_cached_streams(key: &str, streams: Vec<RemoteStream>) {
    let mut cache = STREAM_CACHE.lock().unwrap();
    let map = cache.get_or_insert_with(HashMap::new);
    map.insert(
        key.to_string(),
        CacheEntry {
            streams,
            fetched_at: Instant::now(),
        },
    );
}

fn clear_stream_cache() {
    let mut cache = STREAM_CACHE.lock().unwrap();
    *cache = None;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStream {
    pub name: String,
    pub description: String,
    pub url: String,
    #[serde(default)]
    pub video_size: i64,
    #[serde(default)]
    pub not_web_ready: bool,
    #[serde(skip)]
    pub parsed_quality: String,
    #[serde(skip)]
    pub parsed_source: String,
    #[serde(default)]
    pub recommended: bool,
}

fn is_recommended_url(url: &str) -> bool {
    url.contains("r2.dev")
}

#[derive(Debug, Deserialize)]
struct RawStream {
    name: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    url: String,
    #[serde(default)]
    behavior_hints: BehaviorHints,
}

#[derive(Debug, Deserialize, Default)]
struct BehaviorHints {
    #[serde(default)]
    not_web_ready: bool,
    #[serde(default, deserialize_with = "deserialize_f64_as_i64")]
    video_size: i64,
}

fn deserialize_f64_as_i64<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v: f64 = serde::Deserialize::deserialize(deserializer)?;
    Ok(v as i64)
}

#[derive(Debug, Deserialize)]
struct StreamsResponse {
    streams: Vec<RawStream>,
    #[serde(default)]
    cache_max_age: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupedStreams {
    pub quality: String,
    pub streams: Vec<RemoteStream>,
}

pub fn parse_quality(name: &str) -> String {
    let lower = name.to_lowercase();
    if lower.contains("4k") || lower.contains("2160p") {
        "4K".to_string()
    } else if lower.contains("1080p") {
        "1080p".to_string()
    } else if lower.contains("720p") {
        "720p".to_string()
    } else if lower.contains("480p") {
        "480p".to_string()
    } else {
        "Unknown".to_string()
    }
}

pub fn parse_source(name: &str) -> String {
    let lower = name.to_lowercase();
    if lower.contains("4k") {
        "Premium".to_string()
    } else {
        "Standard".to_string()
    }
}

pub fn fetch_movie_streams(imdb_id: &str, base_url: &str, force_refresh: bool) -> Result<Vec<RemoteStream>, String> {
    let cache_key = format!("movie:{}", imdb_id);

    if !force_refresh {
        if let Some(cached) = get_cached_streams(&cache_key) {
            println!("[REMOTE] Cache hit for {}", cache_key);
            return Ok(cached);
        }
    }

    let url = format!("{}/stream/movie/{}.json", base_url.trim_end_matches('/'), imdb_id);
    let streams = fetch_and_parse_streams(&url)?;
    set_cached_streams(&cache_key, streams.clone());
    Ok(streams)
}

pub fn fetch_series_streams(
    imdb_id: &str,
    season: i32,
    episode: i32,
    base_url: &str,
    force_refresh: bool,
) -> Result<Vec<RemoteStream>, String> {
    let cache_key = format!("series:{}:{}:{}", imdb_id, season, episode);

    if !force_refresh {
        if let Some(cached) = get_cached_streams(&cache_key) {
            println!("[REMOTE] Cache hit for {}", cache_key);
            return Ok(cached);
        }
    }

    let url = format!(
        "{}/stream/series/{}:{}:{}.json",
        base_url.trim_end_matches('/'),
        imdb_id,
        season,
        episode
    );
    let streams = fetch_and_parse_streams(&url)?;
    set_cached_streams(&cache_key, streams.clone());
    Ok(streams)
}

pub fn clear_streams_cache() {
    clear_stream_cache();
}

fn fetch_and_parse_streams(url: &str) -> Result<Vec<RemoteStream>, String> {
    let client = crate::http_client::shared_client();

    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("Failed to fetch streams: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Server returned {}", response.status()));
    }

    let body = response
        .text()
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    let raw: StreamsResponse = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let streams: Vec<RemoteStream> = raw
        .streams
        .into_iter()
        .map(|s| {
            let quality = parse_quality(&s.name);
            let source = parse_source(&s.name);
            RemoteStream {
                name: s.name,
                description: s.description.or(s.title).unwrap_or_default(),
                url: s.url.clone(),
                video_size: s.behavior_hints.video_size,
                not_web_ready: s.behavior_hints.not_web_ready,
                parsed_quality: quality,
                parsed_source: source,
                recommended: is_recommended_url(&s.url),
            }
        })
        .collect();

    if streams.is_empty() {
        return Err("No streams available for this content".to_string());
    }

    Ok(streams)
}

pub fn group_streams(streams: Vec<RemoteStream>) -> Vec<GroupedStreams> {
    let mut groups: std::collections::HashMap<String, Vec<RemoteStream>> =
        std::collections::HashMap::new();

    for stream in streams {
        groups
            .entry(stream.parsed_quality.clone())
            .or_default()
            .push(stream);
    }

    let quality_order = ["4K", "2160p", "1080p", "720p", "480p", "Unknown"];
    let mut result: Vec<(usize, String, Vec<RemoteStream>)> = groups
        .into_iter()
        .filter_map(|(quality, mut streams)| {
            // Recommended streams first within each group, then by video size descending
            streams.sort_by(|a, b| {
                b.recommended
                    .cmp(&a.recommended)
                    .then_with(|| {
                        b.video_size
                            .partial_cmp(&a.video_size)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
            });
            let rank = quality_order
                .iter()
                .position(|q| *q == quality)
                .unwrap_or(usize::MAX);
            Some((rank, quality, streams))
        })
        .collect();

    // Sort groups: those containing recommended streams float to the top,
    // otherwise by quality rank
    result.sort_by(|(ra, _, sa), (rb, _, sb)| {
        let a_has_rec = sa.iter().any(|s| s.recommended);
        let b_has_rec = sb.iter().any(|s| s.recommended);
        b_has_rec
            .cmp(&a_has_rec)
            .then_with(|| ra.cmp(rb))
    });

    result
        .into_iter()
        .map(|(_, quality, streams)| GroupedStreams { quality, streams })
        .collect()
}

pub fn format_file_size(bytes: i64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit_idx = 0;
    while size >= 1024.0 && unit_idx < UNITS.len() - 1 {
        size /= 1024.0;
        unit_idx += 1;
    }
    format!("{:.2} {}", size, UNITS[unit_idx])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamVerification {
    pub url: String,
    pub active: bool,
}

fn is_video_content_type(ct: &str) -> bool {
    ct.starts_with("video/")
        || ct.starts_with("application/octet-stream")
        || ct.starts_with("application/x-mpegURL")
        || ct.starts_with("application/vnd.apple.mpegurl")
        || ct.starts_with("binary/")
        || ct.contains("mp4")
        || ct.contains("matroska")
        || ct.contains("webm")
}

fn try_probe_range_get(client: &reqwest::blocking::Client, url: &str) -> Option<bool> {
    let resp = client
        .get(url)
        .header("Range", "bytes=0-1024")
        .timeout(std::time::Duration::from_secs(6))
        .send()
        .ok()?;

    let status = resp.status();
    if !status.is_success() && status != 206 {
        return None;
    }

    let ct = resp.headers().get("content-type")?.to_str().ok()?;
    if is_video_content_type(ct) {
        Some(true)
    } else {
        None
    }
}

fn try_probe_head(client: &reqwest::blocking::Client, url: &str) -> Option<bool> {
    let resp = client
        .head(url)
        .timeout(std::time::Duration::from_secs(6))
        .send()
        .ok()?;

    if !resp.status().is_success() && resp.status() != 206 {
        return None;
    }

    if let Some(ct) = resp.headers().get("content-type") {
        if let Ok(ct_str) = ct.to_str() {
            if is_video_content_type(ct_str) {
                return Some(true);
            }
            return None;
        }
    }

    None
}

fn try_probe_get_status(client: &reqwest::blocking::Client, url: &str) -> Option<bool> {
    let resp = client
        .get(url)
        .timeout(std::time::Duration::from_secs(6))
        .send()
        .ok()?;

    if !resp.status().is_success() && resp.status() != 206 {
        return None;
    }

    let ct = resp.headers().get("content-type")?.to_str().ok()?;
    if is_video_content_type(ct) {
        Some(true)
    } else {
        None
    }
}

fn verify_single_url(url: &str) -> bool {
    let client = crate::http_client::shared_client();

    if let Some(result) = try_probe_range_get(client, url) {
        return result;
    }

    if let Some(result) = try_probe_head(client, url) {
        return result;
    }

    if let Some(result) = try_probe_get_status(client, url) {
        return result;
    }

    false
}

pub fn verify_streams(urls: &[String]) -> Vec<StreamVerification> {
    use std::sync::{Arc, Mutex};
    use std::thread;

    let results = Arc::new(Mutex::new(Vec::with_capacity(urls.len())));
    let mut handles = Vec::with_capacity(urls.len());

    for url in urls {
        let url = url.clone();
        let results = Arc::clone(&results);

        handles.push(thread::spawn(move || {
            let active = verify_single_url(&url);
            let mut res = results.lock().expect("verify_streams lock");
            res.push(StreamVerification { url, active });
        }));
    }

    for handle in handles {
        let _ = handle.join();
    }

    Arc::try_unwrap(results)
        .expect("verify_streams arc unwrap")
        .into_inner()
        .expect("verify_streams mutex into_inner")
}
