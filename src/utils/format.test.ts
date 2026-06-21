import { describe, it, expect } from 'vitest'
import { formatFileSize, getYear, formatSpeed } from './format'

describe('formatFileSize', () => {
  it('returns "0 B" for 0 or negative', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(-100)).toBe('0 B')
    expect(formatFileSize(null)).toBe('0 B')
    expect(formatFileSize(undefined)).toBe('0 B')
  })

  it('formats bytes under 1 KB', () => {
    expect(formatFileSize(1)).toBe('1 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1023)).toBe('1023 B')
  })

  it('formats KB range', () => {
    expect(formatFileSize(1024)).toBe('1.00 KB')    // 1 < 100 → 2 decimals
    expect(formatFileSize(1536)).toBe('1.50 KB')
    expect(formatFileSize(10240)).toBe('10.0 KB')   // 10 >= 10, < 100 → 1 decimal
    expect(formatFileSize(102400)).toBe('100 KB')    // >= 100 → 0 decimals
  })

  it('formats MB range', () => {
    expect(formatFileSize(1048576)).toBe('1.00 MB') // 1 < 100 → 2 decimals
    expect(formatFileSize(1572864)).toBe('1.50 MB')
    expect(formatFileSize(104857600)).toBe('100 MB') // >= 100 → 0 decimals
  })

  it('formats GB range', () => {
    expect(formatFileSize(1073741824)).toBe('1.00 GB')
    expect(formatFileSize(1073741824 * 2.5)).toBe('2.50 GB')
  })

  it('formats TB range', () => {
    expect(formatFileSize(1099511627776)).toBe('1.00 TB')
  })
})

describe('getYear', () => {
  it('returns empty string for falsy input', () => {
    expect(getYear(undefined)).toBe('')
    expect(getYear('')).toBe('')
  })

  it('extracts year from valid ISO date', () => {
    expect(getYear('2023-06-15')).toBe('2023')
    expect(getYear('2020-01-01T00:00:00Z')).toBe('2020')
  })

  it('falls back to first 4 chars for invalid date that looks like year', () => {
    expect(getYear('2020-something')).toBe('2020')
  })

  it('returns empty for non-date garbage', () => {
    expect(getYear('not-a-date')).toBe('')
    expect(getYear('abc123xyz')).toBe('')
  })

  it('returns empty for non-parseable strings', () => {
    expect(getYear('abc1')).toBe('') // not parseable as year
    expect(getYear('hello')).toBe('')
  })
})

describe('formatSpeed', () => {
  it('returns "0 B/s" for zero', () => {
    expect(formatSpeed(0)).toBe('0 B/s')
  })

  it('formats bytes/sec', () => {
    expect(formatSpeed(500)).toBe('500.0 B/s')
  })

  it('formats KB/s', () => {
    expect(formatSpeed(1024)).toBe('1.0 KB/s')
    expect(formatSpeed(1536)).toBe('1.5 KB/s')
  })

  it('formats MB/s', () => {
    expect(formatSpeed(1048576)).toBe('1.0 MB/s')
  })

  it('formats GB/s', () => {
    expect(formatSpeed(1073741824)).toBe('1.0 GB/s')
  })
})
