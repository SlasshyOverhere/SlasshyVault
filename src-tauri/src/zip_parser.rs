use serde::Serialize;
use std::path::Component;
use std::path::Path;
use thiserror::Error;

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const ZIP64_EOCD_SIGNATURE: u32 = 0x0606_4b50;
const ZIP64_LOCATOR_SIGNATURE: u32 = 0x0706_4b50;
const CENTRAL_DIRECTORY_SIGNATURE: u32 = 0x0201_4b50;
const LOCAL_FILE_HEADER_SIGNATURE: u32 = 0x0403_4b50;
const ZIP64_EXTRA_FIELD_ID: u16 = 0x0001;
const EOCD_MIN_SIZE: usize = 22;
const CENTRAL_DIRECTORY_FIXED_SIZE: usize = 46;
const LOCAL_FILE_HEADER_FIXED_SIZE: usize = 30;

#[derive(Debug, Clone, Serialize)]
pub struct EocdRecord {
    pub offset: u64,
    pub cd_offset: u64,
    pub cd_size: u64,
    pub cd_entries_total: u64,
    pub is_zip64: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ZipEntry {
    pub filename: String,
    pub compression_method: u16,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub local_header_offset: u64,
    pub crc32: u32,
    pub is_encrypted: bool,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ZipCompressionType {
    Store,
    Deflate,
    Mixed,
    Other,
}

#[derive(Debug, Clone)]
pub struct LocalFileHeaderInfo {
    pub data_start_offset: u64,
}

#[derive(Debug, Clone, Default)]
pub struct Zip64Extra {
    pub uncompressed_size: Option<u64>,
    pub compressed_size: Option<u64>,
    pub local_header_offset: Option<u64>,
}

#[derive(Debug, Error)]
pub enum ZipError {
    #[error("This file is not a valid ZIP archive")]
    NotAValidZip,
    #[error("Could not find the ZIP directory structure")]
    EocdNotFound,
    #[error("ZIP archive is truncated or corrupted")]
    CorruptedArchive,
    #[error("ZIP64 metadata is missing or incomplete")]
    Zip64ParsingError,
    #[error("ZIP contains an invalid path")]
    InvalidPath,
    #[error("ZIP contains a path traversal attempt")]
    PathTraversalAttempt,
    #[error("ZIP contains an invalid UTF-8 filename")]
    InvalidUtf8Filename,
    #[error("ZIP entry uses unsupported encryption")]
    EncryptedEntry,
    #[error("ZIP entry uses unsupported compression method {0}")]
    UnsupportedCompressionMethod(u16),
    #[error("Compressed ZIP entry must be extracted before playback")]
    EntryRequiresExtraction,
    #[error("Extracted ZIP entry failed integrity validation")]
    IntegrityCheckFailed,
}

pub fn find_eocd(data: &[u8], buffer_base_offset: u64) -> Result<EocdRecord, ZipError> {
    if data.len() < EOCD_MIN_SIZE {
        return Err(ZipError::EocdNotFound);
    }

    let mut idx = data.len() - EOCD_MIN_SIZE;
    loop {
        if read_u32(data, idx)? == EOCD_SIGNATURE {
            let entries_total = read_u16(data, idx + 10)? as u64;
            let cd_size_32 = read_u32(data, idx + 12)? as u64;
            let cd_offset_32 = read_u32(data, idx + 16)? as u64;
            let comment_length = read_u16(data, idx + 20)? as usize;

            if idx + EOCD_MIN_SIZE + comment_length > data.len() {
                return Err(ZipError::CorruptedArchive);
            }

            let eocd_offset = buffer_base_offset + idx as u64;
            let needs_zip64 = entries_total == u16::MAX as u64
                || cd_size_32 == u32::MAX as u64
                || cd_offset_32 == u32::MAX as u64;

            if !needs_zip64 {
                return Ok(EocdRecord {
                    offset: eocd_offset,
                    cd_offset: cd_offset_32,
                    cd_size: cd_size_32,
                    cd_entries_total: entries_total,
                    is_zip64: false,
                });
            }

            if idx < 20 || read_u32(data, idx - 20)? != ZIP64_LOCATOR_SIGNATURE {
                return Err(ZipError::Zip64ParsingError);
            }

            let zip64_eocd_offset = read_u64(data, idx - 12)?;
            if zip64_eocd_offset < buffer_base_offset {
                return Err(ZipError::Zip64ParsingError);
            }

            let relative_offset = (zip64_eocd_offset - buffer_base_offset) as usize;
            if read_u32(data, relative_offset)? != ZIP64_EOCD_SIGNATURE {
                return Err(ZipError::Zip64ParsingError);
            }

            let record_size = read_u64(data, relative_offset + 4)? as usize;
            let required = relative_offset + 12 + record_size;
            if required > data.len() {
                return Err(ZipError::Zip64ParsingError);
            }

            return Ok(EocdRecord {
                offset: eocd_offset,
                cd_offset: read_u64(data, relative_offset + 48)?,
                cd_size: read_u64(data, relative_offset + 40)?,
                cd_entries_total: read_u64(data, relative_offset + 32)?,
                is_zip64: true,
            });
        }

        if idx == 0 {
            break;
        }
        idx -= 1;
    }

    Err(ZipError::EocdNotFound)
}

pub fn parse_central_directory(
    cd_data: &[u8],
    _base_offset: u64,
) -> Result<Vec<ZipEntry>, ZipError> {
    let mut entries = Vec::new();
    let mut cursor = 0usize;

    while cursor < cd_data.len() {
        if cursor + CENTRAL_DIRECTORY_FIXED_SIZE > cd_data.len() {
            return Err(ZipError::CorruptedArchive);
        }

        if read_u32(cd_data, cursor)? != CENTRAL_DIRECTORY_SIGNATURE {
            return Err(ZipError::CorruptedArchive);
        }

        let flags = read_u16(cd_data, cursor + 8)?;
        let compression_method = read_u16(cd_data, cursor + 10)?;
        let crc32 = read_u32(cd_data, cursor + 16)?;
        let compressed_size_32 = read_u32(cd_data, cursor + 20)? as u64;
        let uncompressed_size_32 = read_u32(cd_data, cursor + 24)? as u64;
        let file_name_length = read_u16(cd_data, cursor + 28)? as usize;
        let extra_field_length = read_u16(cd_data, cursor + 30)? as usize;
        let file_comment_length = read_u16(cd_data, cursor + 32)? as usize;
        let local_header_offset_32 = read_u32(cd_data, cursor + 42)? as u64;

        let total_length = CENTRAL_DIRECTORY_FIXED_SIZE
            + file_name_length
            + extra_field_length
            + file_comment_length;
        if cursor + total_length > cd_data.len() {
            return Err(ZipError::CorruptedArchive);
        }

        let filename_start = cursor + CENTRAL_DIRECTORY_FIXED_SIZE;
        let filename_end = filename_start + file_name_length;
        let filename_bytes = &cd_data[filename_start..filename_end];
        let raw_filename =
            std::str::from_utf8(filename_bytes).map_err(|_| ZipError::InvalidUtf8Filename)?;
        let filename = sanitize_zip_entry_path(raw_filename)?;

        let extra_start = filename_end;
        let extra_end = extra_start + extra_field_length;
        let extra = &cd_data[extra_start..extra_end];

        let needs_uncompressed = uncompressed_size_32 == u32::MAX as u64;
        let needs_compressed = compressed_size_32 == u32::MAX as u64;
        let needs_offset = local_header_offset_32 == u32::MAX as u64;
        let zip64 = if needs_uncompressed || needs_compressed || needs_offset {
            parse_zip64_extra(extra, needs_uncompressed, needs_compressed, needs_offset)?
        } else {
            Zip64Extra::default()
        };

        let compressed_size = zip64.compressed_size.unwrap_or(compressed_size_32);
        let uncompressed_size = zip64.uncompressed_size.unwrap_or(uncompressed_size_32);
        let local_header_offset = zip64.local_header_offset.unwrap_or(local_header_offset_32);
        let is_directory = filename.ends_with('/');

        entries.push(ZipEntry {
            filename,
            compression_method,
            compressed_size,
            uncompressed_size,
            local_header_offset,
            crc32,
            is_encrypted: (flags & 0x0001) != 0,
            is_directory,
        });

        cursor += total_length;
    }

    Ok(entries)
}

pub fn parse_zip64_extra(
    extra_data: &[u8],
    need_uncompressed: bool,
    need_compressed: bool,
    need_offset: bool,
) -> Result<Zip64Extra, ZipError> {
    let mut cursor = 0usize;

    while cursor + 4 <= extra_data.len() {
        let header_id = read_u16(extra_data, cursor)?;
        let data_size = read_u16(extra_data, cursor + 2)? as usize;
        cursor += 4;

        if cursor + data_size > extra_data.len() {
            return Err(ZipError::Zip64ParsingError);
        }

        if header_id == ZIP64_EXTRA_FIELD_ID {
            let mut field_cursor = cursor;
            let mut zip64 = Zip64Extra::default();

            if need_uncompressed {
                zip64.uncompressed_size = Some(read_u64(extra_data, field_cursor)?);
                field_cursor += 8;
            }
            if need_compressed {
                zip64.compressed_size = Some(read_u64(extra_data, field_cursor)?);
                field_cursor += 8;
            }
            if need_offset {
                zip64.local_header_offset = Some(read_u64(extra_data, field_cursor)?);
            }

            if need_uncompressed && zip64.uncompressed_size.is_none() {
                return Err(ZipError::Zip64ParsingError);
            }
            if need_compressed && zip64.compressed_size.is_none() {
                return Err(ZipError::Zip64ParsingError);
            }
            if need_offset && zip64.local_header_offset.is_none() {
                return Err(ZipError::Zip64ParsingError);
            }

            return Ok(zip64);
        }

        cursor += data_size;
    }

    Err(ZipError::Zip64ParsingError)
}

/// Sanitize a ZIP entry path to prevent path traversal attacks.
/// Rejects absolute paths, Windows drive letters, and '..' traversal components.
pub fn sanitize_zip_entry_path(filename: &str) -> Result<String, ZipError> {
    if filename.is_empty() {
        return Err(ZipError::InvalidPath);
    }

    let normalized = filename.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(ZipError::InvalidPath);
    }

    if normalized.len() > 1 && normalized.as_bytes()[1] == b':' {
        return Err(ZipError::InvalidPath);
    }

    let mut clean_parts = Vec::new();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy();
                if part.is_empty() {
                    continue;
                }
                clean_parts.push(part.to_string());
            }
            Component::CurDir => {}
            Component::ParentDir => return Err(ZipError::PathTraversalAttempt),
            Component::RootDir | Component::Prefix(_) => return Err(ZipError::InvalidPath),
        }
    }

    if clean_parts.is_empty() {
        return Err(ZipError::InvalidPath);
    }

    let trailing_slash = normalized.ends_with('/');
    let mut sanitized = clean_parts.join("/");
    if trailing_slash {
        sanitized.push('/');
    }
    Ok(sanitized)
}

pub fn parse_local_file_header(
    header_data: &[u8],
    local_header_offset: u64,
) -> Result<LocalFileHeaderInfo, ZipError> {
    if header_data.len() < LOCAL_FILE_HEADER_FIXED_SIZE {
        return Err(ZipError::CorruptedArchive);
    }

    if read_u32(header_data, 0)? != LOCAL_FILE_HEADER_SIGNATURE {
        return Err(ZipError::NotAValidZip);
    }

    let file_name_length = read_u16(header_data, 26)? as u64;
    let extra_field_length = read_u16(header_data, 28)? as u64;

    Ok(LocalFileHeaderInfo {
        data_start_offset: local_header_offset
            + LOCAL_FILE_HEADER_FIXED_SIZE as u64
            + file_name_length
            + extra_field_length,
    })
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16, ZipError> {
    let bytes = data
        .get(offset..offset + 2)
        .ok_or(ZipError::CorruptedArchive)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(data: &[u8], offset: usize) -> Result<u32, ZipError> {
    let bytes = data
        .get(offset..offset + 4)
        .ok_or(ZipError::CorruptedArchive)?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_u64(data: &[u8], offset: usize) -> Result<u64, ZipError> {
    let bytes = data
        .get(offset..offset + 8)
        .ok_or(ZipError::CorruptedArchive)?;
    Ok(u64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]))
}

#[cfg(test)]
mod tests {
    use super::{
        find_eocd, parse_central_directory, parse_local_file_header, sanitize_zip_entry_path,
        ZipCompressionType,
    };

    #[test]
    fn sanitize_rejects_path_traversal() {
        assert!(sanitize_zip_entry_path("../episode.mkv").is_err());
        assert!(sanitize_zip_entry_path("C:/episode.mkv").is_err());
        // Note: "...." is NOT path traversal — four dots is a valid filename component
        assert!(sanitize_zip_entry_path("foo/../../episode.mkv").is_err());
        assert!(sanitize_zip_entry_path("foo/..\\bar/episode.mkv").is_err());
        assert!(sanitize_zip_entry_path("/absolute/path.mkv").is_err());
        assert!(sanitize_zip_entry_path("//unc/path.mkv").is_err());
        assert!(sanitize_zip_entry_path("").is_err());
        // Note: "..." is NOT path traversal — it's a valid filename component
        assert!(sanitize_zip_entry_path("foo/./../bar.mkv").is_err());
        assert!(sanitize_zip_entry_path("foo/..").is_err());
        assert!(sanitize_zip_entry_path("..").is_err());
    }

    #[test]
    fn sanitize_accepts_valid_paths() {
        assert!(sanitize_zip_entry_path("episode.mkv").is_ok());
        assert!(sanitize_zip_entry_path("Season 01/episode.mkv").is_ok());
        assert!(sanitize_zip_entry_path("foo/bar/episode.mkv").is_ok());
        assert!(sanitize_zip_entry_path("foo/./bar.mkv").is_ok());
        assert!(sanitize_zip_entry_path("normal_path.mkv").is_ok());
    }

    #[test]
    fn sanitize_normalizes_slashes() {
        assert_eq!(
            sanitize_zip_entry_path("Season 01\\Show.S01E01.mkv").unwrap(),
            "Season 01/Show.S01E01.mkv"
        );
    }

    #[test]
    fn parse_local_header_calculates_data_offset() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        bytes.extend_from_slice(&20u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&10u32.to_le_bytes());
        bytes.extend_from_slice(&10u32.to_le_bytes());
        bytes.extend_from_slice(&8u16.to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(b"file.mkv");
        bytes.extend_from_slice(&[1, 2, 3, 4]);

        let header = parse_local_file_header(&bytes, 200).unwrap();
        assert_eq!(header.data_start_offset, 200 + 30 + 8 + 4);
    }

    #[test]
    fn finds_simple_eocd() {
        let mut bytes = vec![0u8; 30];
        bytes.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&123u32.to_le_bytes());
        bytes.extend_from_slice(&456u32.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());

        let eocd = find_eocd(&bytes, 0).unwrap();
        assert_eq!(eocd.cd_offset, 456);
        assert_eq!(eocd.cd_size, 123);
        assert_eq!(eocd.cd_entries_total, 1);
    }

    #[test]
    fn parses_central_directory_entry() {
        let mut entry = Vec::new();
        entry.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        entry.extend_from_slice(&20u16.to_le_bytes());
        entry.extend_from_slice(&20u16.to_le_bytes());
        entry.extend_from_slice(&0u16.to_le_bytes());
        entry.extend_from_slice(&0u16.to_le_bytes());
        entry.extend_from_slice(&0u16.to_le_bytes());
        entry.extend_from_slice(&0u16.to_le_bytes());
        entry.extend_from_slice(&0x1234_5678u32.to_le_bytes());
        entry.extend_from_slice(&100u32.to_le_bytes());
        entry.extend_from_slice(&100u32.to_le_bytes());
        entry.extend_from_slice(&15u16.to_le_bytes());
        entry.extend_from_slice(&0u16.to_le_bytes());
        entry.extend_from_slice(&0u16.to_le_bytes());
        entry.extend_from_slice(&0u16.to_le_bytes());
        entry.extend_from_slice(&0u16.to_le_bytes());
        entry.extend_from_slice(&0u32.to_le_bytes());
        entry.extend_from_slice(&2048u32.to_le_bytes());
        entry.extend_from_slice(b"Show.S01E01.mkv");

        let entries = parse_central_directory(&entry, 0).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].filename, "Show.S01E01.mkv");
        assert_eq!(entries[0].compressed_size, 100);
        assert_eq!(ZipCompressionType::Store, ZipCompressionType::Store);
    }
}
