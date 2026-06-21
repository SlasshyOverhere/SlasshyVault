// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RemoteSearchResults } from './RemoteSearchResults'

vi.mock('framer-motion', () => ({
  LazyMotion: ({ children }: any) => <div>{children}</div>,
  domAnimation: {},
  m: { button: ({ children, onClick, ...p }: any) => <button onClick={onClick} {...p}>{children}</button> },
}))

vi.mock('lucide-react', () => ({
  Film: () => <span />,
  Star: () => <span />,
  Clapperboard: () => <span />,
  Tv: () => <span />,
}))

describe('RemoteSearchResults', () => {
  it('shows loading state', () => {
    const { container } = render(<RemoteSearchResults results={[]} isLoading={true} onSelect={() => {}} />)
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  it('shows empty state', () => {
    render(<RemoteSearchResults results={[]} isLoading={false} onSelect={() => {}} />)
    expect(screen.getByText(/Search for movies/)).toBeTruthy()
  })

  it('renders search results', () => {
    const results = [
      { id: 1, title: 'Inception', media_type: 'movie' as const, vote_average: 8.5, release_date: '2010-07-16' },
      { id: 2, name: 'Breaking Bad', media_type: 'tv' as const, vote_average: 9.5, first_air_date: '2008-01-20' },
    ]
    render(<RemoteSearchResults results={results} isLoading={false} onSelect={() => {}} />)
    expect(screen.getByText('Inception')).toBeTruthy()
    expect(screen.getByText('Breaking Bad')).toBeTruthy()
  })

  it('calls onSelect on click', () => {
    const onSelect = vi.fn()
    const results = [
      { id: 1, title: 'Inception', media_type: 'movie' as const },
    ]
    render(<RemoteSearchResults results={results} isLoading={false} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('Inception'))
    expect(onSelect).toHaveBeenCalledWith(results[0])
  })

  it('shows MOV/TV badges', () => {
    const results = [
      { id: 1, title: 'Movie', media_type: 'movie' as const },
      { id: 2, name: 'Show', media_type: 'tv' as const },
    ]
    render(<RemoteSearchResults results={results} isLoading={false} onSelect={() => {}} />)
    expect(screen.getByText('MOV')).toBeTruthy()
    expect(screen.getByText('TV')).toBeTruthy()
  })

  it('shows rating when available', () => {
    const results = [
      { id: 1, title: 'Movie', media_type: 'movie' as const, vote_average: 8.5 },
    ]
    render(<RemoteSearchResults results={results} isLoading={false} onSelect={() => {}} />)
    expect(screen.getByText('8.5')).toBeTruthy()
  })

  it('shows overview for first result', () => {
    const results = [
      { id: 1, title: 'Movie', media_type: 'movie' as const, overview: 'A great movie about testing' },
    ]
    render(<RemoteSearchResults results={results} isLoading={false} onSelect={() => {}} />)
    expect(screen.getByText('A great movie about testing')).toBeTruthy()
  })
})
