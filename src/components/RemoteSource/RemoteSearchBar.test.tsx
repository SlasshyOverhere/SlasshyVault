// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RemoteSearchBar } from './RemoteSearchBar'

vi.mock('lucide-react', () => ({
  Search: () => <span />,
  X: () => <span />,
}))

describe('RemoteSearchBar', () => {
  it('renders search input', () => {
    render(<RemoteSearchBar value="" onChange={() => {}} />)
    expect(screen.getByPlaceholderText(/Search/)).toBeTruthy()
  })

  it('displays initial value', () => {
    render(<RemoteSearchBar value="hello" onChange={() => {}} />)
    expect(screen.getByDisplayValue('hello')).toBeTruthy()
  })

  it('shows clear button when value exists', () => {
    render(<RemoteSearchBar value="test" onChange={() => {}} />)
    expect(screen.getByLabelText('Clear search')).toBeTruthy()
  })

  it('hides clear button when empty', () => {
    render(<RemoteSearchBar value="" onChange={() => {}} />)
    expect(screen.queryByLabelText('Clear search')).toBeNull()
  })

  it('calls onChange on input change', () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    render(<RemoteSearchBar value="" onChange={onChange} />)
    fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value: 'query' } })
    vi.advanceTimersByTime(300)
    expect(onChange).toHaveBeenCalledWith('query')
    vi.useRealTimers()
  })

  it('clears on clear button click', () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    render(<RemoteSearchBar value="test" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Clear search'))
    vi.advanceTimersByTime(300)
    expect(onChange).toHaveBeenCalledWith('')
    vi.useRealTimers()
  })
})
