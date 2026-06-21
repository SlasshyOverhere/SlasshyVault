// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GoogleDriveSettings } from './GoogleDriveSettings'

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className }: any) => (
    <button onClick={onClick} disabled={disabled} className={className}>{children}</button>
  ),
}))

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}))

vi.mock('@/services/gdrive', () => ({
  isGDriveConnected: vi.fn().mockResolvedValue(false),
  getGDriveAccountInfo: vi.fn().mockResolvedValue(null),
  startGDriveAuth: vi.fn(),
  completeGDriveAuth: vi.fn(),
  disconnectGDrive: vi.fn(),
  formatStorageSize: vi.fn(() => '1 GB'),
}))

vi.mock('framer-motion', () => ({
  LazyMotion: ({ children }: any) => <div>{children}</div>,
  domAnimation: {},
  m: { div: ({ children, ...p }: any) => <div {...p}>{children}</div> },
}))

vi.mock('lucide-react', () => ({
  Cloud: () => <span />,
  LogIn: () => <span />,
  LogOut: () => <span />,
  Loader2: () => <span />,
  CheckCircle2: () => <span />,
  HardDrive: () => <span />,
  User: () => <span />,
}))

describe('GoogleDriveSettings', () => {
  it('shows connect button when not connected', async () => {
    render(<GoogleDriveSettings />)
    const btn = await screen.findByText('Connect Google Drive')
    expect(btn).toBeTruthy()
  })

  it('shows connected state when connected', async () => {
    const gdrive = await import('@/services/gdrive')
    vi.mocked(gdrive.isGDriveConnected).mockResolvedValueOnce(true)
    vi.mocked(gdrive.getGDriveAccountInfo).mockResolvedValueOnce({
      email: 'user@gmail.com',
      display_name: 'User',
      photo_url: null,
      storage_used: 1073741824,
      storage_limit: 16106127360,
    })
    render(<GoogleDriveSettings />)
    expect(await screen.findByText('user@gmail.com')).toBeTruthy()
  })
})
