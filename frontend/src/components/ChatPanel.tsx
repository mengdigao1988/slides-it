import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  connectEventStream,
  createSession,
  sendPrompt,
  abortSession,
  fileToFilePart,
  type FilePart,
} from '../lib/opencode-api'
import {
  enqueueDelta,
  flushAll,
  MS_PER_CHAR,
  type ChatMessage,
  type PendingMap,
  type ToolEntry,
} from '../lib/typewriter'
import { getModels, setModel } from '../lib/slides-server-api'
import ThinkingDots from './ThinkingDots'
import ToolBlock from './ToolBlock'
import AtPopover from './AtPopover'

const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'))

type Mode = 'build' | 'plan'

interface ChatPanelProps {
  workspacePath: string
  activeTemplate?: string
  onHtmlGenerated: (path: string) => void
}

interface AtReference {
  path: string
  name: string
}

export default function ChatPanel({ workspacePath, onHtmlGenerated }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [chatError, setChatError] = useState('')
  const [isComposing, setIsComposing] = useState(false)

  // Mode
  const [currentMode, setCurrentMode] = useState<Mode>('build')

  // @ references
  const [atQuery, setAtQuery] = useState<string | null>(null)
  const [atStartPos, setAtStartPos] = useState(0)
  const [atReferences, setAtReferences] = useState<AtReference[]>([])

  // Model
  const [currentModel, setCurrentModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [modelOpen, setModelOpen] = useState(false)
  const modelDropdownRef = useRef<HTMLDivElement>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const msgMapRef = useRef<Map<string, string>>(new Map())
  const partMapRef = useRef<Map<string, string>>(new Map())
  const partTypeRef = useRef<Map<string, string>>(new Map())
  const pendingCharsRef = useRef<PendingMap>(new Map())
  const rafRef = useRef<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ── Load models ──────────────────────────────────────────────────────────
  useEffect(() => {
    getModels().then((res) => {
      setModels(res.models)
      setCurrentModel(res.current)
    }).catch(() => {})
  }, [])

  // Close model dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelOpen(false)
      }
    }
    if (modelOpen) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [modelOpen])

  async function handleModelSelect(modelID: string) {
    setCurrentModel(modelID)
    setModelOpen(false)
    await setModel(modelID).catch(() => {})
  }

  // ── Typewriter ──────────────────────────────────────────────────────────
  const typewriterTick = useCallback(() => {
    const pending = pendingCharsRef.current
    if (pending.size === 0) { rafRef.current = null; return }
    setMessages((prev) =>
      prev.map((m) => {
        const chars = pending.get(m.id)
        if (!chars) return m
        const take = chars[0]
        const rest = chars.slice(1)
        if (rest.length > 0) pending.set(m.id, rest)
        else pending.delete(m.id)
        return { ...m, text: m.text + take }
      }),
    )
    rafRef.current = window.setTimeout(typewriterTick, MS_PER_CHAR) as unknown as number
  }, [])

  const startTypewriter = useCallback(() => {
    if (!rafRef.current) {
      rafRef.current = window.setTimeout(typewriterTick, MS_PER_CHAR) as unknown as number
    }
  }, [typewriterTick])

  const flushPending = useCallback(() => {
    flushAll(pendingCharsRef.current, setMessages)
  }, [])

  // ── Session init ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    createSession('slides-it').then((s) => {
      if (!cancelled) setSessionId(s.id)
    }).catch(console.error)

    const es = connectEventStream()
    eventSourceRef.current = es
    es.onmessage = (e) => {
      try { handleEvent(JSON.parse(e.data)) } catch { /* ignore */ }
    }

    return () => {
      cancelled = true
      es.close()
      flushPending()
      if (rafRef.current) clearTimeout(rafRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── SSE handler ──────────────────────────────────────────────────────────
  function handleEvent(event: { type: string; properties: Record<string, unknown> }) {
    const { type, properties } = event

    if (type === 'session.status') {
      const status = (properties.status as { type: string })?.type
      if (status === 'idle') {
        flushPending()
        setMessages((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false } : m))
        setSending(false)
        detectHtmlFile()
      }
    }

    if (type === 'session.error') {
      const errData = properties.error as { name?: string; data?: { message?: string } } | undefined
      const errMsg = errData?.data?.message ?? errData?.name ?? 'Unknown error'
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'assistant' && last.streaming && last.text === '') {
          return prev.slice(0, -1).concat({ ...last, streaming: false, error: errMsg })
        }
        return [...prev, {
          id: `err-${Date.now()}`, role: 'assistant', text: '', streaming: false,
          error: errMsg, timestamp: new Date(), tools: [],
        }]
      })
      setSending(false)
    }

    if (type === 'message.updated') {
      const am = properties as { id: string; role: string; error?: unknown }
      if (am.role !== 'assistant') return
      if (!msgMapRef.current.has(am.id)) {
        const bid = `a-${am.id}`
        msgMapRef.current.set(am.id, bid)
        setMessages((prev) => [...prev, {
          id: bid, role: 'assistant', text: '', streaming: true,
          error: null, timestamp: new Date(), tools: [],
        }])
      }
      if (am.error) {
        const errMsg = (am.error as { data?: { message?: string } })?.data?.message ?? 'Error'
        const bid = msgMapRef.current.get(am.id)!
        setMessages((prev) => prev.map((m) =>
          m.id === bid ? { ...m, error: errMsg, streaming: false } : m
        ))
        setSending(false)
      }
    }

    if (type === 'message.part.updated') {
      const { partID, messageID, part } = properties as {
        partID: string; messageID: string
        part: { type: string; tool?: string; status?: string }
      }
      partTypeRef.current.set(partID, part.type)
      const bubbleId = msgMapRef.current.get(messageID)
      if (!bubbleId) return
      if (part.type === 'text') partMapRef.current.set(partID, bubbleId)
      if (part.type === 'tool') {
        const toolEntry: ToolEntry = {
          id: partID, name: part.tool ?? '', tool: part.tool ?? '', status: part.status ?? '',
        }
        setMessages((prev) => prev.map((m) => {
          if (m.id !== bubbleId) return m
          const idx = m.tools.findIndex((t) => t.id === partID)
          if (idx >= 0) { const tools = [...m.tools]; tools[idx] = toolEntry; return { ...m, tools } }
          return { ...m, tools: [...m.tools, toolEntry] }
        }))
      }
    }

    if (type === 'message.part.delta') {
      const { partID, messageID, field, delta } = properties as {
        partID: string; messageID: string; field: string; delta?: string
      }
      if (!delta) return
      if (partTypeRef.current.get(partID) === 'reasoning') return
      if (field !== 'text') return

      let bid = partMapRef.current.get(partID) ?? msgMapRef.current.get(messageID)
      if (!bid) {
        bid = `a-${messageID}`
        msgMapRef.current.set(messageID, bid)
        partMapRef.current.set(partID, bid)
        partTypeRef.current.set(partID, 'text')
        setMessages((prev) => [...prev, {
          id: bid!, role: 'assistant', text: '', streaming: true,
          error: null, timestamp: new Date(), tools: [],
        }])
      }
      enqueueDelta(pendingCharsRef.current, bid, delta)
      startTypewriter()
    }
  }

  function detectHtmlFile() {
    if (!workspacePath) return
    fetch('http://localhost:4096/file/status')
      .then((r) => r.json())
      .then((files: Array<{ path: string }>) => {
        const html = files.filter((f) => f.path.endsWith('.html'))
          .sort((a, b) => b.path.localeCompare(a.path))[0]
        if (html) onHtmlGenerated(html.path)
      })
      .catch(() => {})
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || sending || !sessionId) return
    setChatError('')
    setInput('')
    resize()

    // Build file parts from @ references
    let fileParts: FilePart[] | undefined
    if (atReferences.length > 0) {
      try {
        fileParts = await Promise.all(atReferences.map((r) => fileToFilePart(r.path)))
      } catch {
        // If file read fails, send without file parts
      }
      setAtReferences([])
    }

    // Build display text (show @ refs in bubble)
    const attachmentNames = atReferences.map((r) => r.name)

    setMessages((prev) => [...prev, {
      id: `u-${Date.now()}`, role: 'user', text, streaming: false,
      error: null, timestamp: new Date(), tools: [],
      attachmentNames: attachmentNames.length > 0 ? attachmentNames : undefined,
    }])
    setSending(true)

    try {
      await sendPrompt(sessionId, text, currentModel || undefined, currentMode, fileParts)
    } catch (e) {
      setChatError((e as Error).message)
      setSending(false)
    }
  }

  async function handleAbort() {
    if (!sessionId) return
    await abortSession(sessionId).catch(() => {})
    flushPending()
    if (rafRef.current) { clearTimeout(rafRef.current); rafRef.current = null }
    setMessages((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false } : m))
    setSending(false)
  }

  async function handleNewChat() {
    flushPending()
    if (rafRef.current) { clearTimeout(rafRef.current); rafRef.current = null }
    msgMapRef.current.clear(); partMapRef.current.clear(); partTypeRef.current.clear()
    setMessages([])
    setSending(false)
    setAtReferences([])
    setAtQuery(null)
    const s = await createSession('slides-it').catch(() => null)
    if (s) setSessionId(s.id)
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function resize() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  // ── @ detection ──────────────────────────────────────────────────────────
  function handleInput(e: React.FormEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget
    const val = el.value
    const pos = el.selectionStart ?? val.length
    const before = val.slice(0, pos)
    const atIdx = before.lastIndexOf('@')

    if (atIdx >= 0) {
      const query = before.slice(atIdx + 1)
      // Only activate if no space between @ and cursor
      if (!query.includes(' ')) {
        setAtQuery(query)
        setAtStartPos(atIdx)
        resize()
        return
      }
    }
    setAtQuery(null)
    resize()
  }

  function handleAtSelect(path: string, name: string) {
    const el = textareaRef.current
    if (!el) return
    const pos = el.selectionStart ?? input.length
    const before = input.slice(0, atStartPos)
    const after = input.slice(pos)
    const newVal = `${before}@${name} ${after}`
    setInput(newVal)
    setAtQuery(null)
    setAtReferences((prev) => {
      // Avoid duplicates
      if (prev.find((r) => r.path === path)) return prev
      return [...prev, { path, name }]
    })
    // Restore focus + cursor after @name
    requestAnimationFrame(() => {
      el.focus()
      const newPos = before.length + name.length + 2 // "@name "
      el.setSelectionRange(newPos, newPos)
    })
  }

  function removeAtReference(path: string) {
    setAtReferences((prev) => prev.filter((r) => r.path !== path))
  }

  // ── Shared input box ─────────────────────────────────────────────────────
  const inputBox = (
    <div className="relative">
      {/* AtPopover */}
      {atQuery !== null && (
        <AtPopover
          query={atQuery}
          onSelect={handleAtSelect}
          onClose={() => setAtQuery(null)}
        />
      )}

      {/* @ reference badges */}
      {atReferences.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {atReferences.map((ref) => (
            <span
              key={ref.path}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded"
              style={{
                background: 'rgba(99,102,241,0.1)',
                border: '1px solid rgba(99,102,241,0.25)',
                color: '#6366f1',
              }}
            >
              📎 {ref.name}
              <button
                onClick={() => removeAtReference(ref.path)}
                className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
                tabIndex={-1}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input card */}
      <div
        className="rounded-2xl shadow-sm"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          rows={1}
          placeholder="Describe your presentation… @ to reference files"
          className="w-full bg-transparent px-4 pt-3.5 pb-2 text-sm resize-none outline-none"
          style={{ maxHeight: '160px', color: 'var(--text-primary)', fontFamily: 'inherit' }}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onChange={(e) => setInput(e.target.value)}
          onInput={handleInput}
          onKeyDown={(e) => {
            // Tab → toggle mode (when AtPopover is closed)
            if (e.key === 'Tab' && !isComposing && atQuery === null) {
              e.preventDefault()
              setCurrentMode((m) => m === 'build' ? 'plan' : 'build')
              return
            }
            if (e.key === 'Enter' && !e.shiftKey && !isComposing && atQuery === null) {
              e.preventDefault()
              handleSend()
            }
          }}
        />

        {/* Bottom bar: mode pill + hints + send button */}
        <div className="flex items-center px-3 pb-2.5 gap-2">
          {/* Mode pill */}
          <button
            onClick={() => setCurrentMode((m) => m === 'build' ? 'plan' : 'build')}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors flex-shrink-0"
            style={currentMode === 'plan' ? {
              background: 'rgba(99,102,241,0.12)',
              border: '1px solid rgba(99,102,241,0.3)',
              color: '#6366f1',
            } : {
              background: 'var(--bg-hover)',
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
            }}
            title="Click or press Tab to switch mode"
          >
            {currentMode === 'plan' ? (
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            ) : (
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
            )}
            {currentMode}
          </button>

          <p className="flex-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Tab · @ · Enter
          </p>

          {sending ? (
            <button
              onClick={handleAbort}
              className="rounded-full w-8 h-8 flex items-center justify-center transition-colors"
              style={{ background: 'var(--text-secondary)' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#ef4444')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--text-secondary)')}
              title="Stop"
            >
              <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="1" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="rounded-full w-8 h-8 flex items-center justify-center transition-colors disabled:opacity-30"
              style={{ background: 'var(--btn-send)' }}
              onMouseEnter={e => { if (input.trim()) e.currentTarget.style.background = 'var(--btn-send-hover)' }}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--btn-send)')}
              title="Send"
            >
              <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )

  // ── Model pill ───────────────────────────────────────────────────────────
  const modelPill = (
    <div className="relative" ref={modelDropdownRef}>
      <button
        onClick={() => setModelOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] transition-colors"
        style={{
          color: 'var(--text-muted)',
          border: '1px solid var(--border)',
          background: 'var(--bg-surface)',
          fontFamily: 'inherit',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
      >
        <svg className="w-2.5 h-2.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        <span className="truncate max-w-[180px]">
          {currentModel ? currentModel.split('/').pop() : 'default model'}
        </span>
        <svg
          className="w-2.5 h-2.5 flex-shrink-0 transition-transform"
          style={{ transform: modelOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {modelOpen && models.length > 0 && (
        <div
          className="absolute bottom-full mb-1 left-0 z-50 rounded-xl py-1 overflow-y-auto"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
            minWidth: '220px',
            maxHeight: '260px',
          }}
        >
          {models.map((m) => (
            <button
              key={m}
              onClick={() => handleModelSelect(m)}
              className="w-full text-left px-3 py-1.5 text-[11px] transition-colors flex items-center gap-2"
              style={{
                color: m === currentModel ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: m === currentModel ? 500 : 400,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {m === currentModel
                ? <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--green-dot)' }} />
                : <span className="w-1.5 h-1.5 flex-shrink-0" />
              }
              <span className="truncate">{m}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div className="flex flex-col flex-1 min-h-0" style={{ background: 'var(--bg-app)' }}>

      {messages.length === 0 ? (
        // ── Empty state ──────────────────────────────────────────────────
        <div className="flex-1 flex flex-col items-center justify-center px-6">
          <div className="mb-6 select-none">
            <span
              style={{
                fontFamily: "'Press Start 2P', monospace",
                fontSize: '0.8rem',
                color: 'var(--text-primary)',
                letterSpacing: '0.04em',
                textShadow: '2px 2px 0 var(--border)',
                lineHeight: 1,
              }}
            >
              slides-it
            </span>
          </div>
          <div style={{ width: '100%', maxWidth: '560px' }}>
            {inputBox}
            <div className="mt-2 flex justify-start">
              {modelPill}
            </div>
          </div>
        </div>
      ) : (
        // ── Chat mode ────────────────────────────────────────────────────
        <>
          <div
            className="px-5 py-2 flex items-center justify-between flex-shrink-0"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            {modelPill}
            <button
              onClick={handleNewChat}
              className="text-xs transition-colors"
              style={{ color: 'var(--text-muted)' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
            >
              New Chat
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-5 space-y-1">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {chatError && (
            <div
              className="mx-4 mb-2 px-3 py-2 rounded text-xs"
              style={{
                background: 'var(--error-bg)',
                border: '1px solid var(--error-border)',
                color: 'var(--error)',
              }}
            >
              {chatError}
            </div>
          )}

          <div className="flex-shrink-0 px-4 pb-4 pt-2">
            {inputBox}
          </div>
        </>
      )}
    </div>
  )
}

// ── MessageBubble ──────────────────────────────────────────────────────────
function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user'
  const attachments = (msg as ChatMessage & { attachmentNames?: string[] }).attachmentNames

  return (
    <div
      className="py-3 px-4 rounded-2xl"
      style={isUser ? { background: 'var(--bg-user-msg)' } : { background: 'transparent' }}
    >
      {/* Role + timestamp */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: isUser ? 'var(--text-secondary)' : 'var(--green-dot)' }}
        />
        <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
          {isUser ? 'you' : 'agent'}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* @ attachment badges */}
      {attachments && attachments.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {attachments.map((name) => (
            <span
              key={name}
              className="text-[10px] px-2 py-0.5 rounded"
              style={{
                background: 'rgba(99,102,241,0.1)',
                border: '1px solid rgba(99,102,241,0.2)',
                color: '#6366f1',
              }}
            >
              📎 {name}
            </span>
          ))}
        </div>
      )}

      {/* Tool blocks */}
      {msg.tools.map((t) => <ToolBlock key={t.id} tool={t} />)}

      {/* Body */}
      {msg.error ? (
        <p className="text-sm" style={{ color: 'var(--error)' }}>{msg.error}</p>
      ) : msg.streaming && msg.text === '' ? (
        <ThinkingDots />
      ) : msg.streaming ? (
        <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-primary)' }}>
          {msg.text}
          <span
            className="inline-block w-0.5 h-4 ml-0.5 animate-pulse align-middle"
            style={{ background: 'var(--text-muted)' }}
          />
        </p>
      ) : isUser ? (
        <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-primary)' }}>
          {msg.text}
        </p>
      ) : (
        <Suspense fallback={
          <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-primary)' }}>
            {msg.text}
          </p>
        }>
          <MarkdownRenderer content={msg.text} className="chat-markdown text-sm" />
        </Suspense>
      )}
    </div>
  )
}
