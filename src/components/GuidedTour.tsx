import { useState, useEffect, useCallback, useRef } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { ArrowRight, ArrowLeft, X, Sparkles, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface TourStep {
  id: string
  target: string // CSS selector for the element to highlight
  title: string
  description: string
  position?: 'top' | 'bottom' | 'left' | 'right' | 'center'
  action?: () => void // Optional action to perform when step starts
  highlight?: boolean // Whether to add spotlight effect
}

interface GuidedTourProps {
  steps: TourStep[]
  isActive: boolean
  onComplete: () => void
  onSkip: () => void
}

interface TooltipPosition {
  top: number
  left: number
  arrowPosition: 'top' | 'bottom' | 'left' | 'right'
}

const springConfig = {
  type: "spring" as const,
  stiffness: 400,
  damping: 30,
}

export function GuidedTour({ steps, isActive, onComplete, onSkip }: GuidedTourProps) {
  const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null)
  const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition | null>(null)
  const [isTransitioning, setIsTransitioning] = useState(false)
  const lastExecutedStepRef = useRef<number>(-1)

  const noAnim = prefersReducedMotion ? { duration: 0 } : undefined
  const currentStep = steps[currentStepIndex]
  const isLastStep = currentStepIndex === steps.length - 1
  const isFirstStep = currentStepIndex === 0

  // Find and measure target element
  const updateTargetPosition = useCallback(() => {
    if (!currentStep || !isActive) return

    const target = document.querySelector(currentStep.target)
    if (target) {
      const rect = target.getBoundingClientRect()
      setTargetRect(rect)

      // Calculate tooltip position
      const padding = 20
      const tooltipWidth = 340
      const tooltipHeight = 260 // Increased height for content + buttons

      let position: TooltipPosition = {
        top: 0,
        left: 0,
        arrowPosition: 'top'
      }

      const preferredPosition = currentStep.position || 'bottom'

      switch (preferredPosition) {
        case 'bottom':
          position = {
            top: rect.bottom + padding,
            left: Math.max(padding, Math.min(rect.left + rect.width / 2 - tooltipWidth / 2, window.innerWidth - tooltipWidth - padding)),
            arrowPosition: 'top'
          }
          // If tooltip would go off bottom, try top instead
          if (position.top + tooltipHeight > window.innerHeight - padding) {
            position = {
              top: rect.top - tooltipHeight - padding,
              left: position.left,
              arrowPosition: 'bottom'
            }
          }
          break
        case 'top':
          position = {
            top: rect.top - tooltipHeight - padding,
            left: Math.max(padding, Math.min(rect.left + rect.width / 2 - tooltipWidth / 2, window.innerWidth - tooltipWidth - padding)),
            arrowPosition: 'bottom'
          }
          // If tooltip would go off top, try bottom instead
          if (position.top < padding) {
            position = {
              top: rect.bottom + padding,
              left: position.left,
              arrowPosition: 'top'
            }
          }
          break
        case 'left':
          position = {
            top: Math.max(padding, Math.min(rect.top + rect.height / 2 - tooltipHeight / 2, window.innerHeight - tooltipHeight - padding)),
            left: rect.left - tooltipWidth - padding,
            arrowPosition: 'right'
          }
          // If tooltip would go off left, try right instead
          if (position.left < padding) {
            position = {
              top: position.top,
              left: rect.right + padding,
              arrowPosition: 'left'
            }
          }
          break
        case 'right':
          position = {
            top: Math.max(padding, Math.min(rect.top + rect.height / 2 - tooltipHeight / 2, window.innerHeight - tooltipHeight - padding)),
            left: rect.right + padding,
            arrowPosition: 'left'
          }
          // If tooltip would go off right, try left instead
          if (position.left + tooltipWidth > window.innerWidth - padding) {
            position = {
              top: position.top,
              left: rect.left - tooltipWidth - padding,
              arrowPosition: 'right'
            }
          }
          break
        case 'center':
          position = {
            top: window.innerHeight / 2 - tooltipHeight / 2,
            left: window.innerWidth / 2 - tooltipWidth / 2,
            arrowPosition: 'top'
          }
          break
      }

      // Final safety bounds check
      position.top = Math.max(padding, Math.min(position.top, window.innerHeight - tooltipHeight - padding))
      position.left = Math.max(padding, Math.min(position.left, window.innerWidth - tooltipWidth - padding))

      setTooltipPosition(position)
      return
    }

    setTargetRect(null)
    setTooltipPosition({
      top: Math.max(20, window.innerHeight / 2 - 130),
      left: Math.max(20, window.innerWidth / 2 - 170),
      arrowPosition: 'top',
    })
  }, [currentStep, isActive])

  // Update position on step change and window resize
  useEffect(() => {
    if (!isActive) return

    updateTargetPosition()

    const timer = setTimeout(updateTargetPosition, 100)

    window.addEventListener('resize', updateTargetPosition)
    window.addEventListener('scroll', updateTargetPosition, true)

    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', updateTargetPosition)
      window.removeEventListener('scroll', updateTargetPosition, true)
    }
  }, [currentStepIndex, isActive, updateTargetPosition])

  // Reset step index when tour becomes active
  useEffect(() => {
    if (isActive) {
      setCurrentStepIndex(0)
      lastExecutedStepRef.current = -1
    }
  }, [isActive])

  // Execute step action when step changes
  useEffect(() => {
    if (!isActive) {
      // Reset tracking when tour becomes inactive
      lastExecutedStepRef.current = -1
      return
    }

    // Only execute action if this step hasn't been executed yet
    if (currentStepIndex === lastExecutedStepRef.current) return

    // Mark this step as executed
    lastExecutedStepRef.current = currentStepIndex

    // Get the step directly from the steps array
    const step = steps[currentStepIndex]
    if (step?.action) {
      // Small delay to ensure DOM has updated before executing action
      const timer = setTimeout(() => {
        step.action!()
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [currentStepIndex, isActive, steps])

  const handleNext = () => {
    if (isLastStep) {
      onComplete()
    } else {
      setIsTransitioning(true)
      setTimeout(() => {
        setCurrentStepIndex(prev => prev + 1)
        setIsTransitioning(false)
      }, 150)
    }
  }

  const handlePrev = () => {
    if (!isFirstStep) {
      setIsTransitioning(true)
      setTimeout(() => {
        setCurrentStepIndex(prev => prev - 1)
        setIsTransitioning(false)
      }, 150)
    }
  }

  const handleSkip = () => {
    setCurrentStepIndex(0)
    onSkip()
  }

  if (!isActive) return null

  return (
    <AnimatePresence>
      {isActive && (
        <>
          {/* Overlay with spotlight cutout */}
          <motion.div
            className="fixed inset-0 z-[300] pointer-events-auto"
            initial={noAnim ? undefined : { opacity: 0 }}
            animate={noAnim ? undefined : { opacity: 1 }}
            exit={noAnim ? undefined : { opacity: 0 }}
            transition={noAnim || { duration: 0.3 }}
          >
            {/* Dark overlay - NO blur so highlighted elements stay sharp */}
            <div className="absolute inset-0 bg-black/70" />

            {/* Spotlight cutout using clip-path */}
            {targetRect && currentStep?.highlight !== false && (
              <motion.div
                className="absolute inset-0"
                initial={noAnim ? undefined : { opacity: 0 }}
                animate={noAnim ? undefined : { opacity: 1 }}
                style={{
                  background: 'transparent',
                  boxShadow: `0 0 0 9999px rgba(0, 0, 0, 0.75)`,
                  borderRadius: '16px',
                  top: targetRect.top - 8,
                  left: targetRect.left - 8,
                  width: targetRect.width + 16,
                  height: targetRect.height + 16,
                  position: 'absolute',
                }}
                transition={noAnim || { duration: 0.3 }}
              />
            )}

            {/* Glowing border around target */}
            {targetRect && currentStep?.highlight !== false && (
              <motion.div
                className="absolute pointer-events-none"
                initial={noAnim ? undefined : { opacity: 0, scale: 0.95 }}
                animate={noAnim ? undefined : { opacity: 1, scale: 1 }}
                transition={noAnim || springConfig}
                style={{
                  top: targetRect.top - 8,
                  left: targetRect.left - 8,
                  width: targetRect.width + 16,
                  height: targetRect.height + 16,
                  borderRadius: '16px',
                  border: '2px solid rgba(255, 255, 255, 0.6)',
                  boxShadow: '0 0 30px rgba(255, 255, 255, 0.3), inset 0 0 20px rgba(255, 255, 255, 0.1)',
                }}
              >
                {!noAnim && (
                  <motion.div
                    className="absolute inset-0 rounded-2xl border-2 border-white/50"
                    animate={{
                      scale: [1, 1.05, 1],
                      opacity: [0.5, 0, 0.5]
                    }}
                    transition={{
                      duration: 2,
                      repeat: Infinity,
                      ease: "easeInOut"
                    }}
                  />
                )}
              </motion.div>
            )}
          </motion.div>

          {/* Tooltip */}
          {tooltipPosition && (
            <motion.div
              className="fixed z-[400] w-[340px] pointer-events-auto"
              initial={noAnim ? undefined : { opacity: 0, y: 10, scale: 0.95 }}
              animate={noAnim ? undefined : {
                opacity: isTransitioning ? 0.5 : 1,
                y: 0,
                scale: 1
              }}
              exit={noAnim ? undefined : { opacity: 0, y: 10, scale: 0.95 }}
              transition={noAnim || springConfig}
              style={{
                top: tooltipPosition.top,
                left: tooltipPosition.left,
              }}
            >
              {/* Arrow */}
              <div
                className={cn(
                  "absolute w-4 h-4 bg-card border-l border-t border-white/30 transform rotate-45",
                  tooltipPosition.arrowPosition === 'top' && "-top-2 left-1/2 -translate-x-1/2",
                  tooltipPosition.arrowPosition === 'bottom' && "-bottom-2 left-1/2 -translate-x-1/2 rotate-[225deg]",
                  tooltipPosition.arrowPosition === 'left' && "top-1/2 -left-2 -translate-y-1/2 -rotate-45",
                  tooltipPosition.arrowPosition === 'right' && "top-1/2 -right-2 -translate-y-1/2 rotate-[135deg]"
                )}
              />

              {/* Card content */}
              <div className="relative rounded-2xl bg-card/95 backdrop-blur-xl border border-white/30 shadow-2xl overflow-hidden">
                {/* Gradient accent */}
                <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-white via-gray-400 to-gray-600" />

                {/* Header with step counter */}
                <div className="flex items-center justify-between px-5 pt-4 pb-2">
                  <div className="flex items-center gap-2">
                    {noAnim ? (
                      <div className="p-1.5 rounded-lg bg-white/20">
                        <Sparkles className="w-4 h-4 text-white" />
                      </div>
                    ) : (
                      <motion.div
                        className="p-1.5 rounded-lg bg-white/20"
                        animate={{ rotate: [0, 10, -10, 0] }}
                        transition={{ duration: 2, repeat: Infinity }}
                      >
                        <Sparkles className="w-4 h-4 text-white" />
                      </motion.div>
                    )}
                    <span className="text-xs font-medium text-white">
                      Step {currentStepIndex + 1} of {steps.length}
                    </span>
                  </div>
                  <button
                    onClick={handleSkip}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Content */}
                <div className="px-5 pb-4">
                  <AnimatePresence mode="wait">
                    <motion.div
                    key={currentStep.id}
                    initial={noAnim ? undefined : { opacity: 0, x: 20 }}
                    animate={noAnim ? undefined : { opacity: 1, x: 0 }}
                    exit={noAnim ? undefined : { opacity: 0, x: -20 }}
                    transition={noAnim || { duration: 0.2 }}
                    >
                      <h3 className="text-lg font-bold text-foreground mb-2">
                        {currentStep.title}
                      </h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {currentStep.description}
                      </p>
                    </motion.div>
                  </AnimatePresence>
                </div>

                {/* Progress dots */}
                <div className="flex justify-center gap-1.5 pb-3">
                  {steps.map((_, index) => (
                    <div
                      key={index}
                      className={cn(
                        "w-1.5 h-1.5 rounded-full transition-colors",
                        index === currentStepIndex
                          ? "bg-white"
                          : index < currentStepIndex
                            ? "bg-white/50"
                            : "bg-muted-foreground/30"
                      )}
                    />
                  ))}
                </div>

                {/* Actions */}
                <div className="flex items-center justify-between px-5 pb-5 pt-2 border-t border-border/50">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handlePrev}
                    disabled={isFirstStep}
                    className={cn(
                      "gap-1",
                      isFirstStep && "opacity-0 pointer-events-none"
                    )}
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Back
                  </Button>

                  <Button
                    size="sm"
                    onClick={handleNext}
                    className="gap-1 bg-white text-black hover:bg-gray-200"
                  >
                    {isLastStep ? (
                      <>
                        <Check className="w-4 h-4" />
                        Done
                      </>
                    ) : (
                      <>
                        Next
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </motion.div>
          )}

          {/* Click blocker for non-target areas */}
          <div
            className="fixed inset-0 z-[250]"
            onClick={(e) => e.stopPropagation()}
          />
        </>
      )}
    </AnimatePresence>
  )
}
