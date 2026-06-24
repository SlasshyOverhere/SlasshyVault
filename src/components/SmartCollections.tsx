import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Trash2, X, FolderOpen } from 'lucide-react'
import { MediaItem, getLibraryFiltered } from '@/services/api'
import { MovieCard } from './MovieCard'
import {
  SmartCollection,
  CollectionRule,
  getCollections,
  saveCollection,
  deleteCollection,
  matchCollectionRules,
  generateId,
} from '@/utils/smartCollections'

const FIELD_OPTIONS: { value: CollectionRule['field']; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'media_type', label: 'Type' },
  { value: 'director', label: 'Director' },
  { value: 'cast', label: 'Cast' },
  { value: 'duration_seconds', label: 'Duration (s)' },
]

const OPERATORS_FOR_FIELD = (field: CollectionRule['field']): { value: CollectionRule['operator']; label: string }[] => {
  if (field === 'title' || field === 'director' || field === 'cast') {
    return [
      { value: 'contains', label: 'contains' },
      { value: 'equals', label: 'equals' },
    ]
  }
  if (field === 'media_type') {
    return [
      { value: 'equals', label: 'equals' },
      { value: 'not_equals', label: 'not equals' },
    ]
  }
  return [
    { value: 'equals', label: 'equals' },
    { value: 'gt', label: '>' },
    { value: 'lt', label: '<' },
    { value: 'gte', label: '>=' },
    { value: 'lte', label: '<=' },
  ]
}

const MEDIA_TYPE_OPTIONS = [
  { value: 'movie', label: 'Movie' },
  { value: 'tvshow', label: 'TV Show' },
]

interface RuleBuilderProps {
  rule: CollectionRule
  onChange: (r: CollectionRule) => void
  onRemove: () => void
}

function RuleBuilder({ rule, onChange, onRemove }: RuleBuilderProps) {
  const ops = OPERATORS_FOR_FIELD(rule.field)
  const isMediaField = rule.field === 'media_type'

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={rule.field}
        onChange={e => {
          const field = e.target.value as CollectionRule['field']
          const newOps = OPERATORS_FOR_FIELD(field)
          onChange({ ...rule, field, operator: newOps[0].value, value: field === 'media_type' ? 'movie' : field === 'duration_seconds' ? 0 : '' })
        }}
        className="bg-white/[0.06] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-white/90 focus:outline-none focus:border-white/20"
      >
        {FIELD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      <select
        value={rule.operator}
        onChange={e => onChange({ ...rule, operator: e.target.value as CollectionRule['operator'] })}
        className="bg-white/[0.06] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-white/90 focus:outline-none focus:border-white/20"
      >
        {ops.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      {isMediaField ? (
        <select
          value={String(rule.value)}
          onChange={e => onChange({ ...rule, value: e.target.value })}
          className="bg-white/[0.06] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-white/90 focus:outline-none focus:border-white/20"
        >
          {MEDIA_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input
          type={rule.field === 'year' || rule.field === 'duration_seconds' ? 'number' : 'text'}
          value={String(rule.value)}
          onChange={e => {
            const v = rule.field === 'year' || rule.field === 'duration_seconds'
              ? Number(e.target.value) : e.target.value
            onChange({ ...rule, value: v })
          }}
          placeholder="value"
          className="w-28 bg-white/[0.06] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-white/90 placeholder:text-white/30 focus:outline-none focus:border-white/20"
        />
      )}

      <button
        type="button"
        onClick={onRemove}
        className="p-1 rounded-md hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

interface SmartCollectionsProps {
  onItemClick: (item: MediaItem) => void
  onFixMatch: (item: MediaItem) => void
  onDownload?: (item: MediaItem) => void
  onDelete?: (item: MediaItem) => void
  viewMode: 'grid' | 'list'
}

export function SmartCollections({ onItemClick, onFixMatch, onDownload, onDelete, viewMode }: SmartCollectionsProps) {
  const [collections, setCollections] = useState<SmartCollection[]>(getCollections)
  const [editing, setEditing] = useState<SmartCollection | null>(null)
  const [activeCollection, setActiveCollection] = useState<string | null>(null)
  const [matchedItems, setMatchedItems] = useState<MediaItem[]>([])
  const [allItems, setAllItems] = useState<MediaItem[]>([])

  // Load all cloud items once for matching
  const loadAllItems = useCallback(async () => {
    try {
      const [movies, tv] = await Promise.all([
        getLibraryFiltered('movie', '', true),
        getLibraryFiltered('tv', '', true),
      ])
      setAllItems([...movies, ...tv])
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => { loadAllItems() }, [loadAllItems])

  // When active collection changes, re-match
  useEffect(() => {
    if (!activeCollection) { setMatchedItems([]); return }
    const col = collections.find(c => c.id === activeCollection)
    if (!col) { setMatchedItems([]); return }
    setMatchedItems(allItems.filter(item => matchCollectionRules(item, col.rules)))
  }, [activeCollection, collections, allItems])

  const refresh = () => setCollections(getCollections())

  const startCreate = () => {
    setEditing({ id: '', name: '', rules: [{ field: 'title', operator: 'contains', value: '' }], createdAt: Date.now() })
  }

  const startEdit = (col: SmartCollection) => {
    setEditing({ ...col, rules: [...col.rules] })
  }

  const handleSave = () => {
    if (!editing || !editing.name.trim()) return
    const col = { ...editing, id: editing.id || generateId(), createdAt: editing.createdAt || Date.now() }
    saveCollection(col)
    refresh()
    setEditing(null)
  }

  const handleDelete = (id: string) => {
    deleteCollection(id)
    if (activeCollection === id) setActiveCollection(null)
    refresh()
  }

  const addRule = () => {
    if (!editing) return
    setEditing({ ...editing, rules: [...editing.rules, { field: 'title', operator: 'contains', value: '' }] })
  }

  const updateRule = (idx: number, rule: CollectionRule) => {
    if (!editing) return
    const rules = [...editing.rules]
    rules[idx] = rule
    setEditing({ ...editing, rules })
  }

  const removeRule = (idx: number) => {
    if (!editing) return
    setEditing({ ...editing, rules: editing.rules.filter((_, i) => i !== idx) })
  }

  const activeCol = collections.find(c => c.id === activeCollection)

  return (
    <div className="pt-24 px-4 pb-8 max-w-7xl mx-auto">
      <AnimatePresence mode="wait">
        {/* Collection detail view */}
        {activeCollection && activeCol ? (
          <motion.div
            key="detail"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
          >
            <div className="flex items-center gap-3 mb-6">
              <button
                type="button"
                onClick={() => setActiveCollection(null)}
                className="px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/[0.08] text-xs text-white/70 hover:text-white hover:bg-white/[0.1] transition-colors"
              >
                Back
              </button>
              <h2 className="text-lg font-semibold text-white">{activeCol.name}</h2>
              <span className="text-xs text-white/40">{matchedItems.length} items</span>
            </div>

            {matchedItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center min-h-[40vh]">
                <FolderOpen className="size-12 text-white/20 mb-4" />
                <p className="text-white/40 text-sm">No matching items found</p>
              </div>
            ) : (
              <div className={viewMode === 'grid' ? 'grid-media' : 'list-media'}>
                {matchedItems.map((item, index) => (
                  <MovieCard
                    key={item.id}
                    item={item}
                    index={index}
                    layout={viewMode}
                    onClick={onItemClick}
                    onFixMatch={onFixMatch}
                    onDownload={onDownload}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            )}
          </motion.div>
        ) : editing ? (
          /* Create / Edit form */
          <motion.div
            key="editor"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="max-w-xl mx-auto"
          >
            <div className="flex items-center gap-3 mb-6">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/[0.08] text-xs text-white/70 hover:text-white hover:bg-white/[0.1] transition-colors"
              >
                Cancel
              </button>
              <h2 className="text-lg font-semibold text-white">{editing.id ? 'Edit' : 'New'} Collection</h2>
            </div>

            <div className="p-4 rounded-xl bg-white/[0.04] border border-white/[0.06] space-y-4">
              <input
                type="text"
                placeholder="Collection name"
                value={editing.name}
                onChange={e => setEditing({ ...editing, name: e.target.value })}
                className="w-full bg-white/[0.06] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/20"
              />

              <div className="space-y-2">
                <span className="text-xs text-white/50 font-medium">Rules (all must match)</span>
                {editing.rules.map((rule, i) => (
                  <RuleBuilder
                    key={i}
                    rule={rule}
                    onChange={r => updateRule(i, r)}
                    onRemove={() => removeRule(i)}
                  />
                ))}
                {editing.rules.length === 0 && (
                  <p className="text-xs text-white/30">No rules yet -- add one below.</p>
                )}
              </div>

              <button
                type="button"
                onClick={addRule}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/[0.08] text-xs text-white/60 hover:text-white hover:bg-white/[0.1] transition-colors"
              >
                <Plus className="size-3" /> Add Rule
              </button>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={!editing.name.trim() || editing.rules.length === 0}
                  className="px-4 py-2 rounded-lg bg-white text-black text-xs font-medium hover:bg-white/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Save
                </button>
              </div>
            </div>
          </motion.div>
        ) : (
          /* Collections list */
          <motion.div
            key="list"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-white">Smart Collections</h2>
              <button
                type="button"
                onClick={startCreate}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-black text-xs font-medium hover:bg-white/90 transition-colors"
              >
                <Plus className="size-3.5" /> Create
              </button>
            </div>

            {collections.length === 0 ? (
              <div className="flex flex-col items-center justify-center min-h-[40vh]">
                <FolderOpen className="size-12 text-white/20 mb-4" />
                <p className="text-white/40 text-sm mb-4">No collections yet</p>
                <button
                  type="button"
                  onClick={startCreate}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/[0.06] border border-white/[0.08] text-xs text-white/70 hover:text-white hover:bg-white/[0.1] transition-colors"
                >
                  <Plus className="size-3.5" /> Create your first collection
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {collections.map(col => (
                  <motion.div
                    key={col.id}
                    layout
                    className="group p-4 rounded-xl bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.07] hover:border-white/[0.12] transition-colors cursor-pointer"
                    onClick={() => setActiveCollection(col.id)}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <FolderOpen className="size-4 text-white/40" />
                        <h3 className="text-sm font-medium text-white truncate">{col.name}</h3>
                      </div>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); startEdit(col) }}
                          className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors text-xs"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); handleDelete(col.id) }}
                          className="p-1 rounded hover:bg-red-500/20 text-white/40 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-white/30">
                      {col.rules.length} rule{col.rules.length !== 1 ? 's' : ''}
                    </p>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
