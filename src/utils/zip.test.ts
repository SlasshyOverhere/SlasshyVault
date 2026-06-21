import { describe, it, expect } from 'vitest'
import { getZipCompressionLabel } from './zip'

describe('getZipCompressionLabel', () => {
  it('returns "Store" for method 0', () => {
    expect(getZipCompressionLabel(0)).toBe('Store')
  })

  it('returns "Deflate" for method 8', () => {
    expect(getZipCompressionLabel(8)).toBe('Deflate')
  })

  it('returns null for unknown method', () => {
    expect(getZipCompressionLabel(1)).toBeNull()
    expect(getZipCompressionLabel(99)).toBeNull()
    expect(getZipCompressionLabel(-1)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(getZipCompressionLabel(undefined)).toBeNull()
  })
})
