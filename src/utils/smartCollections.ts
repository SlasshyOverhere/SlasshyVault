import { MediaItem } from '@/services/api'

export interface CollectionRule {
  field: 'title' | 'year' | 'media_type' | 'director' | 'cast' | 'is_cloud' | 'duration_seconds'
  operator: 'contains' | 'equals' | 'not_equals' | 'gt' | 'lt' | 'gte' | 'lte'
  value: string | number | boolean
}

export interface SmartCollection {
  id: string
  name: string
  rules: CollectionRule[]
  createdAt: number
}

const STORAGE_KEY = 'slasshyvault_smart_collections'

export const getCollections = (): SmartCollection[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export const saveCollections = (collections: SmartCollection[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(collections))
}

export const saveCollection = (col: SmartCollection): void => {
  const all = getCollections()
  const idx = all.findIndex(c => c.id === col.id)
  if (idx >= 0) all[idx] = col
  else all.push(col)
  saveCollections(all)
}

export const deleteCollection = (id: string): void => {
  saveCollections(getCollections().filter(c => c.id !== id))
}

const getField = (item: MediaItem, field: CollectionRule['field']): string | number | boolean | undefined => {
  switch (field) {
    case 'title': return item.title
    case 'year': return item.year
    case 'media_type': return item.media_type
    case 'director': return item.director
    case 'cast': return item.cast_names
    case 'is_cloud': return item.is_cloud
    case 'duration_seconds': return item.duration_seconds
  }
}

export const matchCollectionRules = (item: MediaItem, rules: CollectionRule[]): boolean => {
  return rules.every(rule => {
    const val = getField(item, rule.field)
    const { operator, value } = rule

    if (val === undefined || val === null) return false

    switch (operator) {
      case 'contains':
        return typeof val === 'string' && val.toLowerCase().includes(String(value).toLowerCase())
      case 'equals':
        // eslint-disable-next-line eqeqeq
        return val == value
      case 'not_equals':
        // eslint-disable-next-line eqeqeq
        return val != value
      case 'gt': return Number(val) > Number(value)
      case 'lt': return Number(val) < Number(value)
      case 'gte': return Number(val) >= Number(value)
      case 'lte': return Number(val) <= Number(value)
      default: return false
    }
  })
}

export const generateId = (): string =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
