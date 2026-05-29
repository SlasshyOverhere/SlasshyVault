import * as React from "react"
import { Layers } from "lucide-react"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import { useToast } from "@/components/ui/use-toast"

export function Toaster() {
  const { toasts } = useToast()
  const [isExpanded, setIsExpanded] = React.useState(false)

  // Show only the top toast if not expanded
  const visibleToasts = isExpanded ? toasts : toasts.slice(0, 1)

  return (
    <ToastProvider duration={5000}>
      {visibleToasts.map((toast, index) => {
        const { id, title, description, action, ...props } = toast
        
        return (
          <Toast key={id} {...props} className="relative overflow-visible">
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && <ToastDescription>{description}</ToastDescription>}
            </div>
            {action}

            {/* Stack indicator */}
            {!isExpanded && toasts.length > 1 && index === 0 && (
              <button
                type="button"
                onClick={() => setIsExpanded(true)}
                className="absolute -left-3 -top-3 flex size-6 items-center justify-center rounded-full border border-white/10 bg-[#090909] shadow-lg transition-transform hover:scale-110"
              >
                <Layers className="size-3 text-white/70" />
              </button>
            )}

            <ToastClose />
          </Toast>
        )
      })}
      
      {/* Collapse button when expanded */}
      {isExpanded && toasts.length > 1 && (
        <button
          type="button"
          onClick={() => setIsExpanded(false)}
          className="fixed bottom-6 right-6 z-[101] rounded-2xl border border-white/10 bg-[#090909] px-4 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-white/50 shadow-2xl backdrop-blur-xl hover:text-white"
        >
          Collapse
        </button>
      )}

      <ToastViewport />
    </ToastProvider>
  )
}
