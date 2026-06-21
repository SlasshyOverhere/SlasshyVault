// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { EpisodeThumbnailImage } from './EpisodeThumbnailImage'

vi.mock('@/services/api', () => ({
  getCachedImageUrl: vi.fn().mockResolvedValue(null),
}))

vi.mock('lucide-react', () => ({
  Loader2: () => <span data-testid="loader" />,
}))

vi.mock('./EpisodeThumbnailImage.types', () => ({}))

describe('EpisodeThumbnailImage', () => {
  it('shows episode number when no image', async () => {
    render(<EpisodeThumbnailImage localStillPath={undefined} tmdbStillUrl={undefined} episodeTitle="Test" episodeNumber={5} />)
    await waitFor(() => {
      expect(screen.getByText('5')).toBeTruthy()
    })
  })

  it('shows question mark for episode 0', async () => {
    render(<EpisodeThumbnailImage localStillPath={undefined} tmdbStillUrl={undefined} episodeTitle="Test" episodeNumber={0} />)
    await waitFor(() => {
      expect(screen.getByText('?')).toBeTruthy()
    })
  })

  it('uses http URL directly', async () => {
    render(<EpisodeThumbnailImage localStillPath="https://example.com/image.jpg" tmdbStillUrl={undefined} episodeTitle="Test Ep" episodeNumber={1} />)
    await waitFor(() => {
      const img = screen.getByAltText('Test Ep') as HTMLImageElement
      expect(img.src).toContain('https://example.com/image.jpg')
    })
  })

  it('falls back to tmdbStillUrl', async () => {
    render(<EpisodeThumbnailImage localStillPath={undefined} tmdbStillUrl="https://tmdb.org/img.jpg" episodeTitle="TMDB Ep" episodeNumber={1} />)
    await waitFor(() => {
      const img = screen.getByAltText('TMDB Ep') as HTMLImageElement
      expect(img.src).toContain('tmdb.org')
    })
  })
})
