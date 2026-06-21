// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CountdownTimer } from './CountdownTimer'

vi.mock('framer-motion', () => ({
  LazyMotion: ({ children }: any) => <div>{children}</div>,
  domAnimation: {},
  m: { div: ({ children, ...p }: any) => <div {...p}>{children}</div> },
}))

vi.mock('lucide-react', () => ({
  Clock: () => <span />,
  AlertCircle: () => <span />,
  CheckCircle2: () => <span />,
}))

describe('CountdownTimer', () => {
  it('shows available now for past target', () => {
    render(<CountdownTimer target="2000-01-01" />)
    expect(screen.getByText('Available now')).toBeTruthy()
  })

  it('shows countdown blocks for future target', () => {
    const future = new Date(Date.now() + 86400000 * 3 + 3600000 * 5 + 60000 * 30)
    render(<CountdownTimer target={future} />)
    expect(screen.getByText('Days')).toBeTruthy()
    expect(screen.getByText('Hours')).toBeTruthy()
    expect(screen.getByText('Mins')).toBeTruthy()
    expect(screen.getByText('Secs')).toBeTruthy()
  })

  it('shows custom label', () => {
    const future = new Date(Date.now() + 86400000)
    render(<CountdownTimer target={future} label="Releases in" />)
    expect(screen.getByText('Releases in')).toBeTruthy()
  })

  it('shows custom expired label', () => {
    render(<CountdownTimer target="2000-01-01" expiredLabel="Out now!" />)
    expect(screen.getByText('Out now!')).toBeTruthy()
  })

  it('shows pending when forcePending with past target', () => {
    render(<CountdownTimer target="2020-01-01" forcePending />)
    expect(screen.getByText('Pending Update')).toBeTruthy()
  })

  it('renders nothing when target is null', () => {
    const { container } = render(<CountdownTimer target={null} />)
    expect(container.textContent).toBe('')
  })

  it('renders in compact mode', () => {
    render(<CountdownTimer target="2000-01-01" compact />)
    expect(screen.getByText('Available now')).toBeTruthy()
  })

  it('renders in banner mode', () => {
    const future = new Date(Date.now() + 86400000)
    render(<CountdownTimer target={future} banner />)
    expect(screen.getByText('Days')).toBeTruthy()
  })
})
