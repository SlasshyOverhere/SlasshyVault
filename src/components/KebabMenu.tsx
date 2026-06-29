import { useState, useRef, useEffect, useCallback } from "react"
import { createPortal } from "react-dom"
import { MoreHorizontal, LucideIcon } from "lucide-react"

export interface KebabMenuItem {
  icon: LucideIcon
  label: string
  onClick: () => void
}

interface KebabMenuProps {
  items: KebabMenuItem[]
}

export function KebabMenu({ items }: KebabMenuProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, right: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    }
    setOpen((v) => !v)
  }, [open])

  const handleAction = useCallback((action: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    action()
    setOpen(false)
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={handleToggle}
        aria-label="More options"
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center justify-center size-8 rounded-lg bg-white/10 hover:bg-white/20 text-white/70 hover:text-white focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:outline-none transition-all duration-200"
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[9999] bg-zinc-900/95 backdrop-blur-xl border border-zinc-800 rounded-xl shadow-2xl shadow-black/60 p-1.5 min-w-[170px]"
          style={{ top: pos.top, right: pos.right }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={handleAction(item.onClick)}
              className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-xs font-semibold text-white/70 hover:text-white hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none transition-colors text-left"
            >
              <item.icon className="size-3.5" aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
