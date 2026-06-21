// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ShareDialog } from './ShareDialog'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className }: any) => (
    <button onClick={onClick} disabled={disabled} className={className}>{children}</button>
  ),
}))

vi.mock('@/components/ui/input', () => ({
  Input: ({ value, onChange, placeholder, type, onKeyDown, className }: any) => (
    <input value={value} onChange={onChange} placeholder={placeholder} type={type} onKeyDown={onKeyDown} className={className} />
  ),
}))

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}))

vi.mock('@/services/gdrive', () => ({
  shareGDriveFile: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
}))

vi.mock('lucide-react', () => ({
  Mail: () => <span />,
  Send: () => <span />,
  CheckCircle2: () => <span />,
  Loader2: () => <span />,
  Shield: () => <span />,
}))

describe('ShareDialog', () => {
  const baseProps = {
    open: true,
    onOpenChange: vi.fn(),
    fileId: 'file123',
    fileName: 'test.mp4',
  }

  it('renders when open', () => {
    render(<ShareDialog {...baseProps} />)
    expect(screen.getByText('Share via Google Drive')).toBeTruthy()
    expect(screen.getByPlaceholderText('person@example.com')).toBeTruthy()
  })

  it('does not render when closed', () => {
    render(<ShareDialog {...baseProps} open={false} />)
    expect(screen.queryByText('Share via Google Drive')).toBeNull()
  })

  it('updates email on input change', () => {
    render(<ShareDialog {...baseProps} />)
    const input = screen.getByPlaceholderText('person@example.com') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'test@example.com' } })
    expect(input.value).toBe('test@example.com')
  })

  it('shows share button', () => {
    render(<ShareDialog {...baseProps} />)
    expect(screen.getByText('Share')).toBeTruthy()
  })

  it('share button is disabled when email is empty', () => {
    render(<ShareDialog {...baseProps} />)
    const btn = screen.getByText('Share') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('share button is enabled when email has content', () => {
    render(<ShareDialog {...baseProps} />)
    const input = screen.getByPlaceholderText('person@example.com')
    fireEvent.change(input, { target: { value: 'a@b.com' } })
    const btn = screen.getByText('Share') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('displays file name in description', () => {
    render(<ShareDialog {...baseProps} />)
    expect(screen.getByText(/test\.mp4/)).toBeTruthy()
  })
})
