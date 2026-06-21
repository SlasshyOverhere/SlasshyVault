// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { AnalyticsView } from './AnalyticsView'

vi.mock('framer-motion', () => ({
  LazyMotion: ({ children }: any) => <div>{children}</div>,
  m: { div: ({ children, ...p }: any) => <div {...p}>{children}</div> },
  domAnimation: {},
}))

vi.mock('lucide-react', () => new Proxy({}, { get: () => () => <span /> }))

const mockData = {
  overview: {
    total_watch_time_seconds: 36000,
    movies_completed: 5,
    episodes_completed: 20,
    total_completion_rate: 80,
    current_streak_days: 3,
    total_events: 50,
  },
  heatmap: [],
  daily_trend: [],
  content_breakdown: [],
  source_breakdown: [],
  top_watched: [],
  hour_distribution: [],
  day_distribution: [],
  completion_funnel: { started: 10, in_progress_25: 5, mostly_done_75: 3, completed: 2 },
  library_stats: { movies: 10, shows: 5, episodes: 50 },
  recent_events: [],
}

describe('AnalyticsView', () => {
  it('renders without crashing', () => {
    const { container } = render(<AnalyticsView data={mockData} />)
    expect(container.firstChild).toBeTruthy()
  })
})
