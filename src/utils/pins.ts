const STORAGE_KEY = 'pinned_items'

export function getPinnedIds(): Set<string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return new Set<string>(stored ? JSON.parse(stored) : [])
  } catch {
    return new Set<string>()
  }
}

export function togglePin(id: string | number): boolean {
  const strId = String(id)
  const ids = getPinnedIds()
  if (ids.has(strId)) ids.delete(strId); else ids.add(strId)
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
  return ids.has(strId)
}

export function sortPinnedFirst<T extends { id: string | number }>(items: T[]): T[] {
  const pinned = getPinnedIds()
  return items.toSorted((a, b) => {
    const aPinned = pinned.has(String(a.id)) ? 1 : 0
    const bPinned = pinned.has(String(b.id)) ? 1 : 0
    return bPinned - aPinned
  })
}
