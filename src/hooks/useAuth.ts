import { useState, useEffect, useRef } from 'react'
import { useToast } from '@/components/ui/use-toast'
import {
  getConfig,
  saveConfig,
  autoDetectMpv,
  getBundledMpvInfo,
} from '@/services/api'


const AUTH_CHECK_TIMEOUT_MS = 8000

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutValue: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(timeoutValue), timeoutMs)),
  ])
}

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isAuthLoading, setIsAuthLoading] = useState(true)
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [showIndexingPrompt, setShowIndexingPrompt] = useState(false)
  const [isIndexing, setIsIndexing] = useState(false)
  const isMountedRef = useRef(true)
  const initialScanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const authFailsafeRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { toast } = useToast()

  const autoDetectMpvIfUnconfigured = async () => {
    try {
      const config = await withTimeout(getConfig(), AUTH_CHECK_TIMEOUT_MS, null)
      if (config && !config.mpv_path) {
        const mpvPath = await withTimeout(autoDetectMpv(), AUTH_CHECK_TIMEOUT_MS, null)
        if (mpvPath) {
          await saveConfig({ ...config, mpv_path: mpvPath })
          toast({
            title: "MPV Detected",
            description: "Media player configured automatically"
          })
          return
        }

        // Fallback: try to use bundled MPV if available
        const bundledInfo = await getBundledMpvInfo()
        if (bundledInfo.exists) {
          await saveConfig({ ...config, mpv_path: bundledInfo.path })
          console.debug('[useAuth] Using bundled MPV:', bundledInfo.path)
          return
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

      if (isMountedRef.current) {
        setIsAuthLoading(true)
      }
      authFailsafeRef.current = setTimeout(() => {
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
        if (authFailsafeRef.current) {
          clearTimeout(authFailsafeRef.current)
          authFailsafeRef.current = null
        }
        if (isMountedRef.current) {
          setIsAuthLoading(false)
        }
      }

      // Non-critical boot tasks run after auth loading is cleared.
      if (isMountedRef.current && connected) {
        void autoDetectMpvIfUnconfigured()
      }
    }
    checkAuth()

    return () => {
      if (authFailsafeRef.current) {
        clearTimeout(authFailsafeRef.current)
        authFailsafeRef.current = null
      }
    }
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

          void autoDetectMpvIfUnconfigured()

          // Check if first-time user (no cloud folders tracked)
          try {
            const { getCloudFolders } = await import('@/services/gdrive')
            const folders = await getCloudFolders()
            if (folders.length === 0) {
              // First-time user — show indexing prompt
              if (isMountedRef.current) {
                setShowIndexingPrompt(true)
              }
            } else {
              // Returning user — trigger initial cloud scan
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
            }
          } catch (checkError) {
            console.warn('[useAuth] Failed to check cloud folders:', checkError)
          }
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
      const { disconnectGDrive } = await import('@/services/gdrive')
      await disconnectGDrive()
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

  const confirmIndexing = async () => {
    setIsIndexing(true)
    try {
      const { addCloudFolder, scanCloudFolder } = await import('@/services/gdrive')
      await addCloudFolder('root', 'My Drive')
      const result = await scanCloudFolder('root', 'My Drive')
      if (isMountedRef.current) {
        toast({
          title: "Drive Indexed",
          description: result.message || `Indexed ${result.indexed_count} files`
        })
      }
    } catch (error) {
      console.error('[useAuth] Indexing failed:', error)
      if (isMountedRef.current) {
        toast({
          title: "Indexing Failed",
          description: "Could not index your Google Drive",
          variant: "destructive"
        })
      }
    } finally {
      if (isMountedRef.current) {
        setIsIndexing(false)
        setShowIndexingPrompt(false)
      }
    }
  }

  const declineIndexing = () => {
    if (isMountedRef.current) {
      setShowIndexingPrompt(false)
      toast({
        title: "Skipped",
        description: "You can index your Drive later from Settings"
      })
    }
  }

  return {
    isAuthenticated,
    isAuthLoading,
    isLoggingIn,
    login,
    logout,
    showIndexingPrompt,
    isIndexing,
    confirmIndexing,
    declineIndexing
  }
}
