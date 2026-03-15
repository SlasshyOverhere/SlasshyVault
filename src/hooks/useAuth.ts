import { useState, useEffect, useRef } from 'react'
import { useToast } from '@/components/ui/use-toast'
import {
  getConfig,
  saveConfig,
  autoDetectMpv,
} from '@/services/api'
import {
  restoreSocialConnection,
  disconnectSocial,
} from '@/services/social'

const AUTH_CHECK_TIMEOUT_MS = 8000

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutValue: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(timeoutValue), timeoutMs)
    }),
  ])
}

async function withTimeoutOrNull<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs)
    }),
  ])
}

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isAuthLoading, setIsAuthLoading] = useState(true)
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const isMountedRef = useRef(true)
  const initialScanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (initialScanTimeoutRef.current) {
        clearTimeout(initialScanTimeoutRef.current)
        initialScanTimeoutRef.current = null
      }
    }
  }, [])

  // Check authentication on mount
  useEffect(() => {
    const checkAuth = async () => {
      let connected = false
      let authLoadingFailsafe: ReturnType<typeof setTimeout> | null = null

      if (isMountedRef.current) {
        setIsAuthLoading(true)
      }
      authLoadingFailsafe = setTimeout(() => {
        if (isMountedRef.current) {
          console.warn('[Auth] Failsafe: forcing auth loading to false after timeout')
          setIsAuthLoading(false)
        }
      }, AUTH_CHECK_TIMEOUT_MS + 4000)

      try {
        // First check if GDrive is connected (fast local check)
        const { isGDriveConnected } = await import('@/services/gdrive')
        connected = await withTimeout(
          isGDriveConnected(),
          AUTH_CHECK_TIMEOUT_MS,
          false
        )

        if (connected) {
          // GDrive is connected, user is authenticated
          if (isMountedRef.current) {
            setIsAuthenticated(true)
          }
        }
      } catch (error) {
        console.error('[Auth] Failed to check connection:', error)
      } finally {
        if (authLoadingFailsafe) {
          clearTimeout(authLoadingFailsafe)
        }
        if (isMountedRef.current) {
          setIsAuthLoading(false)
        }
      }

      // Non-critical boot tasks run after auth loading is cleared.
      if (isMountedRef.current && connected) {
        // Auto-detect MPV if not configured (background, bounded by timeout)
        void (async () => {
          try {
            const config = await withTimeoutOrNull(getConfig(), AUTH_CHECK_TIMEOUT_MS)
            if (config && !config.mpv_path) {
              console.log('[Boot] No MPV configured, auto-detecting...')
              const mpvPath = await withTimeoutOrNull(autoDetectMpv(), AUTH_CHECK_TIMEOUT_MS)
              if (mpvPath) {
                await saveConfig({ ...config, mpv_path: mpvPath })
                console.log('[Boot] MPV auto-detected:', mpvPath)
                toast({
                  title: "MPV Detected",
                  description: "Media player configured automatically"
                })
              }
            }
          } catch (mpvError) {
            console.log('[Boot] MPV auto-detect failed (non-critical):', mpvError)
          }
        })()

        // Restore social connection in background (don't block UI)
        restoreSocialConnection().catch(err => {
          console.log('[Auth] Social restore failed (non-critical):', err)
        })
      }
    }
    checkAuth()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Handle Google login
  const login = async () => {
    if (isMountedRef.current) {
      setIsLoggingIn(true)
    }
    try {
      const { startGDriveAuth, completeGDriveAuth, isGDriveConnected } = await import('@/services/gdrive')

      // Start OAuth flow - opens browser
      await startGDriveAuth()

      // Wait for OAuth completion (this waits for localhost:8085 callback)
      const accountInfo = await completeGDriveAuth()

      if (accountInfo) {
        // Check if GDrive is now connected
        const connected = await withTimeout(
          isGDriveConnected(),
          AUTH_CHECK_TIMEOUT_MS,
          false
        )

        if (connected) {
          if (isMountedRef.current) {
            setIsAuthenticated(true)
            toast({
              title: "Welcome!",
              description: `Signed in as ${accountInfo.email}`
            })
          }

          // Initialize social connection with new tokens in background
          restoreSocialConnection().catch((socialError) => {
            console.log('[Auth] Social init failed (non-critical):', socialError)
          })

          // Auto-detect MPV in background to avoid blocking the login flow
          void (async () => {
            try {
              const config = await withTimeoutOrNull(getConfig(), AUTH_CHECK_TIMEOUT_MS)
              if (config && !config.mpv_path) {
                console.log('[Auth] No MPV configured, auto-detecting...')
                const mpvPath = await withTimeoutOrNull(autoDetectMpv(), AUTH_CHECK_TIMEOUT_MS)
                if (mpvPath) {
                  await saveConfig({ ...config, mpv_path: mpvPath })
                  console.log('[Auth] MPV auto-detected:', mpvPath)
                  toast({
                    title: "MPV Detected",
                    description: "Media player configured automatically"
                  })
                }
              }
            } catch (mpvError) {
              console.log('[Auth] MPV auto-detect failed (non-critical):', mpvError)
            }
          })()

          // Trigger initial cloud scan to set up folders
          if (initialScanTimeoutRef.current) {
            clearTimeout(initialScanTimeoutRef.current)
          }
          initialScanTimeoutRef.current = setTimeout(async () => {
            try {
              const { scanCloudFolder } = await import('@/services/gdrive')
              console.log('[Auth] Starting initial cloud scan...')
              await scanCloudFolder('root', 'My Drive')
              console.log('[Auth] Initial cloud scan complete')
            } catch (scanError) {
              console.log('[Auth] Initial scan failed (non-critical):', scanError)
            }
          }, 1000)
        } else {
          throw new Error('OAuth completed but GDrive not connected')
        }
      }
    } catch (error) {
      console.error('[Auth] Login failed:', error)
      if (isMountedRef.current) {
        toast({
          title: "Login Failed",
          description: String(error) || "Failed to sign in with Google",
          variant: "destructive"
        })
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoggingIn(false)
      }
    }
  }

  // Handle logout
  const logout = async () => {
    try {
      const { disconnectGDrive, disconnectSocialAuth } = await import('@/services/gdrive')
      await disconnectGDrive()
      await disconnectSocialAuth().catch((error) => {
        console.log('[Auth] Social auth disconnect failed (non-critical):', error)
      })
      disconnectSocial()
      if (isMountedRef.current) {
        setIsAuthenticated(false)
        toast({
          title: "Signed Out",
          description: "You have been signed out successfully"
        })
      }
    } catch (error) {
      console.error('[Auth] Logout failed:', error)
    }
  }

  return {
    isAuthenticated,
    isAuthLoading,
    isLoggingIn,
    login,
    logout
  }
}
