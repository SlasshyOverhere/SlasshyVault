use crate::database;
use crate::media_manager;
use crate::zip_parser;
use crate::zip_parser::{ZipCompressionType, ZipEntry, ZipError};
use crc32fast::Hasher as Crc32Hasher;
use flate2::read::DeflateDecoder;
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const DRIVE_API_BASE: &str = "https://www.googleapis.com/drive/v3";
const ZIP_TAIL_BYTES: u64 = 131_072;
const MAX_ZIP_ENTRIES: usize = 10_000;
const MAX_ENTRY_SIZE_BYTES: u64 = 50 * 1024 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES: u64 = 16 * 1024 * 1024;
const LOCAL_HEADER_PREFETCH_BYTES: u64 = 4096;
const ZIP_CACHE_MAX_AGE: Duration = Duration::from_secs(21_600);

#[derive(Debug, Clone)]
pub struct ZipArchiveInfo {
    pub zip_file_id: String,
    pub filename: String,
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

    let cache_dir = ensure_zip_cache_dir()?;
    let cache_path = cache_path_for_entry(
        &cache_dir,
        &zip_file_id,
        &entry_path,
        expected_crc,
        uncompressed_size,
    );

    if let Ok(metadata) = fs::metadata(&cache_path) {
        if metadata.is_file() && metadata.len() == uncompressed_size {
            return Ok(cache_path.to_string_lossy().to_string());
        }
        let _ = fs::remove_file(&cache_path);
    }

    let temp_path = cache_dir.join(format!("{}.part", Uuid::new_v4()));
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

    Ok(cache_path.to_string_lossy().to_string())
}

pub fn cleanup_stale_zip_cache() -> Result<(), ZipError> {
    let cache_dir = PathBuf::from(database::get_zip_cache_dir());
    if !cache_dir.exists() {
        return Ok(());
    }

    let now = std::time::SystemTime::now();
    for entry in fs::read_dir(&cache_dir).map_err(|_| ZipError::CorruptedArchive)? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }

        let modified = metadata.modified().unwrap_or(now);
        let age = now.duration_since(modified).unwrap_or_default();
        if age > ZIP_CACHE_MAX_AGE {
            let _ = fs::remove_file(path);
        }
    }

    Ok(())
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
            "{}/files/{}?fields=id,name,size",
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
            "{}/files/{}?alt=media",
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
            "{}/files/{}?alt=media",
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

fn ensure_zip_cache_dir() -> Result<PathBuf, ZipError> {
    let cache_dir = PathBuf::from(database::get_zip_cache_dir());
    fs::create_dir_all(&cache_dir).map_err(|_| ZipError::CorruptedArchive)?;
    Ok(cache_dir)
}

fn cache_path_for_entry(
    cache_dir: &Path,
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
    cache_dir.join(format!("{:016x}.{}", hash, extension))
}

fn extract_response_to_file(
    response: reqwest::blocking::Response,
    compression_method: u16,
    output_path: &Path,
    expected_size: u64,
    expected_crc32: u32,
) -> Result<(), ZipError> {
    let mut writer =
        BufWriter::new(File::create(output_path).map_err(|_| ZipError::CorruptedArchive)?);
    let mut crc = Crc32Hasher::new();
    let bytes_written = match compression_method {
        0 => copy_and_hash(response, &mut writer, &mut crc)?,
        8 => copy_and_hash(DeflateDecoder::new(response), &mut writer, &mut crc)?,
        method => return Err(ZipError::UnsupportedCompressionMethod(method)),
    };

    writer.flush().map_err(|_| ZipError::CorruptedArchive)?;

    if bytes_written != expected_size || crc.finalize() != expected_crc32 {
        return Err(ZipError::IntegrityCheckFailed);
    }

    Ok(())
}

fn copy_and_hash<R: Read, W: Write>(
    mut reader: R,
    writer: &mut W,
    crc: &mut Crc32Hasher,
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
    }

    Ok(total)
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
    use crate::zip_parser::ZipEntry;

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
