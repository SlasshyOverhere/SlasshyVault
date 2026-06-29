export type PerfTier = 'smooth' | 'balanced' | 'performance'

export interface OptimizationConfig {
  tier: PerfTier
  /** framer-motion complexity level */
  animationBudget: 'full' | 'reduced' | 'minimal'
  /** How the cloud grid renders items */
  renderStrategy: 'direct' | 'chunked' | 'virtualized'
  /** Poster thumbnail quality tier */
  imageQuality: 'high' | 'medium' | 'low'
  /** Debounce delay for search inputs (ms) */
  searchDelayMs: number
  /** Number of items to render per chunk */
  chunkSize: number
  /** Initial render count for cloud view */
  initialRender: number
}

const TIERS: Record<PerfTier, OptimizationConfig> = {
  smooth: {
    tier: 'smooth',
    animationBudget: 'full',
    renderStrategy: 'direct',
    imageQuality: 'high',
    searchDelayMs: 300,
    chunkSize: 96,
    initialRender: 48,
  },
  balanced: {
    tier: 'balanced',
    animationBudget: 'reduced',
    renderStrategy: 'chunked',
    imageQuality: 'medium',
    searchDelayMs: 180,
    chunkSize: 64,
    initialRender: 32,
  },
  performance: {
    tier: 'performance',
    animationBudget: 'minimal',
    renderStrategy: 'virtualized',
    imageQuality: 'low',
    searchDelayMs: 100,
    chunkSize: 48,
    initialRender: 24,
  },
}

/** Pick the right tier based on library item count. */
export function pickTier(librarySize: number): PerfTier {
  if (librarySize >= 2000) return 'performance'
  if (librarySize >= 500) return 'balanced'
  return 'smooth'
}

/** Hook: auto-detect optimization tier. Pass `librarySize` explicitly or it
 *  falls back to a cached value from localStorage (set by the backend). */
export function useAutoOptimize(librarySize?: number): OptimizationConfig {
  // ponytail: once we have a Zustand store, read from there instead of local cached value
  const size = librarySize ?? loadCachedLibrarySize()
  return TIERS[pickTier(size)]
}

const CACHE_KEY = 'slasshyvault.library-cached-size'

export function saveCachedLibrarySize(total: number): void {
  try {
    localStorage.setItem(CACHE_KEY, String(total))
  } catch { /* quota exceeded — non-critical */ }
}

function loadCachedLibrarySize(): number {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return 0
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}
