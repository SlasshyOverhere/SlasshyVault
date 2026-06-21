import { describe, it, expect, vi, beforeEach } from 'vitest'
import { reducer, toast, useToast } from './use-toast'

// Mock localStorage
const store: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: vi.fn((k: string) => store[k] ?? null),
  setItem: vi.fn((k: string, v: string) => { store[k] = v }),
  removeItem: vi.fn((k: string) => { delete store[k] }),
  clear: vi.fn(() => { for (const k in store) delete store[k] }),
})

describe('toast reducer', () => {
  const baseState = { toasts: [] }

  const makeToast = (id: string, overrides = {}) => ({
    id,
    open: true,
    title: `Toast ${id}`,
    ...overrides,
  })

  describe('ADD_TOAST', () => {
    it('adds a toast to the front', () => {
      const toast = makeToast('1')
      const result = reducer(baseState, { type: 'ADD_TOAST', toast })
      expect(result.toasts).toHaveLength(1)
      expect(result.toasts[0].id).toBe('1')
    })

    it('limits to 5 toasts', () => {
      let state = baseState
      for (let i = 1; i <= 7; i++) {
        state = reducer(state, { type: 'ADD_TOAST', toast: makeToast(String(i)) })
      }
      expect(state.toasts).toHaveLength(5)
      expect(state.toasts[0].id).toBe('7')
      expect(state.toasts[4].id).toBe('3')
    })
  })

  describe('UPDATE_TOAST', () => {
    it('updates matching toast', () => {
      const state = reducer(baseState, { type: 'ADD_TOAST', toast: makeToast('1') })
      const result = reducer(state, { type: 'UPDATE_TOAST', toast: { id: '1', title: 'Updated' } })
      expect(result.toasts[0].title).toBe('Updated')
      expect(result.toasts[0].open).toBe(true)
    })

    it('does not change non-matching toasts', () => {
      let state = baseState
      state = reducer(state, { type: 'ADD_TOAST', toast: makeToast('1') })
      state = reducer(state, { type: 'ADD_TOAST', toast: makeToast('2') })
      const result = reducer(state, { type: 'UPDATE_TOAST', toast: { id: '1', title: 'Updated' } })
      expect(result.toasts.find(t => t.id === '2')!.title).toBe('Toast 2')
    })
  })

  describe('DISMISS_TOAST', () => {
    it('sets open=false on specific toast', () => {
      const state = reducer(baseState, { type: 'ADD_TOAST', toast: makeToast('1') })
      const result = reducer(state, { type: 'DISMISS_TOAST', toastId: '1' })
      expect(result.toasts[0].open).toBe(false)
    })

    it('sets open=false on all toasts when no id', () => {
      let state = baseState
      state = reducer(state, { type: 'ADD_TOAST', toast: makeToast('1') })
      state = reducer(state, { type: 'ADD_TOAST', toast: makeToast('2') })
      const result = reducer(state, { type: 'DISMISS_TOAST' })
      expect(result.toasts.every(t => !t.open)).toBe(true)
    })
  })

  describe('REMOVE_TOAST', () => {
    it('removes specific toast', () => {
      let state = baseState
      state = reducer(state, { type: 'ADD_TOAST', toast: makeToast('1') })
      state = reducer(state, { type: 'ADD_TOAST', toast: makeToast('2') })
      const result = reducer(state, { type: 'REMOVE_TOAST', toastId: '1' })
      expect(result.toasts).toHaveLength(1)
      expect(result.toasts[0].id).toBe('2')
    })

    it('removes all toasts when no id', () => {
      let state = baseState
      state = reducer(state, { type: 'ADD_TOAST', toast: makeToast('1') })
      state = reducer(state, { type: 'ADD_TOAST', toast: makeToast('2') })
      const result = reducer(state, { type: 'REMOVE_TOAST' })
      expect(result.toasts).toHaveLength(0)
    })
  })
})

describe('toast function', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('creates a toast and returns id', () => {
    const result = toast({ title: 'Test' })
    expect(result.id).toBeTruthy()
    expect(result.dismiss).toBeInstanceOf(Function)
    expect(result.update).toBeInstanceOf(Function)
  })

  it('deduplicates within 3s window', () => {
    const first = toast({ title: 'Same', description: 'Same' })
    const second = toast({ title: 'Same', description: 'Same' })
    expect(second.id).toBe('')
  })

  it('does not deduplicate different toasts', () => {
    const first = toast({ title: 'First' })
    const second = toast({ title: 'Second' })
    expect(second.id).not.toBe('')
    expect(second.id).not.toBe(first.id)
  })

  it('cleans up expired dedupe entries', () => {
    toast({ title: 'Old' })
    vi.advanceTimersByTime(4000) // past 3s window
    const newer = toast({ title: 'Old' })
    expect(newer.id).not.toBe('')
  })
})
