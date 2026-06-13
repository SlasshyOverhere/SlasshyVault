/**
 * Format a byte count into a human-readable file size string.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unitIdx = 0
  while (size >= 1024 && unitIdx < units.length - 1) {
    size /= 1024
    unitIdx++
  }
  return `${size.toFixed(2)} ${units[unitIdx]}`
}

/**
 * Extract a 4-digit year from a date string, with validation.
 * Returns an empty string for invalid or missing dates.
 */
export function getYear(dateStr?: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) {
    // Fallback: try extracting first 4 chars if they look like a year
    const raw = dateStr.substring(0, 4)
    const num = parseInt(raw, 10)
    if (num >= 1900 && num <= 2100) return raw
    return ''
  }
  return d.getFullYear().toString()
}

/**
 * Format a bytes-per-second value into a human-readable speed string.
 */
export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return '0 B/s'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let speed = bytesPerSec
  let unitIdx = 0
  while (speed >= 1024 && unitIdx < units.length - 1) {
    speed /= 1024
    unitIdx++
  }
  return `${speed.toFixed(1)} ${units[unitIdx]}`
}
