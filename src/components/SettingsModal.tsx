import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Trash2,
  MonitorPlay,
  FolderOpen,
  AlertTriangle,
  Settings,
  Key,
  Zap,
  Power,
  X,
  Save,
  Sparkles,
  Cloud,
  Download,
  RefreshCw,
  Code,
  FlaskConical,
  Radio,
  Shield,
  Archive,
  Loader2,
} from "lucide-react";
import {
  Config,
  getConfig,
  saveConfig,
  clearAllAppData,
  TabVisibility,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  getAppVersion,
  UpdateInfo,
  autoDetectMpv,
} from "@/services/api";

import { useToast } from "@/components/ui/use-toast";
import { open as openDialog } from "@tauri-apps/api/dialog";
import { invoke } from "@tauri-apps/api/tauri";
import { Switch } from "@/components/ui/switch";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { GoogleDriveSettings } from "@/components/GoogleDriveSettings";
import { ZipGuideModal } from "@/components/ZipGuideModal";

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestartOnboarding?: () => void;
  initialTab?: SettingsSection;
  tabVisibility?: TabVisibility;
  onTabVisibilityChange?: (visibility: TabVisibility) => void;
  onLogout?: () => void;
  betaEnabled?: boolean;
  onBetaToggle?: (enabled: boolean) => void;
  autoCheckUpdate?: boolean;
  onSimulateUpdate?: () => void;
}

type SettingsSection =
  | "general"
  | "account"
  | "beta"
  | "updates"
  | "cloud"
  | "api"
  | "danger"
  | "dev";

export function SettingsModal({
  open,
  onOpenChange,
  onRestartOnboarding,
  initialTab,
  tabVisibility: _tabVisibility,
  onTabVisibilityChange: _onTabVisibilityChange,
  onLogout,
  betaEnabled = false,
  onBetaToggle,
  autoCheckUpdate = false,
  onSimulateUpdate,
}: SettingsModalProps) {
  const [config, setConfig] = useState<Config>({
    mpv_path: "",
    vlc_path: "",
    ffprobe_path: "",
    ffmpeg_path: "",
    tmdb_api_key: "",
    cloud_cache_enabled: false,
    cloud_cache_dir: "",
    cloud_cache_max_mb: 1024,
    cloud_cache_expiry_hours: 24,
    zip_indexing_enabled: true,
    zip_cache_dir: "",
    zip_cache_max_gb: 20,
    zip_cache_expiry_days: 7,
    dev_backend_url: "",
  });
  const [loading, setLoading] = useState(false);
  const [autoStart, setAutoStart] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [activeSection, setActiveSection] =
    useState<SettingsSection>("general");
  const [appVersion, setAppVersion] = useState<string>("");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [downloadingUpdate, setDownloadingUpdate] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [detectingMpv, setDetectingMpv] = useState(false);
  const [useOwnApiKey, setUseOwnApiKey] = useState(false);
  const [showZipGuide, setShowZipGuide] = useState(false);
  const [pathValidation, setPathValidation] = useState<Record<string, string>>({});
  const { toast } = useToast();

  const validatePath = useCallback((path: string, label: string) => {
    if (!path) {
      setPathValidation(prev => ({ ...prev, [label]: "" }));
      return;
    }
    if (path.includes("..") || path.includes("~")) {
      setPathValidation(prev => ({ ...prev, [label]: "Path contains relative segments" }));
    } else if (path.length > 260) {
      setPathValidation(prev => ({ ...prev, [label]: "Path too long" }));
    } else {
      setPathValidation(prev => ({ ...prev, [label]: "" }));
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadConfig();
      checkAutoStart();
      loadAppVersion();
      setActiveSection(initialTab || "general");
      setShowResetConfirm(false);
    }
  }, [open, initialTab]);

  // Auto-trigger update check when navigated from update notification
  useEffect(() => {
    if (open && autoCheckUpdate && activeSection === "updates") {
      handleCheckUpdate();
    }
  }, [open, autoCheckUpdate]);

  const loadAppVersion = async () => {
    try {
      const version = await getAppVersion();
      setAppVersion(version);
    } catch (error) {
      console.error("Failed to load app version", error);
    }
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateInfo(null);
    try {
      const info = await checkForUpdates();
      setUpdateInfo(info);
      if (!info.available) {
        toast({
          title: "Up to Date",
          description: `You're running the latest version (${info.current_version})`,
        });
      }
    } catch (error) {
      console.error("Failed to check for updates", error);
      const description =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : String(error);
      toast({
        title: "Error",
        description,
        variant: "destructive",
      });
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleDownloadAndInstall = async () => {
    if (!updateInfo?.download_url) return;

    setDownloadingUpdate(true);
    setDownloadProgress(0);
    try {
      // Listen for download progress events
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<{ progress: number }>(
        "update-download-progress",
        (event) => {
          setDownloadProgress(event.payload.progress);
        },
      );

      const installerPath = await downloadUpdate(updateInfo.download_url);
      unlisten();

      toast({
        title: "Download Complete",
        description: "Installing update and restarting...",
      });

      // Small delay to show the toast
      await new Promise((resolve) => setTimeout(resolve, 1000));

      await installUpdate(installerPath);
    } catch (error) {
      console.error("Failed to download/install update", error);
      const description =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : String(error);
      toast({
        title: "Error",
        description,
        variant: "destructive",
      });
    } finally {
      setDownloadingUpdate(false);
      setDownloadProgress(0);
    }
  };

  const checkAutoStart = async () => {
    try {
      const enabled = await invoke<boolean>("plugin:autostart|is_enabled");
      setAutoStart(enabled);
    } catch (error) {
      console.error("Failed to check autostart", error);
    }
  };

  const toggleAutoStart = async (checked: boolean) => {
    try {
      if (checked) {
        await invoke("plugin:autostart|enable");
        toast({
          title: "Auto Startup Enabled",
          description: "SlasshyVault will now start automatically.",
        });
      } else {
        await invoke("plugin:autostart|disable");
        toast({
          title: "Auto Startup Disabled",
          description: "SlasshyVault will not start automatically.",
        });
      }
      setAutoStart(checked);
    } catch (error) {
      console.error("Failed to toggle autostart", error);
      toast({
        title: "Error",
        description: "Failed to update startup settings",
        variant: "destructive",
      });
    }
  };

  const loadConfig = async () => {
    try {
      const data = await getConfig();
      setConfig({
        mpv_path: data.mpv_path || "",
        vlc_path: data.vlc_path || "",
        ffprobe_path: data.ffprobe_path || "",
        ffmpeg_path: data.ffmpeg_path || "",
        tmdb_api_key: data.tmdb_api_key || "",
        cloud_cache_enabled: data.cloud_cache_enabled ?? false,
        cloud_cache_dir: data.cloud_cache_dir || "",
        cloud_cache_max_mb: data.cloud_cache_max_mb ?? 1024,
        cloud_cache_expiry_hours: data.cloud_cache_expiry_hours ?? 24,
        zip_indexing_enabled: data.zip_indexing_enabled ?? true,
        zip_cache_dir: data.zip_cache_dir || "",
        zip_cache_max_gb: data.zip_cache_max_gb ?? 20,
        zip_cache_expiry_days: data.zip_cache_expiry_days ?? 7,
        dev_backend_url: data.dev_backend_url || "",
      });
      // If user already has a custom API key saved, show the custom input
      setUseOwnApiKey(!!data.tmdb_api_key);
    } catch (error) {
      console.error("Failed to load config", error);
      toast({
        title: "Error",
        description: "Failed to load configuration",
        variant: "destructive",
      });
    }
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      await saveConfig(config);
      toast({ title: "Success", description: "Settings saved successfully" });
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to save config", error);
      toast({
        title: "Error",
        description: "Failed to save settings",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleResetApp = async () => {
    setResetting(true);
    try {
      await clearAllAppData();
      setShowResetConfirm(false);
      onOpenChange(false);
      toast({
        title: "App Reset Complete",
        description: "All data has been cleared. Please restart the app for changes to take effect.",
      });
    } catch (error) {
      console.error("Failed to reset app", error);
      toast({
        title: "Error",
        description: "Failed to reset app data",
        variant: "destructive",
      });
    } finally {
      setResetting(false);
    }
  };

  const browseMpvPath = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Executable", extensions: ["exe"] }],
        title: "Select MPV Executable",
      });
      if (selected && typeof selected === "string") {
        setConfig({ ...config, mpv_path: selected });
      }
    } catch (error) {
      console.error("Failed to open file dialog", error);
    }
  };

  const browseZipCacheDir = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Select ZIP Cache Directory",
      });
      if (selected && typeof selected === "string") {
        setConfig({ ...config, zip_cache_dir: selected });
      }
    } catch (error) {
      console.error("Failed to open directory dialog", error);
    }
  };

  const handleAutoDetectMpv = async () => {
    setDetectingMpv(true);
    try {
      const foundPath = await autoDetectMpv();
      if (foundPath) {
        setConfig({ ...config, mpv_path: foundPath });
        toast({
          title: "MPV Found",
          description: `Detected at: ${foundPath}`,
        });
      } else {
        toast({
          title: "MPV Not Found",
          description:
            "Could not find mpv.exe on your system. Please install MPV or set the path manually.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Failed to auto-detect MPV:", error);
      toast({
        title: "Detection Failed",
        description: "An error occurred while searching for MPV.",
        variant: "destructive",
      });
    } finally {
      setDetectingMpv(false);
    }
  };

  const sections: {
    id: SettingsSection;
    label: string;
    icon: React.ReactNode;
  }[] = [
    { id: "general", label: "General", icon: <Settings className="w-4 h-4" /> },
    {
      id: "account",
      label: "Account",
      icon: <Power className="w-4 h-4" />,
    },
    {
      id: "updates",
      label: "Updates",
      icon: <Shield className="w-4 h-4" />,
    },
    {
      id: "cloud",
      label: "Cache & Storage",
      icon: <Cloud className="w-4 h-4" />,
    },
    { id: "api", label: "API Keys", icon: <Key className="w-4 h-4" /> },
    {
      id: "danger",
      label: "Factory Reset",
      icon: <AlertTriangle className="w-4 h-4" />,
    },
    { id: "beta", label: "Beta", icon: <FlaskConical className="w-4 h-4" /> },
    ...(import.meta.env.DEV
      ? [{ id: "dev" as SettingsSection, label: "Dev", icon: <Code className="w-4 h-4" /> }]
      : []),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <>
        <DialogContent className="!flex max-w-4xl max-h-[85vh] p-0 gap-0 flex-col overflow-hidden pr-14">
          <div className="flex flex-1 min-h-0">
            {/* Sidebar */}
            <div className="w-40 sm:w-48 md:w-56 flex-shrink-0 bg-card/50 border-r border-border p-3 sm:p-4 overflow-y-auto">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-foreground">
                  Settings
                </h2>
                <button
                  onClick={() => onOpenChange(false)}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  aria-label="Close settings"
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
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                    )}
                    aria-label={`${section.label} settings section`}
                  >
                    {section.icon}
                    <span className="text-xs sm:text-sm font-medium truncate">
                      {section.label}
                    </span>
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
                  {/* ===== General Settings ===== */}
                  {activeSection === "general" && (
                    <motion.div
                      key="general"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="space-y-6"
                    >
                      <div>
                        <h3 className="text-lg font-semibold text-foreground mb-1">
                          General Settings
                        </h3>
                        <p className="text-sm text-muted-foreground">
                          Configure general app behavior
                        </p>
                      </div>

                      {/* Auto Start */}
                      <div className="p-4 rounded-xl bg-card border border-border">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-white/10">
                              <Power className="w-5 h-5 text-white" />
                            </div>
                            <div>
                              <Label className="text-base font-medium">
                                Run on Startup
                              </Label>
                              <p className="text-sm text-muted-foreground">
                                Automatically start SlasshyVault when you log in
                              </p>
                            </div>
                          </div>
                          <Switch
                            checked={autoStart}
                            onCheckedChange={toggleAutoStart}
                          />
                        </div>
                      </div>

                      {/* MPV Path */}
                      <div className="p-4 rounded-xl bg-card border border-border space-y-3">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-white/10">
                            <MonitorPlay className="w-5 h-5 text-white" />
                          </div>
                          <div>
                            <Label className="text-base font-medium">
                              MPV Executable Path
                            </Label>
                            <p className="text-sm text-muted-foreground">
                              Required for video playback
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <div className="flex-1 relative">
                            <Input
                              value={config.mpv_path || ""}
                              onChange={(e) => {
                                setConfig({ ...config, mpv_path: e.target.value });
                                validatePath(e.target.value, "mpv_path");
                              }}
                              placeholder="C:\path\to\mpv.exe"
                              className="flex-1"
                              aria-label="MPV executable path"
                              aria-invalid={!!pathValidation.mpv_path}
                            />
                            {pathValidation.mpv_path && (
                              <p className="text-xs text-destructive mt-1">{pathValidation.mpv_path}</p>
                            )}
                          </div>
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={browseMpvPath}
                            title="Browse"
                            aria-label="Browse for MPV executable"
                          >
                            <FolderOpen className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="outline"
                            onClick={handleAutoDetectMpv}
                            disabled={detectingMpv}
                            className="gap-2"
                            title="Auto-detect MPV on your PC"
                            aria-label="Auto-detect MPV on your PC"
                          >
                            <RefreshCw
                              className={cn(
                                "w-4 h-4",
                                detectingMpv && "animate-spin",
                              )}
                            />
                            {detectingMpv ? "Detecting..." : "Detect"}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Download MPV from mpv.io if not installed
                        </p>
                      </div>

                      {/* Onboarding Overview */}
                      <div className="p-4 rounded-xl bg-card border border-border">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-white/10">
                              <Sparkles className="w-5 h-5 text-white" />
                            </div>
                            <div>
                              <Label className="text-base font-medium">
                                Onboarding Overview
                              </Label>
                              <p className="text-sm text-muted-foreground">
                                Experience the full app introduction again
                              </p>
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              onOpenChange(false);
                              onRestartOnboarding?.();
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

                  {/* ===== Beta Features ===== */}
                  {activeSection === "beta" && (
                    <motion.div
                      key="beta"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="space-y-6"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-semibold text-foreground mb-1">
                            Experimental Features
                          </h3>
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-purple-500/20 text-purple-400 rounded-full">
                            EXPERIMENTAL
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Beta features are testable. Unstable features may be incomplete, paused, or not usable yet.
                        </p>
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
                                <Label className="text-base font-medium">
                                  Enable Beta Features
                                </Label>
                                <span
                                  className={cn(
                                    "px-1.5 py-0.5 text-[10px] font-semibold rounded",
                                    betaEnabled
                                      ? "bg-green-500/20 text-green-400"
                                      : "bg-muted text-muted-foreground",
                                  )}
                                >
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
                                // TODO: Replace browser confirm() with custom modal
                                const confirmed = window.confirm(
                                  "Beta Features Warning\n\n" +
                                    "These features are experimental and for public testing only:\n\n" +
                                    "\u2022 Watch Together - Watch with friends in sync\n" +
                                    "\u2022 Social Features - Friends, chat, activity feed\n\n" +
                                    "These features may not work properly, may have bugs, " +
                                    "and could stop working at any time.\n\n" +
                                    "Do you want to enable beta features?",
                                );
                                if (confirmed) {
                                  onBetaToggle?.(true);
                                }
                              } else {
                                onBetaToggle?.(false);
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
                            <p className="text-xs font-medium text-yellow-500">
                              Heads up
                            </p>
                            <p className="text-xs text-yellow-500/70">
                              Beta features are meant for public testing.
                              Unstable features are earlier than beta and may be
                              paused, incomplete, or unavailable at any time.
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Feature List */}
                      <div className="space-y-3">
                        <Label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                          Beta Features
                        </Label>
                        {/* Watch Together */}
                        <div
                          className={cn(
                            "p-4 rounded-xl border transition-colors",
                            betaEnabled
                              ? "bg-card border-purple-500/20"
                              : "bg-card/50 border-border opacity-60",
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <div
                              className={cn(
                                "p-2 rounded-lg flex-shrink-0",
                                betaEnabled ? "bg-purple-500/20" : "bg-muted",
                              )}
                            >
                              <Radio
                                className={cn(
                                  "w-5 h-5",
                                  betaEnabled
                                    ? "text-purple-400"
                                    : "text-muted-foreground",
                                )}
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-sm font-medium">
                                  Watch Together
                                </span>
                                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-purple-500/20 text-purple-400 rounded">
                                  BETA
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Watch movies and shows in sync with friends.
                                Create or join rooms for synchronized playback.
                              </p>
                            </div>
                          </div>
                        </div>

                      </div>

                    </motion.div>
                  )}

                  {/* ===== Account ===== */}
                  {activeSection === "account" && (
                    <motion.div
                      key="account"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="space-y-6"
                    >
                      <div>
                        <h3 className="text-lg font-semibold text-foreground mb-1">
                          Account
                        </h3>
                        <p className="text-sm text-muted-foreground">
                          Manage your Google account connection
                        </p>
                      </div>

                      {/* Google Drive connection card */}
                      <GoogleDriveSettings />

                      {/* Logout */}
                      <div className="p-4 rounded-xl bg-card border border-red-500/30 space-y-4">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-red-500/20">
                            <Power className="w-5 h-5 text-red-400" />
                          </div>
                          <div>
                            <p className="text-base font-medium">
                              Sign Out
                            </p>
                            <p className="text-sm text-muted-foreground">
                              Disconnect your Google account and clear all stored data
                            </p>
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          This will sign you out of SlasshyVault, disconnect your Google Drive,
                          and clear all locally stored tokens. You'll need to sign in again
                          to access your library.
                        </p>

                        {!showLogoutConfirm ? (
                          <Button
                            variant="destructive"
                            onClick={() => setShowLogoutConfirm(true)}
                            className="w-full"
                          >
                            <Power className="mr-2 h-4 w-4" />
                            Sign Out
                          </Button>
                        ) : (
                          <div className="space-y-3 p-4 rounded-lg bg-destructive/10 border border-destructive/30">
                            <p className="text-sm font-medium text-destructive text-center">
                              Are you sure you want to sign out? This will clear all
                              locally stored credentials.
                            </p>
                            <div className="flex gap-2">
                              <Button
                                variant="outline"
                                onClick={() => setShowLogoutConfirm(false)}
                                className="flex-1"
                                disabled={loggingOut}
                              >
                                Cancel
                              </Button>
                              <Button
                                variant="destructive"
                                onClick={async () => {
                                  setLoggingOut(true)
                                  try {
                                    if (onLogout) {
                                      onLogout()
                                      onOpenChange(false)
                                    }
                                  } finally {
                                    setLoggingOut(false)
                                    setShowLogoutConfirm(false)
                                  }
                                }}
                                className="flex-1"
                                disabled={loggingOut}
                              >
                                {loggingOut ? (
                                  <>
                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                    Signing Out...
                                  </>
                                ) : (
                                  "Yes, Sign Out"
                                )}
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}

                  {/* ===== Updates & Security ===== */}
                  {activeSection === "updates" && (
                    <motion.div
                      key="updates"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="space-y-6"
                    >
                      <div>
                        <h3 className="text-lg font-semibold text-foreground mb-1">
                          Updates & Security
                        </h3>
                        <p className="text-sm text-muted-foreground">
                          App updates, what's new, and version info
                        </p>
                      </div>

                      {/* About & Updates */}
                      <div className="p-4 rounded-xl bg-card border border-border space-y-4">
                        <div className="flex items-center gap-3 mb-2">
                          <div className="p-2 rounded-lg bg-white/10">
                            <Download className="w-5 h-5 text-white" />
                          </div>
                          <div>
                            <Label className="text-base font-medium">
                              About & Updates
                            </Label>
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
                            <RefreshCw
                              className={cn(
                                "w-4 h-4",
                                checkingUpdate && "animate-spin",
                              )}
                            />
                            {checkingUpdate
                              ? "Checking..."
                              : "Check for Updates"}
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
                                  {new Date(
                                    updateInfo.published_at,
                                  ).toLocaleDateString()}
                                </span>
                              )}
                            </div>

                            {updateInfo.release_notes && (
                              <div className="text-xs text-muted-foreground max-h-24 overflow-y-auto">
                                <p className="whitespace-pre-wrap">
                                  {updateInfo.release_notes}
                                </p>
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
                    </motion.div>
                  )}

                  {/* ===== Cache and Storage ===== */}
                  {activeSection === "cloud" && (
                    <motion.div
                      key="cloud"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="space-y-6"
                    >
                      <div className="p-4 rounded-xl bg-card border border-border space-y-4">
                        <div className="flex items-start gap-3">
                          <div className="p-2 rounded-lg bg-white/10">
                            <Archive className="w-5 h-5 text-white" />
                          </div>
                          <div className="flex-1">
                            <Label className="text-base font-medium">
                              ZIP Archive Support
                            </Label>
                            <p className="text-sm text-muted-foreground">
                              Index TV episodes directly from Google Drive ZIP
                              archives and keep extracted playback cache under
                              control.
                            </p>
                          </div>
                          <Switch
                            checked={config.zip_indexing_enabled ?? true}
                            onCheckedChange={(checked) =>
                              setConfig({
                                ...config,
                                zip_indexing_enabled: checked,
                              })
                            }
                          />
                        </div>

                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="space-y-2 md:col-span-2">
                            <Label>ZIP Cache Directory</Label>
                            <div className="flex gap-2">
                              <Input
                                value={config.zip_cache_dir || ""}
                                onChange={(e) =>
                                  setConfig({
                                    ...config,
                                    zip_cache_dir: e.target.value,
                                  })
                                }
                                placeholder="Default app cache location"
                                className="flex-1"
                              />
                              <Button
                                variant="outline"
                                size="icon"
                                onClick={browseZipCacheDir}
                                title="Browse"
                              >
                                <FolderOpen className="h-4 w-4" />
                              </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Pick a different drive if you want ZIP extraction
                              cache stored outside the default app data folder.
                            </p>
                          </div>

                          <div className="space-y-2">
                            <Label>ZIP Cache Size Limit (GB)</Label>
                            <Input
                              type="number"
                              min={1}
                              max={500}
                              value={config.zip_cache_max_gb ?? 20}
                              onChange={(e) =>
                                setConfig({
                                  ...config,
                                  zip_cache_max_gb: Math.max(
                                    1,
                                    Number(e.target.value) || 1,
                                  ),
                                })
                              }
                            />
                            <p className="text-xs text-muted-foreground">
                              Older ZIP cache files will be replaced first when
                              the limit is reached.
                            </p>
                          </div>

                          <div className="space-y-2">
                            <Label>ZIP Cache Expiry (Days)</Label>
                            <Input
                              type="number"
                              min={1}
                              max={365}
                              value={config.zip_cache_expiry_days ?? 7}
                              onChange={(e) =>
                                setConfig({
                                  ...config,
                                  zip_cache_expiry_days: Math.max(
                                    1,
                                    Number(e.target.value) || 1,
                                  ),
                                })
                              }
                            />
                            <p className="text-xs text-muted-foreground">
                              Unused ZIP cache files older than this will be
                              removed automatically.
                            </p>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {/* ===== API Configuration ===== */}
                  {activeSection === "api" && (
                    <motion.div
                      key="api"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="space-y-6"
                    >
                      <div>
                        <h3 className="text-lg font-semibold text-foreground mb-1">
                          API Configuration
                        </h3>
                        <p className="text-sm text-muted-foreground">
                          Configure external service API keys
                        </p>
                      </div>

                      {/* TMDB API Key Mode Selection */}
                      <div className="p-4 rounded-xl bg-card border border-border space-y-4">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-white/10">
                            <Zap className="w-5 h-5 text-white" />
                          </div>
                          <div>
                            <Label className="text-base font-medium">
                              TMDB API Key
                            </Label>
                            <p className="text-sm text-muted-foreground">
                              Used for metadata, posters, and search
                            </p>
                          </div>
                        </div>

                        {/* Option: Use Built-in */}
                        <button
                          type="button"
                          onClick={() => {
                            setUseOwnApiKey(false);
                            setConfig({ ...config, tmdb_api_key: "" });
                          }}
                          className={cn(
                            "w-full p-3 rounded-xl border text-left transition-all",
                            !useOwnApiKey
                              ? "border-white/30 bg-white/10"
                              : "border-border bg-card/50 hover:bg-card/80",
                          )}
                        >
                          <div className="flex items-center gap-3">
                            <div
                              className={cn(
                                "w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0",
                                !useOwnApiKey
                                  ? "border-white"
                                  : "border-muted-foreground",
                              )}
                            >
                              {!useOwnApiKey && (
                                <div className="w-2 h-2 rounded-full bg-white" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium">
                                  Use Built-in API Key
                                </span>
                                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/20 text-green-400 rounded">
                                  FREE
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                No setup needed. Shared across all users, so it
                                may hit rate limits during peak usage.
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
                              : "border-border bg-card/50 hover:bg-card/80",
                          )}
                        >
                          <div className="flex items-center gap-3">
                            <div
                              className={cn(
                                "w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0",
                                useOwnApiKey
                                  ? "border-white"
                                  : "border-muted-foreground",
                              )}
                            >
                              {useOwnApiKey && (
                                <div className="w-2 h-2 rounded-full bg-white" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium">
                                  Use Your Own API Key
                                </span>
                                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/20 text-blue-400 rounded">
                                  RECOMMENDED
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                Get your own free key for unlimited requests
                                with no rate limits.
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
                              onChange={(e) =>
                                setConfig({
                                  ...config,
                                  tmdb_api_key: e.target.value,
                                })
                              }
                              placeholder="Enter your TMDB API key or Access Token"
                            />
                            <p className="text-xs text-muted-foreground">
                              You can use either an <strong>API Key</strong> (v3
                              auth) or <strong>Access Token</strong> (v4 auth /
                              Bearer token). Get yours at{" "}
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

                  {/* ===== Dev Panel (only shown in dev mode) ===== */}
                  {import.meta.env.DEV && activeSection === "dev" && (
                    <motion.div
                      key="dev"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="space-y-6"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-semibold text-foreground mb-1">
                            Dev Panel
                          </h3>
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/20 text-yellow-400 rounded-full">
                            DEV ONLY
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Override the backend URL for local development. Auth,
                          TMDB proxy, and WebSocket URLs are derived from this.
                        </p>
                      </div>

                      {/* Backend URL */}
                      <div className="p-4 rounded-xl bg-card border border-yellow-500/30 space-y-3">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-yellow-500/20">
                            <Code className="w-5 h-5 text-yellow-400" />
                          </div>
                          <div>
                            <Label className="text-base font-medium">
                              Backend URL
                            </Label>
                            <p className="text-sm text-muted-foreground">
                              Points to SlasshyVault-Backend/server.js
                            </p>
                          </div>
                        </div>
                        <Input
                          value={config.dev_backend_url || ""}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              dev_backend_url: e.target.value,
                            })
                          }
                          placeholder="https://slasshyvault.onrender.com"
                          className="font-mono text-xs"
                        />
                        <p className="text-xs text-muted-foreground">
                          Default: https://slasshyvault.onrender.com · Local: http://localhost:3001
                        </p>
                      </div>

                      {/* Derived URLs hint */}
                      <div className="p-3 rounded-lg bg-muted/50 border border-border space-y-1">
                        <p className="text-xs font-medium text-muted-foreground">
                          Derived endpoints:
                        </p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {config.dev_backend_url || "https://slasshyvault.onrender.com"}/auth/...
                        </p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {config.dev_backend_url || "https://slasshyvault.onrender.com"}/api/tmdb
                        </p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {(config.dev_backend_url || "https://slasshyvault.onrender.com")
                            .replace("https://", "wss://")
                            .replace("http://", "ws://")}
                          /ws/watchtogether
                        </p>
                      </div>

                      {/* Reset hint */}
                      <div className="p-3 rounded-lg bg-muted/50 border border-border">
                        <p className="text-xs text-muted-foreground">
                          Leave empty and save to use production defaults.
                        </p>
                      </div>
                    </motion.div>
                  )}

                  {/* ===== Factory Reset (Danger Zone) ===== */}
                  {activeSection === "danger" && (
                    <motion.div
                      key="danger"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="space-y-6"
                    >
                      <div>
                        <h3 className="text-lg font-semibold text-foreground mb-1">
                          Factory Reset
                        </h3>
                        <p className="text-sm text-muted-foreground">
                          Danger zone - proceed with caution
                        </p>
                      </div>


                      {/* Reset App */}
                      <div className="p-4 rounded-xl border border-destructive/30 bg-destructive/5 space-y-4">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-destructive/20">
                            <AlertTriangle className="w-5 h-5 text-destructive" />
                          </div>
                          <div>
                            <Label className="text-base font-medium text-destructive">
                              Reset Application
                            </Label>
                            <p className="text-sm text-muted-foreground">
                              Delete all data and start fresh
                            </p>
                          </div>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          This will permanently delete your library data and
                          watch history, cached posters, and all settings. This
                          action cannot be undone.
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
                              Are you absolutely sure? This will delete
                              everything!
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
                                {resetting
                                  ? "Resetting..."
                                  : "Yes, Delete Everything"}
                              </Button>
                            </div>
                          </div>
                        )}
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={loading}
                className="gap-2"
              >
                <Save className="w-4 h-4" />
                {loading ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </DialogContent>
        <ZipGuideModal open={showZipGuide} onOpenChange={setShowZipGuide} />
      </>
    </Dialog>
  );
}
