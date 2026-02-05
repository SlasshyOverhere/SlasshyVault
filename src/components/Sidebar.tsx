import { cn } from "@/lib/utils"
import {
  History, Settings,
  Globe, Home, RotateCw, Cloud, Users
} from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
import { useState, useEffect } from "react"
import { isGdriveConnected, getGdriveAccountInfo, DriveAccountInfo } from "@/services/api"

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

// Smooth spring config for natural feel
const springConfig = {
  type: "spring" as const,
  stiffness: 400,
  damping: 30,
}

const smoothTransition = {
  type: "spring" as const,
  stiffness: 300,
  damping: 25,
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
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const [gdriveConnected, setGdriveConnected] = useState(false);
  const [gdriveInfo, setGdriveInfo] = useState<DriveAccountInfo | null>(null);

  // Fetch Google Drive info
  useEffect(() => {
    const fetchGdriveInfo = async () => {
      const connected = await isGdriveConnected();
      setGdriveConnected(connected);
      if (connected) {
        const info = await getGdriveAccountInfo();
        setGdriveInfo(info);
      }
    };
    fetchGdriveInfo();
    // Refresh every 60 seconds
    const interval = setInterval(fetchGdriveInfo, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 800) {
        setIsCollapsed(true);
        setSidebarWidth(72);
      } else if (window.innerWidth < 1100) {
        setIsCollapsed(false);
        setSidebarWidth(220);
      } else {
        setIsCollapsed(false);
        setSidebarWidth(260);
      }
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const allMenuItems = [
    { id: "home", label: "Home", icon: Home },
    { id: "cloud", label: "Google Drive", icon: Cloud },
    { id: "stream", label: "Discover", icon: Globe },
    { id: "social", label: "Social", icon: Users },
    { id: "history", label: "History", icon: History },
  ];

  // Filter menu items based on visibility settings
  const menuItems = allMenuItems.filter(item => {
    if (item.id === 'cloud' && !showCloudTab) return false;
    if (item.id === 'social' && !betaEnabled) return false;
    return true;
  });

  return (
    <motion.aside
      initial={false}
      animate={{ width: sidebarWidth }}
      transition={{ ...smoothTransition, duration: 0.3 }}
      data-tour="sidebar"
      className={cn(
        "h-screen flex flex-col relative z-50",
        "bg-gradient-to-b from-card/90 via-background/95 to-background",
        "backdrop-blur-2xl border-r border-white/[0.08]",
        className
      )}
    >
      {/* Decorative gradient blob */}
      <div className="absolute top-0 left-0 w-full h-48 pointer-events-none overflow-hidden">
        <motion.div
          className="absolute -top-24 -left-24 w-48 h-48 rounded-full bg-white/10 blur-[80px]"
          animate={{
            scale: [1, 1.1, 1],
            opacity: [0.1, 0.15, 0.1]
          }}
          transition={{
            duration: 4,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
      </div>

      {/* Logo Section */}
      <motion.div
        layout
        transition={smoothTransition}
        className={cn(
          "relative z-10 flex items-center gap-3 py-5",
          isCollapsed ? "justify-center px-0" : "px-4"
        )}
      >
        <motion.div
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          transition={springConfig}
          className="relative group cursor-pointer"
        >
          {/* Animated glow ring */}
          <motion.div
            className="absolute -inset-1 rounded-2xl bg-gradient-to-r from-white/40 via-white/20 to-white/40 opacity-0 group-hover:opacity-60 blur-md"
            animate={{
              rotate: [0, 360],
            }}
            transition={{
              duration: 8,
              repeat: Infinity,
              ease: "linear"
            }}
          />

          {/* Logo container */}
          <div className="relative flex items-center justify-center w-11 h-11 rounded-2xl bg-white shadow-xl shadow-white/10 border border-white/20 overflow-hidden">
            {/* Inner shine effect */}
            <div className="absolute inset-0 bg-gradient-to-tr from-white/20 via-transparent to-transparent" />

            {/* Play icon with better styling */}
            <svg
              viewBox="0 0 24 24"
              className="w-5 h-5 text-black ml-0.5 relative z-10 drop-shadow-lg"
              fill="currentColor"
            >
              <path d="M8 5.14v14l11-7-11-7z" />
            </svg>
          </div>
        </motion.div>

        <AnimatePresence mode="wait">
          {!isCollapsed && (
            <motion.div
              initial={{ opacity: 0, x: -15, filter: "blur(4px)" }}
              animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, x: -10, filter: "blur(4px)" }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="flex flex-col overflow-hidden"
            >
              <h1 className="text-lg font-bold text-white tracking-tight">
                StreamVault
              </h1>
              <span className="text-[10px] text-white/60 font-semibold tracking-[0.2em] uppercase -mt-0.5">
                Media Center
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Navigation */}
      <nav className="flex-1 px-2.5 overflow-y-auto py-3">
        <AnimatePresence>
          {!isCollapsed && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="px-3 py-2 text-[10px] font-bold text-muted-foreground/60 uppercase tracking-[0.15em]"
            >
              Navigation
            </motion.div>
          )}
        </AnimatePresence>

        <div className="space-y-1">
          {menuItems.map((item, index) => {
            const isActive = currentView === item.id;
            const isHovered = hoveredItem === item.id;

            return (
              <motion.div
                key={item.id}
                className="relative"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{
                  delay: index * 0.05,
                  duration: 0.4,
                  ease: [0.25, 0.46, 0.45, 0.94]
                }}
                onHoverStart={() => setHoveredItem(item.id)}
                onHoverEnd={() => setHoveredItem(null)}
              >
                <motion.button
                  onClick={() => setView(item.id)}
                  whileTap={{ scale: 0.97 }}
                  transition={springConfig}
                  data-tour={`nav-${item.id}`}
                  className={cn(
                    "relative w-full flex items-center gap-3 rounded-xl text-sm font-medium overflow-hidden",
                    isCollapsed ? "justify-center p-3" : "px-3 py-2.5",
                    "transition-colors duration-200",
                    isActive
                      ? "text-white"
                      : "text-muted-foreground hover:text-white"
                  )}
                >
                  {/* Background highlight */}
                  <motion.div
                    className="absolute inset-0 rounded-xl"
                    initial={false}
                    animate={{
                      backgroundColor: isActive
                        ? "rgba(255,255,255,0.15)"
                        : isHovered
                          ? "rgba(255,255,255,0.04)"
                          : "rgba(255,255,255,0)",
                      borderColor: isActive ? "rgba(255,255,255,0.3)" : "transparent",
                    }}
                    style={{ borderWidth: 1, borderStyle: "solid" }}
                    transition={{ duration: 0.2 }}
                  />

                  {/* Active indicator line */}
                  <motion.div
                    className="absolute left-0 top-1/2 w-[3px] rounded-r-full"
                    initial={false}
                    animate={{
                      height: isActive ? (isCollapsed ? 28 : 22) : 0,
                      y: "-50%",
                      backgroundColor: "#ffffff",
                      boxShadow: isActive ? "0 0 12px rgba(255,255,255,0.5)" : "none",
                    }}
                    transition={springConfig}
                  />

                  {/* Icon container */}
                  <motion.div
                    className="relative z-10 flex items-center justify-center"
                    initial={false}
                    animate={{
                      scale: isActive ? 1 : (isHovered ? 1.1 : 1),
                    }}
                    transition={springConfig}
                  >
                    <motion.div
                      className="p-1.5 rounded-lg"
                      initial={false}
                      animate={{
                        backgroundColor: isActive ? "#ffffff" : "transparent",
                        boxShadow: isActive ? "0 4px 12px rgba(255,255,255,0.3)" : "none",
                      }}
                      transition={{ duration: 0.25 }}
                    >
                      <item.icon
                        className="w-[18px] h-[18px]"
                        style={{
                          color: isActive ? "#000000" : (isHovered ? "#ffffff" : undefined),
                          transition: "color 0.2s ease"
                        }}
                      />
                    </motion.div>
                  </motion.div>

                  {/* Label */}
                  <AnimatePresence mode="wait">
                    {!isCollapsed && (
                      <motion.span
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -10 }}
                        transition={{ duration: 0.2 }}
                        className="relative z-10 truncate font-medium"
                      >
                        {item.label}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </motion.button>

                {/* Tooltip for collapsed mode */}
                <AnimatePresence>
                  {isCollapsed && isHovered && (
                    <motion.div
                      initial={{ opacity: 0, x: -8, scale: 0.95 }}
                      animate={{ opacity: 1, x: 0, scale: 1 }}
                      exit={{ opacity: 0, x: -8, scale: 0.95 }}
                      transition={{ duration: 0.15, ease: "easeOut" }}
                      className="absolute left-full ml-3 top-1/2 -translate-y-1/2 px-3 py-2 rounded-lg bg-card/95 backdrop-blur-xl border border-white/10 text-xs font-medium text-white shadow-xl whitespace-nowrap z-50"
                      style={{
                        boxShadow: "0 4px 20px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.1)"
                      }}
                    >
                      <span className="text-white">{item.label}</span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      </nav>

      {/* Bottom Section */}
      <motion.div
        layout
        transition={smoothTransition}
        className={cn(
          "relative z-10 py-4 space-y-2",
          "border-t border-white/[0.06]",
          "bg-gradient-to-t from-card/50 to-transparent",
          isCollapsed ? "px-2.5" : "px-3"
        )}
      >
        {/* Google Drive Storage Stats */}
        {gdriveConnected && gdriveInfo && gdriveInfo.storage_used !== null && gdriveInfo.storage_limit !== null && (
          <AnimatePresence>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3 }}
              className={cn(
                "mb-3 rounded-xl p-3",
                "bg-white/5",
                "border border-white/10"
              )}
            >
              {!isCollapsed ? (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <Cloud className="w-4 h-4 text-white/70" />
                    <span className="text-xs font-medium text-white/70">Google Drive</span>
                  </div>
                  <div className="space-y-1.5">
                    <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-white rounded-full"
                        initial={{ width: 0 }}
                        animate={{
                          width: `${Math.min((gdriveInfo.storage_used / gdriveInfo.storage_limit) * 100, 100)}%`
                        }}
                        transition={{ duration: 0.8, ease: "easeOut" }}
                      />
                    </div>
                    <div className="flex justify-between items-center text-[10px] text-muted-foreground">
                      <span>
                        {(gdriveInfo.storage_used / (1024 * 1024 * 1024)).toFixed(1)} GB
                      </span>
                      <span>
                        {(gdriveInfo.storage_limit / (1024 * 1024 * 1024)).toFixed(0)} GB
                      </span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center gap-1" title={`${(gdriveInfo.storage_used / (1024 * 1024 * 1024)).toFixed(1)} / ${(gdriveInfo.storage_limit / (1024 * 1024 * 1024)).toFixed(0)} GB`}>
                  <Cloud className="w-4 h-4 text-white/70" />
                  <div className="w-6 h-6 relative">
                    <svg className="w-6 h-6 -rotate-90" viewBox="0 0 24 24">
                      <circle
                        className="stroke-white/10"
                        cx="12" cy="12" r="10"
                        strokeWidth="3"
                        fill="none"
                      />
                      <motion.circle
                        className="stroke-white"
                        cx="12" cy="12" r="10"
                        strokeWidth="3"
                        fill="none"
                        strokeLinecap="round"
                        initial={{ strokeDasharray: "0 62.83" }}
                        animate={{
                          strokeDasharray: `${(gdriveInfo.storage_used / gdriveInfo.storage_limit) * 62.83} 62.83`
                        }}
                        transition={{ duration: 0.8, ease: "easeOut" }}
                      />
                    </svg>
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        )}

        {/* Update Library Button - Only show if connected to Google Drive */}
        {gdriveConnected && onCloudScan && (
          <motion.button
            onClick={onCloudScan}
            disabled={isCloudIndexing || isScanning}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            transition={springConfig}
            data-tour="scan-library-btn"
            className={cn(
              "relative w-full flex items-center gap-3 py-2.5 rounded-xl text-sm font-semibold overflow-hidden",
              isCollapsed ? "justify-center px-0" : "px-3",
              isCloudIndexing
                ? "bg-white/20 text-white border border-white/30"
                : "bg-gradient-to-r from-white/[0.06] to-white/[0.03] hover:from-white/10 hover:to-white/[0.05] border border-white/[0.08] text-muted-foreground hover:text-white"
            )}
          >
            {/* Shimmer effect when indexing */}
            {isCloudIndexing && (
              <motion.div
                className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent"
                animate={{ x: ["-100%", "100%"] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
              />
            )}

            <motion.div
              animate={isCloudIndexing ? { rotate: 360 } : { rotate: 0 }}
              transition={isCloudIndexing ? { duration: 1, repeat: Infinity, ease: "linear" } : {}}
            >
              <RotateCw className={cn(
                "w-4 h-4 flex-shrink-0",
                isCloudIndexing && "text-white"
              )} />
            </motion.div>

            <AnimatePresence mode="wait">
              {!isCollapsed && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="relative z-10"
                >
                  {isCloudIndexing ? "Updating..." : "Update Library"}
                </motion.span>
              )}
            </AnimatePresence>
          </motion.button>
        )}

        {/* Settings Button */}
        <motion.button
          onClick={onOpenSettings}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          transition={springConfig}
          data-tour="settings-btn"
          className={cn(
            "w-full flex items-center gap-3 py-2.5 rounded-xl text-sm font-medium",
            "text-muted-foreground hover:text-white",
            "hover:bg-white/[0.04] transition-colors duration-200",
            isCollapsed ? "justify-center px-0" : "px-3"
          )}
        >
          <motion.div
            whileHover={{ rotate: 90 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
          >
            <Settings className="w-4 h-4" />
          </motion.div>

          <AnimatePresence mode="wait">
            {!isCollapsed && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                Settings
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
      </motion.div>

      {/* Bottom decorative gradient */}
      <div className="absolute bottom-0 left-0 right-0 h-32 pointer-events-none bg-gradient-to-t from-white/5 to-transparent" />
    </motion.aside>
  );
}
