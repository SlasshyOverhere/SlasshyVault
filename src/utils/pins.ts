const STORAGE_KEY = 'pinned_items'

export function getPinnedIds(): Set<string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return new Set<string>(stored ? JSON.parse(stored) : [])
  } catch {
    return new Set<string>()
  }
}

export function togglePin(id: string): boolean {
  const ids = getPinnedIds()
  if (ids.has(id)) ids.delete(id); else ids.add(id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
  return ids.has(id)
}

export function isPinned(id: string): boolean {
  return getPinnedIds().has(id)
}

export function sortPinnedFirst<T extends { id: string }>(items: T[]): T[] {
  const pinned = getPinnedIds()
  return [...items].sort((a, b) => {
    const aPinned = pinned.has(a.id) ? 1 : 0
    const bPinned = pinned.has(b.id) ? 1 : 0
    return bPinned - aPinned
  })
}
