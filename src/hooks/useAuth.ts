import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/tauri'
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
  const [nickname, setNickname] = useState<string | null>(null)
  const [nicknameLoaded, setNicknameLoaded] = useState(false)
  const isMountedRef = useRef(true)
  const initialScanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { toast } = useToast()

  const autoDetectMpvIfUnconfigured = async () => {
    try {
      const config = await withTimeoutOrNull(getConfig(), AUTH_CHECK_TIMEOUT_MS)
      if (config && !config.mpv_path) {
        const mpvPath = await withTimeoutOrNull(autoDetectMpv(), AUTH_CHECK_TIMEOUT_MS)
        if (mpvPath) {
          await saveConfig({ ...config, mpv_path: mpvPath })
          toast({
            title: "MPV Detected",
            description: "Media player configured automatically"
          })
        }
      }
    } catch (error) {
      console.warn('[useAuth] MPV auto-detect failed:', error)
    }
  }

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
        void autoDetectMpvIfUnconfigured()

        // Restore social connection in background (don't block UI)
        restoreSocialConnection().catch(err => {
          console.warn('[useAuth] Social restore failed:', err)
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
            console.warn('[useAuth] Social init failed:', socialError)
          })

          void autoDetectMpvIfUnconfigured()

          // Trigger initial cloud scan to set up folders
          if (initialScanTimeoutRef.current) {
            clearTimeout(initialScanTimeoutRef.current)
          }
          initialScanTimeoutRef.current = setTimeout(async () => {
            try {
              const { scanCloudFolder } = await import('@/services/gdrive')
              await scanCloudFolder('root', 'My Drive')
            } catch (scanError) {
              console.warn('[useAuth] Initial scan failed:', scanError)
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
        console.warn('[useAuth] Social auth disconnect failed:', error)
      })
      disconnectSocial()
      if (isMountedRef.current) {
        setIsAuthenticated(false)
        setNickname(null)
        setNicknameLoaded(false)
        toast({
          title: "Signed Out",
          description: "You have been signed out successfully"
        })
      }
    } catch (error) {
      console.error('[Auth] Logout failed:', error)
    }
  }

  useEffect(() => {
    if (!isAuthenticated) {
      setNickname(null)
      setNicknameLoaded(false)
      return
    }

    setNicknameLoaded(false)
    invoke<string | null>('get_nickname')
      .then((value) => {
        setNickname(value && value.trim() ? value.trim() : null)
      })
      .catch((error) => {
        console.error('[Auth] Failed to load nickname:', error)
        setNickname(null)
      })
      .finally(() => {
        if (isMountedRef.current) {
          setNicknameLoaded(true)
        }
      })
  }, [isAuthenticated])

  const updateNickname = async (newNickname: string) => {
    const trimmedNickname = newNickname.trim()
    await invoke('set_nickname', { nickname: trimmedNickname })
    setNickname(trimmedNickname)
    setNicknameLoaded(true)
  }

  return {
    isAuthenticated,
    isAuthLoading,
    isLoggingIn,
    login,
    logout,
    nickname,
    nicknameLoaded,
    updateNickname
  }
}
