import { cn } from "@/lib/utils"
import {
  History, Settings,
  Home, RotateCw, Cloud, Users, Sparkles, Bot
} from "lucide-react"
import { motion } from "framer-motion"
import { useState, useEffect, useRef } from "react"
import { isGDriveConnected, getGDriveAccountInfo, DriveAccountInfo, formatStorageSize } from "@/services/gdrive"

interface SidebarProps {
  className?: string
  currentView: string
  setView: (view: string) => void
  onAiChatClick?: () => void
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
  unstableEnabled?: boolean
  aiChatPaused?: boolean
}

export function Sidebar({
  className,
  currentView,
  setView,
  onAiChatClick,
  onOpenSettings,
  onCloudScan,
  isScanning = false,
  isCloudIndexing = false,
  showCloudTab = true,
  betaEnabled = false,
  unstableEnabled = false,
  aiChatPaused = false,
}: SidebarProps) {
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [isManualCollapsed] = useState(() => {
    const saved = window.localStorage.getItem("sidebar-collapsed");
    return saved === null ? true : saved === "1";
  });
  const [isHovered, setIsHovered] = useState(false);
  const [gdriveConnected, setGdriveConnected] = useState(false);
  const [gdriveInfo, setGdriveInfo] = useState<DriveAccountInfo | null>(null);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleMouseEnter = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    // Clear any existing timer
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    
    // Start 0.1 second timer AFTER leaving the sidebar
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 100);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  const isForcedCollapsed = windowWidth < 800;
  const isCollapsed = (isForcedCollapsed || isManualCollapsed) && !isHovered;
  const sidebarWidth = isCollapsed ? (isForcedCollapsed ? 68 : 72) : (windowWidth < 1100 ? 240 : 280);

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
      setWindowWidth(window.innerWidth);
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("sidebar-collapsed", isManualCollapsed ? "1" : "0");
  }, [isManualCollapsed]);

  const menuItems = [
    { id: "home", label: "Home", icon: Home },
    { id: "cloud", label: "Library", icon: Cloud, hidden: !showCloudTab },
    { id: "ai", label: "AI Chat", icon: Bot, isNew: true, hidden: !unstableEnabled, paused: aiChatPaused },
    { id: "social", label: "Social", icon: Users, hidden: !betaEnabled },
    { id: "history", label: "History", icon: History },
  ].filter(item => !item.hidden);

  return (
    <motion.aside
      data-tour="sidebar"
      className={cn(
        "h-screen flex flex-col fixed left-0 top-0 z-[100]",
        "bg-[#0D0D0D]",
        "border-r border-white/[0.05] shadow-2xl",
        "will-change-[width]",
        className
      )}
      animate={{ width: sidebarWidth }}
      transition={{ 
        type: "spring", 
        stiffness: 400, 
        damping: 40,
        mass: 1,
        restDelta: 0.001
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Glossy Overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-white/[0.02] to-transparent pointer-events-none" />

      <div className={cn("flex-1 px-4 pt-14 pb-3 flex flex-col", isCollapsed ? "px-2 pt-12" : "")}>
        {/* Navigation Items (Middle) */}
        <div className="flex-1 flex items-center">
          <nav className="w-full space-y-2 overflow-visible">
            {menuItems.map((item) => {
              const isActive = currentView === item.id;

              return (
                <button
                  key={item.id}
                  data-tour={`nav-${item.id}`}
                  onClick={() => {
                    if (item.id === "ai" && item.paused) {
                      onAiChatClick?.()
                      return
                    }
                    setView(item.id)
                  }}
                  className={cn(
                    "group relative w-full flex items-center gap-3.5 px-4 py-3 rounded-xl transition-colors duration-300",
                    isActive
                      ? "bg-white/[0.08] text-white shadow-[0_0_20px_rgba(255,255,255,0.05)] border border-white/10"
                      : "text-neutral-500 hover:text-neutral-200 hover:bg-white/[0.03]",
                    item.paused ? "opacity-75" : "",
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
                      {item.paused ? (
                        <span className={cn(
                          "ml-auto rounded-full px-2 py-0.5 text-[9px] font-bold tracking-[0.14em] uppercase border transition-colors duration-300",
                          isActive
                            ? "border-amber-300/60 bg-amber-300/20 text-amber-100"
                            : "border-amber-400/45 bg-amber-400/15 text-amber-300"
                        )}>
                          Paused
                        </span>
                      ) : item.isNew && (
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
                    <div className="absolute left-full ml-4 z-[60] whitespace-nowrap rounded-lg border border-white/10 bg-[#141414] px-3 py-2 shadow-2xl pointer-events-none opacity-0 translate-x-1 transition-all duration-200 [transition-delay:0ms] group-hover:[transition-delay:100ms] group-hover:opacity-100 group-hover:translate-x-0">
                      <span className="text-xs font-semibold text-white">Open {item.label}</span>
                      {item.paused ? (
                        <span className="text-xs font-bold text-amber-300 tracking-wider">{" • PAUSED"}</span>
                      ) : item.isNew && (
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
      <div className={cn("mt-auto space-y-3 border-t border-white/[0.04] bg-white/[0.01]", isCollapsed ? "p-2.5" : "p-4")}>

        {/* Cloud Sync Status */}
        {gdriveConnected && (
          <div className="space-y-3 flex flex-col items-center">
            {onCloudScan && (
              <button
                data-tour="scan-library-btn"
                onClick={onCloudScan}
                disabled={isCloudIndexing || isScanning}
                className={cn(
                  "w-full flex items-center justify-between transition-all duration-300",
                  isCollapsed 
                    ? "h-10 w-10 justify-center rounded-full bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08]" 
                    : "px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08] hover:border-white/10 group",
                  isCloudIndexing ? "opacity-70 cursor-wait" : ""
                )}
                title={isCollapsed ? "Update Library" : ""}
              >
                <div className={cn("flex items-center gap-3", isCollapsed ? "justify-center" : "")}>
                  <RotateCw className={cn("w-4 h-4 text-white", isCloudIndexing && "animate-spin")} />
                  {!isCollapsed && <span className="text-xs font-bold text-neutral-300">Update Library</span>}
                </div>
                {!isCollapsed && <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse shadow-[0_0_8px_rgba(255,255,255,0.5)]" />}
              </button>
            )}

            {/* Storage Card - Premium Polished Version */}
            {gdriveInfo && gdriveInfo.storage_used !== undefined && gdriveInfo.storage_limit !== undefined && (
              <div className={cn(
                "w-full transition-all duration-300 relative overflow-hidden group/storage",
                isCollapsed 
                  ? "h-11 w-11 rounded-full bg-white/[0.03] border border-white/[0.08] shadow-[0_0_15px_rgba(255,255,255,0.02)]" 
                  : "h-[88px] rounded-2xl bg-white/[0.03] border border-white/[0.06] px-4 py-3 shadow-[0_8px_30px_rgba(0,0,0,0.2)]"
              )}>
                {/* Glossy Sheen Overlay */}
                <div className="absolute inset-0 bg-gradient-to-br from-white/[0.02] to-transparent pointer-events-none" />
                
                {/* Expanded Content Layer */}
                <div className={cn(
                  "transition-all duration-300 ease-in-out h-full flex flex-col justify-center",
                  isCollapsed ? "opacity-0 translate-x-[-10px] invisible" : "opacity-100 translate-x-0 visible"
                )}>
                  <div className="space-y-2.5">
                    <div className="flex justify-between items-baseline">
                      <div className="flex items-center gap-1.5">
                        <div className="w-1 h-3 bg-white/20 rounded-full" />
                        <span className="text-[10px] font-black text-white/40 uppercase tracking-[0.15em]">Storage</span>
                      </div>
                      <span className="text-[10px] font-black text-white/90 bg-white/10 px-2 py-0.5 rounded-full border border-white/5">
                        {Math.round((gdriveInfo.storage_used / gdriveInfo.storage_limit) * 100)}%
                      </span>
                    </div>
                    
                    <div className="relative h-1.5 w-full bg-white/[0.03] rounded-full overflow-hidden border border-white/[0.02] shadow-inner">
                      <div
                        className="h-full bg-gradient-to-r from-neutral-500 via-white to-neutral-400 rounded-full transition-all duration-700 relative"
                        style={{ 
                          width: `${Math.min((gdriveInfo.storage_used / gdriveInfo.storage_limit) * 100, 100)}%`,
                          boxShadow: '0 0 10px rgba(255,255,255,0.2)' 
                        }}
                      >
                        {/* Shimmer Effect */}
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" style={{ backgroundSize: '200% 100%' }} />
                      </div>
                    </div>

                    <div className="flex justify-between items-center">
                      <span className="text-[9px] font-black text-white/30 uppercase tracking-wider">
                        {formatStorageSize(gdriveInfo.storage_used)} / {formatStorageSize(gdriveInfo.storage_limit)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Collapsed Content Layer (Modern Circle Indicator) */}
                <div className={cn(
                  "absolute inset-0 flex items-center justify-center transition-all duration-300",
                  !isCollapsed ? "opacity-0 scale-90 invisible" : "opacity-100 scale-100 visible"
                )}>
                  <div className="relative flex items-center justify-center">
                    {/* Outer Glow Ring */}
                    <div className="absolute inset-[-4px] rounded-full border border-white/[0.03] animate-pulse-soft" />
                    <span className="text-[9px] font-black text-white/50 tracking-tighter group-hover/storage:text-white transition-colors">
                      {Math.round((gdriveInfo.storage_used / gdriveInfo.storage_limit) * 100)}%
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer Actions */}
        {isCollapsed ? (
          <div className="space-y-1.5">
            <div className="group relative">
              <button
                data-tour="settings-btn"
                onClick={onOpenSettings}
                title="Open settings"
                className="w-full h-10 rounded-xl border border-white/[0.06] bg-white/[0.03] transition-colors duration-200 flex items-center justify-center text-neutral-400 hover:bg-white/[0.08] hover:text-white hover:border-white/10"
              >
                <Settings className="h-4.5 w-4.5 transition-transform duration-200 group-hover:rotate-45" />
              </button>
              <div className="absolute left-full top-1/2 ml-3 -translate-y-1/2 z-[60] whitespace-nowrap rounded-lg border border-white/10 bg-[#141414] px-3 py-2 shadow-2xl pointer-events-none opacity-0 translate-x-1 transition-all duration-200 [transition-delay:0ms] group-hover:[transition-delay:100ms] group-hover:opacity-100 group-hover:translate-x-0">
                <span className="text-xs font-semibold text-white">Open Settings</span>
              </div>
            </div>

          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <button
              data-tour="settings-btn"
              onClick={onOpenSettings}
              title="Open settings"
              className="group h-11 w-full rounded-xl border border-white/[0.06] bg-white/[0.03] transition-colors duration-200 flex items-center justify-center gap-2 px-2 text-neutral-400 hover:bg-white/[0.08] hover:text-white hover:border-white/10"
            >
              <Settings className="h-4.5 w-4.5 transition-transform duration-200 group-hover:rotate-45" />
              <span className="text-xs font-semibold tracking-wide">Settings</span>
            </button>
          </div>
        )}
      </div>
    </motion.aside>
  )
}
