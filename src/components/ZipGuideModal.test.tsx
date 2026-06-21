// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ZipGuideModal } from './ZipGuideModal'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
}))

vi.mock('lucide-react', () => ({
  Archive: () => <span />,
  Info: () => <span />,
  ShieldAlert: () => <span />,
}))

describe('ZipGuideModal', () => {
  it('renders when open', () => {
    render(<ZipGuideModal open={true} onOpenChange={() => {}} />)
    expect(screen.getByText('Create Compatible ZIP Archives')).toBeTruthy()
    expect(screen.getByText('7-Zip on Windows')).toBeTruthy()
    expect(screen.getByText('Command line examples')).toBeTruthy()
    expect(screen.getByText('Avoid these options')).toBeTruthy()
  })

  it('does not render when closed', () => {
    render(<ZipGuideModal open={false} onOpenChange={() => {}} />)
    expect(screen.queryByText('Create Compatible ZIP Archives')).toBeNull()
  })

  it('closes on close button click', () => {
    const onOpenChange = vi.fn()
    render(<ZipGuideModal open={true} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByText('Close'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
