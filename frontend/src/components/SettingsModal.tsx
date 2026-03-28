import { useEffect, useRef, useState } from 'react'
import { getSettings, saveSettings, getStatus } from '../lib/slides-server-api'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

const PROVIDERS = [
  { id: 'anthropic',  label: 'Anthropic' },
  { id: 'openai',     label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'deepseek',   label: 'DeepSeek' },
  { id: 'custom',     label: 'Custom (OpenAI-compatible)' },
]

const NATIVE_PROVIDERS = new Set(['anthropic', 'openai', 'openrouter', 'deepseek', ''])

export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [providerID, setProviderID]     = useState('anthropic')
  const [apiKey, setApiKey]             = useState('')        // what user types (may be empty = no change)
  const [apiKeyMasked, setApiKeyMasked] = useState('')        // loaded from server
  const [baseURL, setBaseURL]           = useState('')
  const [customModel, setCustomModel]   = useState('')
  const [showKey, setShowKey]           = useState(false)
  const [saving, setSaving]             = useState(false)
  const [restarting, setRestarting]     = useState(false)
  const [error, setError]               = useState('')
  const [success, setSuccess]           = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  // Load current settings when modal opens
  useEffect(() => {
    if (!open) return
    setError(''); setSuccess(false); setApiKey(''); setShowKey(false)
    getSettings().then((s) => {
      setProviderID(s.providerID || 'anthropic')
      setApiKeyMasked(s.apiKeyMasked)
      setBaseURL(s.baseURL)
      setCustomModel(s.customModel)
    }).catch(() => {})
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const isCustomProvider = !NATIVE_PROVIDERS.has(providerID)

  async function handleSave() {
    if (isCustomProvider && !baseURL) {
      setError('Base URL is required for custom providers.')
      return
    }
    if (isCustomProvider && !customModel) {
      setError('Model ID is required for custom providers.')
      return
    }
    setSaving(true); setError('')
    try {
      const result = await saveSettings({ providerID, apiKey, baseURL, customModel, clearKey: false })
      if (result.status === 'restarting') {
        // Server is restarting opencode — poll until it's healthy, then close
        setSaving(false)
        setRestarting(true)
        await pollUntilReady(8000)
        setRestarting(false)
        setSuccess(true)
        setTimeout(() => { setSuccess(false); onClose() }, 800)
      } else {
        setSuccess(true)
        setTimeout(() => { setSuccess(false); onClose() }, 800)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  /** Poll /api/status until opencode is healthy or timeout is reached. */
  async function pollUntilReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 600))
      try {
        const s = await getStatus()
        if (s.ready) return
      } catch { /* not up yet */ }
    }
  }

  async function handleClearKey() {
    setSaving(true); setError('')
    try {
      await saveSettings({ providerID, apiKey: '', baseURL, customModel, clearKey: true })
      setApiKeyMasked('')
      setApiKey('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    /* Overlay */
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.25)', backdropFilter: 'blur(2px)' }}
      onMouseDown={(e) => { if (e.target === overlayRef.current) onClose() }}
    >
      {/* Card */}
      <div
        className="w-full max-w-md rounded-2xl overflow-hidden flex flex-col"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.12)',
        }}
      >
        {/* Header */}
        <div
          className="px-5 py-4 flex items-center justify-between flex-shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Settings
          </h2>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-lg transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto">

          {/* Provider */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              Provider
            </label>
            <select
              value={providerID}
              onChange={(e) => { setProviderID(e.target.value); setError('') }}
              className="w-full rounded-lg px-3 py-2 text-sm outline-none appearance-none"
              style={{
                background: 'var(--bg-app)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* API Key */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              API Key
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  placeholder={apiKeyMasked || 'Leave empty to use opencode free tier'}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full rounded-lg px-3 py-2 pr-9 text-sm outline-none"
                  style={{
                    background: 'var(--bg-app)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                    fontFamily: 'inherit',
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                  onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
                  onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                  tabIndex={-1}
                >
                  {showKey ? (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
              {apiKeyMasked && (
                <button
                  onClick={handleClearKey}
                  disabled={saving}
                  className="px-2.5 py-2 rounded-lg text-xs transition-colors flex-shrink-0 disabled:opacity-40"
                  style={{
                    color: 'var(--error)',
                    border: '1px solid var(--error-border)',
                    background: 'var(--error-bg)',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '0.8')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                  title="Remove saved API key"
                >
                  Clear
                </button>
              )}
            </div>
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Leave empty to use opencode free tier (opencode/big-pickle etc.)
            </p>
          </div>

          {/* Base URL */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              Base URL
              {isCustomProvider && <span style={{ color: 'var(--error)' }}> *</span>}
              <span className="ml-1 font-normal" style={{ color: 'var(--text-muted)' }}>
                (OpenAI-compatible endpoint)
              </span>
            </label>
            <input
              type="url"
              value={baseURL}
              placeholder="https://api.example.com/v1"
              onChange={(e) => { setBaseURL(e.target.value); setError('') }}
              className="w-full rounded-lg px-3 py-2 text-sm outline-none"
              style={{
                background: 'var(--bg-app)',
                border: `1px solid ${isCustomProvider && !baseURL && error ? 'var(--error)' : 'var(--border)'}`,
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
              }}
            />
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Optional for built-in providers. Required for custom.
            </p>
          </div>

          {/* Model ID (shown for custom or when baseURL is set) */}
          {(isCustomProvider || baseURL) && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Model ID
                {isCustomProvider && <span style={{ color: 'var(--error)' }}> *</span>}
              </label>
              <input
                type="text"
                value={customModel}
                placeholder="gpt-4o"
                onChange={(e) => { setCustomModel(e.target.value); setError('') }}
                className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                style={{
                  background: 'var(--bg-app)',
                  border: `1px solid ${isCustomProvider && !customModel && error ? 'var(--error)' : 'var(--border)'}`,
                  color: 'var(--text-primary)',
                  fontFamily: 'inherit',
                }}
              />
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Registers this model ID for the custom provider in opencode.json.
              </p>
            </div>
          )}

          {/* Info note */}
          <p
            className="text-[11px] px-3 py-2 rounded-lg"
            style={{
              color: 'var(--text-muted)',
              background: 'var(--bg-app)',
              border: '1px solid var(--border)',
            }}
          >
            Saving will automatically restart the AI engine so your new provider settings take effect immediately.
          </p>

          {/* Error */}
          {error && (
            <p className="text-xs" style={{ color: 'var(--error)' }}>{error}</p>
          )}
        </div>

        {/* Footer */}
        <div
          className="px-5 py-3 flex items-center justify-end gap-2 flex-shrink-0"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <button
            onClick={onClose}
            disabled={restarting}
            className="px-4 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-40"
            style={{
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              background: 'transparent',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || restarting}
            className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
            style={{
              background: success ? '#16A34A' : 'var(--btn-send)',
              color: '#fff',
            }}
            onMouseEnter={e => { if (!saving && !restarting) e.currentTarget.style.background = success ? '#16A34A' : 'var(--btn-send-hover)' }}
            onMouseLeave={e => (e.currentTarget.style.background = success ? '#16A34A' : 'var(--btn-send)')}
          >
            {saving ? 'Saving…' : restarting ? 'Restarting AI…' : success ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
