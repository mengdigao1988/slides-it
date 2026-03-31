import { useEffect, useRef, useState } from 'react'

interface ModelModalProps {
  open: boolean
  models: string[]
  currentModel: string
  onClose: () => void
  onSelect: (modelID: string) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the provider slug from a "provider/model-name" ID. */
function providerOf(id: string): string {
  return id.includes('/') ? id.split('/')[0] : 'other'
}

/** Format a provider slug into a human-readable title. */
function providerTitle(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Display name for a model: strip provider prefix. */
function displayName(id: string): string {
  return id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
}

interface Group {
  provider: string
  title: string
  models: string[]
}

function groupModels(models: string[]): Group[] {
  const map = new Map<string, string[]>()
  for (const m of models) {
    const p = providerOf(m)
    if (!map.has(p)) map.set(p, [])
    map.get(p)!.push(m)
  }
  return Array.from(map.entries()).map(([provider, ms]) => ({
    provider,
    title: providerTitle(provider),
    models: ms,
  }))
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ModelModal({
  open,
  models,
  currentModel,
  onClose,
  onSelect,
}: ModelModalProps) {
  const [search, setSearch] = useState('')
  const [activeId, setActiveId] = useState(currentModel)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setSearch('')
      setActiveId(currentModel)
      setTimeout(() => searchRef.current?.focus(), 50)
    }
  }, [open, currentModel])

  // ESC to close
  useEffect(() => {
    if (!open) return
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  // Filter models by search query
  const q = search.trim().toLowerCase()
  const filtered = q
    ? models.filter((m) => m.toLowerCase().includes(q))
    : models

  const groups = groupModels(filtered)

  // Flat list for keyboard navigation
  const flat = filtered

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const idx = flat.indexOf(activeId)
      const next = e.key === 'ArrowDown'
        ? Math.min(idx + 1, flat.length - 1)
        : Math.max(idx - 1, 0)
      setActiveId(flat[next])
      // scroll into view
      setTimeout(() => {
        const el = listRef.current?.querySelector(`[data-model-id="${CSS.escape(flat[next])}"]`) as HTMLElement | null
        el?.scrollIntoView({ block: 'nearest' })
      }, 0)
    } else if (e.key === 'Enter') {
      if (activeId) { onSelect(activeId); onClose() }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={onClose}
    >
      <div
        className="flex flex-col rounded-2xl overflow-hidden"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          width: '520px',
          maxWidth: '95vw',
          maxHeight: '70vh',
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* ── Header ── */}
        <div
          className="flex items-center justify-between px-5 pt-4 pb-3 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Select model
          </span>
          <button
            onClick={onClose}
            className="text-[11px] transition-colors"
            style={{ color: 'var(--text-muted)', fontFamily: 'inherit' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
          >
            esc
          </button>
        </div>

        {/* ── Search ── */}
        <div className="px-4 py-2.5 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <div
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
            style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}
          >
            <svg className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }}
              fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setActiveId(filtered[0] ?? activeId) }}
              placeholder="Search models…"
              className="flex-1 bg-transparent text-sm outline-none"
              style={{ color: 'var(--text-primary)', fontFamily: 'inherit' }}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="text-[10px]"
                style={{ color: 'var(--text-muted)' }}
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* ── Model list ── */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-2">
          {groups.length === 0 && (
            <p className="text-[11px] px-5 py-4 text-center" style={{ color: 'var(--text-muted)' }}>
              No models found
            </p>
          )}

          {groups.map((group) => (
            <div key={group.provider}>
              {/* Provider heading */}
              <p
                className="px-5 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: '#EA580C' }}
              >
                {group.title}
              </p>

              {group.models.map((m) => {
                const isActive = m === activeId
                const isCurrent = m === currentModel
                return (
                  <button
                    key={m}
                    data-model-id={m}
                    onClick={() => { onSelect(m); onClose() }}
                    onMouseEnter={() => setActiveId(m)}
                    className="w-full text-left px-5 py-1.5 flex items-center gap-3 transition-colors"
                    style={{
                      background: isActive ? 'rgba(234,88,12,0.10)' : 'transparent',
                      borderLeft: `2px solid ${isActive ? '#EA580C' : 'transparent'}`,
                    }}
                  >
                    {/* Active indicator */}
                    {isCurrent
                      ? <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--green-dot)' }} />
                      : <span className="w-1.5 h-1.5 flex-shrink-0" />
                    }

                    {/* Model name */}
                    <span
                      className="text-[13px] flex-1 truncate"
                      style={{
                        color: isCurrent ? 'var(--text-primary)' : 'var(--text-secondary)',
                        fontWeight: isCurrent ? 500 : 400,
                      }}
                    >
                      {displayName(m)}
                    </span>

                    {/* Provider badge (only when searching across groups) */}
                    {q && (
                      <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                        {providerTitle(providerOf(m))}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
