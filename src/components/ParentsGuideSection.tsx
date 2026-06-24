import { useState } from "react"
import { AlertTriangle, ChevronDown, Swords, Pill, MessageSquareWarning, Flame, EyeOff } from "lucide-react"
import type { ParentsGuideCategory } from "@/services/api"

const CATEGORY_META: Record<string, { label: string; icon: typeof AlertTriangle }> = {
  VIOLENCE: { label: "Violence", icon: Swords },
  SEXUAL_CONTENT: { label: "Sexual Content", icon: Flame },
  PROFANITY: { label: "Profanity", icon: MessageSquareWarning },
  ALCOHOL_DRUGS: { label: "Alcohol & Drugs", icon: Pill },
  FRIGHTENING_INTENSE_SCENES: { label: "Frightening Scenes", icon: EyeOff },
}

const SEVERITY_ORDER = ["none", "mild", "moderate", "severe"] as const

const SEVERITY_STYLES: Record<string, { bg: string; text: string; border: string; label: string }> = {
  none:     { bg: "bg-green-500/10", text: "text-green-400", border: "border-green-500/20", label: "None" },
  mild:     { bg: "bg-yellow-500/10", text: "text-yellow-400", border: "border-yellow-500/20", label: "Mild" },
  moderate: { bg: "bg-orange-500/10", text: "text-orange-400", border: "border-orange-500/20", label: "Moderate" },
  severe:   { bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/20", label: "Severe" },
}

function getDominantSeverity(breakdowns: ParentsGuideCategory["severity_breakdowns"]): string | null {
  if (!breakdowns || breakdowns.length === 0) return null
  let best = breakdowns[0]
  for (const b of breakdowns) {
    if (b.vote_count > best.vote_count) best = b
  }
  return best.severity_level
}

interface ParentsGuideSectionProps {
  categories: ParentsGuideCategory[]
}

export function ParentsGuideSection({ categories }: ParentsGuideSectionProps) {
  const [expanded, setExpanded] = useState(false)

  if (!categories || categories.length === 0) return null

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between text-[10px] font-black uppercase tracking-[0.2em] text-white/20 hover:text-white/40 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <AlertTriangle className="size-3" />
          Content Warnings
        </span>
        <ChevronDown className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {/* Summary row — always visible */}
      <div className="flex flex-wrap gap-1.5">
        {categories.map((cat) => {
          const meta = CATEGORY_META[cat.category]
          if (!meta) return null
          const severity = getDominantSeverity(cat.severity_breakdowns)
          if (!severity || severity === "none") return null
          const style = SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.mild
          const Icon = meta.icon
          return (
            <span
              key={cat.category}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold ${style.bg} ${style.text} ${style.border}`}
            >
              <Icon className="size-2.5" />
              {meta.label}
            </span>
          )
        })}
        {categories.every((c) => getDominantSeverity(c.severity_breakdowns) === "none" || getDominantSeverity(c.severity_breakdowns) === null) && (
          <span className="text-white/30 text-[10px]">No notable content warnings</span>
        )}
      </div>

      {/* Expanded detail grid */}
      {expanded && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
          {categories.map((cat) => {
            const meta = CATEGORY_META[cat.category]
            if (!meta) return null
            const severity = getDominantSeverity(cat.severity_breakdowns)
            const style = severity ? (SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.mild) : SEVERITY_STYLES.none
            const Icon = meta.icon
            return (
              <div
                key={cat.category}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border ${style.bg} ${style.border}`}
              >
                <Icon className={`size-4 shrink-0 ${style.text}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-white/70 text-[11px] font-bold">{meta.label}</div>
                  {cat.severity_breakdowns && (
                    <div className="flex gap-1.5 mt-1">
                      {SEVERITY_ORDER.map((level) => {
                        const entry = cat.severity_breakdowns?.find((b) => b.severity_level === level)
                        if (!entry || entry.vote_count === 0) return null
                        const lStyle = SEVERITY_STYLES[level]
                        return (
                          <span
                            key={level}
                            className={`text-[9px] font-bold ${lStyle.text} opacity-70`}
                            title={`${lStyle.label}: ${entry.vote_count} votes`}
                          >
                            {lStyle.label[0]}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </div>
                <span className={`text-[11px] font-black ${style.text}`}>{style.label}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
