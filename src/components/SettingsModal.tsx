import { useState, useEffect } from "react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import {
  Trash2, MonitorPlay, FolderOpen,
  AlertTriangle, Settings, Key, Zap, Power, X, Save, Sparkles, Eye, Cloud, Download, RefreshCw, FileText, Code, FlaskConical, Users, Radio, Activity, Shield
} from "lucide-react"
import {
  Config, getConfig, saveConfig, clearAllAppData, cleanupMissingMetadata,
  TabVisibility,
  checkForUpdates, downloadUpdate, installUpdate, getAppVersion, UpdateInfo, autoDetectMpv
} from "@/services/api"
import {
  getDevSettings,
  setDevSettings,
  getDefaultAuthServerUrl
} from "@/services/social"
import { isDev } from "@/config/social"
import { useToast } from "@/components/ui/use-toast"
import { open as openDialog } from '@tauri-apps/api/dialog'
import { invoke } from '@tauri-apps/api/tauri'
import { Switch } from "@/components/ui/switch"
import { motion, AnimatePresence } from "framer-motion"
import { cn } from "@/lib/utils"
import { GoogleDriveSettings } from "@/components/GoogleDriveSettings"
import { CURRENT_APP_VERSION } from "@/components/UpdateNotesModal"

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRestartOnboarding?: () => void
  onViewUpdateNotes?: () => void
  initialTab?: SettingsSection
  tabVisibility?: TabVisibility
  onTabVisibilityChange?: (visibility: TabVisibility) => void
  onLogout?: () => void
  betaEnabled?: boolean
  onBetaToggle?: (enabled: boolean) => void
  autoCheckUpdate?: boolean
  onSimulateUpdate?: () => void
}

type SettingsSection = 'general' | 'beta' | 'updates' | 'cloud' | 'api' | 'danger' | 'dev'

export function SettingsModal({ open, onOpenChange, onRestartOnboarding, onViewUpdateNotes, initialTab, tabVisibility: _tabVisibility, onTabVisibilityChange: _onTabVisibilityChange, onLogout, betaEnabled = false, onBetaToggle, autoCheckUpdate = false, onSimulateUpdate }: SettingsModalProps) {
  const [config, setConfig] = useState<Config>({
    mpv_path: "",
    vlc_path: "",
    ffprobe_path: "",
    ffmpeg_path: "",
    tmdb_api_key: "",
    cloud_cache_enabled: false,
    cloud_cache_dir: "",
    cloud_cache_max_mb: 1024,
    cloud_cache_expiry_hours: 24
  })
  const [loading, setLoading] = useState(false)
  const [autoStart, setAutoStart] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [cleaningUp, setCleaningUp] = useState(false)
  const [activeSection, setActiveSection] = useState<SettingsSection>('general')
  const [appVersion, setAppVersion] = useState<string>("")
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [downloadingUpdate, setDownloadingUpdate] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [devAuthServerUrl, setDevAuthServerUrl] = useState("")
  const [detectingMpv, setDetectingMpv] = useState(false)
  const [useOwnApiKey, setUseOwnApiKey] = useState(false)
  const { toast } = useToast()

  useEffect(() => {
    if (open) {
      loadConfig()
      checkAutoStart()
      loadAppVersion()
      setActiveSection(initialTab || 'general')
      setShowResetConfirm(false)
      // Load dev settings
      if (isDev) {
        const devSettings = getDevSettings()
        setDevAuthServerUrl(devSettings.authServerUrl)
      }
    }
  }, [open, initialTab])

  // Auto-trigger update check when navigated from update notification
  useEffect(() => {
    if (open && autoCheckUpdate && activeSection === 'updates') {
      handleCheckUpdate()
    }
  }, [open, autoCheckUpdate])

  const loadAppVersion = async () => {
    try {
      const version = await getAppVersion()
      setAppVersion(version)
    } catch (error) {
      console.error("Failed to load app version", error)
    }
  }

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true)
    setUpdateInfo(null)
    try {
      const info = await checkForUpdates()
      setUpdateInfo(info)
      if (!info.available) {
        toast({ title: "Up to Date", description: `You're running the latest version (${info.current_version})` })
      }
    } catch (error) {
      console.error("Failed to check for updates", error)
      toast({ title: "Error", description: "Failed to check for updates. Please try again later.", variant: "destructive" })
    } finally {
      setCheckingUpdate(false)
    }
  }

  const handleDownloadAndInstall = async () => {
    if (!updateInfo?.download_url) return

    setDownloadingUpdate(true)
    setDownloadProgress(0)
    try {
      // Listen for download progress events
      const { listen } = await import('@tauri-apps/api/event')
      const unlisten = await listen<{ progress: number }>('update-download-progress', (event) => {
        setDownloadProgress(event.payload.progress)
      })

      const installerPath = await downloadUpdate(updateInfo.download_url)
      unlisten()

      toast({ title: "Download Complete", description: "Installing update and restarting..." })

      // Small delay to show the toast
      await new Promise(resolve => setTimeout(resolve, 1000))

      await installUpdate(installerPath)
    } catch (error) {
      console.error("Failed to download/install update", error)
      toast({ title: "Error", description: "Failed to download update. Please try again.", variant: "destructive" })
    } finally {
      setDownloadingUpdate(false)
      setDownloadProgress(0)
    }
  }

  const checkAutoStart = async () => {
    try {
      const enabled = await invoke<boolean>('plugin:autostart|is_enabled')
      setAutoStart(enabled)
    } catch (error) {
      console.error("Failed to check autostart", error)
    }
  }

  const toggleAutoStart = async (checked: boolean) => {
    try {
      if (checked) {
        await invoke('plugin:autostart|enable')
        toast({ title: "Auto Startup Enabled", description: "StreamVault will now start automatically." })
      } else {
        await invoke('plugin:autostart|disable')
        toast({ title: "Auto Startup Disabled", description: "StreamVault will not start automatically." })
      }
      setAutoStart(checked)
    } catch (error) {
      console.error("Failed to toggle autostart", error)
      toast({ title: "Error", description: "Failed to update startup settings", variant: "destructive" })
    }
  }

  const loadConfig = async () => {
    try {
      const data = await getConfig()
      setConfig({
        mpv_path: data.mpv_path || "",
        vlc_path: data.vlc_path || "",
        ffprobe_path: data.ffprobe_path || "",
        ffmpeg_path: data.ffmpeg_path || "",
        tmdb_api_key: data.tmdb_api_key || "",
        cloud_cache_enabled: data.cloud_cache_enabled ?? false,
        cloud_cache_dir: data.cloud_cache_dir || "",
        cloud_cache_max_mb: data.cloud_cache_max_mb ?? 1024,
        cloud_cache_expiry_hours: data.cloud_cache_expiry_hours ?? 24
      })
      // If user already has a custom API key saved, show the custom input
      setUseOwnApiKey(!!data.tmdb_api_key)
    } catch (error) {
      console.error("Failed to load config", error)
      toast({ title: "Error", description: "Failed to load configuration", variant: "destructive" })
    }
  }

  const handleSave = async () => {
    setLoading(true)
    try {
      await saveConfig(config)
      toast({ title: "Success", description: "Settings saved successfully" })
      onOpenChange(false)
    } catch (error) {
      console.error("Failed to save config", error)
      toast({ title: "Error", description: "Failed to save settings", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  const handleResetApp = async () => {
    setResetting(true)
    try {
      await clearAllAppData()
      toast({
        title: "App Reset Complete",
        description: "All data has been cleared. The app is now like new."
      })
      setShowResetConfirm(false)
      onOpenChange(false)
      window.location.reload()
    } catch (error) {
      console.error("Failed to reset app", error)
      toast({
        title: "Error",
        description: "Failed to reset app data",
        variant: "destructive"
      })
    } finally {
      setResetting(false)
    }
  }

  const handleCleanupMissing = async () => {
    setCleaningUp(true)
    try {
      const result = await cleanupMissingMetadata()
      toast({
        title: "Cleanup Complete",
        description: result.message
      })
      if (result.removed_count > 0) {
        window.location.reload()
      }
    } catch (error) {
      console.error("Failed to cleanup missing metadata", error)
      toast({
        title: "Error",
        description: "Failed to cleanup missing metadata",
        variant: "destructive"
      })
    } finally {
      setCleaningUp(false)
    }
  }

  const browseMpvPath = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: 'Executable', extensions: ['exe'] }],
        title: 'Select MPV Executable'
      })
      if (selected && typeof selected === 'string') {
        setConfig({ ...config, mpv_path: selected })
      }
    } catch (error) {
      console.error("Failed to open file dialog", error)
    }
  }

  const handleSaveDevSettings = () => {
    setDevSettings({ authServerUrl: devAuthServerUrl })
    toast({
      title: "Dev Settings Saved",
      description: "Backend URL updated. Social connections will reconnect."
    })
  }

  const handleResetDevSettings = () => {
    const defaultUrl = getDefaultAuthServerUrl()
    setDevAuthServerUrl(defaultUrl)
    setDevSettings({ authServerUrl: defaultUrl })
    toast({
      title: "Dev Settings Reset",
      description: "Backend URL reset to default."
    })
  }

  const handleAutoDetectMpv = async () => {
    setDetectingMpv(true)
    try {
      const foundPath = await autoDetectMpv()
      if (foundPath) {
        setConfig({ ...config, mpv_path: foundPath })
        toast({
          title: "MPV Found",
          description: `Detected at: ${foundPath}`
        })
      } else {
        toast({
          title: "MPV Not Found",
          description: "Could not find mpv.exe on your system. Please install MPV or set the path manually.",
          variant: "destructive"
        })
      }
    } catch (error) {
      console.error("Failed to auto-detect MPV:", error)
      toast({
        title: "Detection Failed",
        description: "An error occurred while searching for MPV.",
        variant: "destructive"
      })
    } finally {
      setDetectingMpv(false)
    }
  }

  const sections: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
    { id: 'general', label: 'General', icon: <Settings className="w-4 h-4" /> },
    { id: 'updates', label: 'Updates & Security', icon: <Shield className="w-4 h-4" /> },
    { id: 'cloud', label: 'Cloud Storage', icon: <Cloud className="w-4 h-4" /> },
    { id: 'api', label: 'API Keys', icon: <Key className="w-4 h-4" /> },
    { id: 'danger', label: 'Advanced', icon: <AlertTriangle className="w-4 h-4" /> },
    { id: 'beta', label: 'Beta', icon: <FlaskConical className="w-4 h-4" /> },
    // Dev section only visible in development mode
    ...(isDev ? [{ id: 'dev' as SettingsSection, label: 'Developer', icon: <Code className="w-4 h-4" /> }] : []),
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!flex max-w-4xl max-h-[85vh] p-0 gap-0 flex-col overflow-hidden">
        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <div className="w-40 sm:w-48 md:w-56 flex-shrink-0 bg-card/50 border-r border-border p-3 sm:p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-foreground">Settings</h2>
              <button
                onClick={() => onOpenChange(false)}
                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <nav className="space-y-1">
              {sections.map((section) => (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={cn(
                    "w-full flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 sm:py-2.5 rounded-xl transition-all duration-200 text-left",
                    activeSection === section.id
                      ? "bg-white/10 text-white"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  )}
                >
                  {section.icon}
                  <span className="text-xs sm:text-sm font-medium truncate">{section.label}</span>
                </button>
              ))}
            </nav>
          </div>

          {/* Content */}
          <div className="flex-1 flex flex-col min-h-0 min-w-0">
            {/* Content Area */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 min-h-0">
              <AnimatePresence mode="wait">
                {/* General Section */}
                {activeSection === 'general' && (
                  <motion.div
                    key="general"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-6"
                  >
                    <div>
                      <h3 className="text-lg font-semibold text-foreground mb-1">General Settings</h3>
                      <p className="text-sm text-muted-foreground">Configure general app behavior</p>
                    </div>

                    {/* Auto Start */}
                    <div className="p-4 rounded-xl bg-card border border-border">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-white/10">
                            <Power className="w-5 h-5 text-white" />
                          </div>
                          <div>
                            <Label className="text-base font-medium">Run on Startup</Label>
                            <p className="text-sm text-muted-foreground">
                              Automatically start StreamVault when you log in
                            </p>
                          </div>
                        </div>
                        <Switch checked={autoStart} onCheckedChange={toggleAutoStart} />
                      </div>
                    </div>

                    {/* MPV Path */}
                    <div className="p-4 rounded-xl bg-card border border-border space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-white/10">
                          <MonitorPlay className="w-5 h-5 text-white" />
                        </div>
                        <div>
                          <Label className="text-base font-medium">MPV Executable Path</Label>
                          <p className="text-sm text-muted-foreground">
                            Required for video playback
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Input
                          value={config.mpv_path || ""}
                          onChange={(e) => setConfig({ ...config, mpv_path: e.target.value })}
                          placeholder="C:\path\to\mpv.exe"
                          className="flex-1"
                        />
                        <Button variant="outline" size="icon" onClick={browseMpvPath} title="Browse">
                          <FolderOpen className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          onClick={handleAutoDetectMpv}
                          disabled={detectingMpv}
                          className="gap-2"
                          title="Auto-detect MPV on your PC"
                        >
                          <RefreshCw className={cn("w-4 h-4", detectingMpv && "animate-spin")} />
                          {detectingMpv ? "Detecting..." : "Detect"}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">Download MPV from mpv.io if not installed</p>
                    </div>

                    {/* Onboarding Overview */}
                    <div className="p-4 rounded-xl bg-card border border-border">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-white/10">
                            <Sparkles className="w-5 h-5 text-white" />
                          </div>
                          <div>
                            <Label className="text-base font-medium">Onboarding Overview</Label>
                            <p className="text-sm text-muted-foreground">
                              Experience the full app introduction again
                            </p>
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            onOpenChange(false)
                            onRestartOnboarding?.()
                          }}
                          className="gap-2"
                        >
                          <Sparkles className="w-4 h-4" />
                          Start Tour
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                )}

                {/* Beta Features Section */}
                {activeSection === 'beta' && (
                  <motion.div
                    key="beta"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-6"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-semibold text-foreground mb-1">Beta Features</h3>
                        <span className="px-1.5 py-0.5 text-[10px] font-medium bg-purple-500/20 text-purple-400 rounded-full">EXPERIMENTAL</span>
                      </div>
                      <p className="text-sm text-muted-foreground">Try new features before they're stable</p>
                    </div>

                    {/* Master Beta Toggle */}
                    <div className="p-4 rounded-xl bg-card border border-purple-500/30">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-purple-500/20">
                            <FlaskConical className="w-5 h-5 text-purple-400" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <Label className="text-base font-medium">Enable Beta Features</Label>
                              <span className={cn(
                                "px-1.5 py-0.5 text-[10px] font-semibold rounded",
                                betaEnabled
                                  ? "bg-green-500/20 text-green-400"
                                  : "bg-muted text-muted-foreground"
                              )}>
                                {betaEnabled ? "ON" : "OFF"}
                              </span>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              Toggle all beta features on or off
                            </p>
                          </div>
                        </div>
                        <Switch
                          checked={betaEnabled}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              const confirmed = window.confirm(
                                "Beta Features Warning\n\n" +
                                "These features are experimental and for public testing only:\n\n" +
                                "\u2022 Watch Together - Watch with friends in sync\n" +
                                "\u2022 Social Features - Friends, chat, activity feed\n\n" +
                                "These features may not work properly, may have bugs, " +
                                "and could stop working at any time.\n\n" +
                                "Do you want to enable beta features?"
                              )
                              if (confirmed) {
                                onBetaToggle?.(true)
                              }
                            } else {
                              onBetaToggle?.(false)
                            }
                          }}
                        />
                      </div>
                    </div>

                    {/* Warning Banner */}
                    <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-yellow-500 mt-0.5 flex-shrink-0" />
                        <div className="space-y-1">
                          <p className="text-xs font-medium text-yellow-500">Heads up</p>
                          <p className="text-xs text-yellow-500/70">
                            Beta features are experimental and for public testing only. They may not work properly, may have bugs, and could stop working at any time. Use at your own risk.
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Feature List */}
                    <div className="space-y-3">
                      <Label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Beta Features</Label>

                      {/* Watch Together */}
                      <div className={cn(
                        "p-4 rounded-xl border transition-colors",
                        betaEnabled
                          ? "bg-card border-purple-500/20"
                          : "bg-card/50 border-border opacity-60"
                      )}>
                        <div className="flex items-start gap-3">
                          <div className={cn(
                            "p-2 rounded-lg flex-shrink-0",
                            betaEnabled ? "bg-purple-500/20" : "bg-muted"
                          )}>
                            <Radio className={cn("w-5 h-5", betaEnabled ? "text-purple-400" : "text-muted-foreground")} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-sm font-medium">Watch Together</span>
                              <span className="px-1.5 py-0.5 text-[10px] font-medium bg-orange-500/20 text-orange-400 rounded">UNSTABLE</span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Watch movies and shows in sync with friends. Create or join rooms for synchronized playback.
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Social - Friends & Chat */}
                      <div className={cn(
                        "p-4 rounded-xl border transition-colors",
                        betaEnabled
                          ? "bg-card border-purple-500/20"
                          : "bg-card/50 border-border opacity-60"
                      )}>
                        <div className="flex items-start gap-3">
                          <div className={cn(
                            "p-2 rounded-lg flex-shrink-0",
                            betaEnabled ? "bg-purple-500/20" : "bg-muted"
                          )}>
                            <Users className={cn("w-5 h-5", betaEnabled ? "text-purple-400" : "text-muted-foreground")} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-sm font-medium">Social - Friends & Chat</span>
                              <span className="px-1.5 py-0.5 text-[10px] font-medium bg-orange-500/20 text-orange-400 rounded">UNSTABLE</span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Add friends, send messages, and see what others are watching. Social tab appears in the sidebar.
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Activity Feed */}
                      <div className={cn(
                        "p-4 rounded-xl border transition-colors",
                        betaEnabled
                          ? "bg-card border-purple-500/20"
                          : "bg-card/50 border-border opacity-60"
                      )}>
                        <div className="flex items-start gap-3">
                          <div className={cn(
                            "p-2 rounded-lg flex-shrink-0",
                            betaEnabled ? "bg-purple-500/20" : "bg-muted"
                          )}>
                            <Activity className={cn("w-5 h-5", betaEnabled ? "text-purple-400" : "text-muted-foreground")} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-sm font-medium">Activity Feed</span>
                              <span className="px-1.5 py-0.5 text-[10px] font-medium bg-orange-500/20 text-orange-400 rounded">UNSTABLE</span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              See what your friends are watching in real-time. Activity updates show on the Social page.
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}

                {/* Updates & Security Section */}
                {activeSection === 'updates' && (
                  <motion.div
                    key="updates"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-6"
                  >
                    <div>
                      <h3 className="text-lg font-semibold text-foreground mb-1">Updates & Security</h3>
                      <p className="text-sm text-muted-foreground">App updates, what's new, and version info</p>
                    </div>

                    {/* About & Updates */}
                    <div className="p-4 rounded-xl bg-card border border-border space-y-4">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="p-2 rounded-lg bg-white/10">
                          <Download className="w-5 h-5 text-white" />
                        </div>
                        <div>
                          <Label className="text-base font-medium">About & Updates</Label>
                          <p className="text-sm text-muted-foreground">
                            Version {appVersion || "..."}
                          </p>
                        </div>
                      </div>

                      {/* Check for Updates Button */}
                      {!updateInfo?.available && (
                        <Button
                          variant="outline"
                          onClick={handleCheckUpdate}
                          disabled={checkingUpdate}
                          className="w-full gap-2"
                        >
                          <RefreshCw className={cn("w-4 h-4", checkingUpdate && "animate-spin")} />
                          {checkingUpdate ? "Checking..." : "Check for Updates"}
                        </Button>
                      )}

                      {/* Update Available */}
                      {updateInfo?.available && (
                        <div className="space-y-3 p-3 rounded-lg bg-white/10 border border-white/20">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-white">
                              Update Available: v{updateInfo.latest_version}
                            </span>
                            {updateInfo.published_at && (
                              <span className="text-xs text-muted-foreground">
                                {new Date(updateInfo.published_at).toLocaleDateString()}
                              </span>
                            )}
                          </div>

                          {updateInfo.release_notes && (
                            <div className="text-xs text-muted-foreground max-h-24 overflow-y-auto">
                              <p className="whitespace-pre-wrap">{updateInfo.release_notes}</p>
                            </div>
                          )}

                          {downloadingUpdate ? (
                            <div className="space-y-2">
                              <div className="w-full bg-muted rounded-full h-2">
                                <div
                                  className="bg-white h-2 rounded-full transition-all duration-300"
                                  style={{ width: `${downloadProgress}%` }}
                                />
                              </div>
                              <p className="text-xs text-center text-muted-foreground">
                                Downloading... {downloadProgress.toFixed(0)}%
                              </p>
                            </div>
                          ) : (
                            <Button
                              onClick={handleDownloadAndInstall}
                              disabled={!updateInfo.download_url}
                              className="w-full gap-2 bg-white text-black hover:bg-gray-200"
                            >
                              <Download className="w-4 h-4" />
                              Download & Install
                            </Button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* What's New */}
                    <div className="p-4 rounded-xl bg-card border border-border">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-white/10">
                            <FileText className="w-5 h-5 text-white" />
                          </div>
                          <div>
                            <Label className="text-base font-medium">What's New</Label>
                            <p className="text-sm text-muted-foreground">
                              Version {CURRENT_APP_VERSION}
                            </p>
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            onOpenChange(false)
                            onViewUpdateNotes?.()
                          }}
                          className="gap-2"
                        >
                          <Eye className="w-4 h-4" />
                          View What's New
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                )}

                {/* Cloud Storage Section */}
                {activeSection === 'cloud' && (
                  <motion.div
                    key="cloud"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-6"
                  >
                    <GoogleDriveSettings />
                  </motion.div>
                )}

                {/* API Section */}
                {activeSection === 'api' && (
                  <motion.div
                    key="api"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-6"
                  >
                    <div>
                      <h3 className="text-lg font-semibold text-foreground mb-1">API Configuration</h3>
                      <p className="text-sm text-muted-foreground">Configure external service API keys</p>
                    </div>

                    {/* TMDB API Key Mode Selection */}
                    <div className="p-4 rounded-xl bg-card border border-border space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-white/10">
                          <Zap className="w-5 h-5 text-white" />
                        </div>
                        <div>
                          <Label className="text-base font-medium">TMDB API Key</Label>
                          <p className="text-sm text-muted-foreground">Used for metadata, posters, and streaming search</p>
                        </div>
                      </div>

                      {/* Option: Use Built-in */}
                      <button
                        type="button"
                        onClick={() => {
                          setUseOwnApiKey(false)
                          setConfig({ ...config, tmdb_api_key: "" })
                        }}
                        className={cn(
                          "w-full p-3 rounded-xl border text-left transition-all",
                          !useOwnApiKey
                            ? "border-white/30 bg-white/10"
                            : "border-border bg-card/50 hover:bg-card/80"
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <div className={cn(
                            "w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0",
                            !useOwnApiKey ? "border-white" : "border-muted-foreground"
                          )}>
                            {!useOwnApiKey && (
                              <div className="w-2 h-2 rounded-full bg-white" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">Use Built-in API Key</span>
                              <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/20 text-green-400 rounded">FREE</span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              No setup needed. Shared across all users, so it may hit rate limits during peak usage.
                            </p>
                          </div>
                        </div>
                      </button>

                      {/* Option: Use Your Own */}
                      <button
                        type="button"
                        onClick={() => setUseOwnApiKey(true)}
                        className={cn(
                          "w-full p-3 rounded-xl border text-left transition-all",
                          useOwnApiKey
                            ? "border-white/30 bg-white/10"
                            : "border-border bg-card/50 hover:bg-card/80"
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <div className={cn(
                            "w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0",
                            useOwnApiKey ? "border-white" : "border-muted-foreground"
                          )}>
                            {useOwnApiKey && (
                              <div className="w-2 h-2 rounded-full bg-white" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">Use Your Own API Key</span>
                              <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/20 text-blue-400 rounded">RECOMMENDED</span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Get your own free key for unlimited requests with no rate limits.
                            </p>
                          </div>
                        </div>
                      </button>

                      {/* Custom API Key Input - Only shown when "Use Your Own" is selected */}
                      {useOwnApiKey && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="space-y-3 pt-1"
                        >
                          <Input
                            type="password"
                            value={config.tmdb_api_key || ""}
                            onChange={(e) => setConfig({ ...config, tmdb_api_key: e.target.value })}
                            placeholder="Enter your TMDB API key or Access Token"
                          />
                          <p className="text-xs text-muted-foreground">
                            You can use either an <strong>API Key</strong> (v3 auth) or <strong>Access Token</strong> (v4 auth / Bearer token).{" "}
                            Get yours at{" "}
                            <a
                              href="https://www.themoviedb.org/settings/api"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-white hover:underline"
                            >
                              themoviedb.org
                            </a>
                          </p>
                        </motion.div>
                      )}
                    </div>
                  </motion.div>
                )}

                {/* Danger Section */}
                {activeSection === 'danger' && (
                  <motion.div
                    key="danger"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-6"
                  >
                    <div>
                      <h3 className="text-lg font-semibold text-foreground mb-1">Advanced Settings</h3>
                      <p className="text-sm text-muted-foreground">Danger zone - proceed with caution</p>
                    </div>

                    {/* Cleanup Missing Metadata */}
                    <div className="p-4 rounded-xl border border-gray-500/30 bg-gray-500/5 space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-gray-500/20">
                          <Trash2 className="w-5 h-5 text-gray-400" />
                        </div>
                        <div>
                          <Label className="text-base font-medium text-gray-400">Clean Up Missing Titles</Label>
                          <p className="text-sm text-muted-foreground">
                            Remove orphaned metadata and posters
                          </p>
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        This will remove database entries and cached posters for movies and TV shows
                        that no longer exist on disk. Useful for cleaning up after deleting files externally.
                      </p>
                      <Button
                        variant="outline"
                        onClick={handleCleanupMissing}
                        className="w-full border-gray-500/30 hover:bg-gray-500/10"
                        disabled={cleaningUp}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {cleaningUp ? "Cleaning up..." : "Clean Up Missing Titles"}
                      </Button>
                    </div>

                    {/* Reset App */}
                    <div className="p-4 rounded-xl border border-destructive/30 bg-destructive/5 space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-destructive/20">
                          <AlertTriangle className="w-5 h-5 text-destructive" />
                        </div>
                        <div>
                          <Label className="text-base font-medium text-destructive">Reset Application</Label>
                          <p className="text-sm text-muted-foreground">
                            Delete all data and start fresh
                          </p>
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        This will permanently delete your library data, watch history, streaming history,
                        cached posters, and all settings. This action cannot be undone.
                      </p>

                      {!showResetConfirm ? (
                        <Button
                          variant="destructive"
                          onClick={() => setShowResetConfirm(true)}
                          className="w-full"
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Reset App to Factory State
                        </Button>
                      ) : (
                        <div className="space-y-3 p-4 rounded-lg bg-destructive/10 border border-destructive/30">
                          <p className="text-sm font-medium text-destructive text-center">
                            Are you absolutely sure? This will delete everything!
                          </p>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              onClick={() => setShowResetConfirm(false)}
                              className="flex-1"
                              disabled={resetting}
                            >
                              Cancel
                            </Button>
                            <Button
                              variant="destructive"
                              onClick={handleResetApp}
                              className="flex-1"
                              disabled={resetting}
                            >
                              {resetting ? "Resetting..." : "Yes, Delete Everything"}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}

                {/* Developer Section - Only visible in dev mode */}
                {activeSection === 'dev' && isDev && (
                  <motion.div
                    key="dev"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-6"
                  >
                    <div>
                      <h3 className="text-lg font-semibold text-foreground mb-1">Developer Settings</h3>
                      <p className="text-sm text-muted-foreground">
                        These settings are only available in development mode
                      </p>
                    </div>

                    {/* Dev Mode Indicator */}
                    <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                      <div className="flex items-center gap-2 text-yellow-500">
                        <Code className="w-4 h-4" />
                        <span className="text-sm font-medium">Development Mode Active</span>
                      </div>
                      <p className="text-xs text-yellow-500/70 mt-1">
                        These options are hidden in production builds
                      </p>
                    </div>

                    {/* Backend URL Configuration */}
                    <div className="p-4 rounded-xl bg-card border border-border space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-purple-500/20">
                          <Zap className="w-5 h-5 text-purple-400" />
                        </div>
                        <div>
                          <Label className="text-base font-medium">Auth Server URL</Label>
                          <p className="text-sm text-muted-foreground">
                            Override the backend server URL for social features
                          </p>
                        </div>
                      </div>

                      <div className="space-y-3">
                        <Input
                          value={devAuthServerUrl}
                          onChange={(e) => setDevAuthServerUrl(e.target.value)}
                          placeholder="https://your-server.com"
                          className="font-mono text-sm"
                        />
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleResetDevSettings}
                            className="flex-1"
                          >
                            <RefreshCw className="w-4 h-4 mr-2" />
                            Reset to Default
                          </Button>
                          <Button
                            size="sm"
                            onClick={handleSaveDevSettings}
                            className="flex-1 bg-purple-600 hover:bg-purple-700"
                          >
                            <Save className="w-4 h-4 mr-2" />
                            Apply URL
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Default: {getDefaultAuthServerUrl()}
                        </p>
                      </div>
                    </div>

                    {/* Quick Actions */}
                    <div className="p-4 rounded-xl bg-card border border-border space-y-3">
                      <Label className="text-base font-medium">Quick Actions</Label>
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setDevAuthServerUrl("http://localhost:3000")
                            setDevSettings({ authServerUrl: "http://localhost:3000" })
                            toast({ title: "Set to localhost:3000" })
                          }}
                        >
                          Use localhost:3000
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setDevAuthServerUrl("http://localhost:8080")
                            setDevSettings({ authServerUrl: "http://localhost:8080" })
                            toast({ title: "Set to localhost:8080" })
                          }}
                        >
                          Use localhost:8080
                        </Button>
                      </div>
                    </div>

                    {/* MPV Auto-Detection */}
                    <div className="p-4 rounded-xl bg-card border border-border space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-green-500/20">
                          <MonitorPlay className="w-5 h-5 text-green-400" />
                        </div>
                        <div>
                          <Label className="text-base font-medium">MPV Auto-Detection</Label>
                          <p className="text-sm text-muted-foreground">
                            Search the entire PC for mpv.exe
                          </p>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Searches common installation paths (Program Files, Scoop, Chocolatey, etc.)
                        and the system PATH for mpv.exe. If found, it will be automatically configured.
                      </p>
                      {config.mpv_path && (
                        <div className="p-2 rounded-lg bg-muted/50 text-xs font-mono text-muted-foreground truncate">
                          Current: {config.mpv_path}
                        </div>
                      )}
                      <Button
                        variant="outline"
                        onClick={handleAutoDetectMpv}
                        disabled={detectingMpv}
                        className="w-full gap-2 border-green-500/30 hover:bg-green-500/10"
                      >
                        <MonitorPlay className={cn("w-4 h-4", detectingMpv && "animate-pulse")} />
                        {detectingMpv ? "Searching PC..." : "Auto-Detect MPV"}
                      </Button>
                    </div>

                    {/* Simulate Update Notification */}
                    <div className="p-4 rounded-xl bg-card border border-violet-500/30 space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-violet-500/20">
                          <Download className="w-5 h-5 text-violet-400" />
                        </div>
                        <div>
                          <Label className="text-base font-medium">Simulate Update</Label>
                          <p className="text-sm text-muted-foreground">
                            Trigger a fake update notification to test the flow
                          </p>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        This will show the in-app update notification banner with fake data so you can test the full update workflow without a real update being available.
                      </p>
                      <Button
                        variant="outline"
                        onClick={() => {
                          if (onSimulateUpdate) {
                            onSimulateUpdate()
                            onOpenChange(false)
                          }
                        }}
                        className="w-full gap-2 border-violet-500/30 hover:bg-violet-500/10 text-violet-400 hover:text-violet-300"
                      >
                        <Download className="w-4 h-4" />
                        Simulate Update Notification
                      </Button>
                    </div>

                    {/* Logout Button for Testing */}
                    <div className="p-4 rounded-xl bg-card border border-red-500/30 space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-red-500/20">
                          <Power className="w-5 h-5 text-red-400" />
                        </div>
                        <div>
                          <Label className="text-base font-medium">Test Login Screen</Label>
                          <p className="text-sm text-muted-foreground">
                            Sign out to test the login screen
                          </p>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        This will sign you out and show the login screen. You'll need to sign in again with Google.
                      </p>
                      <Button
                        variant="outline"
                        onClick={() => {
                          if (onLogout) {
                            onLogout()
                            onOpenChange(false)
                          }
                        }}
                        className="w-full gap-2 border-red-500/30 hover:bg-red-500/10 text-red-400 hover:text-red-300"
                      >
                        <Power className="w-4 h-4" />
                        Sign Out (Test Login Screen)
                      </Button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Footer - Always visible at bottom */}
        <div className="flex-shrink-0 p-3 sm:p-4 border-t border-border bg-card/50">
          <div className="flex justify-end gap-2 sm:gap-3">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={loading} className="gap-2">
              <Save className="w-4 h-4" />
              {loading ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
