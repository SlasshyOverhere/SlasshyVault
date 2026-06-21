// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FullHistoryView } from './FullHistoryView'

vi.mock('framer-motion', () => ({
  LazyMotion: ({ children }: any) => <div>{children}</div>,
  m: { div: ({ children, ...p }: any) => <div {...p}>{children}</div> },
}))

vi.mock('lucide-react', () => ({
  BarChart3: () => <span />,
}))

vi.mock('@/components/AnalyticsView', () => ({
  AnalyticsView: ({ data }: any) => <div data-testid="analytics">Analytics: {data?.overview?.total_events ?? 0}</div>,
}))

describe('FullHistoryView', () => {
  it('shows loading state when no analytics data', () => {
    render(<FullHistoryView />)
    expect(screen.getByText(/Loading analytics/)).toBeTruthy()
  })

  it('renders AnalyticsView when data is provided', () => {
    const data = { overview: { total_events: 42, total_watch_time_seconds: 0, movies_completed: 0, episodes_completed: 0, total_completion_rate: 0, current_streak_days: 0 } } as any
    render(<FullHistoryView analyticsData={data} />)
    expect(screen.getByTestId('analytics')).toBeTruthy()
    expect(screen.getByText(/42/)).toBeTruthy()
  })

  it('calls onAnalyticsTabActive on mount', () => {
    const cb = vi.fn()
    render(<FullHistoryView onAnalyticsTabActive={cb} />)
    expect(cb).toHaveBeenCalled()
  })
})
