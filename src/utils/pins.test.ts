import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getPinnedIds, togglePin, sortPinnedFirst } from './pins'

const STORAGE_KEY = 'pinned_items'

// Mock localStorage
const store: Record<string, string> = {}
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value }),
  removeItem: vi.fn((key: string) => { delete store[key] }),
  clear: vi.fn(() => { for (const k in store) delete store[k] }),
  get length() { return Object.keys(store).length },
  key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
}

vi.stubGlobal('localStorage', localStorageMock)

beforeEach(() => {
  vi.clearAllMocks()
  for (const k in store) delete store[k]
})

describe('getPinnedIds', () => {
  it('returns empty set when nothing stored', () => {
    const ids = getPinnedIds()
    expect(ids.size).toBe(0)
  })

  it('parses stored JSON array', () => {
    store[STORAGE_KEY] = JSON.stringify(['1', '2', '3'])
    const ids = getPinnedIds()
    expect(ids.size).toBe(3)
    expect(ids.has('1')).toBe(true)
    expect(ids.has('2')).toBe(true)
    expect(ids.has('3')).toBe(true)
  })

  it('returns empty set on corrupt JSON', () => {
    store[STORAGE_KEY] = 'not-json!!!'
    const ids = getPinnedIds()
    expect(ids.size).toBe(0)
  })
})

describe('togglePin', () => {
  it('adds an unpinned item', () => {
    const result = togglePin('42')
    expect(result).toBe(true)
    expect(store[STORAGE_KEY]).toBe(JSON.stringify(['42']))
  })

  it('removes an already-pinned item', () => {
    store[STORAGE_KEY] = JSON.stringify(['42'])
    const result = togglePin('42')
    expect(result).toBe(false)
    expect(store[STORAGE_KEY]).toBe(JSON.stringify([]))
  })

  it('converts numeric ids to strings', () => {
    togglePin(99)
    expect(store[STORAGE_KEY]).toBe(JSON.stringify(['99']))
  })

  it('toggles back and forth', () => {
    expect(togglePin('1')).toBe(true)
    expect(togglePin('1')).toBe(false)
    expect(togglePin('1')).toBe(true)
  })
})

describe('sortPinnedFirst', () => {
  it('sorts pinned items first', () => {
    store[STORAGE_KEY] = JSON.stringify(['2'])
    const items = [
      { id: '1', name: 'a' },
      { id: '2', name: 'b' },
      { id: '3', name: 'c' },
    ]
    const sorted = sortPinnedFirst(items)
    expect(sorted[0].id).toBe('2')
  })

  it('returns original order when nothing pinned', () => {
    const items = [
      { id: '1', name: 'a' },
      { id: '2', name: 'b' },
    ]
    const sorted = sortPinnedFirst(items)
    // Both unpinned, order preserved (stable sort)
    expect(sorted[0].id).toBe('1')
    expect(sorted[1].id).toBe('2')
  })

  it('handles numeric ids', () => {
    store[STORAGE_KEY] = JSON.stringify(['5'])
    const items = [
      { id: 1, name: 'a' },
      { id: 5, name: 'b' },
    ]
    const sorted = sortPinnedFirst(items)
    expect(sorted[0].id).toBe(5)
  })

  it('handles empty array', () => {
    expect(sortPinnedFirst([])).toEqual([])
  })
})
