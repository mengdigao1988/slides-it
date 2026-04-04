import { useCallback, useEffect, useRef, useState } from 'react'

interface PreviewPanelProps {
  htmlFile: string | null
}

const OPENCODE = 'http://localhost:4096'
const SLIDES_IT = 'http://localhost:3000'

export default function PreviewPanel({ htmlFile }: PreviewPanelProps) {
  const [lastFile, setLastFile] = useState<string | null>(null)
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const prevBlobUrl = useRef<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // ── Core fetch function — shared by effect and Refresh button ────────────
  const fetchContent = useCallback(async (path: string) => {
    try {
      const res = await fetch(`${OPENCODE}/file/content?path=${encodeURIComponent(path)}`)
      if (!res.ok) return
      const data = await res.json()
      const content: string = data.content ?? data.text ?? ''
      if (!content) return
      const blob = new Blob([content], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      // Revoke previous blob URL to avoid memory leaks
      if (prevBlobUrl.current) URL.revokeObjectURL(prevBlobUrl.current)
      prevBlobUrl.current = url
      setIframeSrc(url)
    } catch {
      // silently ignore network errors
    }
  }, [])

  // ── Sync htmlFile prop → lastFile state ──────────────────────────────────
  // Only update when the file actually changes; also expand the panel.
  useEffect(() => {
    if (!htmlFile || htmlFile === lastFile) return
    setLastFile(htmlFile)
    setCollapsed(false)
  }, [htmlFile, lastFile])

  // ── Fetch content whenever lastFile changes ───────────────────────────────
  // Runs independently of collapsed — content is always ready when panel opens.
  useEffect(() => {
    if (!lastFile) return
    fetchContent(lastFile)
  }, [lastFile, fetchContent])

  // ── Cleanup blob URL on unmount ───────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (prevBlobUrl.current) URL.revokeObjectURL(prevBlobUrl.current)
    }
  }, [])

  async function handleDownload() {
    if (!lastFile) return
    try {
      const res = await fetch(`${OPENCODE}/file/content?path=${encodeURIComponent(lastFile)}`)
      const data = await res.json()
      const content: string = data.content ?? data.text ?? ''
      const blob = new Blob([content], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = lastFile.split('/').pop() ?? 'presentation.html'
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('Download failed:', e)
    }
  }

  async function handleSave() {
    if (!lastFile || !iframeRef.current) return
    try {
      // Try to call getEditedHTML() inside the iframe
      const win = iframeRef.current.contentWindow as
        (Window & { getEditedHTML?: () => string }) | null
      if (!win?.getEditedHTML) {
        // HTML doesn't have inline editing — fall back to current DOM
        console.warn('getEditedHTML not found in iframe')
        return
      }
      setSaveStatus('saving')
      const html = win.getEditedHTML()
      const res = await fetch(`${SLIDES_IT}/api/file/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: lastFile, content: html }),
      })
      if (res.ok) {
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus('idle'), 2000)
      } else {
        setSaveStatus('error')
        setTimeout(() => setSaveStatus('idle'), 3000)
      }
    } catch (e) {
      console.error('Save failed:', e)
      setSaveStatus('error')
      setTimeout(() => setSaveStatus('idle'), 3000)
    }
  }

  // ── Collapsed strip ───────────────────────────────────────────────────────
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
            className="mt-2 text-[0.5625rem]"
            style={{ writingMode: 'vertical-rl', color: 'var(--text-muted)' }}
          >
            preview
          </span>
        )}
      </div>
    )
  }

  // ── Save button label & style ─────────────────────────────────────────────
  const saveLabel = saveStatus === 'saving' ? 'Saving…'
    : saveStatus === 'saved' ? 'Saved'
    : saveStatus === 'error' ? 'Error'
    : 'Save'
  const saveColor = saveStatus === 'saved' ? '#22C55E'
    : saveStatus === 'error' ? '#EF4444'
    : 'var(--text-muted)'

  // ── Expanded ──────────────────────────────────────────────────────────────
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

        <span className="text-[0.625rem] font-mono truncate flex-1" style={{ color: 'var(--text-muted)' }}>
          {lastFile ? lastFile.split('/').pop() : 'No preview yet'}
        </span>

        {lastFile && (
          <>
            <button
              onClick={handleSave}
              disabled={saveStatus === 'saving'}
              className="text-xs px-1.5 py-1 rounded transition-colors"
              style={{ color: saveColor }}
              onMouseEnter={e => { if (saveStatus === 'idle') e.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              title="Save inline edits back to file"
            >
              {saveLabel}
            </button>
            <button
              onClick={() => fetchContent(lastFile)}
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
      {!iframeSrc ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {lastFile ? 'Loading preview…' : 'Preview will appear here'}
            </p>
            {!lastFile && (
              <p className="text-[0.6875rem] mt-1" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
                Chat with the AI to generate slides
              </p>
            )}
          </div>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          key={lastFile}
          src={iframeSrc}
          className="flex-1 w-full border-0"
          title="Slide preview"
          sandbox="allow-scripts allow-same-origin"
        />
      )}
    </div>
  )
}
