import { createContext, useContext } from 'react'
import type { OptimizationConfig } from '@/lib/optimization'

export const OptimizationContext = createContext<OptimizationConfig>({
  tier: 'smooth',
  animationBudget: 'full',
  renderStrategy: 'direct',
  imageQuality: 'high',
  searchDelayMs: 300,
  chunkSize: 96,
  initialRender: 48,
})

export const useOptimization = () => useContext(OptimizationContext)
