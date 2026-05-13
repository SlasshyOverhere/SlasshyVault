use crate::database;
use crate::media_manager;
use crate::zip_manager;
use crate::zip_parser;
use flate2::read::GzDecoder;
use rar_stream::{
    FileMedia as RarFileMedia, ParseOptions as RarParseOptions, RarFilesPackage, ReadInterval,
};
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, RANGE};
use reqwest::Client as AsyncClient;
use serde::Serialize;
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::OnceLock;
use tar::Archive as TarArchive;
use tokio::runtime::Builder as TokioRuntimeBuilder;
use unrar::Archive as RarArchive;

fn get_rar_runtime() -> &'static tokio::runtime::Runtime {
    static RAR_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RAR_RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("Failed to create RAR runtime")
    })
}

const DRIVE_API_BASE: &str = "https://www.googleapis.com/drive/v3";
const ARCHIVE_STREAM_BUFFER_BYTES: usize = 1024 * 1024;
const RAR_HEADER_PREFETCH_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    Zip,
    Tar,
    Rar,
}

impl ArchiveFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            ArchiveFormat::Zip => "zip",
            ArchiveFormat::Tar => "tar",
            ArchiveFormat::Rar => "rar",
        }
    }
}

#[derive(Debug, Clone)]
pub struct IndexedArchiveEntry {
    pub entry_path: String,
    pub entry_name: String,
    pub parsed: media_manager::ParsedMedia,
    pub local_header_offset: u64,
    pub data_start_offset: u64,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub crc32: String,
    pub compression_method: i64,
}

#[derive(Debug, Clone)]
pub struct AnalyzedArchive {
    pub archive: zip_manager::ZipArchiveInfo,
    pub indexed_entries: Vec<IndexedArchiveEntry>,
}

pub fn detect_archive_format(name: &str, mime_type: Option<&str>) -> Option<ArchiveFormat> {
    let lower = name.to_ascii_lowercase();
    let mime = mime_type.unwrap_or_default().to_ascii_lowercase();

    if mime == "application/zip"
        || mime == "application/x-zip-compressed"
        || lower.ends_with(".zip")
    {
        return Some(ArchiveFormat::Zip);
    }

    if mime == "application/x-rar-compressed"
        || mime == "application/vnd.rar"
        || lower.ends_with(".rar")
    {
        return Some(ArchiveFormat::Rar);
    }

    if mime == "application/x-tar"
        || mime == "application/gzip"
        || lower.ends_with(".tar")
        || lower.ends_with(".tar.gz")
        || lower.ends_with(".tgz")
    {
        return Some(ArchiveFormat::Tar);
    }

    None
}

pub fn is_supported_archive_item(name: &str, mime_type: Option<&str>) -> bool {
    detect_archive_format(name, mime_type).is_some()
}

pub fn archive_format_for_media(media: &database::MediaItem) -> ArchiveFormat {
    match media.archive_format.as_deref() {
        Some("tar") => ArchiveFormat::Tar,
        Some("rar") => ArchiveFormat::Rar,
        _ => ArchiveFormat::Zip,
    }
}

pub fn analyze_archive_from_drive(
    access_token: &str,
    file_id: &str,
    filename: &str,
    mime_type: Option<&str>,
    cache_config: &zip_manager::ZipCacheConfig,
) -> Result<AnalyzedArchive, String> {
    match detect_archive_format(filename, mime_type)
        .ok_or_else(|| format!("Unsupported archive format for '{}'", filename))?
    {
        ArchiveFormat::Zip => {
            let analyzed = zip_manager::analyze_zip_from_drive(access_token, file_id)
                .map_err(|e| e.to_string())?;
            Ok(AnalyzedArchive {
                archive: analyzed.archive,
                indexed_entries: analyzed
                    .indexed_entries
                    .into_iter()
                    .map(|entry| IndexedArchiveEntry {
                        entry_path: entry.entry_path,
                        entry_name: entry.entry_name,
                        parsed: entry.parsed,
                        local_header_offset: entry.local_header_offset,
                        data_start_offset: entry.data_start_offset,
                        compressed_size: entry.compressed_size,
                        uncompressed_size: entry.uncompressed_size,
                        crc32: entry.crc32,
                        compression_method: i64::from(entry.compression_method),
                    })
                    .collect(),
            })
        }
        ArchiveFormat::Tar => analyze_tar_from_drive(access_token, file_id, filename, mime_type),
        ArchiveFormat::Rar => analyze_rar_from_drive(access_token, file_id, filename, cache_config),
    }
}

pub fn extract_archive_entry_to_cache(
    access_token: &str,
    media: &database::MediaItem,
    cache_config: &zip_manager::ZipCacheConfig,
) -> Result<String, String> {
    match archive_format_for_media(media) {
        ArchiveFormat::Zip => {
            zip_manager::extract_zip_entry_to_cache(access_token, media, cache_config)
                .map_err(|e| e.to_string())
        }
        ArchiveFormat::Tar => extract_tar_entry_to_cache(access_token, media, cache_config),
        ArchiveFormat::Rar => extract_rar_entry_to_cache(access_token, media, cache_config),
    }
}

pub fn build_archive_stream_info(
    media: &database::MediaItem,
) -> Result<zip_manager::ZipStreamInfo, String> {
    match archive_format_for_media(media) {
        ArchiveFormat::Zip => zip_manager::build_zip_stream_info(media).map_err(|e| e.to_string()),
        ArchiveFormat::Tar | ArchiveFormat::Rar => {
            let archive_file_id = media
                .parent_zip_id
                .clone()
                .ok_or_else(|| "Archive file ID not found".to_string())?;
            let method = media.zip_compression_method.unwrap_or(-1);
            if method != 0 {
                return Err("Archive entry requires extraction before playback".to_string());
            }

            let byte_start = media
                .zip_data_start_offset
                .ok_or_else(|| "Archive entry does not support direct streaming".to_string())?
                as u64;
            let compressed_size = media
                .zip_compressed_size
                .ok_or_else(|| "Archive entry size not available".to_string())?
                as u64;
            let byte_end = byte_start
                .checked_add(compressed_size.saturating_sub(1))
                .ok_or_else(|| "Archive entry range overflow".to_string())?;

            Ok(zip_manager::ZipStreamInfo {
                zip_file_id: archive_file_id,
                byte_start,
                byte_end,
                content_type: zip_manager::content_type_for_name(
                    media
                        .zip_entry_path
                        .as_deref()
                        .or(media.file_path.as_deref())
                        .unwrap_or("video/mp4"),
                ),
            })
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePlaybackAssessment {
    pub can_play: bool,
    pub mode: String,
    pub message: String,
    pub details: Vec<String>,
}

pub fn assess_archive_playback(media: &database::MediaItem) -> Option<ArchivePlaybackAssessment> {
    if media.parent_zip_id.is_none() {
        return None;
    }

    let assessment = match archive_format_for_media(media) {
        ArchiveFormat::Zip => assess_zip_playback(media),
        ArchiveFormat::Tar => assess_tar_playback(media),
        ArchiveFormat::Rar => assess_rar_playback(media),
    };

    Some(assessment)
}

fn assess_zip_playback(media: &database::MediaItem) -> ArchivePlaybackAssessment {
    match media.zip_compression_method.unwrap_or(0) {
        0 if build_archive_stream_info(media).is_ok() => ArchivePlaybackAssessment {
            can_play: true,
            mode: "direct".to_string(),
            message: "Playable directly from the archive.".to_string(),
            details: vec![
                "ZIP entry uses store mode, so playback can stream raw bytes directly from Drive."
                    .to_string(),
            ],
        },
        8 => ArchivePlaybackAssessment {
            can_play: true,
            mode: "extract".to_string(),
            message: "Playable, but playback requires extraction first.".to_string(),
            details: vec![
                "ZIP entry is compressed with deflate, so raw byte-range streaming is not possible."
                    .to_string(),
                "Startup may be slower because the video must be extracted into cache before playback."
                    .to_string(),
            ],
        },
        method => ArchivePlaybackAssessment {
            can_play: false,
            mode: "unsupported".to_string(),
            message: "This ZIP entry is not supported for playback.".to_string(),
            details: vec![format!(
                "ZIP entry uses unsupported compression or archive metadata (method {}).",
                method
            )],
        },
    }
}

fn assess_tar_playback(media: &database::MediaItem) -> ArchivePlaybackAssessment {
    if build_archive_stream_info(media).is_ok() {
        ArchivePlaybackAssessment {
            can_play: true,
            mode: "direct".to_string(),
            message: "Playable directly from the archive.".to_string(),
            details: vec![
                "This TAR entry has direct raw byte offsets, so playback can stream without extraction."
                    .to_string(),
            ],
        }
    } else {
        ArchivePlaybackAssessment {
            can_play: true,
            mode: "extract".to_string(),
            message: "Playable, but playback requires extraction first.".to_string(),
            details: vec![
                "Compressed TAR variants such as .tar.gz or .tgz are not directly range-streamable."
                    .to_string(),
                "Playback may start slower because the video must be extracted into cache first."
                    .to_string(),
            ],
        }
    }
}

fn assess_rar_playback(media: &database::MediaItem) -> ArchivePlaybackAssessment {
    if build_archive_stream_info(media).is_ok() {
        ArchivePlaybackAssessment {
            can_play: true,
            mode: "direct".to_string(),
            message: "Playable directly from the archive.".to_string(),
            details: vec![
                "This RAR entry is stored and directly range-streamable, so playback can start without extraction."
                    .to_string(),
            ],
        }
    } else {
        ArchivePlaybackAssessment {
            can_play: true,
            mode: "extract".to_string(),
            message: "Playable, but playback requires extraction first.".to_string(),
            details: vec![
                "Most RAR entries cannot be streamed like ZIP store mode if they are compressed, solid, split across volumes, encrypted, or otherwise not directly range-addressable."
                    .to_string(),
                "Playback may start slower because the video must be extracted into cache first."
                    .to_string(),
            ],
        }
    }
}

#[derive(Clone)]
struct DriveRarMedia {
    access_token: String,
    file_id: String,
    name: String,
    length: u64,
    client: AsyncClient,
}

impl DriveRarMedia {
    fn new(access_token: &str, file_id: &str, name: &str, length: u64) -> Result<Self, String> {
        let client = AsyncClient::builder().build().map_err(|e| e.to_string())?;
        Ok(Self {
            access_token: access_token.to_string(),
            file_id: file_id.to_string(),
            name: name.to_string(),
            length,
            client,
        })
    }
}

impl RarFileMedia for DriveRarMedia {
    fn length(&self) -> u64 {
        self.length
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn read_range(
        &self,
        interval: ReadInterval,
    ) -> Pin<Box<dyn std::future::Future<Output = rar_stream::error::Result<Vec<u8>>> + Send + '_>>
    {
        let client = self.client.clone();
        let access_token = self.access_token.clone();
        let file_id = self.file_id.clone();

        Box::pin(async move {
            if interval.start > interval.end {
                return Err(rar_stream::RarError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "invalid range interval",
                )));
            }

            let response = client
                .get(format!(
                    "{}/files/{}?alt=media&supportsAllDrives=true",
                    DRIVE_API_BASE, file_id
                ))
                .header(AUTHORIZATION, format!("Bearer {}", access_token))
                .header(RANGE, format!("bytes={}-{}", interval.start, interval.end))
                .send()
                .await
                .map_err(http_error_to_rar_io)?
                .error_for_status()
                .map_err(http_error_to_rar_io)?;

            let bytes = response.bytes().await.map_err(http_error_to_rar_io)?;
            Ok(bytes.to_vec())
        })
    }
}

fn http_error_to_rar_io(error: reqwest::Error) -> rar_stream::RarError {
    rar_stream::RarError::Io(std::io::Error::other(error.to_string()))
}

fn fetch_drive_media_response(
    access_token: &str,
    file_id: &str,
) -> Result<reqwest::blocking::Response, String> {
    let client = Client::builder().build().map_err(|e| e.to_string())?;
    client
        .get(format!(
            "{}/files/{}?alt=media&supportsAllDrives=true",
            DRIVE_API_BASE, file_id
        ))
        .header(AUTHORIZATION, format!("Bearer {}", access_token))
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|e| e.to_string())
}

fn fetch_drive_file_size(access_token: &str, file_id: &str) -> Result<u64, String> {
    let client = Client::builder().build().map_err(|e| e.to_string())?;
    let payload = client
        .get(format!(
            "{}/files/{}?fields=size&supportsAllDrives=true",
            DRIVE_API_BASE, file_id
        ))
        .header(AUTHORIZATION, format!("Bearer {}", access_token))
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .map_err(|e| e.to_string())?;

    payload["size"]
        .as_str()
        .ok_or_else(|| "Drive file size missing from metadata response".to_string())?
        .parse::<u64>()
        .map_err(|e| e.to_string())
}

fn analyze_tar_from_drive(
    access_token: &str,
    file_id: &str,
    filename: &str,
    mime_type: Option<&str>,
) -> Result<AnalyzedArchive, String> {
    let response = fetch_drive_media_response(access_token, file_id)?;
    let file_size_bytes = response.content_length().unwrap_or(0);
    let gzip_hint = mime_type
        .map(|value| value.eq_ignore_ascii_case("application/gzip"))
        .unwrap_or(false)
        || is_gzip_tar(filename);
    let buffered = BufReader::with_capacity(ARCHIVE_STREAM_BUFFER_BYTES, response);
    let reader: Box<dyn Read> = if gzip_hint {
        Box::new(GzDecoder::new(buffered))
    } else {
        Box::new(buffered)
    };

    analyze_tar_reader(file_id, filename, file_size_bytes, reader, !gzip_hint)
}

fn analyze_tar_reader(
    file_id: &str,
    filename: &str,
    file_size_bytes: u64,
    reader: Box<dyn Read>,
    supports_passthrough: bool,
) -> Result<AnalyzedArchive, String> {
    let mut archive = TarArchive::new(reader);
    let mut indexed_entries = Vec::new();
    let mut total_entries = 0usize;

    for entry_result in archive.entries().map_err(|e| e.to_string())? {
        let entry = entry_result.map_err(|e| e.to_string())?;
        total_entries += 1;

        if entry.header().entry_type().is_dir() {
            continue;
        }

        let raw_path = entry
            .path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let entry_path =
            zip_parser::sanitize_zip_entry_path(&raw_path).map_err(|e| e.to_string())?;
        if !zip_manager::is_video_path(&entry_path) {
            continue;
        }

        let entry_name = entry_path
            .rsplit('/')
            .next()
            .unwrap_or(&entry_path)
            .to_string();
        let parsed = media_manager::parse_cloud_filename(&entry_name);
        if parsed.season.is_none() || parsed.episode.is_none() {
            continue;
        }

        indexed_entries.push(IndexedArchiveEntry {
            entry_path,
            entry_name,
            parsed,
            local_header_offset: if supports_passthrough {
                entry.raw_header_position()
            } else {
                0
            },
            data_start_offset: if supports_passthrough {
                entry.raw_file_position()
            } else {
                0
            },
            compressed_size: if supports_passthrough {
                entry.size()
            } else {
                0
            },
            uncompressed_size: entry.size(),
            crc32: "00000000".to_string(),
            compression_method: if supports_passthrough { 0 } else { -2 },
        });
    }

    Ok(AnalyzedArchive {
        archive: zip_manager::ZipArchiveInfo {
            zip_file_id: file_id.to_string(),
            filename: filename.to_string(),
            archive_format: ArchiveFormat::Tar.as_str().to_string(),
            file_size_bytes,
            compression_type: zip_parser::ZipCompressionType::Other,
            central_dir_offset: 0,
            central_dir_size: 0,
            total_entries,
            video_entries: indexed_entries.len(),
        },
        indexed_entries,
    })
}

fn analyze_rar_from_drive(
    access_token: &str,
    file_id: &str,
    filename: &str,
    cache_config: &zip_manager::ZipCacheConfig,
) -> Result<AnalyzedArchive, String> {
    match analyze_rar_from_drive_fast(access_token, file_id, filename) {
        Ok(analyzed) => Ok(analyzed),
        Err(error) => {
            eprintln!(
                "[ARCHIVE] Fast RAR analysis failed for '{}'; falling back to local source: {}",
                filename, error
            );

            let source_path =
                download_archive_to_temp(access_token, file_id, filename, cache_config, "analyze")?;
            let result = analyze_rar_from_path(file_id, filename, &source_path);
            let _ = fs::remove_file(source_path);
            result
        }
    }
}

fn analyze_rar_from_drive_fast(
    access_token: &str,
    file_id: &str,
    filename: &str,
) -> Result<AnalyzedArchive, String> {
    let file_size_bytes = fetch_drive_file_size(access_token, file_id)?;
    let media: Arc<dyn RarFileMedia> = Arc::new(DriveRarMedia::new(
        access_token,
        file_id,
        filename,
        file_size_bytes,
    )?);
    let package = RarFilesPackage::new(vec![media]);
    let runtime = get_rar_runtime();
    let entries = runtime
        .block_on(async {
            package
                .parse(RarParseOptions {
                    header_prefetch_size: Some(RAR_HEADER_PREFETCH_BYTES),
                    ..Default::default()
                })
                .await
        })
        .map_err(|e| e.to_string())?;

    let total_entries = entries.len();
    let mut indexed_entries = Vec::new();

    for entry in entries {
        let entry_path =
            zip_parser::sanitize_zip_entry_path(&entry.name).map_err(|e| e.to_string())?;
        if !zip_manager::is_video_path(&entry_path) {
            continue;
        }

        let entry_name = entry_path
            .rsplit('/')
            .next()
            .unwrap_or(&entry_path)
            .to_string();
        let parsed = media_manager::parse_cloud_filename(&entry_name);
        if parsed.season.is_none() || parsed.episode.is_none() {
            continue;
        }

        let supports_passthrough =
            !entry.is_compressed() && !entry.is_solid() && entry.chunk_count() == 1;
        let (data_start_offset, compressed_size, compression_method) = if supports_passthrough {
            let chunk = entry
                .get_chunk(0)
                .ok_or_else(|| "RAR entry missing raw chunk metadata".to_string())?;
            (chunk.start_offset, chunk.length(), 0)
        } else {
            (0, 0, -1)
        };

        indexed_entries.push(IndexedArchiveEntry {
            entry_path,
            entry_name,
            parsed,
            local_header_offset: 0,
            data_start_offset,
            compressed_size,
            uncompressed_size: entry.length,
            crc32: "00000000".to_string(),
            compression_method,
        });
    }

    Ok(AnalyzedArchive {
        archive: zip_manager::ZipArchiveInfo {
            zip_file_id: file_id.to_string(),
            filename: filename.to_string(),
            archive_format: ArchiveFormat::Rar.as_str().to_string(),
            file_size_bytes,
            compression_type: zip_parser::ZipCompressionType::Other,
            central_dir_offset: 0,
            central_dir_size: 0,
            total_entries,
            video_entries: indexed_entries.len(),
        },
        indexed_entries,
    })
}

fn analyze_rar_from_path(
    file_id: &str,
    filename: &str,
    source_path: &Path,
) -> Result<AnalyzedArchive, String> {
    let mut indexed_entries = Vec::new();
    let mut total_entries = 0usize;

    let listing = RarArchive::new(source_path)
        .open_for_listing()
        .map_err(|e| e.to_string())?;

    for header_result in listing {
        let header = header_result.map_err(|e| e.to_string())?;
        total_entries += 1;

        if !header.is_file() || header.is_encrypted() || header.is_split() {
            continue;
        }

        let raw_path = header.filename.to_string_lossy().to_string();
        let entry_path =
            zip_parser::sanitize_zip_entry_path(&raw_path).map_err(|e| e.to_string())?;
        if !zip_manager::is_video_path(&entry_path) {
            continue;
        }

        let entry_name = entry_path
            .rsplit('/')
            .next()
            .unwrap_or(&entry_path)
            .to_string();
        let parsed = media_manager::parse_cloud_filename(&entry_name);
        if parsed.season.is_none() || parsed.episode.is_none() {
            continue;
        }

        indexed_entries.push(IndexedArchiveEntry {
            entry_path,
            entry_name,
            parsed,
            local_header_offset: 0,
            data_start_offset: 0,
            compressed_size: 0,
            uncompressed_size: header.unpacked_size,
            crc32: format!("{:08x}", header.file_crc),
            compression_method: -1,
        });
    }

    Ok(AnalyzedArchive {
        archive: zip_manager::ZipArchiveInfo {
            zip_file_id: file_id.to_string(),
            filename: filename.to_string(),
            archive_format: ArchiveFormat::Rar.as_str().to_string(),
            file_size_bytes: fs::metadata(source_path).map_err(|e| e.to_string())?.len(),
            compression_type: zip_parser::ZipCompressionType::Other,
            central_dir_offset: 0,
            central_dir_size: 0,
            total_entries,
            video_entries: indexed_entries.len(),
        },
        indexed_entries,
    })
}

fn extract_tar_entry_to_cache(
    access_token: &str,
    media: &database::MediaItem,
    cache_config: &zip_manager::ZipCacheConfig,
) -> Result<String, String> {
    let archive_id = media
        .parent_zip_id
        .as_deref()
        .ok_or_else(|| "Archive file ID not found".to_string())?;
    let entry_path = media
        .zip_entry_path
        .as_deref()
        .or(media.file_path.as_deref())
        .ok_or_else(|| "Archive entry path not found".to_string())?;
    let output_path = archive_cache_path(media, cache_config)?;
    if output_path.exists() {
        return Ok(output_path.to_string_lossy().to_string());
    }

    let source_path = download_archive_to_temp(
        access_token,
        archive_id,
        &archive_filename_for_media(media),
        cache_config,
        "extract",
    )?;

    let file = File::open(&source_path).map_err(|e| e.to_string())?;
    let reader: Box<dyn Read> = if is_gzip_tar_path(&source_path)? {
        Box::new(GzDecoder::new(file))
    } else {
        Box::new(file)
    };

    let mut archive = TarArchive::new(reader);
    let mut found = false;
    for entry_result in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry_result.map_err(|e| e.to_string())?;
        let raw_path = entry
            .path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let sanitized =
            zip_parser::sanitize_zip_entry_path(&raw_path).map_err(|e| e.to_string())?;
        if sanitized != entry_path {
            continue;
        }

        let mut writer = File::create(&output_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut writer).map_err(|e| e.to_string())?;
        found = true;
        break;
    }

    let _ = fs::remove_file(source_path);
    if !found {
        return Err(format!("Archive entry '{}' not found", entry_path));
    }

    Ok(output_path.to_string_lossy().to_string())
}

fn extract_rar_entry_to_cache(
    access_token: &str,
    media: &database::MediaItem,
    cache_config: &zip_manager::ZipCacheConfig,
) -> Result<String, String> {
    let archive_id = media
        .parent_zip_id
        .as_deref()
        .ok_or_else(|| "Archive file ID not found".to_string())?;
    let entry_path = media
        .zip_entry_path
        .as_deref()
        .or(media.file_path.as_deref())
        .ok_or_else(|| "Archive entry path not found".to_string())?;
    let output_path = archive_cache_path(media, cache_config)?;
    if output_path.exists() {
        return Ok(output_path.to_string_lossy().to_string());
    }

    let source_path = download_archive_to_temp(
        access_token,
        archive_id,
        &archive_filename_for_media(media),
        cache_config,
        "extract",
    )?;

    let mut archive = RarArchive::new(&source_path)
        .open_for_processing()
        .map_err(|e| e.to_string())?;

    let mut found = false;
    while let Some(next) = archive.read_header().map_err(|e| e.to_string())? {
        let current_path = next.entry().filename.to_string_lossy().to_string();
        let sanitized =
            zip_parser::sanitize_zip_entry_path(&current_path).map_err(|e| e.to_string())?;
        if sanitized == entry_path {
            let parent = output_path
                .parent()
                .ok_or_else(|| "Invalid archive cache path".to_string())?;
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            let _ = next.extract_to(&output_path).map_err(|e| e.to_string())?;
            found = true;
            break;
        }

        archive = next.skip().map_err(|e| e.to_string())?;
    }

    let _ = fs::remove_file(source_path);
    if !found {
        return Err(format!("Archive entry '{}' not found", entry_path));
    }

    Ok(output_path.to_string_lossy().to_string())
}

fn download_archive_to_temp(
    access_token: &str,
    file_id: &str,
    filename: &str,
    cache_config: &zip_manager::ZipCacheConfig,
    suffix: &str,
) -> Result<PathBuf, String> {
    let cache_dir = PathBuf::from(&cache_config.cache_dir).join("archive_sources");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let temp_path = cache_dir.join(format!(
        "{}-{}-{}",
        safe_filename(file_id),
        suffix,
        safe_filename(filename)
    ));

    let mut response = fetch_drive_media_response(access_token, file_id)?;

    let mut writer = File::create(&temp_path).map_err(|e| e.to_string())?;
    std::io::copy(&mut response, &mut writer).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(temp_path)
}

fn archive_cache_path(
    media: &database::MediaItem,
    cache_config: &zip_manager::ZipCacheConfig,
) -> Result<PathBuf, String> {
    let archive_id = media
        .parent_zip_id
        .as_deref()
        .ok_or_else(|| "Archive file ID not found".to_string())?;
    let entry_path = media
        .zip_entry_path
        .as_deref()
        .or(media.file_path.as_deref())
        .ok_or_else(|| "Archive entry path not found".to_string())?;

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    archive_id.hash(&mut hasher);
    entry_path.hash(&mut hasher);
    let hash = hasher.finish();
    let ext = Path::new(entry_path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin");
    let label = safe_filename(&format!("{}-{}", media.title, entry_path));
    let cache_dir = PathBuf::from(&cache_config.cache_dir);
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    Ok(cache_dir.join(format!("archive-{}-{:016x}.{}", label, hash, ext)))
}

fn archive_filename_for_media(media: &database::MediaItem) -> String {
    let archive_id = media.parent_zip_id.as_deref().unwrap_or("archive");
    let format = archive_format_for_media(media);
    match media.file_path.as_deref() {
        Some(path) if path.contains("://") => format!("{}.{}", archive_id, format.as_str()),
        Some(path) => path.to_string(),
        None => format!("{}.{}", archive_id, format.as_str()),
    }
}

fn is_gzip_tar(filename: &str) -> bool {
    let lower = filename.to_ascii_lowercase();
    lower.ends_with(".tar.gz") || lower.ends_with(".tgz")
}

fn is_gzip_tar_path(path: &Path) -> Result<bool, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut magic = [0u8; 2];
    let bytes_read = file.read(&mut magic).map_err(|e| e.to_string())?;
    Ok(bytes_read == 2 && magic == [0x1f, 0x8b])
}

fn safe_filename(input: &str) -> String {
    input
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}
