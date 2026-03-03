import { cn } from "@/lib/utils"
import {
  History, Settings,
  Globe, Home, RotateCw, Cloud, Users, Sparkles, Bot
} from "lucide-react"
import { motion } from "framer-motion"
import { useState, useEffect } from "react"
import { isGDriveConnected, getGDriveAccountInfo, DriveAccountInfo, formatStorageSize } from "@/services/gdrive"

interface SidebarProps {
  className?: string
  currentView: string
  setView: (view: string) => void
  onOpenSettings: () => void
  onCloudScan?: () => void
  theme?: 'dark' | 'light'
  toggleTheme?: () => void
  isScanning?: boolean
  isCloudIndexing?: boolean
  scanProgress?: {
    current: number
    total: number
  } | null
  showCloudTab?: boolean
  betaEnabled?: boolean
}

export function Sidebar({
  className,
  currentView,
  setView,
  onOpenSettings,
  onCloudScan,
  isScanning = false,
  isCloudIndexing = false,
  showCloudTab = true,
  betaEnabled = false,
}: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [gdriveConnected, setGdriveConnected] = useState(false);
  const [gdriveInfo, setGdriveInfo] = useState<DriveAccountInfo | null>(null);

  // Fetch Google Drive info
  useEffect(() => {
    const fetchGdriveInfo = async () => {
      const connected = await isGDriveConnected();
      setGdriveConnected(connected);
      if (connected) {
        const info = await getGDriveAccountInfo();
        setGdriveInfo(info);
      }
    };
    fetchGdriveInfo();
    const interval = setInterval(fetchGdriveInfo, 60000);
    return () => clearInterval(interval);
  }, []);

  // Responsive sidebar
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 800) {
        setIsCollapsed(true);
        setSidebarWidth(68);
      } else if (window.innerWidth < 1100) {
        setIsCollapsed(false);
        setSidebarWidth(240);
      } else {
        setIsCollapsed(false);
        setSidebarWidth(280);
      }
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const menuItems = [
    { id: "home", label: "Home", icon: Home },
    { id: "cloud", label: "Google Drive", icon: Cloud, hidden: !showCloudTab },
    { id: "stream", label: "Discover", icon: Globe },
    { id: "ai", label: "AI Chat", icon: Bot, hidden: !betaEnabled, isNew: true },
    { id: "social", label: "Social", icon: Users, hidden: !betaEnabled },
    { id: "history", label: "History", icon: History },
  ].filter(item => !item.hidden);

  return (
    <motion.aside
      className={cn(
        "h-screen flex flex-col relative z-50",
        "bg-[#0D0D0D]/80 backdrop-blur-2xl",
        "border-r border-white/[0.05] shadow-2xl",
        className
      )}
      animate={{ width: sidebarWidth }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Glossy Overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-white/[0.02] to-transparent pointer-events-none" />

      <div className={cn("flex-1 px-4 pt-14 pb-3 flex flex-col", isCollapsed ? "px-2 pt-12" : "")}>
        {/* Navigation Items (Middle) */}
        <div className="flex-1 flex items-center">
          <nav className="w-full space-y-2 overflow-y-auto overflow-x-hidden custom-scrollbar max-h-[45vh]">
            {menuItems.map((item) => {
              const isActive = currentView === item.id;

              return (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  className={cn(
                    "group relative w-full flex items-center gap-3.5 px-4 py-3 rounded-xl transition-colors duration-300",
                    isActive
                      ? "bg-white/[0.08] text-white shadow-[0_0_20px_rgba(255,255,255,0.05)] border border-white/10"
                      : "text-neutral-500 hover:text-neutral-200 hover:bg-white/[0.03]",
                    isCollapsed ? "justify-center px-0" : ""
                  )}
                >
                  {/* Active Indicator & Glow */}
                  {isActive && (
                    <>
                      <motion.div
                        layoutId="active-glow"
                        className="absolute inset-0 rounded-xl bg-white/5 blur-md"
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                      />
                      <motion.div
                        layoutId="active-pill"
                        className="absolute left-0 inset-y-0 my-auto w-1 h-6 bg-white rounded-r-full shadow-[0_0_15px_rgba(255,255,255,0.5)]"
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                      />
                    </>
                  )}

                  <div className="relative">
                    <item.icon className={cn(
                      "w-5 h-5 transition-all duration-300",
                      isActive ? "text-white drop-shadow-white" : "text-neutral-500 group-hover:text-neutral-300"
                    )} />
                    {item.isNew && (
                      <Sparkles className={cn(
                        "absolute -right-1 -top-1 h-2.5 w-2.5 transition-colors duration-300",
                        isActive ? "text-emerald-300" : "text-emerald-400/80 group-hover:text-emerald-300"
                      )} />
                    )}
                  </div>

                  {!isCollapsed && (
                    <>
                      <span className={cn(
                        "text-sm font-semibold tracking-wide transition-colors duration-300",
                        isActive ? "text-white" : "text-neutral-500 group-hover:text-neutral-200"
                      )}>
                        {item.label}
                      </span>
                      {item.isNew && (
                        <span className={cn(
                          "ml-auto rounded-full px-2 py-0.5 text-[9px] font-bold tracking-[0.14em] uppercase",
                          "border transition-colors duration-300",
                          isActive
                            ? "border-amber-300/60 bg-amber-300/20 text-amber-100"
                            : "border-amber-400/45 bg-amber-400/15 text-amber-300"
                        )}>
                          New
                        </span>
                      )}
                    </>
                  )}

                  {/* Tooltip for collapsed mode */}
                  {isCollapsed && (
                    <div className="absolute left-full ml-4 hidden group-hover:flex items-center px-3 py-2 bg-[#141414] border border-white/10 rounded-lg shadow-2xl z-[60] whitespace-nowrap animate-in fade-in zoom-in-95 duration-200">
                      <span className="text-xs text-white font-semibold">{item.label}</span>
                      {item.isNew && (
                        <span className="text-xs font-bold text-amber-300 tracking-wider">{" • NEW"}</span>
                      )}
                    </div>
                  )}
                </button>
              )
            })}
          </nav>
        </div>

      </div>

      {/* Footer / Status Area */}
      <div className="p-4 mt-auto space-y-4 border-t border-white/[0.04] bg-white/[0.01]">

        {/* Cloud Sync Status */}
        {gdriveConnected && (
          <div className={cn("space-y-3", isCollapsed ? "flex flex-col items-center" : "")}>
            {onCloudScan && !isCollapsed ? (
              <button
                onClick={onCloudScan}
                disabled={isCloudIndexing || isScanning}
                className={cn(
                  "w-full flex items-center justify-between px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] transition-all duration-300",
                  "hover:bg-white/[0.08] hover:border-white/10 group",
                  isCloudIndexing ? "opacity-70 cursor-wait" : ""
                )}
              >
                <div className="flex items-center gap-3">
                  <RotateCw className={cn("w-4 h-4 text-white", isCloudIndexing && "animate-spin")} />
                  <span className="text-xs font-bold text-neutral-300">Sync Library</span>
                </div>
                <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse shadow-[0_0_8px_rgba(255,255,255,0.5)]" />
              </button>
            ) : (
              isCloudIndexing && (
                <div className="flex justify-center p-2 relative">
                  <div className="absolute inset-0 bg-white/10 blur-xl rounded-full" />
                  <RotateCw className="w-4 h-4 text-white animate-spin relative" />
                </div>
              )
            )}

            {/* Storage Bar */}
            {gdriveInfo && gdriveInfo.storage_used !== undefined && gdriveInfo.storage_limit !== undefined && !isCollapsed && (
              <div className="px-1 space-y-2">
                <div className="flex justify-between items-end">
                  <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider">Cloud Storage</span>
                  <span className="text-[10px] font-bold text-white bg-white/10 px-1.5 py-0.5 rounded">
                    {Math.round((gdriveInfo.storage_used / gdriveInfo.storage_limit) * 100)}%
                  </span>
                </div>
                <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden border border-white/[0.03]">
                  <motion.div
                    className="h-full bg-gradient-to-r from-neutral-400 to-white rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.min((gdriveInfo.storage_used / gdriveInfo.storage_limit) * 100, 100)}%` }}
                    transition={{ duration: 1, ease: "easeOut" }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-neutral-400">
                  <span>{formatStorageSize(gdriveInfo.storage_used)} used</span>
                  <span>{formatStorageSize(gdriveInfo.storage_limit - gdriveInfo.storage_used)} left</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Settings */}
        <button
          onClick={onOpenSettings}
          className={cn(
            "w-full flex items-center gap-3.5 px-4 py-3 rounded-xl transition-all duration-300",
            "hover:bg-white/[0.08] text-neutral-500 hover:text-white border border-transparent hover:border-white/5",
            isCollapsed ? "justify-center px-0" : ""
          )}
        >
          <div className="relative">
            <Settings className="w-5 h-5 transition-transform group-hover:rotate-45" />
          </div>
          {!isCollapsed && (
            <span className="text-sm font-semibold tracking-wide">Settings</span>
          )}
        </button>
      </div>
    </motion.aside>
  )
}
