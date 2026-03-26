import { useEffect, useRef, useState } from 'react'

interface PreviewPanelProps {
  htmlFile: string | null
}

export default function PreviewPanel({ htmlFile }: PreviewPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [lastFile, setLastFile] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(true)

  useEffect(() => {
    if (htmlFile && htmlFile !== lastFile) {
      setLastFile(htmlFile)
      setCollapsed(false)
      setRefreshToken((t) => t + 1)
    }
  }, [htmlFile, lastFile])

  useEffect(() => {
    if (!lastFile) return
    fetch(`http://localhost:4096/file/content?path=${encodeURIComponent(lastFile)}`)
      .then((r) => r.json())
      .then((data) => {
        const content: string = data.content ?? data.text ?? ''
        const blob = new Blob([content], { type: 'text/html' })
        const url = URL.createObjectURL(blob)
        setIframeSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return url })
      })
      .catch(() => {})
  }, [lastFile, refreshToken])

  async function handleDownload() {
    if (!lastFile) return
    try {
      const res = await fetch(`http://localhost:4096/file/content?path=${encodeURIComponent(lastFile)}`)
      const data = await res.json()
      const content: string = data.content ?? data.text ?? ''
      const blob = new Blob([content], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = lastFile.split('/').pop() ?? 'presentation.html'
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) { console.error('Download failed:', e) }
  }

  // ── Collapsed: 32px strip ──────────────────────────────────────────────
  if (collapsed) {
    return (
      <div
        className="w-8 flex-shrink-0 flex flex-col items-center"
        style={{ background: 'var(--bg-sidebar)', borderLeft: '1px solid var(--border)' }}
      >
        <button
          onClick={() => setCollapsed(false)}
          className="mt-3 w-6 h-6 flex items-center justify-center rounded-lg transition-colors"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          title="Expand preview"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        {lastFile && (
          <span
            className="mt-2 text-[9px]"
            style={{ writingMode: 'vertical-rl', color: 'var(--text-muted)' }}
          >
            preview
          </span>
        )}
      </div>
    )
  }

  // ── Expanded ───────────────────────────────────────────────────────────
  return (
    <div
      className="flex flex-col min-h-0 flex-shrink-0"
      style={{
        width: '45%',
        background: 'var(--bg-app)',
        borderLeft: '1px solid var(--border)',
      }}
    >
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-3 py-2 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}
      >
        <button
          onClick={() => setCollapsed(true)}
          className="p-0.5 rounded transition-colors"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          title="Collapse preview"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        <span className="text-[10px] font-mono truncate flex-1" style={{ color: 'var(--text-muted)' }}>
          {lastFile ? lastFile.split('/').pop() : 'No preview yet'}
        </span>

        {lastFile && (
          <>
            <button
              onClick={() => setRefreshToken((t) => t + 1)}
              className="text-xs px-1.5 py-1 rounded transition-colors"
              style={{ color: 'var(--text-muted)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              title="Refresh"
            >
              ↺
            </button>
            <button
              onClick={handleDownload}
              className="text-xs px-3 py-1 rounded-lg transition-colors"
              style={{
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
                background: 'var(--bg-surface)',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
            >
              Download
            </button>
          </>
        )}
      </div>

      {/* Preview */}
      {!lastFile ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Preview will appear here</p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
              Chat with the AI to generate slides
            </p>
          </div>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          src={iframeSrc ?? undefined}
          className="flex-1 w-full border-0"
          title="Slide preview"
          sandbox="allow-scripts allow-same-origin"
        />
      )}
    </div>
  )
}
