import { useState, useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Play, Film, Tv, History, Settings,
  Sparkles, ArrowRight, Check, FolderOpen, ChevronRight,
  MonitorPlay, Clock, Star, Rocket
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface OnboardingModalProps {
  open: boolean
  onComplete: () => void
}

interface OnboardingStep {
  id: string
  title: string
  subtitle: string
  description: string
  icon: React.ReactNode
  color: string
  features?: { icon: React.ReactNode; text: string }[]
  visual?: React.ReactNode
}

const springConfig = {
  type: "spring" as const,
  stiffness: 300,
  damping: 25,
}

export function OnboardingModal({ open, onComplete }: OnboardingModalProps) {
  const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const noAnim = prefersReducedMotion ? { duration: 0 } : undefined
  const [currentStep, setCurrentStep] = useState(0)
  const [isAutoPlaying, setIsAutoPlaying] = useState(true)

  const steps: OnboardingStep[] = [
    {
      id: "welcome",
      title: "Welcome to SlasshyVault",
      subtitle: "Your Personal Media Center",
      description: "Organize, discover, and enjoy your movies and TV shows in one beautiful place.",
      icon: <Play className="w-8 h-8" />,
      color: "#FFFFFF",
      visual: (
        <div className="relative w-full h-48 flex items-center justify-center">
          <div className="relative">
            <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-white/30 to-gray-500/30 blur-3xl opacity-40" />
            <div className="relative w-24 h-24 rounded-3xl bg-gradient-to-br from-white to-gray-600 flex items-center justify-center shadow-2xl border border-white/20">
              <Play className="w-10 h-10 text-black fill-black ml-1" />
            </div>
          </div>
        </div>
      )
    },
    {
      id: "library",
      title: "Your Media Library",
      subtitle: "All Your Content, Organized",
      description: "Add your media folders and SlasshyVault will automatically organize your movies and TV shows with beautiful artwork.",
      icon: <Film className="w-8 h-8" />,
      color: "#CCCCCC",
      features: [
        { icon: <FolderOpen className="w-4 h-4" />, text: "Scan local folders automatically" },
        { icon: <Star className="w-4 h-4" />, text: "Fetch artwork & metadata from TMDB" },
        { icon: <Tv className="w-4 h-4" />, text: "Organize TV shows by seasons" },
      ],
      visual: (
        <div className="relative w-full h-48 flex items-center justify-center gap-4 px-8">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="relative w-20 h-28 rounded-xl bg-gradient-to-br from-gray-500/20 to-gray-500/20 border border-white/10 overflow-hidden"
            >
              <div className="absolute inset-0 bg-gradient-to-t from-background to-transparent" />
              <div className="absolute bottom-2 left-2 right-2 h-2 rounded-full bg-white/20" />
              <div className={cn(
                "absolute top-2 left-2 w-6 h-6 rounded-lg flex items-center justify-center",
                i === 0 ? "bg-gray-500/30" : i === 1 ? "bg-gray-500/30" : "bg-gray-500/30"
              )}>
                {i === 2 ? <Tv className="w-3 h-3" /> : <Film className="w-3 h-3" />}
              </div>
            </div>
          ))}
        </div>
      )
    },
    {
      id: "playback",
      title: "Seamless Playback",
      subtitle: "Watch Your Way",
      description: "Resume exactly where you left off. Track your progress across all your content with smart resume.",
      icon: <MonitorPlay className="w-8 h-8" />,
      color: "#999999",
      features: [
        { icon: <Play className="w-4 h-4" />, text: "Play with MPV player" },
        { icon: <Clock className="w-4 h-4" />, text: "Smart resume from any device" },
        { icon: <History className="w-4 h-4" />, text: "Full watch history" },
      ],
      visual: (
        <div className="relative w-full h-48 flex items-center justify-center">
          <div className="relative w-64 h-36 rounded-2xl bg-gradient-to-br from-gray-500/10 to-gray-500/10 border border-white/10 overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-t from-background/80 to-transparent" />

            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-14 h-14 rounded-full bg-white/80 flex items-center justify-center backdrop-blur-sm">
                <Play className="w-6 h-6 text-black fill-black ml-0.5" />
              </div>
            </div>

            <div className="absolute bottom-3 left-3 right-3">
              <div className="h-1.5 rounded-full bg-white/20 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-gray-500 to-gray-400 rounded-full" style={{ width: "65%" }} />
              </div>
              <div className="flex justify-between mt-1 text-[10px] text-white/60">
                <span>32:15</span>
                <span>49:30</span>
              </div>
            </div>
          </div>
        </div>
      )
    },
    {
      id: "ready",
      title: "You're All Set!",
      subtitle: "Let's Get Started",
      description: "Configure your settings and start enjoying your media collection. Welcome to SlasshyVault!",
      icon: <Rocket className="w-8 h-8" />,
      color: "#FFFFFF",
      features: [
        { icon: <Settings className="w-4 h-4" />, text: "Add your TMDB API key for metadata" },
        { icon: <FolderOpen className="w-4 h-4" />, text: "Configure your media folders" },
        { icon: <Sparkles className="w-4 h-4" />, text: "Scan and enjoy your library" },
      ],
      visual: (
        <div className="relative w-full h-48 flex items-center justify-center">
          <div className="relative">
            <div className="absolute -inset-8 rounded-full bg-gradient-to-br from-white/30 to-gray-400/30 blur-2xl" />
            <div className="relative w-20 h-20 rounded-2xl bg-gradient-to-br from-white to-gray-600 flex items-center justify-center shadow-2xl border border-white/20">
              <Rocket className="w-10 h-10 text-black" />
            </div>
          </div>
        </div>
      )
    },
  ]

  // Auto-advance timer
  useEffect(() => {
    if (!open || !isAutoPlaying || currentStep === steps.length - 1) return

    const timer = setTimeout(() => {
      setCurrentStep((prev) => Math.min(prev + 1, steps.length - 1))
    }, 5000) // 5 seconds per step

    return () => clearTimeout(timer)
  }, [open, currentStep, isAutoPlaying, steps.length])

  const handleNext = () => {
    setIsAutoPlaying(false)
    if (currentStep === steps.length - 1) {
      onComplete()
    } else {
      setCurrentStep((prev) => prev + 1)
    }
  }

  const handleSkip = () => {
    onComplete()
  }

  const handleStepClick = (index: number) => {
    setIsAutoPlaying(false)
    setCurrentStep(index)
  }

  if (!open) return null

  const step = steps[currentStep]

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[200] flex items-center justify-center"
          initial={noAnim ? undefined : { opacity: 0 }}
          animate={noAnim ? undefined : { opacity: 1 }}
          exit={noAnim ? undefined : { opacity: 0 }}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-background/95 backdrop-blur-xl"
            initial={noAnim ? undefined : { opacity: 0 }}
            animate={noAnim ? undefined : { opacity: 1 }}
          />

          {/* Background orbs */}
          {!noAnim && (
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
              <motion.div
                className="absolute -top-32 -left-32 w-96 h-96 rounded-full"
                style={{ background: `radial-gradient(circle, ${step.color}20 0%, transparent 70%)` }}
                animate={{
                  scale: [1, 1.2, 1],
                  x: [0, 50, 0],
                  y: [0, 30, 0]
                }}
                transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
              />
              <motion.div
                className="absolute -bottom-32 -right-32 w-96 h-96 rounded-full bg-gray-400/10"
                animate={{
                  scale: [1, 1.3, 1],
                  x: [0, -30, 0],
                  y: [0, -50, 0]
                }}
                transition={{ duration: 10, repeat: Infinity, ease: "easeInOut" }}
              />
            </div>
          )}

          {/* Content */}
          <motion.div
            className="relative z-10 w-full max-w-2xl mx-4"
            initial={noAnim ? undefined : { scale: 0.9, y: 20 }}
            animate={noAnim ? undefined : { scale: 1, y: 0 }}
            transition={noAnim || springConfig}
          >
            {/* Main card */}
            <div className="relative rounded-3xl bg-card/80 backdrop-blur-2xl border border-white/10 overflow-hidden shadow-2xl">
              {/* Gradient top border */}
              <div
                className="absolute top-0 left-0 right-0 h-1"
                style={{ background: `linear-gradient(90deg, ${step.color}, ${step.color}50, transparent)` }}
              />

              {/* Skip button */}
              {currentStep < steps.length - 1 && (
                <motion.button
                  onClick={handleSkip}
                  className="absolute top-4 right-4 px-3 py-1.5 rounded-full text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors z-20"
                  initial={noAnim ? undefined : { opacity: 0 }}
                  animate={noAnim ? undefined : { opacity: 1 }}
                  transition={noAnim || { delay: 0.5 }}
                >
                  Skip Tour
                </motion.button>
              )}

              {/* Step content */}
              <div className="p-8 pt-10">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={step.id}
                    initial={noAnim ? undefined : { opacity: 0, x: 50 }}
                    animate={noAnim ? undefined : { opacity: 1, x: 0 }}
                    exit={noAnim ? undefined : { opacity: 0, x: -50 }}
                    transition={noAnim || springConfig}
                    className="space-y-6"
                  >
                    {/* Visual */}
                    {step.visual}

                    {/* Icon & Title */}
                    <div className="text-center space-y-3">
                      {noAnim ? (
                        <div
                          className="inline-flex p-4 rounded-2xl mx-auto"
                          style={{ backgroundColor: `${step.color}20` }}
                        >
                          <div style={{ color: step.color }}>
                            {step.icon}
                          </div>
                        </div>
                      ) : (
                        <motion.div
                          className="inline-flex p-4 rounded-2xl mx-auto"
                          style={{ backgroundColor: `${step.color}20` }}
                          animate={{ scale: [1, 1.05, 1] }}
                          transition={{ duration: 2, repeat: Infinity }}
                        >
                          <div style={{ color: step.color }}>
                            {step.icon}
                          </div>
                        </motion.div>
                      )}

                      <div>
                        <p
                          className="text-sm font-medium uppercase tracking-wider mb-1"
                          style={{ color: step.color }}
                        >
                          {step.subtitle}
                        </p>
                        <h2
                          className="text-3xl font-bold text-foreground"
                        >
                          {step.title}
                        </h2>
                      </div>

                      <p
                        className="text-muted-foreground max-w-md mx-auto"
                      >
                        {step.description}
                      </p>
                    </div>

                    {/* Features */}
                    {step.features && (
                      <div
                        className="flex flex-wrap justify-center gap-3"
                      >
                        {step.features.map((feature, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/10"
                          >
                            <span style={{ color: step.color }}>{feature.icon}</span>
                            <span className="text-sm text-foreground">{feature.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>

              {/* Footer */}
              <div className="px-8 pb-8 pt-4">
                {/* Progress dots */}
                <div className="flex items-center justify-center gap-2 mb-6">
                  {steps.map((_, index) => (
                    <button
                      key={index}
                      onClick={() => handleStepClick(index)}
                      className="relative p-1"
                    >
                        <div
                        className={cn(
                          "w-2 h-2 rounded-full transition-colors",
                          index === currentStep ? "bg-white" : "bg-white/20 hover:bg-white/40"
                        )}
                      />
                      {!noAnim && index === currentStep && isAutoPlaying && (
                        <svg className="absolute -inset-1 w-4 h-4">
                          <motion.circle
                            cx="8"
                            cy="8"
                            r="6"
                            fill="none"
                            stroke={step.color}
                            strokeWidth="2"
                            strokeLinecap="round"
                            initial={{ pathLength: 0 }}
                            animate={{ pathLength: 1 }}
                            transition={{ duration: 5, ease: "linear" }}
                            style={{
                              transform: "rotate(-90deg)",
                              transformOrigin: "center"
                            }}
                          />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>

                {/* Action buttons */}
                <div className="flex items-center justify-center gap-4">
                  {currentStep > 0 && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setIsAutoPlaying(false)
                        setCurrentStep((prev) => prev - 1)
                      }}
                      className="text-muted-foreground"
                    >
                      Back
                    </Button>
                  )}

                  <Button
                    onClick={handleNext}
                    className="px-8 gap-2"
                    style={{
                      background: `linear-gradient(135deg, ${step.color}, ${step.color}cc)`,
                    }}
                  >
                    {currentStep === steps.length - 1 ? (
                      <>
                        <Check className="w-4 h-4" />
                        Get Started
                      </>
                    ) : (
                      <>
                        Continue
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>

            {/* Floating hints */}
            {!noAnim && (
              <AnimatePresence>
                {currentStep === 0 && (
                  <motion.div
                    className="absolute -bottom-16 left-1/2 -translate-x-1/2 flex items-center gap-2 text-sm text-muted-foreground"
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ delay: 1 }}
                  >
                    <motion.div
                      animate={{ y: [0, 5, 0] }}
                      transition={{ duration: 1.5, repeat: Infinity }}
                    >
                      <ChevronRight className="w-4 h-4 rotate-90" />
                    </motion.div>
                    <span>Swipe or click to navigate</span>
                  </motion.div>
                )}
              </AnimatePresence>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
