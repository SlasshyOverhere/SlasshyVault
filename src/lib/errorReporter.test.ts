import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/tauri', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

describe('errorReporter', async () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the installed flag by re-importing
    vi.resetModules()
  })

  it('reportToSentry sends Error details', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    vi.stubGlobal('window', {
      __TAURI__: { invoke: vi.fn().mockResolvedValue(undefined) },
      addEventListener: vi.fn(),
    })

    const { installGlobalErrorHandlers } = await import('./errorReporter')
    installGlobalErrorHandlers()

    // The install function should have added event listeners
    expect(window.addEventListener).toHaveBeenCalledWith('error', expect.any(Function))
    expect(window.addEventListener).toHaveBeenCalledWith('unhandledrejection', expect.any(Function))
  })

  it('reportToSentry handles string errors', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    const errorCb = vi.fn()
    vi.stubGlobal('window', {
      __TAURI__: { invoke: vi.fn().mockResolvedValue(undefined) },
      addEventListener: vi.fn((event: string, cb: Function) => {
        if (event === 'error') errorCb.mockImplementation(cb)
      }),
    })

    const { installGlobalErrorHandlers } = await import('./errorReporter')
    installGlobalErrorHandlers()

    // Simulate error event
    errorCb({ error: 'test error', message: 'test error' })
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('sentry_report_error', expect.objectContaining({
        context: 'window.onerror',
      }))
    })
  })

  it('reportToSentry handles object errors', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    const rejectionCb = vi.fn()
    vi.stubGlobal('window', {
      __TAURI__: { invoke: vi.fn().mockResolvedValue(undefined) },
      addEventListener: vi.fn((event: string, cb: Function) => {
        if (event === 'unhandledrejection') rejectionCb.mockImplementation(cb)
      }),
    })

    const { installGlobalErrorHandlers } = await import('./errorReporter')
    installGlobalErrorHandlers()

    // Simulate unhandledrejection with object reason
    rejectionCb({ reason: { code: 'ERR_TEST', msg: 'fail' } })
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('sentry_report_error', expect.objectContaining({
        context: 'unhandledrejection',
      }))
    })
  })

  it('reportToSentry handles non-stringifiable object errors', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    const rejectionCb = vi.fn()
    vi.stubGlobal('window', {
      __TAURI__: { invoke: vi.fn().mockResolvedValue(undefined) },
      addEventListener: vi.fn((event: string, cb: Function) => {
        if (event === 'unhandledrejection') rejectionCb.mockImplementation(cb)
      }),
    })

    const { installGlobalErrorHandlers } = await import('./errorReporter')
    installGlobalErrorHandlers()

    // Object with circular ref that breaks JSON.stringify
    const circular: any = {}
    circular.self = circular
    rejectionCb({ reason: circular })
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalled()
    })
  })

  it('installGlobalErrorHandlers is idempotent', async () => {
    vi.stubGlobal('window', {
      __TAURI__: { invoke: vi.fn() },
      addEventListener: vi.fn(),
    })

    const { installGlobalErrorHandlers } = await import('./errorReporter')
    installGlobalErrorHandlers()
    installGlobalErrorHandlers() // second call should be no-op

    // addEventListener called 2 times (error + unhandledrejection), not 4
    expect(window.addEventListener).toHaveBeenCalledTimes(2)
  })

  it('patches tauri invoke when __TAURI__ is present', async () => {
    const originalInvoke = vi.fn().mockRejectedValue(new Error('cmd failed'))
    vi.stubGlobal('window', {
      __TAURI__: { invoke: originalInvoke },
      addEventListener: vi.fn(),
    })

    const { installGlobalErrorHandlers } = await import('./errorReporter')
    installGlobalErrorHandlers()

    // The patched invoke should report and re-throw
    await expect(window.__TAURI__!.invoke('test_cmd')).rejects.toThrow('cmd failed')
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('sentry_report_error', expect.objectContaining({
        context: 'tauri:test_cmd',
      }))
    })
  })

  it('skips tauri patch when __TAURI__ is absent', async () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
    })

    const { installGlobalErrorHandlers } = await import('./errorReporter')
    installGlobalErrorHandlers()

    // Should not throw
    expect(window.addEventListener).toHaveBeenCalledTimes(2)
  })

  it('reportToSentry handles falsy (null) error', async () => {
    const rejectionCb = vi.fn()
    vi.stubGlobal('window', {
      __TAURI__: { invoke: vi.fn() },
      addEventListener: vi.fn((event: string, cb: Function) => {
        if (event === 'unhandledrejection') rejectionCb.mockImplementation(cb)
      }),
    })

    const { installGlobalErrorHandlers } = await import('./errorReporter')
    installGlobalErrorHandlers()

    rejectionCb({ reason: null })
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('sentry_report_error', expect.objectContaining({
        details: 'null',
      }))
    })
  })

  it('reportToSentry silently ignores invoke failures', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('sentry down'))
    const rejectionCb = vi.fn()
    vi.stubGlobal('window', {
      __TAURI__: { invoke: vi.fn() },
      addEventListener: vi.fn((event: string, cb: Function) => {
        if (event === 'unhandledrejection') rejectionCb.mockImplementation(cb)
      }),
    })

    const { installGlobalErrorHandlers } = await import('./errorReporter')
    installGlobalErrorHandlers()

    // Should not throw even though invoke fails
    rejectionCb({ reason: 'test' })
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalled()
    })
  })
})
