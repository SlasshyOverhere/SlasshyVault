import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parseReleaseTarget,
  formatLocalReleaseTime,
  isFutureReleaseTarget,
  getLocalTimezoneLabel,
} from './CountdownTimer.utils'

describe('getLocalTimezoneLabel', () => {
  it('returns a non-empty string', () => {
    const label = getLocalTimezoneLabel()
    expect(typeof label).toBe('string')
    expect(label.length).toBeGreaterThan(0)
  })
})

describe('parseReleaseTarget', () => {
  it('returns null for null/undefined/empty', () => {
    expect(parseReleaseTarget(null)).toBeNull()
    expect(parseReleaseTarget(undefined)).toBeNull()
    expect(parseReleaseTarget('')).toBeNull()
  })

  it('parses date-only format (YYYY-MM-DD) to 9am local', () => {
    const result = parseReleaseTarget('2026-06-15')
    expect(result).not.toBeNull()
    expect(result!.getFullYear()).toBe(2026)
    expect(result!.getMonth()).toBe(5) // June = 5
    expect(result!.getDate()).toBe(15)
    expect(result!.getHours()).toBe(9)
    expect(result!.getMinutes()).toBe(0)
  })

  it('parses full ISO datetime', () => {
    const result = parseReleaseTarget('2026-06-15T14:30:00Z')
    expect(result).not.toBeNull()
    expect(result!.getFullYear()).toBe(2026)
    // Month/date may vary by timezone, but it should be a valid Date
    expect(result!.getTime()).not.toBeNaN()
  })

  it('returns null for invalid date string', () => {
    expect(parseReleaseTarget('not-a-date')).toBeNull()
    expect(parseReleaseTarget('abcdef')).toBeNull()
  })
})

describe('formatLocalReleaseTime', () => {
  it('returns "Time not set" for null/undefined', () => {
    expect(formatLocalReleaseTime(null)).toBe('Time not set')
    expect(formatLocalReleaseTime(undefined)).toBe('Time not set')
    expect(formatLocalReleaseTime('')).toBe('Time not set')
  })

  it('returns formatted string for valid date', () => {
    const result = formatLocalReleaseTime('2026-12-25')
    expect(result).toContain('Dec')
    expect(result).toContain('2026')
    expect(result).toContain('at')
    // Should contain timezone abbreviation
    expect(result.length).toBeGreaterThan(10)
  })

  it('returns "Time not set" for invalid date', () => {
    expect(formatLocalReleaseTime('garbage')).toBe('Time not set')
  })
})

describe('isFutureReleaseTarget', () => {
  it('returns false for null/undefined', () => {
    expect(isFutureReleaseTarget(null)).toBe(false)
    expect(isFutureReleaseTarget(undefined)).toBe(false)
  })

  it('returns false for past date', () => {
    expect(isFutureReleaseTarget('2000-01-01')).toBe(false)
  })

  it('returns true for far future date', () => {
    expect(isFutureReleaseTarget('2099-12-31')).toBe(true)
  })

  it('returns false for invalid date', () => {
    expect(isFutureReleaseTarget('not-a-date')).toBe(false)
  })
})
