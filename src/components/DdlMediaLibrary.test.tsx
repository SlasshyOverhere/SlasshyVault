// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { DdlMediaLibrary } from './DdlMediaLibrary'

vi.mock('@/services/api', () => ({
  getDdlMedia: vi.fn().mockResolvedValue([]),
}))

vi.mock('./MovieCard', () => ({
  MovieCard: ({ item }: any) => <div data-testid="movie-card">{item.title}</div>,
}))

vi.mock('lucide-react', () => ({
  Loader2: () => <span data-testid="loader" />,
}))

describe('DdlMediaLibrary', () => {
  it('shows loading state initially', () => {
    render(<DdlMediaLibrary viewMode="grid" onItemClick={() => {}} onFixMatch={() => {}} />)
    expect(screen.getByTestId('loader')).toBeTruthy()
  })

  it('renders nothing when empty', async () => {
    const { container } = render(<DdlMediaLibrary viewMode="grid" onItemClick={() => {}} onFixMatch={() => {}} />)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="loader"]')).toBeNull()
    })
  })

  it('renders items when loaded', async () => {
    const api = await import('@/services/api')
    vi.mocked(api.getDdlMedia).mockResolvedValueOnce([
      { id: 1, title: 'Show A', media_type: 'tvepisode' },
      { id: 2, title: 'Show B', media_type: 'tvepisode' },
    ] as any)
    render(<DdlMediaLibrary viewMode="grid" onItemClick={() => {}} onFixMatch={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('Show A')).toBeTruthy()
      expect(screen.getByText('Show B')).toBeTruthy()
    })
  })
})
