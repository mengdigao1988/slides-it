import { useEffect, useRef, useState } from 'react'
import {
  listTemplates,
  installTemplate,
  removeTemplate,
  activateTemplate,
  getTemplatePreview,
  type TemplateEntry,
} from '../lib/slides-server-api'

interface TemplatesModalProps {
  open: boolean
  activeTemplate: string
  onClose: () => void
  onActivate: (name: string) => void
}

export default function TemplatesModal({
  open,
  onClose,
  onActivate,
}: TemplatesModalProps) {
  const [templates, setTemplates] = useState<TemplateEntry[]>([])
  const [selected, setSelected] = useState<string>('')
  const [previewHtml, setPreviewHtml] = useState<string>('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [installSource, setInstallSource] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState('')
  const [actionError, setActionError] = useState('')
  const overlayRef = useRef<HTMLDivElement>(null)

  // Load template list when modal opens
  useEffect(() => {
    if (!open) return
    setInstallError('')
    setActionError('')
    listTemplates()
      .then((list) => {
        setTemplates(list)
        // Auto-select the active template
        const active = list.find((t) => t.active) ?? list[0]
        if (active) {
          setSelected(active.name)
        }
      })
      .catch(() => {})
  }, [open])

  // Load preview whenever selection changes
  useEffect(() => {
    if (!selected || !open) return
    const tpl = templates.find((t) => t.name === selected)
    if (!tpl?.has_preview) {
      setPreviewHtml('')
      return
    }
    setPreviewLoading(true)
    setPreviewHtml('')
    getTemplatePreview(selected)
      .then((r) => setPreviewHtml(r.html))
      .catch(() => setPreviewHtml(''))
      .finally(() => setPreviewLoading(false))
  }, [selected, open, templates]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  async function handleActivate(name: string) {
    setActionError('')
    try {
      await activateTemplate(name)
      setTemplates((prev) => prev.map((t) => ({ ...t, active: t.name === name })))
      onActivate(name)
    } catch (e) {
      setActionError((e as Error).message)
    }
  }

  async function handleRemove(name: string) {
    setActionError('')
    try {
      await removeTemplate(name)
      const newList = templates.filter((t) => t.name !== name)
      setTemplates(newList)
      if (selected === name) {
        const next = newList[0]
        if (next) setSelected(next.name)
        else setSelected('')
      }
    } catch (e) {
      setActionError((e as Error).message)
    }
  }

  async function handleInstall() {
    const source = installSource.trim()
    if (!source) return
    setInstalling(true)
    setInstallError('')
    try {
      const res = await installTemplate({ source })
      setInstallSource('')
      // Refresh list
      const list = await listTemplates()
      setTemplates(list)
      setSelected(res.name)
    } catch (e) {
      setInstallError((e as Error).message)
    } finally {
      setInstalling(false)
    }
  }

  const selectedTpl = templates.find((t) => t.name === selected)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.35)' }}
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
    >
      <div
        className="flex rounded-2xl overflow-hidden shadow-2xl"
        style={{
          width: 'min(900px, 92vw)',
          height: 'min(600px, 88vh)',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
        }}
      >
        {/* ── Left: template list ── */}
        <div
          className="flex flex-col flex-shrink-0 overflow-hidden"
          style={{
            width: '260px',
            borderRight: '1px solid var(--border)',
            background: 'var(--bg-sidebar)',
          }}
        >
          {/* Header */}
          <div
            className="px-4 py-3 flex items-center justify-between flex-shrink-0"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <span className="text-xs font-semibold tracking-widest uppercase" style={{ color: 'var(--text-muted)' }}>
              Templates
            </span>
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded transition-colors text-xs"
              style={{ color: 'var(--text-muted)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Template list */}
          <div className="flex-1 overflow-y-auto py-1">
            {templates.map((tpl) => (
              <div
                key={tpl.name}
                className="flex items-center"
                style={{
                  background: selected === tpl.name ? 'var(--bg-user-msg)' : 'transparent',
                  borderLeft: selected === tpl.name ? '2px solid var(--text-primary)' : '2px solid transparent',
                }}
                onMouseEnter={e => {
                  if (selected !== tpl.name) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = selected === tpl.name ? 'var(--bg-user-msg)' : 'transparent'
                }}
              >
                {/* Template name row — click to select */}
                <button
                  onClick={() => setSelected(tpl.name)}
                  className="flex-1 text-left px-4 py-2.5 min-w-0"
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                      {tpl.name}
                    </span>
                    {tpl.active && (
                      <span
                        className="text-[9px] px-1.5 py-0.5 rounded font-medium"
                        style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                      >
                        active
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] leading-snug truncate" style={{ color: 'var(--text-muted)' }}>
                    {tpl.description || 'No description'}
                  </p>
                </button>

                {/* Eye icon — click to preview (without activating) */}
                <button
                  onClick={() => setSelected(tpl.name)}
                  className="flex-shrink-0 w-7 h-7 flex items-center justify-center mr-2 rounded transition-colors"
                  style={{ color: selected === tpl.name ? 'var(--text-secondary)' : 'var(--text-muted)' }}
                  onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
                  onMouseLeave={e => (e.currentTarget.style.color = selected === tpl.name ? 'var(--text-secondary)' : 'var(--text-muted)')}
                  title="Preview"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
              </div>
            ))}
          </div>

          {/* Install box */}
          <div
            className="flex-shrink-0 p-3"
            style={{ borderTop: '1px solid var(--border)' }}
          >
            <p className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>
              Install from URL
            </p>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={installSource}
                onChange={(e) => setInstallSource(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleInstall() }}
                placeholder="https://... or github:user/repo"
                disabled={installing}
                className="flex-1 text-xs px-2.5 py-1.5 rounded-lg outline-none min-w-0"
                style={{
                  background: 'var(--bg-app)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)',
                  fontFamily: 'inherit',
                }}
              />
              <button
                onClick={handleInstall}
                disabled={!installSource.trim() || installing}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex-shrink-0 disabled:opacity-40"
                style={{
                  background: 'var(--btn-send)',
                  color: '#fff',
                  fontFamily: 'inherit',
                }}
              >
                {installing ? '…' : 'Add'}
              </button>
            </div>
            {installError && (
              <p className="mt-1.5 text-[10px]" style={{ color: 'var(--error)' }}>
                {installError}
              </p>
            )}
          </div>
        </div>

        {/* ── Right: preview + actions ── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {selectedTpl ? (
            <>
              {/* Template meta header */}
              <div
                className="px-5 py-3 flex items-center justify-between flex-shrink-0"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <div>
                  <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {selectedTpl.name}
                  </span>
                  <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    v{selectedTpl.version} by {selectedTpl.author}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {actionError && (
                    <span className="text-[11px]" style={{ color: 'var(--error)' }}>
                      {actionError}
                    </span>
                  )}
                  {!selectedTpl.active && (
                    <button
                      onClick={() => handleActivate(selectedTpl.name)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                      style={{
                        background: 'var(--btn-send)',
                        color: '#fff',
                        fontFamily: 'inherit',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--btn-send-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'var(--btn-send)')}
                    >
                      Use this template
                    </button>
                  )}
                  {selectedTpl.active && (
                    <span
                      className="px-3 py-1.5 rounded-lg text-xs font-medium"
                      style={{
                        background: 'var(--bg-hover)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      Currently active
                    </span>
                  )}
                  <button
                    onClick={() => handleRemove(selectedTpl.name)}
                      className="px-2.5 py-1.5 rounded-lg text-xs transition-colors"
                      style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLElement).style.color = 'var(--error)'
                        ;(e.currentTarget as HTMLElement).style.borderColor = 'var(--error-border)'
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'
                        ;(e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'
                      }}
                      title="Remove template"
                    >
                      Remove
                    </button>
                </div>
              </div>

              {/* Preview iframe */}
              <div className="flex-1 relative overflow-hidden" style={{ background: '#f0f0f0' }}>
                {previewLoading && (
                  <div
                    className="absolute inset-0 flex items-center justify-center text-xs"
                    style={{ color: 'var(--text-muted)', background: 'var(--bg-app)', zIndex: 10 }}
                  >
                    Loading preview…
                  </div>
                )}
                {!previewLoading && !previewHtml && (
                  <div
                    className="absolute inset-0 flex flex-col items-center justify-center gap-2"
                    style={{ background: 'var(--bg-app)' }}
                  >
                    <span className="text-2xl select-none" style={{ opacity: 0.25 }}>◻</span>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No preview available</p>
                  </div>
                )}
                {previewHtml && (
                  <iframe
                    srcDoc={previewHtml}
                    title={`Preview of ${selectedTpl.name}`}
                    className="w-full h-full border-0"
                    sandbox="allow-scripts"
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No templates installed</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
