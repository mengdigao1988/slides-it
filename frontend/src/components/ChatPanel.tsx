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
  replyQuestion,
  rejectQuestion,
  fileToFilePart,
  isAttachableAsFile,
  findFiles,
  type FilePart,
} from '../lib/opencode-api'
import {
  enqueueDelta,
  flushAll,
  MS_PER_CHAR,
  type ChatMessage,
  type PendingMap,
  type ToolEntry,
  type QuestionRequest,
} from '../lib/typewriter'
import { getModels, setModel, listTemplates, getSession, saveSession } from '../lib/slides-server-api'
import ThinkingDots from './ThinkingDots'
import ToolBlock from './ToolBlock'
import QuestionBlock from './QuestionBlock'
import AtPopover from './AtPopover'

const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'))

type Mode = 'build' | 'plan'

interface ChatPanelProps {
  workspacePath: string
  activeSkill?: string
  activeTemplate?: string
  onTemplateChange?: (name: string) => Promise<string>
  onHtmlGenerated: (path: string) => void
}

interface AtReference {
  path: string
  name: string
}

export default function ChatPanel({ workspacePath, activeSkill, activeTemplate, onTemplateChange, onHtmlGenerated }: ChatPanelProps) {
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

  // Template pill
  const [templateList, setTemplateList] = useState<string[]>([])
  const [templateOpen, setTemplateOpen] = useState(false)
  const templateDropdownRef = useRef<HTMLDivElement>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const msgMapRef = useRef<Map<string, string>>(new Map())
  const partMapRef = useRef<Map<string, string>>(new Map())
  const partTypeRef = useRef<Map<string, string>>(new Map())
  // Refs that mirror state so SSE callbacks always read the latest values
  const sessionIdRef = useRef<string | null>(null)
  const messagesRef = useRef<ChatMessage[]>([])
  // True during initSession — blocks the idle SSE handler from wiping restored state
  const restoringRef = useRef(true)
  const pendingCharsRef = useRef<PendingMap>(new Map())
  const rafRef = useRef<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Track the name of the currently running tool for ThinkingDots label
  const runningToolRef = useRef<string>('')
  const [runningTool, setRunningTool] = useState('')
  // Map question requestID → bubble ID (to attach question to the right bubble)
  const questionBubbleRef = useRef<Map<string, string>>(new Map())
  // Track answered question labels for read-only display
  const questionAnswersRef = useRef<Map<string, string[][]>>(new Map())

  // ── Load models ──────────────────────────────────────────────────────────
  useEffect(() => {
    getModels().then((res) => {
      setModels(res.models)
      setCurrentModel(res.current)
    }).catch(() => {})
  }, [])

  // Keep refs in sync so SSE callbacks always read the latest values
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  useEffect(() => { messagesRef.current = messages }, [messages])

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

  // Load template list + close on outside click
  useEffect(() => {
    if (!templateOpen) return
    listTemplates().then((list) => setTemplateList(list.map((t) => t.name))).catch(() => {})
  }, [templateOpen])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (templateDropdownRef.current && !templateDropdownRef.current.contains(e.target as Node)) {
        setTemplateOpen(false)
      }
    }
    if (templateOpen) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [templateOpen])

  async function handleModelSelect(modelID: string) {
    setCurrentModel(modelID)
    setModelOpen(false)
    await setModel(modelID).catch(() => {})
  }

  async function handleTemplateSelect(name: string) {
    setTemplateOpen(false)
    if (name === activeTemplate) return
    // Fetch new skill first, get it back directly (don't rely on React state update timing)
    const newSkill = onTemplateChange ? await onTemplateChange(name) : (activeSkill || undefined)
    // Auto-send a message so the agent actively acknowledges the new template
    if (sessionId) {
      const text = `I've switched to the "${name}" template. Please use this visual style for all future slide generation.`
      setMessages((prev) => [...prev, {
        id: `u-${Date.now()}`,
        role: 'user',
        text,
        streaming: false,
        error: null,
        timestamp: new Date(),
        tools: [],
      }])
      setSending(true)
      try {
        await sendPrompt(sessionId, text, currentModel || undefined, currentMode, undefined, newSkill || undefined)
      } catch (e) {
        setChatError((e as Error).message)
        setSending(false)
      }
    }
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

    async function initSession() {
      restoringRef.current = true   // block idle SSE handler during setup

      // Load saved history from .slides-it/session-<id>.json (via server)
      let savedMessages: ChatMessage[] = []
      try {
        const saved = await getSession()
        if (saved.messages && saved.messages.length > 0) {
          savedMessages = (saved.messages as ChatMessage[]).map((m) => ({
            ...m,
            timestamp: new Date(m.timestamp),
          }))
        }
      } catch { /* no history — start fresh */ }

      if (cancelled) return

      // Always create a fresh OpenCode session (old ones don't survive a server restart)
      try {
        const s = await createSession('slides-it')
        if (cancelled) return

        setSessionId(s.id)
        sessionIdRef.current = s.id

        if (savedMessages.length > 0) {
          setMessages(savedMessages)
          messagesRef.current = savedMessages
          detectHtmlFile()
        }

        // Write new session file immediately (pointer → new session, messages = saved history)
        saveSession(s.id, savedMessages).catch(() => {})
      } catch (err) {
        console.error(err)
      } finally {
        restoringRef.current = false   // unlock idle handler regardless of outcome
      }
    }

    initSession()

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
        // Skip during initSession — prevents the reconnected SSE stream from
        // wiping restored messages before they're set in state
        if (restoringRef.current) return
        flushPending()
        setMessages((prev) => {
          const settled = prev.map((m) => m.streaming ? { ...m, streaming: false } : m)
          // Persist full conversation after every agent turn
          if (sessionIdRef.current) {
            saveSession(sessionIdRef.current, settled).catch(() => {})
          }
          return settled
        })
        setSending(false)
        runningToolRef.current = ''
        setRunningTool('')
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
      runningToolRef.current = ''
      setRunningTool('')
      setSending(false)
    }

    if (type === 'message.updated') {
      // Actual SSE structure: properties.info contains id, role, error
      const info = (properties as { info: { id: string; role: string; error?: unknown } }).info
      if (!info || info.role !== 'assistant') return
      if (!msgMapRef.current.has(info.id)) {
        const bid = `a-${info.id}`
        msgMapRef.current.set(info.id, bid)
        setMessages((prev) => [...prev, {
          id: bid, role: 'assistant', text: '', streaming: true,
          error: null, timestamp: new Date(), tools: [],
        }])
      }
      if (info.error) {
        const errMsg = (info.error as { data?: { message?: string } })?.data?.message ?? 'Error'
        const bid = msgMapRef.current.get(info.id)!
        setMessages((prev) => prev.map((m) =>
          m.id === bid ? { ...m, error: errMsg, streaming: false } : m
        ))
        runningToolRef.current = ''
        setRunningTool('')
        setSending(false)
      }
    }

    if (type === 'message.part.updated') {
      // Actual SSE structure: properties.part contains id, messageID, type, state, tool...
      // partID and messageID are inside part, NOT at properties top-level
      const { part } = properties as {
        part: {
          id: string
          messageID: string
          type: string
          tool?: string
          state?: {
            status: string
            input?: Record<string, unknown>
            output?: string
            title?: string
            error?: string
          }
        }
      }
      const partID = part.id
      const messageID = part.messageID
      const state = part.state
      const status = state?.status ?? ''
      partTypeRef.current.set(partID, part.type)
      const bubbleId = msgMapRef.current.get(messageID)
      if (!bubbleId) return

      if (part.type === 'text') partMapRef.current.set(partID, bubbleId)

      if (part.type === 'tool') {
        const toolName = part.tool ?? ''
        // Track running tool for ThinkingDots
        if (status === 'running') {
          runningToolRef.current = toolName
          setRunningTool(toolName)
        } else if (runningToolRef.current === toolName && (status === 'completed' || status === 'error')) {
          runningToolRef.current = ''
          setRunningTool('')
        }

        const toolEntry: ToolEntry = {
          id: partID,
          name: toolName,
          tool: toolName,
          status,
          title: state?.title,
          input: state?.input,
          output: state?.output,
          error: state?.error,
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
      if (field !== 'text') return

      // Reasoning/thinking — accumulate into bubble's `thinking` field (don't typewrite)
      if (partTypeRef.current.get(partID) === 'reasoning') {
        const bid = msgMapRef.current.get(messageID)
        if (bid) {
          setMessages((prev) => prev.map((m) =>
            m.id === bid ? { ...m, thinking: (m.thinking ?? '') + delta } : m
          ))
        }
        return
      }

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

    // ── AskUserQuestion ────────────────────────────────────────────────────
    if (type === 'question.asked') {
      const req = properties as unknown as QuestionRequest
      // Attach the question to the most recent assistant bubble
      setMessages((prev) => {
        const lastAssistant = [...prev].reverse().find((m) => m.role === 'assistant')
        if (!lastAssistant) {
          // No bubble yet — create one
          const bid = `a-q-${req.id}`
          questionBubbleRef.current.set(req.id, bid)
          return [...prev, {
            id: bid, role: 'assistant', text: '', streaming: true,
            error: null, timestamp: new Date(), tools: [], question: req,
          }]
        }
        questionBubbleRef.current.set(req.id, lastAssistant.id)
        return prev.map((m) =>
          m.id === lastAssistant.id ? { ...m, question: req } : m
        )
      })
    }

    if (type === 'question.replied') {
      const { requestID } = properties as { requestID: string }
      // Clear the question from the bubble (it will show answered summary instead)
      const bid = questionBubbleRef.current.get(requestID)
      if (bid) {
        setMessages((prev) => prev.map((m) =>
          m.id === bid ? { ...m, question: undefined } : m
        ))
      }
    }
  }

  function detectHtmlFile() {
    if (!workspacePath) return
    findFiles('.html', 20)
      .then((files) => {
        const html = files
          .filter((f) => f.path.endsWith('.html'))
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

    // Build file parts from @ references.
    // Only images and PDFs are sent as binary FileParts (Claude supports these natively).
    // Text/code/html files are referenced by path in the message text — the agent
    // reads them with its own tools. Sending them as FileParts causes
    // "media type: text/html functionality not supported" errors from Anthropic.
    let fileParts: FilePart[] | undefined
    let textWithRefs = text
    if (atReferences.length > 0) {
      const binaryRefs = atReferences.filter((r) => isAttachableAsFile(r.name))
      const textRefs = atReferences.filter((r) => !isAttachableAsFile(r.name))

      // Binary files → FilePart
      if (binaryRefs.length > 0) {
        try {
          fileParts = await Promise.all(binaryRefs.map((r) => fileToFilePart(r.path)))
        } catch {
          // If file read fails, fall back to path reference
          textRefs.push(...binaryRefs)
        }
      }

      // Text files → append paths to message text so agent can read them
      if (textRefs.length > 0) {
        const pathList = textRefs.map((r) => r.path).join('\n')
        textWithRefs = text + '\n\n' + pathList
      }

      setAtReferences([])
    }

    // Build display text (show @ refs in bubble)
    const attachmentNames = atReferences.map((r) => r.name)

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`, role: 'user', text, streaming: false,
      error: null, timestamp: new Date(), tools: [],
      attachmentNames: attachmentNames.length > 0 ? attachmentNames : undefined,
    }
    setMessages((prev) => [...prev, userMsg])
    setSending(true)

    // Persist immediately so the user's message survives even if the agent crashes
    if (sessionId) {
      saveSession(sessionId, [...messagesRef.current, userMsg]).catch(() => {})
    }

    try {
      await sendPrompt(sessionId, textWithRefs, currentModel || undefined, currentMode, fileParts, activeSkill || undefined)
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
    runningToolRef.current = ''
    setRunningTool('')
    setSending(false)
  }

  async function handleQuestionReply(requestId: string, answers: string[][]) {
    // Store answers for read-only display
    questionAnswersRef.current.set(requestId, answers)
    // Show answered summary in bubble immediately (optimistic)
    const bid = questionBubbleRef.current.get(requestId)
    if (bid) {
      setMessages((prev) => prev.map((m) =>
        m.id === bid
          ? { ...m, question: undefined, questionAnswered: { requestId, answers, questions: m.question?.questions ?? [] } }
          : m
      ))
    }
    await replyQuestion(requestId, answers).catch(() => {})
  }

  async function handleQuestionReject(requestId: string) {
    // Clear question from bubble
    const bid = questionBubbleRef.current.get(requestId)
    if (bid) {
      setMessages((prev) => prev.map((m) =>
        m.id === bid ? { ...m, question: undefined } : m
      ))
    }
    await rejectQuestion(requestId).catch(() => {})
  }

  async function handleNewChat() {
    flushPending()
    if (rafRef.current) { clearTimeout(rafRef.current); rafRef.current = null }
    msgMapRef.current.clear(); partMapRef.current.clear(); partTypeRef.current.clear()
    questionBubbleRef.current.clear(); questionAnswersRef.current.clear()
    setMessages([])
    setSending(false)
    runningToolRef.current = ''
    setRunningTool('')
    setAtReferences([])
    setAtQuery(null)
    const s = await createSession('slides-it').catch(() => null)
    if (s) {
      setSessionId(s.id)
      saveSession(s.id, []).catch(() => {})
    }
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

  // ── Template pill ─────────────────────────────────────────────────────────
  const templatePill = onTemplateChange ? (
    <div className="relative" ref={templateDropdownRef}>
      <button
        onClick={() => setTemplateOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] transition-colors"
        style={{
          color: 'var(--text-muted)',
          border: '1px solid var(--border)',
          background: 'var(--bg-surface)',
          fontFamily: 'inherit',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
        title="Switch template"
      >
        <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: 'var(--text-muted)' }} />
        <span className="truncate max-w-[100px]">{activeTemplate ?? 'default'}</span>
        <svg
          className="w-2.5 h-2.5 flex-shrink-0 transition-transform"
          style={{ transform: templateOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {templateOpen && (
        <div
          className="absolute bottom-full mb-1 left-0 z-50 rounded-xl py-1 overflow-y-auto"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
            minWidth: '160px',
            maxHeight: '200px',
          }}
        >
          {(templateList.length > 0 ? templateList : [activeTemplate ?? 'default']).map((t) => (
            <button
              key={t}
              onClick={() => handleTemplateSelect(t)}
              className="w-full text-left px-3 py-1.5 text-[11px] transition-colors flex items-center gap-2"
              style={{
                color: t === activeTemplate ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: t === activeTemplate ? 500 : 400,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {t === activeTemplate
                ? <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--green-dot)' }} />
                : <span className="w-1.5 h-1.5 flex-shrink-0" />
              }
              <span className="truncate">{t}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  ) : null

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
                fontFamily: "'Söhne', ui-sans-serif, -apple-system, sans-serif",
                fontSize: '1.75rem',
                fontWeight: 600,
                color: 'var(--text-primary)',
                letterSpacing: '-0.02em',
                lineHeight: 1,
              }}
            >
              slides-it
            </span>
          </div>
          <div style={{ width: '100%', maxWidth: '560px' }}>
            {inputBox}
            <div className="mt-2 flex justify-start gap-2">
              {templatePill}
              {modelPill}
            </div>
          </div>
        </div>
      ) : (
        // ── Chat mode ────────────────────────────────────────────────────
        <>
          <div
            className="px-5 py-2 flex items-center justify-end flex-shrink-0"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
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
              <MessageBubble
                key={msg.id}
                msg={msg}
                runningTool={runningTool}
                onQuestionReply={handleQuestionReply}
                onQuestionReject={handleQuestionReject}
              />
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
            <div className="mt-2 flex justify-start gap-2">
              {templatePill}
              {modelPill}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── MessageBubble ──────────────────────────────────────────────────────────
function MessageBubble({
  msg,
  runningTool,
  onQuestionReply,
  onQuestionReject,
}: {
  msg: ChatMessage
  runningTool: string
  onQuestionReply: (requestId: string, answers: string[][]) => void
  onQuestionReject: (requestId: string) => void
}) {
  const isUser = msg.role === 'user'
  const attachments = (msg as ChatMessage & { attachmentNames?: string[] }).attachmentNames
  const [thinkingOpen, setThinkingOpen] = useState(false)

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

      {/* Thinking/reasoning block (folded by default) */}
      {msg.thinking && (
        <div className="mb-2">
          <button
            onClick={() => setThinkingOpen((o) => !o)}
            className="flex items-center gap-1.5 text-[11px] transition-colors mb-1"
            style={{ color: 'var(--text-muted)', fontFamily: 'inherit' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
          >
            <svg
              className="w-2.5 h-2.5 flex-shrink-0 transition-transform"
              style={{ transform: thinkingOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Thinking…
          </button>
          {thinkingOpen && (
            <div
              className="text-[11px] leading-relaxed px-3 py-2 rounded-lg overflow-y-auto"
              style={{
                background: 'var(--bg-sidebar)',
                border: '1px solid var(--border)',
                color: 'var(--text-muted)',
                maxHeight: '200px',
                whiteSpace: 'pre-wrap',
              }}
            >
              {msg.thinking}
            </div>
          )}
        </div>
      )}

      {/* Tool blocks */}
      {msg.tools.map((t) => <ToolBlock key={t.id} tool={t} />)}

      {/* Pending question (interactive) */}
      {msg.question && (
        <QuestionBlock
          question={msg.question}
          onReply={onQuestionReply}
          onReject={onQuestionReject}
        />
      )}

      {/* Answered question (read-only summary) */}
      {msg.questionAnswered && (
        <QuestionBlock
          question={{ id: msg.questionAnswered.requestId, sessionID: '', questions: msg.questionAnswered.questions }}
          onReply={() => {}}
          onReject={() => {}}
          answered
          answeredLabels={msg.questionAnswered.answers}
        />
      )}

      {/* Body */}
      {msg.error ? (
        <p className="text-sm" style={{ color: 'var(--error)' }}>{msg.error}</p>
      ) : msg.streaming && msg.text === '' && msg.tools.length === 0 && !msg.question ? (
        <ThinkingDots toolName={runningTool} />
      ) : msg.streaming && msg.text === '' ? (
        null
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
