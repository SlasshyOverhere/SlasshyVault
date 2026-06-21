import { describe, it, expect } from 'vitest'
import { areMovieCardPropsEqual, areContinueCardPropsEqual, MovieCardProps, ContinueCardProps } from './MovieCard.types'
import { MediaItem } from '@/services/api'

// Mock MediaItem
const mockItem: MediaItem = {
  id: 1,
  title: 'Test Movie',
  media_type: 'movie',
  poster_path: '/path/to/poster.jpg',
  year: 2023,
  is_cloud: false,
  progress_percent: 0,
  resume_position_seconds: 0,
  duration_seconds: 7200,
}

describe('areMovieCardPropsEqual', () => {
  it('should return true when all relevant props are the same', () => {
    const onClick = () => {}
    const onFixMatch = () => {}

    const prevProps: MovieCardProps = {
      item: mockItem,
      onClick,
      onFixMatch,
      index: 0,
      className: 'test',
      aspectRatio: 'portrait'
    }
    const nextProps: MovieCardProps = {
      item: mockItem,
      onClick,
      onFixMatch,
      index: 0,
      className: 'test',
      aspectRatio: 'portrait'
    }

    expect(areMovieCardPropsEqual(prevProps, nextProps)).toBe(true)
  })

  it('should return true when items are different references but same fields', () => {
    const onClick = () => {}
    const onFixMatch = () => {}

    const prevProps: MovieCardProps = {
      item: { ...mockItem },
      onClick,
      onFixMatch,
    }
    const nextProps: MovieCardProps = {
      item: { ...mockItem },
      onClick,
      onFixMatch,
    }

    expect(areMovieCardPropsEqual(prevProps, nextProps)).toBe(true)
  })

  it('should return false when overview changes', () => {
    const prevProps: MovieCardProps = {
      item: { ...mockItem, overview: 'old' },
      onClick: () => {},
      onFixMatch: () => {},
    }
    const nextProps: MovieCardProps = {
      item: { ...mockItem, overview: 'new' },
      onClick: () => {},
      onFixMatch: () => {},
    }
    expect(areMovieCardPropsEqual(prevProps, nextProps)).toBe(false)
  })

  it('should return false when poster_path changes', () => {
    const prevProps: MovieCardProps = {
      item: { ...mockItem, poster_path: '/a.jpg' },
      onClick: () => {},
      onFixMatch: () => {},
    }
    const nextProps: MovieCardProps = {
      item: { ...mockItem, poster_path: '/b.jpg' },
      onClick: () => {},
      onFixMatch: () => {},
    }
    expect(areMovieCardPropsEqual(prevProps, nextProps)).toBe(false)
  })

  it('should return false when layout changes', () => {
    const prevProps: MovieCardProps = {
      item: mockItem,
      onClick: () => {},
      onFixMatch: () => {},
      layout: 'grid',
    }
    const nextProps: MovieCardProps = {
      item: mockItem,
      onClick: () => {},
      onFixMatch: () => {},
      layout: 'list',
    }
    expect(areMovieCardPropsEqual(prevProps, nextProps)).toBe(false)
  })

  it('should return false when showNewBadge changes', () => {
    const onClick = () => {}
    const onFixMatch = () => {}
    const prevProps: MovieCardProps = {
      item: mockItem,
      onClick,
      onFixMatch,
      showNewBadge: true,
    }
    const nextProps: MovieCardProps = {
      item: mockItem,
      onClick,
      onFixMatch,
      showNewBadge: false,
    }
    expect(areMovieCardPropsEqual(prevProps, nextProps)).toBe(false)
  })

  it('should return false when item id changes', () => {
    const prevProps: MovieCardProps = {
      item: mockItem,
      onClick: () => {},
      onFixMatch: () => {},
    }
    const nextProps: MovieCardProps = {
      item: { ...mockItem, id: 2 },
      onClick: () => {},
      onFixMatch: () => {},
    }

    expect(areMovieCardPropsEqual(prevProps, nextProps)).toBe(false)
  })

  it('should return false when item title changes', () => {
    const prevProps: MovieCardProps = {
      item: mockItem,
      onClick: () => {},
      onFixMatch: () => {},
    }
    const nextProps: MovieCardProps = {
      item: { ...mockItem, title: 'New Title' },
      onClick: () => {},
      onFixMatch: () => {},
    }

    expect(areMovieCardPropsEqual(prevProps, nextProps)).toBe(false)
  })

  it('should return false when progress changes', () => {
    const prevProps: MovieCardProps = {
      item: { ...mockItem, progress_percent: 10 },
      onClick: () => {},
      onFixMatch: () => {},
    }
    const nextProps: MovieCardProps = {
      item: { ...mockItem, progress_percent: 20 },
      onClick: () => {},
      onFixMatch: () => {},
    }

    expect(areMovieCardPropsEqual(prevProps, nextProps)).toBe(false)
  })

  it('should return false when scalar prop changes (index)', () => {
    const prevProps: MovieCardProps = {
      item: mockItem,
      onClick: () => {},
      onFixMatch: () => {},
      index: 0
    }
    const nextProps: MovieCardProps = {
      item: mockItem,
      onClick: () => {},
      onFixMatch: () => {},
      index: 1
    }

    expect(areMovieCardPropsEqual(prevProps, nextProps)).toBe(false)
  })

  it('should return false when callback references change', () => {
    const onFixMatch = () => {}

    const prevProps: MovieCardProps = {
      item: mockItem,
      onClick: () => {},
      onFixMatch,
    }
    const nextProps: MovieCardProps = {
      item: mockItem,
      onClick: () => {},
      onFixMatch,
    }

    expect(areMovieCardPropsEqual(prevProps, nextProps)).toBe(false)
  })
})

describe('areContinueCardPropsEqual', () => {
  it('should return true when all relevant props are the same', () => {
    const onClick = () => {}

    const prevProps: ContinueCardProps = {
      item: mockItem,
      onClick,
      index: 0
    }
    const nextProps: ContinueCardProps = {
      item: mockItem,
      onClick,
      index: 0
    }

    expect(areContinueCardPropsEqual(prevProps, nextProps)).toBe(true)
  })

  it('should return false when item changes', () => {
    const onClick = () => {}

    const prevProps: ContinueCardProps = {
      item: mockItem,
      onClick,
    }
    const nextProps: ContinueCardProps = {
      item: { ...mockItem, title: 'Changed' },
      onClick,
    }

    expect(areContinueCardPropsEqual(prevProps, nextProps)).toBe(false)
  })

  it('should return false when callback references change', () => {
    const prevProps: ContinueCardProps = {
      item: mockItem,
      onClick: () => {},
      index: 0
    }
    const nextProps: ContinueCardProps = {
      item: mockItem,
      onClick: () => {},
      index: 0
    }

    expect(areContinueCardPropsEqual(prevProps, nextProps)).toBe(false)
  })

  it('should return true when items are different references but same fields', () => {
    const onClick = () => {}
    const prevProps: ContinueCardProps = {
      item: { ...mockItem },
      onClick,
    }
    const nextProps: ContinueCardProps = {
      item: { ...mockItem },
      onClick,
    }
    expect(areContinueCardPropsEqual(prevProps, nextProps)).toBe(true)
  })

  it('should return false when items have different ids', () => {
    const onClick = () => {}
    const prevProps: ContinueCardProps = {
      item: { ...mockItem, id: 1 },
      onClick,
    }
    const nextProps: ContinueCardProps = {
      item: { ...mockItem, id: 2 },
      onClick,
    }
    expect(areContinueCardPropsEqual(prevProps, nextProps)).toBe(false)
  })
})
