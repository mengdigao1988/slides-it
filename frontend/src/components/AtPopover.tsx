import { useEffect, useRef, useState } from 'react'
import { findFiles } from '../lib/opencode-api'

interface FileMatch {
  path: string
  name: string
}

interface AtPopoverProps {
  query: string
  onSelect: (path: string, name: string) => void
  onClose: () => void
}

const colorMap: Record<string, string> = {
  py: '#3B82F6', ts: '#60A5FA', tsx: '#60A5FA',
  js: '#F59E0B', jsx: '#F59E0B',
  json: '#10B981', md: '#6B7280', txt: '#9CA3AF',
  html: '#F97316', css: '#EC4899', sh: '#22C55E',
}
function fileColor(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return colorMap[ext] ?? '#9CA3AF'
}

export default function AtPopover({ query, onSelect, onClose }: AtPopoverProps) {
  const [results, setResults] = useState<FileMatch[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Debounced search — skip empty query
  useEffect(() => {
    if (!query) {
      setResults([])
      setLoading(false)
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(async () => {
      setLoading(true)
      try {
        const matches = await findFiles(query, 10)
        setResults(matches)
        setActiveIdx(0)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 120)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query])

  // Keyboard navigation
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((i) => Math.min(i + 1, results.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const node = results[activeIdx]
        if (node) onSelect(node.path, node.name)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [results, activeIdx, onSelect, onClose])

  // Scroll active item into view
  useEffect(() => {
    const item = listRef.current?.children[activeIdx] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  // Empty query — show hint
  if (!query) {
    return (
      <div
        className="absolute bottom-full mb-1 left-0 w-72 rounded-xl px-3 py-2 text-[11px] z-50"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
          color: 'var(--text-muted)',
        }}
      >
        Type to search files…
      </div>
    )
  }

  // Loading or no results
  if (!loading && results.length === 0) {
    return (
      <div
        className="absolute bottom-full mb-1 left-0 w-72 rounded-xl px-3 py-2 text-[11px] z-50"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
          color: 'var(--text-muted)',
        }}
      >
        No files found
      </div>
    )
  }

  return (
    <div
      className="absolute bottom-full mb-1 left-0 w-72 rounded-xl overflow-hidden z-50"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
      }}
    >
      {/* Header */}
      <div
        className="px-3 py-1.5 flex items-center justify-between"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          Files · {query}
        </span>
        {loading && (
          <svg className="w-3 h-3 animate-spin" style={{ color: 'var(--text-muted)' }} fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        )}
      </div>

      {/* Results */}
      <div ref={listRef} style={{ maxHeight: '192px', overflowY: 'auto' }}>
        {results.map((file, i) => (
          <button
            key={file.path}
            className="w-full text-left px-3 py-2 flex items-center gap-2 transition-colors"
            style={{
              background: i === activeIdx ? 'var(--bg-user-msg)' : 'transparent',
              borderLeft: `2px solid ${i === activeIdx ? 'var(--btn-send)' : 'transparent'}`,
            }}
            onMouseEnter={() => setActiveIdx(i)}
            onClick={() => onSelect(file.path, file.name)}
          >
            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"
              style={{ color: fileColor(file.name) }}>
              <path fillRule="evenodd"
                d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
                clipRule="evenodd" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>
                {file.name}
              </p>
              <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                {file.path}
              </p>
            </div>
          </button>
        ))}
      </div>

      {/* Footer */}
      <div
        className="px-3 py-1.5 flex gap-3"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        {['↑↓ navigate', 'Enter select', 'Esc close'].map((hint) => (
          <span key={hint} className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {hint}
          </span>
        ))}
      </div>
    </div>
  )
}

