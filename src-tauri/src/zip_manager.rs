use crate::database;
use crate::media_manager;
use crate::zip_parser;
use crate::zip_parser::{ZipCompressionType, ZipEntry, ZipError};
use crc32fast::Hasher as Crc32Hasher;
use flate2::read::DeflateDecoder;
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DRIVE_API_BASE: &str = "https://www.googleapis.com/drive/v3";
const ZIP_TAIL_BYTES: u64 = 131_072;
const MAX_ZIP_ENTRIES: usize = 10_000;
const MAX_ENTRY_SIZE_BYTES: u64 = 50 * 1024 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES: u64 = 16 * 1024 * 1024;
const LOCAL_HEADER_PREFETCH_BYTES: u64 = 4096;
const ZIP_TEMP_CACHE_MAX_AGE_SECS: u64 = 86_400;

#[derive(Debug, Clone)]
pub struct ZipArchiveInfo {
    pub zip_file_id: String,
    pub filename: String,
    pub archive_format: String,
    pub file_size_bytes: u64,
    pub compression_type: ZipCompressionType,
    pub central_dir_offset: u64,
    pub central_dir_size: u64,
    pub total_entries: usize,
    pub video_entries: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipEpisodeInfo {
    pub filename: String,
    pub title: String,
    pub season: i32,
    pub episode: i32,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipAnalysisResult {
    pub zip_file_id: String,
    pub filename: String,
    pub file_size: u64,
    pub compression_type: ZipCompressionType,
    pub total_entries: usize,
    pub video_entries: usize,
    pub episodes: Vec<ZipEpisodeInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipIndexResult {
    pub indexed_count: usize,
    pub skipped_count: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipStreamInfo {
    pub zip_file_id: String,
    pub byte_start: u64,
    pub byte_end: u64,
    pub content_type: String,
}

#[derive(Debug, Clone)]
pub struct IndexedZipEntry {
    pub archive_file_name: String,
    pub entry_path: String,
    pub entry_name: String,
    pub parsed: media_manager::ParsedMedia,
    pub compression_method: u16,
    pub local_header_offset: u64,
    pub data_start_offset: u64,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub crc32: String,
}

#[derive(Debug, Clone)]
pub struct AnalyzedZipArchive {
    pub archive: ZipArchiveInfo,
    pub indexed_entries: Vec<IndexedZipEntry>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveMetadataResponse {
    id: String,
    name: String,
    size: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ZipCacheConfig {
    pub cache_dir: String,
    pub max_size_bytes: u64,
    pub expiry_days: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ZipCacheMetadata {
    created_at_unix: i64,
    last_accessed_at_unix: i64,
    size_bytes: u64,
}

#[derive(Debug, Clone)]
struct ZipCacheEntry {
    media_path: PathBuf,
    meta_path: PathBuf,
    size_bytes: u64,
    last_accessed_at_unix: i64,
}

#[derive(Debug, Clone)]
pub struct ZipCachePaths {
    pub cache_path: PathBuf,
    pub temp_path: PathBuf,
    pub meta_path: PathBuf,
    pub expected_size: u64,
}

#[derive(Debug, Clone)]
pub struct ZipCacheSnapshot {
    pub paths: ZipCachePaths,
    pub available_bytes: u64,
    pub is_complete: bool,
}

pub fn analyze_zip_from_drive(
    access_token: &str,
    zip_file_id: &str,
) -> Result<AnalyzedZipArchive, ZipError> {
    let client = build_client()?;
    analyze_zip_with_client(&client, access_token, zip_file_id)
}

pub fn analyze_zip_for_preview(
    access_token: &str,
    zip_file_id: &str,
) -> Result<ZipAnalysisResult, ZipError> {
    let analyzed = analyze_zip_from_drive(access_token, zip_file_id)?;
    Ok(to_analysis_result(&analyzed))
}

pub fn check_zip_compression_type(entries: &[ZipEntry]) -> ZipCompressionType {
    let mut has_store = false;
    let mut has_deflate = false;
    let mut has_other = false;

    for entry in entries {
        if entry.is_directory {
            continue;
        }

        match entry.compression_method {
            0 => has_store = true,
            8 => has_deflate = true,
            _ => has_other = true,
        }
    }

    if has_other {
        ZipCompressionType::Other
    } else if has_store && has_deflate {
        ZipCompressionType::Mixed
    } else if has_deflate {
        ZipCompressionType::Deflate
    } else {
        ZipCompressionType::Store
    }
}

pub fn to_analysis_result(analyzed: &AnalyzedZipArchive) -> ZipAnalysisResult {
    ZipAnalysisResult {
        zip_file_id: analyzed.archive.zip_file_id.clone(),
        filename: analyzed.archive.filename.clone(),
        file_size: analyzed.archive.file_size_bytes,
        compression_type: analyzed.archive.compression_type,
        total_entries: analyzed.archive.total_entries,
        video_entries: analyzed.archive.video_entries,
        episodes: analyzed
            .indexed_entries
            .iter()
            .map(|entry| ZipEpisodeInfo {
                filename: entry.entry_name.clone(),
                title: entry.parsed.title.clone(),
                season: entry.parsed.season.unwrap_or(0),
                episode: entry.parsed.episode.unwrap_or(0),
                size: entry.uncompressed_size,
            })
            .collect(),
    }
}

pub fn build_zip_stream_info(media: &database::MediaItem) -> Result<ZipStreamInfo, ZipError> {
    match zip_entry_compression_method(media)? {
        0 => {}
        8 => return Err(ZipError::EntryRequiresExtraction),
        method => return Err(ZipError::UnsupportedCompressionMethod(method)),
    }

    let zip_file_id = media.parent_zip_id.clone().ok_or(ZipError::NotAValidZip)?;
    let byte_start = media
        .zip_data_start_offset
        .ok_or(ZipError::CorruptedArchive)? as u64;
    let compressed_size = media
        .zip_compressed_size
        .ok_or(ZipError::CorruptedArchive)? as u64;
    let byte_end = byte_start
        .checked_add(compressed_size.saturating_sub(1))
        .ok_or(ZipError::CorruptedArchive)?;

    Ok(ZipStreamInfo {
        zip_file_id,
        byte_start,
        byte_end,
        content_type: content_type_for_name(
            media
                .zip_entry_path
                .as_deref()
                .or(media.file_path.as_deref())
                .unwrap_or("video/mp4"),
        ),
    })
}

pub fn zip_entry_compression_method(media: &database::MediaItem) -> Result<u16, ZipError> {
    match media.zip_compression_method {
        Some(method) if method >= 0 && method <= u16::MAX as i64 => Ok(method as u16),
        Some(_) => Err(ZipError::CorruptedArchive),
        None => Ok(0),
    }
}

pub fn extract_zip_entry_to_cache(
    access_token: &str,
    media: &database::MediaItem,
    cache_config: &ZipCacheConfig,
) -> Result<String, ZipError> {
    let zip_file_id = media.parent_zip_id.clone().ok_or(ZipError::NotAValidZip)?;
    let entry_path = media
        .zip_entry_path
        .clone()
        .or_else(|| media.file_path.clone())
        .ok_or(ZipError::NotAValidZip)?;
    let compression_method = zip_entry_compression_method(media)?;
    let data_start_offset = media
        .zip_data_start_offset
        .ok_or(ZipError::CorruptedArchive)? as u64;
    let compressed_size = media
        .zip_compressed_size
        .ok_or(ZipError::CorruptedArchive)? as u64;
    let uncompressed_size = media
        .zip_uncompressed_size
        .ok_or(ZipError::CorruptedArchive)? as u64;
    let expected_crc = parse_crc32(media.zip_crc32.as_deref())?;

    if compressed_size == 0 || uncompressed_size == 0 || uncompressed_size > MAX_ENTRY_SIZE_BYTES {
        return Err(ZipError::CorruptedArchive);
    }

    let cache_dir = ensure_zip_cache_dir(cache_config)?;
    let cache_path = cache_path_for_entry(
        &cache_dir,
        media,
        &zip_file_id,
        &entry_path,
        expected_crc,
        uncompressed_size,
    );
    let meta_path = metadata_path_for_entry(&cache_path);
    let temp_path = temp_cache_path_for_entry(&cache_path);

    if let Ok(metadata) = fs::metadata(&cache_path) {
        if metadata.is_file() && metadata.len() == uncompressed_size {
            touch_cache_entry(&meta_path, uncompressed_size)?;
            println!(
                "[ZIP CACHE] Reusing cached entry: {}",
                cache_path.to_string_lossy()
            );
            return Ok(cache_path.to_string_lossy().to_string());
        }
        let _ = fs::remove_file(&cache_path);
        let _ = fs::remove_file(&meta_path);
    }

    enforce_cache_policy(cache_config, uncompressed_size)?;

    if let Ok(metadata) = fs::metadata(&temp_path) {
        if !metadata.is_file() || metadata.len() > uncompressed_size {
            let _ = fs::remove_file(&temp_path);
        }
    }

    let client = build_client()?;
    let range_end = data_start_offset
        .checked_add(compressed_size)
        .and_then(|value| value.checked_sub(1))
        .ok_or(ZipError::CorruptedArchive)?;
    let response = fetch_response_range(
        &client,
        access_token,
        &zip_file_id,
        data_start_offset,
        range_end,
    )?;

    let extraction_result = extract_response_to_file(
        response,
        compression_method,
        &temp_path,
        uncompressed_size,
        expected_crc,
    );

    if extraction_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    extraction_result?;

    if cache_path.exists() {
        let _ = fs::remove_file(&cache_path);
    }
    fs::rename(&temp_path, &cache_path).map_err(|_| ZipError::CorruptedArchive)?;
    write_cache_metadata(
        &meta_path,
        &ZipCacheMetadata {
            created_at_unix: unix_now(),
            last_accessed_at_unix: unix_now(),
            size_bytes: uncompressed_size,
        },
    )?;
    enforce_cache_policy(cache_config, 0)?;
    println!(
        "[ZIP CACHE] Extracted entry to cache: {}",
        cache_path.to_string_lossy()
    );

    Ok(cache_path.to_string_lossy().to_string())
}

pub fn extract_zip_entry_to_path_with_progress<F>(
    access_token: &str,
    media: &database::MediaItem,
    output_path: &Path,
    mut on_progress: F,
) -> Result<(), ZipError>
where
    F: FnMut(u64, u64),
{
    let zip_file_id = media.parent_zip_id.clone().ok_or(ZipError::NotAValidZip)?;
    let compression_method = zip_entry_compression_method(media)?;
    let data_start_offset = media
        .zip_data_start_offset
        .ok_or(ZipError::CorruptedArchive)? as u64;
    let compressed_size = media
        .zip_compressed_size
        .ok_or(ZipError::CorruptedArchive)? as u64;
    let uncompressed_size = media
        .zip_uncompressed_size
        .ok_or(ZipError::CorruptedArchive)? as u64;
    let expected_crc = parse_crc32(media.zip_crc32.as_deref())?;

    if compressed_size == 0 || uncompressed_size == 0 || uncompressed_size > MAX_ENTRY_SIZE_BYTES {
        return Err(ZipError::CorruptedArchive);
    }

    let client = build_client()?;
    let range_end = data_start_offset
        .checked_add(compressed_size)
        .and_then(|value| value.checked_sub(1))
        .ok_or(ZipError::CorruptedArchive)?;
    let response = fetch_response_range(
        &client,
        access_token,
        &zip_file_id,
        data_start_offset,
        range_end,
    )?;

    extract_response_to_file_with_progress(
        response,
        compression_method,
        output_path,
        uncompressed_size,
        expected_crc,
        &mut on_progress,
    )
}

pub fn cleanup_stale_zip_cache(cache_config: &ZipCacheConfig) -> Result<(), ZipError> {
    enforce_cache_policy(cache_config, 0)
}

pub fn prepare_stream_cache_target(
    media: &database::MediaItem,
    cache_config: &ZipCacheConfig,
) -> Result<ZipCachePaths, ZipError> {
    let zip_file_id = media.parent_zip_id.clone().ok_or(ZipError::NotAValidZip)?;
    let entry_path = media
        .zip_entry_path
        .clone()
        .or_else(|| media.file_path.clone())
        .ok_or(ZipError::NotAValidZip)?;
    let uncompressed_size = media
        .zip_uncompressed_size
        .ok_or(ZipError::CorruptedArchive)? as u64;
    let expected_crc = parse_crc32(media.zip_crc32.as_deref())?;

    if uncompressed_size == 0 || uncompressed_size > MAX_ENTRY_SIZE_BYTES {
        return Err(ZipError::CorruptedArchive);
    }

    let cache_dir = ensure_zip_cache_dir(cache_config)?;
    let cache_path = cache_path_for_entry(
        &cache_dir,
        media,
        &zip_file_id,
        &entry_path,
        expected_crc,
        uncompressed_size,
    );
    let temp_path = temp_cache_path_for_entry(&cache_path);
    let meta_path = metadata_path_for_entry(&cache_path);

    if let Ok(metadata) = fs::metadata(&cache_path) {
        if metadata.is_file() && metadata.len() == uncompressed_size {
            touch_cache_entry(&meta_path, uncompressed_size)?;
            return Ok(ZipCachePaths {
                cache_path,
                temp_path,
                meta_path,
                expected_size: uncompressed_size,
            });
        }

        let _ = fs::remove_file(&cache_path);
        let _ = fs::remove_file(&meta_path);
    }

    if let Ok(metadata) = fs::metadata(&temp_path) {
        if !metadata.is_file() || metadata.len() > uncompressed_size {
            let _ = fs::remove_file(&temp_path);
        }
    }

    enforce_cache_policy(cache_config, uncompressed_size)?;

    Ok(ZipCachePaths {
        cache_path,
        temp_path,
        meta_path,
        expected_size: uncompressed_size,
    })
}

pub fn finalize_stream_cache_target(
    cache_paths: &ZipCachePaths,
    cache_config: &ZipCacheConfig,
) -> Result<String, ZipError> {
    let metadata = fs::metadata(&cache_paths.temp_path).map_err(|_| ZipError::CorruptedArchive)?;
    if !metadata.is_file() || metadata.len() != cache_paths.expected_size {
        return Err(ZipError::IntegrityCheckFailed);
    }

    if cache_paths.cache_path.exists() {
        let _ = fs::remove_file(&cache_paths.cache_path);
    }

    fs::rename(&cache_paths.temp_path, &cache_paths.cache_path)
        .map_err(|_| ZipError::CorruptedArchive)?;
    write_cache_metadata(
        &cache_paths.meta_path,
        &ZipCacheMetadata {
            created_at_unix: unix_now(),
            last_accessed_at_unix: unix_now(),
            size_bytes: cache_paths.expected_size,
        },
    )?;
    enforce_cache_policy(cache_config, 0)?;

    Ok(cache_paths.cache_path.to_string_lossy().to_string())
}

pub fn inspect_stream_cache_target(
    media: &database::MediaItem,
    cache_config: &ZipCacheConfig,
) -> Result<ZipCacheSnapshot, ZipError> {
    let paths = prepare_stream_cache_target(media, cache_config)?;

    if let Ok(metadata) = fs::metadata(&paths.cache_path) {
        if metadata.is_file() && metadata.len() == paths.expected_size {
            touch_cache_entry(&paths.meta_path, paths.expected_size)?;
            return Ok(ZipCacheSnapshot {
                paths,
                available_bytes: metadata.len(),
                is_complete: true,
            });
        }
    }

    let available_bytes = match fs::metadata(&paths.temp_path) {
        Ok(metadata) if metadata.is_file() => metadata.len().min(paths.expected_size),
        _ => 0,
    };

    Ok(ZipCacheSnapshot {
        paths,
        available_bytes,
        is_complete: false,
    })
}

pub fn is_zip_filename(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".zip")
}

fn analyze_zip_with_client(
    client: &Client,
    access_token: &str,
    zip_file_id: &str,
) -> Result<AnalyzedZipArchive, ZipError> {
    let metadata = fetch_drive_metadata(client, access_token, zip_file_id)?;
    let file_size = metadata
        .size
        .as_deref()
        .ok_or(ZipError::NotAValidZip)?
        .parse::<u64>()
        .map_err(|_| ZipError::NotAValidZip)?;

    let tail_len = file_size.min(ZIP_TAIL_BYTES);
    let tail_start = file_size.saturating_sub(tail_len);
    let tail = fetch_range(client, access_token, zip_file_id, tail_start, file_size - 1)?;
    let eocd = zip_parser::find_eocd(&tail, tail_start)?;

    if eocd.cd_size > MAX_CENTRAL_DIRECTORY_BYTES {
        return Err(ZipError::CorruptedArchive);
    }

    let cd_end = eocd
        .cd_offset
        .checked_add(eocd.cd_size)
        .and_then(|value| value.checked_sub(1))
        .ok_or(ZipError::CorruptedArchive)?;
    let central_directory = fetch_range(client, access_token, zip_file_id, eocd.cd_offset, cd_end)?;
    let parsed_entries = zip_parser::parse_central_directory(&central_directory, eocd.cd_offset)?;

    if parsed_entries.len() > MAX_ZIP_ENTRIES {
        return Err(ZipError::CorruptedArchive);
    }

    let video_entries: Vec<_> = parsed_entries
        .iter()
        .filter(|entry| !entry.is_directory && is_video_path(&entry.filename))
        .cloned()
        .collect();

    let compression_type = check_zip_compression_type(&video_entries);

    let mut indexed_entries = Vec::new();
    for entry in video_entries {
        if entry.is_encrypted {
            continue;
        }

        if entry.uncompressed_size > MAX_ENTRY_SIZE_BYTES {
            continue;
        }

        if !is_supported_entry_compression(entry.compression_method) {
            continue;
        }

        let parsed = match extract_episode_metadata(&entry) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let data_start_offset =
            fetch_data_start_offset(client, access_token, zip_file_id, entry.local_header_offset)?;
        let entry_name = entry
            .filename
            .rsplit('/')
            .next()
            .unwrap_or(&entry.filename)
            .to_string();

        indexed_entries.push(IndexedZipEntry {
            archive_file_name: metadata.name.clone(),
            entry_path: entry.filename.clone(),
            entry_name,
            parsed,
            compression_method: entry.compression_method,
            local_header_offset: entry.local_header_offset,
            data_start_offset,
            compressed_size: entry.compressed_size,
            uncompressed_size: entry.uncompressed_size,
            crc32: format!("{:08x}", entry.crc32),
        });
    }

    Ok(AnalyzedZipArchive {
        archive: ZipArchiveInfo {
            zip_file_id: metadata.id,
            filename: metadata.name,
            archive_format: "zip".to_string(),
            file_size_bytes: file_size,
            compression_type,
            central_dir_offset: eocd.cd_offset,
            central_dir_size: eocd.cd_size,
            total_entries: parsed_entries.len(),
            video_entries: indexed_entries.len(),
        },
        indexed_entries,
    })
}

pub fn extract_episode_metadata(entry: &ZipEntry) -> Result<media_manager::ParsedMedia, ZipError> {
    let entry_name = entry.filename.rsplit('/').next().unwrap_or(&entry.filename);
    let parsed = media_manager::parse_cloud_filename(entry_name);

    if parsed.season.is_none() || parsed.episode.is_none() {
        return Err(ZipError::NotAValidZip);
    }

    Ok(parsed)
}

fn build_client() -> Result<Client, ZipError> {
    Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|_| ZipError::NotAValidZip)
}

fn fetch_drive_metadata(
    client: &Client,
    access_token: &str,
    zip_file_id: &str,
) -> Result<DriveMetadataResponse, ZipError> {
    client
        .get(format!(
            "{}/files/{}?fields=id,name,size&supportsAllDrives=true",
            DRIVE_API_BASE, zip_file_id
        ))
        .header(AUTHORIZATION, bearer_value(access_token))
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|_| ZipError::NotAValidZip)?
        .json::<DriveMetadataResponse>()
        .map_err(|_| ZipError::NotAValidZip)
}

fn fetch_range(
    client: &Client,
    access_token: &str,
    zip_file_id: &str,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, ZipError> {
    client
        .get(format!(
            "{}/files/{}?alt=media&supportsAllDrives=true",
            DRIVE_API_BASE, zip_file_id
        ))
        .header(AUTHORIZATION, bearer_value(access_token))
        .header(RANGE, format!("bytes={}-{}", start, end))
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|_| ZipError::CorruptedArchive)?
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|_| ZipError::CorruptedArchive)
}

fn fetch_response_range(
    client: &Client,
    access_token: &str,
    zip_file_id: &str,
    start: u64,
    end: u64,
) -> Result<reqwest::blocking::Response, ZipError> {
    client
        .get(format!(
            "{}/files/{}?alt=media&supportsAllDrives=true",
            DRIVE_API_BASE, zip_file_id
        ))
        .header(AUTHORIZATION, bearer_value(access_token))
        .header(RANGE, format!("bytes={}-{}", start, end))
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|_| ZipError::CorruptedArchive)
}

fn fetch_data_start_offset(
    client: &Client,
    access_token: &str,
    zip_file_id: &str,
    local_header_offset: u64,
) -> Result<u64, ZipError> {
    let mut header_bytes = fetch_range(
        client,
        access_token,
        zip_file_id,
        local_header_offset,
        local_header_offset + LOCAL_HEADER_PREFETCH_BYTES - 1,
    )?;

    if header_bytes.len() < 30 {
        return Err(ZipError::CorruptedArchive);
    }

    let file_name_length = u16::from_le_bytes([header_bytes[26], header_bytes[27]]) as usize;
    let extra_length = u16::from_le_bytes([header_bytes[28], header_bytes[29]]) as usize;
    let required_len = 30 + file_name_length + extra_length;

    if header_bytes.len() < required_len {
        header_bytes = fetch_range(
            client,
            access_token,
            zip_file_id,
            local_header_offset,
            local_header_offset + required_len as u64 - 1,
        )?;
    }

    Ok(zip_parser::parse_local_file_header(&header_bytes, local_header_offset)?.data_start_offset)
}

fn bearer_value(access_token: &str) -> String {
    format!("Bearer {}", access_token)
}

fn is_supported_entry_compression(method: u16) -> bool {
    matches!(method, 0 | 8)
}

fn parse_crc32(value: Option<&str>) -> Result<u32, ZipError> {
    u32::from_str_radix(value.ok_or(ZipError::CorruptedArchive)?, 16)
        .map_err(|_| ZipError::CorruptedArchive)
}

fn ensure_zip_cache_dir(cache_config: &ZipCacheConfig) -> Result<PathBuf, ZipError> {
    let cache_dir = PathBuf::from(&cache_config.cache_dir);
    fs::create_dir_all(&cache_dir).map_err(|_| ZipError::CorruptedArchive)?;
    Ok(cache_dir)
}

fn metadata_path_for_entry(cache_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.meta.json", cache_path.to_string_lossy()))
}

fn temp_cache_path_for_entry(cache_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.part", cache_path.to_string_lossy()))
}

fn cache_path_for_entry(
    cache_dir: &Path,
    media: &database::MediaItem,
    zip_file_id: &str,
    entry_path: &str,
    crc32: u32,
    uncompressed_size: u64,
) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    zip_file_id.hash(&mut hasher);
    entry_path.hash(&mut hasher);
    crc32.hash(&mut hasher);
    uncompressed_size.hash(&mut hasher);
    let hash = hasher.finish();
    let extension = Path::new(entry_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("bin");
    let label = build_cache_label(media, entry_path);
    cache_dir.join(format!("{}__{:016x}.{}", label, hash, extension))
}

fn build_cache_label(media: &database::MediaItem, entry_path: &str) -> String {
    let mut parts = Vec::new();

    let title = sanitize_cache_name_component(&media.title);
    if !title.is_empty() {
        parts.push(title);
    }

    if let (Some(season), Some(episode)) = (media.season_number, media.episode_number) {
        parts.push(format!("S{:02}E{:02}", season.max(0), episode.max(0)));
    } else if let Some(year) = media.year {
        parts.push(year.to_string());
    }

    if let Some(episode_title) = media.episode_title.as_deref() {
        let cleaned_episode_title = sanitize_cache_name_component(episode_title);
        if !cleaned_episode_title.is_empty() {
            parts.push(cleaned_episode_title);
        }
    }

    if parts.is_empty() {
        let fallback = Path::new(entry_path)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(sanitize_cache_name_component)
            .unwrap_or_else(|| "zip-cache".to_string());
        parts.push(fallback);
    }

    let mut label = parts.join(" - ");
    if label.len() > 96 {
        label.truncate(96);
        label = label.trim_end_matches([' ', '.', '-']).to_string();
    }

    if label.is_empty() {
        "zip-cache".to_string()
    } else {
        label
    }
}

fn sanitize_cache_name_component(value: &str) -> String {
    let mut sanitized = String::with_capacity(value.len());
    let mut last_was_separator = false;

    for ch in value.chars() {
        let is_valid =
            ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '.' | '(' | ')');
        let normalized = if is_valid { ch } else { ' ' };

        if normalized.is_whitespace() {
            if !last_was_separator {
                sanitized.push(' ');
                last_was_separator = true;
            }
        } else {
            sanitized.push(normalized);
            last_was_separator = false;
        }
    }

    sanitized.trim_matches([' ', '.', '-']).replace(" .", ".")
}

fn extract_response_to_file(
    response: reqwest::blocking::Response,
    compression_method: u16,
    output_path: &Path,
    expected_size: u64,
    expected_crc32: u32,
) -> Result<(), ZipError> {
    extract_response_to_file_with_progress(
        response,
        compression_method,
        output_path,
        expected_size,
        expected_crc32,
        &mut |_, _| {},
    )
}

fn extract_response_to_file_with_progress<F>(
    response: reqwest::blocking::Response,
    compression_method: u16,
    output_path: &Path,
    expected_size: u64,
    expected_crc32: u32,
    on_progress: &mut F,
) -> Result<(), ZipError>
where
    F: FnMut(u64, u64),
{
    let mut writer =
        BufWriter::new(File::create(output_path).map_err(|_| ZipError::CorruptedArchive)?);
    let mut crc = Crc32Hasher::new();
    let bytes_written = match compression_method {
        0 => copy_and_hash_with_progress(response, &mut writer, &mut crc, expected_size, on_progress)?,
        8 => copy_and_hash_with_progress(
            DeflateDecoder::new(response),
            &mut writer,
            &mut crc,
            expected_size,
            on_progress,
        )?,
        method => return Err(ZipError::UnsupportedCompressionMethod(method)),
    };

    writer.flush().map_err(|_| ZipError::CorruptedArchive)?;

    if bytes_written != expected_size || crc.finalize() != expected_crc32 {
        return Err(ZipError::IntegrityCheckFailed);
    }

    Ok(())
}

fn copy_and_hash<R: Read, W: Write>(
    reader: R,
    writer: &mut W,
    crc: &mut Crc32Hasher,
) -> Result<u64, ZipError> {
    copy_and_hash_with_progress(reader, writer, crc, 0, &mut |_, _| {})
}

fn copy_and_hash_with_progress<R: Read, W: Write, F: FnMut(u64, u64)>(
    mut reader: R,
    writer: &mut W,
    crc: &mut Crc32Hasher,
    expected_size: u64,
    on_progress: &mut F,
) -> Result<u64, ZipError> {
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| ZipError::CorruptedArchive)?;
        if read == 0 {
            break;
        }

        writer
            .write_all(&buffer[..read])
            .map_err(|_| ZipError::CorruptedArchive)?;
        crc.update(&buffer[..read]);
        total = total
            .checked_add(read as u64)
            .ok_or(ZipError::CorruptedArchive)?;
        on_progress(total, expected_size);
    }

    Ok(total)
}

fn enforce_cache_policy(cache_config: &ZipCacheConfig, reserve_bytes: u64) -> Result<(), ZipError> {
    let cache_dir = ensure_zip_cache_dir(cache_config)?;
    cleanup_temporary_cache_files(&cache_dir)?;
    let expiry_seconds = u64::from(cache_config.expiry_days).saturating_mul(86_400);
    let now = unix_now();
    let mut entries = collect_cache_entries(&cache_dir)?;

    for entry in &entries {
        if expiry_seconds > 0
            && now.saturating_sub(entry.last_accessed_at_unix) >= expiry_seconds as i64
        {
            let _ = remove_cache_entry(entry);
        }
    }

    entries = collect_cache_entries(&cache_dir)?;
    let mut total_size: u64 = entries.iter().fold(0u64, |acc, e| acc.saturating_add(e.size_bytes));
    let target_limit = cache_config.max_size_bytes.max(reserve_bytes);

    if total_size.saturating_add(reserve_bytes) <= target_limit {
        return Ok(());
    }

    entries.sort_by_key(|entry| entry.last_accessed_at_unix);
    for entry in entries {
        if total_size.saturating_add(reserve_bytes) <= target_limit {
            break;
        }

        remove_cache_entry(&entry)?;
        total_size = total_size.saturating_sub(entry.size_bytes);
    }

    Ok(())
}

fn collect_cache_entries(cache_dir: &Path) -> Result<Vec<ZipCacheEntry>, ZipError> {
    let mut entries = Vec::new();

    for entry in fs::read_dir(cache_dir).map_err(|_| ZipError::CorruptedArchive)? {
        let entry = entry.map_err(|_| ZipError::CorruptedArchive)?;
        let path = entry.path();
        let metadata = entry.metadata().map_err(|_| ZipError::CorruptedArchive)?;

        if !metadata.is_file() || is_cache_metadata_file(&path) || is_cache_temp_file(&path) {
            continue;
        }

        let meta_path = metadata_path_for_entry(&path);
        let cache_metadata = read_cache_metadata(&meta_path).unwrap_or(ZipCacheMetadata {
            created_at_unix: system_time_to_unix(
                metadata.modified().unwrap_or_else(|_| SystemTime::now()),
            ),
            last_accessed_at_unix: system_time_to_unix(
                metadata.modified().unwrap_or_else(|_| SystemTime::now()),
            ),
            size_bytes: metadata.len(),
        });

        entries.push(ZipCacheEntry {
            media_path: path,
            meta_path,
            size_bytes: metadata.len(),
            last_accessed_at_unix: cache_metadata.last_accessed_at_unix,
        });
    }

    Ok(entries)
}

fn read_cache_metadata(meta_path: &Path) -> Result<ZipCacheMetadata, ZipError> {
    let contents = fs::read_to_string(meta_path).map_err(|_| ZipError::CorruptedArchive)?;
    serde_json::from_str(&contents).map_err(|_| ZipError::CorruptedArchive)
}

fn write_cache_metadata(meta_path: &Path, metadata: &ZipCacheMetadata) -> Result<(), ZipError> {
    let json = serde_json::to_string(metadata).map_err(|_| ZipError::CorruptedArchive)?;
    fs::write(meta_path, json).map_err(|_| ZipError::CorruptedArchive)
}

fn touch_cache_entry(meta_path: &Path, size_bytes: u64) -> Result<(), ZipError> {
    let now = unix_now();
    let mut metadata = read_cache_metadata(meta_path).unwrap_or(ZipCacheMetadata {
        created_at_unix: now,
        last_accessed_at_unix: now,
        size_bytes,
    });
    metadata.last_accessed_at_unix = now;
    metadata.size_bytes = size_bytes;
    write_cache_metadata(meta_path, &metadata)
}

fn remove_cache_entry(entry: &ZipCacheEntry) -> Result<(), ZipError> {
    if entry.media_path.exists() {
        fs::remove_file(&entry.media_path).map_err(|_| ZipError::CorruptedArchive)?;
    }
    if entry.meta_path.exists() {
        fs::remove_file(&entry.meta_path).map_err(|_| ZipError::CorruptedArchive)?;
    }
    Ok(())
}

fn is_cache_metadata_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.ends_with(".meta.json"))
        .unwrap_or(false)
}

fn is_cache_temp_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.ends_with(".part"))
        .unwrap_or(false)
}

fn cleanup_temporary_cache_files(cache_dir: &Path) -> Result<(), ZipError> {
    let now = SystemTime::now();

    for entry in fs::read_dir(cache_dir).map_err(|_| ZipError::CorruptedArchive)? {
        let entry = entry.map_err(|_| ZipError::CorruptedArchive)?;
        let path = entry.path();

        if is_cache_temp_file(&path) {
            let should_remove = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| now.duration_since(modified).ok())
                .map(|age| age.as_secs() >= ZIP_TEMP_CACHE_MAX_AGE_SECS)
                .unwrap_or(true);

            if should_remove {
                let _ = fs::remove_file(path);
            }
        }
    }

    Ok(())
}

fn unix_now() -> i64 {
    system_time_to_unix(SystemTime::now())
}

fn system_time_to_unix(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub fn content_type_for_name(name: &str) -> String {
    match name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mkv" => "video/x-matroska".to_string(),
        "mp4" => "video/mp4".to_string(),
        "webm" => "video/webm".to_string(),
        "avi" => "video/x-msvideo".to_string(),
        "mov" => "video/quicktime".to_string(),
        "m4v" => "video/x-m4v".to_string(),
        "ts" => "video/mp2t".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

pub fn is_video_path(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "mkv" | "mp4" | "avi" | "mov" | "webm" | "m4v" | "wmv" | "flv" | "ts"
    )
}

pub fn response_headers_to_vec(response: &reqwest::blocking::Response) -> Vec<(String, String)> {
    let mut headers = Vec::new();

    if let Some(content_type) = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    {
        headers.push(("Content-Type".to_string(), content_type.to_string()));
    }
    if let Some(content_range) = response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
    {
        headers.push(("Content-Range".to_string(), content_range.to_string()));
    }
    if let Some(content_length) = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
    {
        headers.push(("Content-Length".to_string(), content_length.to_string()));
    }

    headers
}

#[cfg(test)]
mod tests {
    use super::{check_zip_compression_type, content_type_for_name, is_video_path};
    use crate::zip_parser::{ZipCompressionType, ZipEntry};

    #[test]
    fn detects_video_extensions() {
        assert!(is_video_path("Season 01/Show.S01E01.mkv"));
        assert!(!is_video_path("notes.txt"));
    }

    #[test]
    fn maps_content_types() {
        assert_eq!(content_type_for_name("episode.mkv"), "video/x-matroska");
        assert_eq!(content_type_for_name("episode.mp4"), "video/mp4");
    }

    #[test]
    fn classifies_compression_types() {
        let store_entry = ZipEntry {
            filename: "a.mkv".to_string(),
            compression_method: 0,
            compressed_size: 1,
            uncompressed_size: 1,
            local_header_offset: 0,
            crc32: 0,
            is_encrypted: false,
            is_directory: false,
        };
        let deflate_entry = ZipEntry {
            compression_method: 8,
            ..store_entry.clone()
        };

        assert_eq!(
            check_zip_compression_type(&[store_entry.clone()]),
            ZipCompressionType::Store
        );
        assert_eq!(
            check_zip_compression_type(&[deflate_entry]),
            ZipCompressionType::Deflate
        );
        assert_eq!(
            check_zip_compression_type(&[
                store_entry.clone(),
                ZipEntry {
                    compression_method: 8,
                    ..store_entry
                }
            ]),
            ZipCompressionType::Mixed
        );
    }
}
