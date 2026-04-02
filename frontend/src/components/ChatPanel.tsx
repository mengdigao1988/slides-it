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
  injectContext,
  type Todo,
} from '../lib/opencode-api'
import {
  enqueueDelta,
  flushAll,
  MS_PER_CHAR,
  CHARS_PER_TICK,
  type ChatMessage,
  type PendingMap,
  type ToolEntry,
  type QuestionRequest,
} from '../lib/typewriter'
import { getModels, setModel, getSession, saveSession, uploadFiles, listIndustries, postReplay, checkReplayOverflow, type IndustryEntry } from '../lib/slides-server-api'
import ThinkingDots from './ThinkingDots'
import ToolBlock from './ToolBlock'
import QuestionBlock from './QuestionBlock'
import AtPopover from './AtPopover'
import DesignModal from './DesignModal'
import ModelModal from './ModelModal'
import TodoBubble from './TodoBubble'

const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'))

type Mode = 'build' | 'plan'

interface ChatPanelProps {
  workspacePath: string
  activeSkill?: string
  activeDesign?: string
  onDesignChange?: (name: string) => Promise<string>
  activeIndustry?: string
  onIndustryChange?: (name: string) => Promise<string>
  onHtmlGenerated: (path: string) => void
  modelRefreshToken?: number
}

interface AtReference {
  path: string
  name: string
}

export default function ChatPanel({ workspacePath, activeSkill, activeDesign, onDesignChange, activeIndustry, onIndustryChange, onHtmlGenerated, modelRefreshToken }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [chatError, setChatError] = useState('')
  const [isComposing, setIsComposing] = useState(false)

  // Mode
  const [currentMode, setCurrentMode] = useState<Mode>('plan')

  // @ references
  const [atQuery, setAtQuery] = useState<string | null>(null)
  const [atStartPos, setAtStartPos] = useState(0)
  const [atReferences, setAtReferences] = useState<AtReference[]>([])

  // Model
  const [currentModel, setCurrentModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [modelModalOpen, setModelModalOpen] = useState(false)
  const [modelSwitchError, setModelSwitchError] = useState('')

  // Design button
  const [designModalOpen, setDesignModalOpen] = useState(false)

  // Industry dropdown
  const [industries, setIndustries] = useState<IndustryEntry[]>([])
  const [industryOpen, setIndustryOpen] = useState(false)
  const industryDropdownRef = useRef<HTMLDivElement>(null)

  const messagesContainerRef = useRef<HTMLDivElement>(null)
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
  // ESC-to-abort: warning state + auto-dismiss timer
  const [escWarning, setEscWarning] = useState(false)
  const escTimerRef = useRef<number | null>(null)
  // Map question requestID → bubble ID (to attach question to the right bubble)
  const questionBubbleRef = useRef<Map<string, string>>(new Map())
  // Track answered question labels for read-only display
  const questionAnswersRef = useRef<Map<string, string[][]>>(new Map())
  // Sub-agent tracking: childSessionID → { bubbleId, taskPartId } so child tool events
  // can be routed to the parent task tool's childTools array
  const childSessionMapRef = useRef<Map<string, { bubbleId: string; taskPartId: string }>>(new Map())
  // Running task tools awaiting child session association: partId → { bubbleId }
  const pendingTaskToolsRef = useRef<Map<string, { bubbleId: string }>>(new Map())
  // Replay — infinite context
  const replayingRef = useRef(false)
  const lastPromptRef = useRef<{
    text: string; model?: string; mode: Mode; system?: string
  } | null>(null)
  // Index in the messages array where the current session's own messages start.
  // Messages before this index belong to parent sessions (loaded from chain).
  const sessionStartIdxRef = useRef(0)
  // Parent session ID for the current session (set during replay)
  const parentSessionIdRef = useRef<string | undefined>(undefined)

  /** Return only the current session's own messages (for saving to disk). */
  function currentSessionMessages(): ChatMessage[] {
    return messagesRef.current.slice(sessionStartIdxRef.current)
  }

  /** Save current session's messages to disk. */
  function persistCurrentSession(): void {
    if (!sessionIdRef.current) return
    saveSession(
      sessionIdRef.current,
      currentSessionMessages(),
      parentSessionIdRef.current,
    ).catch(() => {})
  }

  // ── Load models ──────────────────────────────────────────────────────────
  useEffect(() => {
    getModels().then((res) => {
      setModels(res.models)
      setCurrentModel(res.current)
    }).catch(() => {})
  }, [modelRefreshToken])

  // ── Load industries ────────────────────────────────────────────────────
  useEffect(() => {
    listIndustries().then(setIndustries).catch(() => {})
  }, [])

  // Keep refs in sync so SSE callbacks always read the latest values
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  useEffect(() => { messagesRef.current = messages }, [messages])

  // Close industry dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (industryDropdownRef.current && !industryDropdownRef.current.contains(e.target as Node)) {
        setIndustryOpen(false)
      }
    }
    if (industryOpen) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [industryOpen])

  async function handleModelSelect(modelID: string) {
    const prev = currentModel
    setCurrentModel(modelID)
    try {
      await setModel(modelID)
    } catch (e) {
      setCurrentModel(prev)
      const msg = (e as Error).message || 'Failed to switch model'
      setModelSwitchError(msg)
      setTimeout(() => setModelSwitchError(''), 3000)
    }
  }

  async function handleDesignSelect(name: string) {
    if (name === activeDesign) return
    // Silently update the system prompt — no message sent to agent.
    // The new design takes effect on the next user message automatically.
    if (onDesignChange) await onDesignChange(name)
  }

  async function handleIndustrySelect(name: string) {
    if (name === activeIndustry) {
      setIndustryOpen(false)
      return
    }
    setIndustryOpen(false)
    // Silently update the system prompt — no message sent to agent.
    // The new industry takes effect on the next user message automatically.
    if (onIndustryChange) await onIndustryChange(name)
  }

  // ── Typewriter ──────────────────────────────────────────────────────────
  const typewriterTick = useCallback(() => {
    const pending = pendingCharsRef.current
    if (pending.size === 0) { rafRef.current = null; return }
    setMessages((prev) =>
      prev.map((m) => {
        const chars = pending.get(m.id)
        if (!chars) return m
        const take = chars.slice(0, CHARS_PER_TICK)
        const rest = chars.slice(CHARS_PER_TICK)
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

      // Load saved history from .slides-it/session-<id>.json (via server).
      // The server walks the parent chain and returns:
      //   messages:        full reconstructed history (all sessions)
      //   recent_messages: only the latest session's own messages
      let savedMessages: ChatMessage[] = []
      let recentMessages: ChatMessage[] = []
      let previousSessionId: string | null = null
      try {
        const saved = await getSession()
        previousSessionId = saved.session_id ?? null
        if (saved.messages && saved.messages.length > 0) {
          savedMessages = (saved.messages as ChatMessage[]).map((m) => ({
            ...m,
            timestamp: new Date(m.timestamp),
          }))
        }
        if (saved.recent_messages && saved.recent_messages.length > 0) {
          recentMessages = (saved.recent_messages as ChatMessage[]).map((m) => ({
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
        }

        // New messages in this session start after all loaded history
        sessionStartIdxRef.current = savedMessages.length
        // Link to the previous session so the chain stays connected
        parentSessionIdRef.current = previousSessionId ?? undefined

        // Write new session file — empty messages, linked to previous session
        saveSession(
          s.id,
          [],
          previousSessionId ?? undefined,
        ).catch(() => {})

        // ── Inject recent conversation history into the new OpenCode session ──
        if (recentMessages.length > 0) {
          const contextParts = recentMessages
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text)
            .map((m) => `[${m.role}]: ${m.text}`)

          if (contextParts.length > 0) {
            const contextText =
              '[Conversation history restored from previous session]\n\n' +
              contextParts.join('\n\n') +
              '\n\n[End of restored history — continue from here]'
            // Fire-and-forget: inject context but don't block init.
            // If it fails, the session still works — just without history context.
            injectContext(s.id, contextText, activeSkill || undefined).catch(() => {})
          }
        }
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
        // Skip during initSession — prevents reconnected SSE from wiping restored messages
        if (restoringRef.current) return
        flushPending()
        setMessages((prev) =>
          prev.map((m) => m.streaming ? { ...m, streaming: false } : m)
        )
        setSending(false)
        runningToolRef.current = ''
        setRunningTool('')
        // Push save to next event loop tick so React has committed state
        // and messagesRef.current holds the fully settled messages
        setTimeout(() => {
          persistCurrentSession()
        }, 0)
      }
    }

    if (type === 'session.error') {
      const errData = properties.error as { name?: string; data?: { message?: string } } | undefined
      const errMsg = errData?.data?.message ?? errData?.name ?? 'Unknown error'

      // ── Replay: auto-detect context overflow and compact ────────────
      // Skip if we're already replaying (prevent infinite loops)
      if (!replayingRef.current && sessionIdRef.current) {
        checkReplayOverflow(errMsg).then((res) => {
          if (!res.is_overflow) return
          performReplay()
        }).catch(() => {})
      }

      if (!replayingRef.current) {
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
      }
      runningToolRef.current = ''
      setRunningTool('')
      setSending(false)
    }

    if (type === 'todo.updated') {
      const todos = properties.todos
      if (Array.isArray(todos) && todos.length > 0) {
        setMessages((prev) => [...prev, {
          id: `todos-${Date.now()}`,
          role: 'todos',
          text: '',
          streaming: false,
          error: null,
          timestamp: new Date(),
          tools: [],
          todos: todos as Todo[],
        }])
      }
    }

    if (type === 'session.diff') {
      // diffs no longer displayed — ignore
    }

    // ── Child session created by Task tool — associate with pending task tool ──
    if (type === 'session.created') {
      const session = (properties as { info?: { id?: string; parentID?: string } }).info
      if (session?.id && session.parentID === sessionIdRef.current) {
        // Find the most recently registered pending task tool and associate it
        const entries = Array.from(pendingTaskToolsRef.current.entries())
        if (entries.length > 0) {
          const [taskPartId, { bubbleId }] = entries[entries.length - 1]
          childSessionMapRef.current.set(session.id, { bubbleId, taskPartId })
          pendingTaskToolsRef.current.delete(taskPartId)
        }
      }
    }

    if (type === 'file.edited') {
      const file = properties.file as string | undefined
      if (file?.endsWith('.html')) {
        // file.edited always carries an absolute path from opencode
        const absPath = file.startsWith('/')
          ? file
          : `${workspacePath}/${file}`
        onHtmlGenerated(absPath)
      }
    }

    if (type === 'message.updated') {
      // Actual SSE structure: properties.info contains id, role, sessionID, error
      const info = (properties as { info: { id: string; role: string; sessionID?: string; error?: unknown } }).info
      if (!info || info.role !== 'assistant') return
      // Skip messages from child sessions (sub-agents) — they show via parent task tool
      if (info.sessionID && info.sessionID !== sessionIdRef.current) return
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
      // Actual SSE structure: properties.part contains id, messageID, sessionID, type, state, tool...
      // partID and messageID are inside part, NOT at properties top-level
      const { part } = properties as {
        part: {
          id: string
          messageID: string
          sessionID?: string
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
      const partSessionID = part.sessionID
      const state = part.state
      const status = state?.status ?? ''

      // ── Child session tool events → route to parent task tool's childTools ──
      if (partSessionID && partSessionID !== sessionIdRef.current) {
        if (part.type === 'tool') {
          const mapping = childSessionMapRef.current.get(partSessionID)
          if (mapping) {
            const childTool: ToolEntry = {
              id: partID,
              name: part.tool ?? '',
              tool: part.tool ?? '',
              status,
              title: state?.title,
              input: state?.input,
              output: state?.output,
              error: state?.error,
            }
            setMessages((prev) => prev.map((m) => {
              if (m.id !== mapping.bubbleId) return m
              return {
                ...m,
                tools: m.tools.map((t) => {
                  if (t.id !== mapping.taskPartId) return t
                  const existing = t.childTools ?? []
                  const idx = existing.findIndex((ct) => ct.id === partID)
                  if (idx >= 0) {
                    const updated = [...existing]
                    updated[idx] = childTool
                    return { ...t, childTools: updated }
                  }
                  return { ...t, childTools: [...existing, childTool] }
                }),
              }
            }))
          }
        }
        return // skip all other child session part events
      }

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

        // Register task tools so incoming child sessions can be associated
        if (toolName === 'task' && status === 'running') {
          pendingTaskToolsRef.current.set(partID, { bubbleId })
        }
      }
    }

    if (type === 'message.part.delta') {
      const { partID, messageID, sessionID: deltaSessionID, field, delta } = properties as {
        partID: string; messageID: string; sessionID?: string; field: string; delta?: string
      }
      if (!delta) return
      if (field !== 'text') return
      // Skip child session text deltas — sub-agent output shown via task tool result
      if (deltaSessionID && deltaSessionID !== sessionIdRef.current) return

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
      // Use tool.messageID from the SSE payload to pinpoint the exact bubble.
      // Fallback to heuristic (last assistant bubble) if messageID is absent.
      const toolMessageID = (properties as { tool?: { messageID?: string } }).tool?.messageID
      setMessages((prev) => {
        const target = toolMessageID
          ? prev.find((m) => m.id === `a-${toolMessageID}`)
          : [...prev].reverse().find((m) => m.role === 'assistant')
        if (!target) {
          // No bubble yet — create one
          const bid = `a-q-${req.id}`
          questionBubbleRef.current.set(req.id, bid)
          return [...prev, {
            id: bid, role: 'assistant', text: '', streaming: true,
            error: null, timestamp: new Date(), tools: [], question: req,
          }]
        }
        questionBubbleRef.current.set(req.id, target.id)
        return prev.map((m) =>
          m.id === target.id ? { ...m, question: req } : m
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

  // ── Replay: compact context and continue in a new session ─────────────
  async function performReplay() {
    const sid = sessionIdRef.current
    if (!sid || replayingRef.current) return
    replayingRef.current = true

    // Save the old session's own messages before switching
    persistCurrentSession()

    // Remove the error bubble that triggered the replay (the overflow error)
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.role === 'assistant' && last.error) {
        return prev.slice(0, -1)
      }
      return prev
    })

    // Show a system message: compacting...
    const replayMsgId = `replay-${Date.now()}`
    setMessages((prev) => [...prev, {
      id: replayMsgId, role: 'system' as ChatMessage['role'], text: 'Compacting context...', streaming: false,
      error: null, timestamp: new Date(), tools: [], compact: true,
    }])
    setSending(true)

    try {
      const result = await postReplay(sid)

      // Switch to the new session
      setSessionId(result.new_session_id)
      sessionIdRef.current = result.new_session_id

      // Update the system message to show completion + separator
      setMessages((prev) => prev.map((m) =>
        m.id === replayMsgId
          ? { ...m, text: '--- Context compacted — conversation continues ---' }
          : m
      ))

      // New session's own messages start after the compact separator.
      // Wait for React to commit the state, then update the index and persist.
      setTimeout(() => {
        // The compact separator is the last "system" message; new messages follow it
        sessionStartIdxRef.current = messagesRef.current.length
        parentSessionIdRef.current = sid
        // Save new session file — empty messages (nothing new yet), linked to old session
        saveSession(result.new_session_id, [], sid).catch(() => {})
      }, 0)

      // Resend the last user message that failed due to overflow
      const lastPrompt = lastPromptRef.current
      if (lastPrompt) {
        await sendPrompt(
          result.new_session_id,
          lastPrompt.text,
          lastPrompt.model,
          lastPrompt.mode,
          lastPrompt.system,
        )
      } else {
        setSending(false)
      }
    } catch (e) {
      // Replay itself failed — show the error
      setMessages((prev) => prev.map((m) =>
        m.id === replayMsgId
          ? { ...m, text: '', error: `Replay failed: ${(e as Error).message}` }
          : m
      ))
      setSending(false)
    } finally {
      replayingRef.current = false
    }
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || sending || !sessionId) return
    setChatError('')
    setInput('')
    resize()

    // All @ references → append file paths to message text.
    // The AI decides how to read each file type based on SKILL.md:
    //   - Images: AI uses `read` tool (OpenCode returns base64 vision attachment)
    //   - Documents (PDF/Excel/Word/PPT/CSV): AI calls /api/documents/extract
    //   - Text/code: AI uses `read` tool directly
    let textWithRefs = text
    if (atReferences.length > 0) {
      const pathList = atReferences.map((r) => r.path).join('\n')
      textWithRefs = text + '\n\n' + pathList
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
    if (sessionIdRef.current) {
      const ownMsgs = [...currentSessionMessages(), userMsg]
      saveSession(sessionIdRef.current, ownMsgs, parentSessionIdRef.current).catch(() => {})
    }

    // Save last prompt info so replay can resend it after context compaction
    lastPromptRef.current = {
      text: textWithRefs,
      model: currentModel || undefined,
      mode: currentMode,
      system: activeSkill || undefined,
    }

    try {
      await sendPrompt(sessionId, textWithRefs, currentModel || undefined, currentMode, activeSkill || undefined)
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
    setEscWarning(false)
    if (escTimerRef.current) { clearTimeout(escTimerRef.current); escTimerRef.current = null }
  }

  // Shared ESC-abort handler — called from both textarea onKeyDown and document listener
  function handleEscPress() {
    if (!sending) return
    if (escWarning) {
      handleAbort()
    } else {
      setEscWarning(true)
      if (escTimerRef.current) clearTimeout(escTimerRef.current)
      escTimerRef.current = window.setTimeout(() => setEscWarning(false), 3000)
    }
  }

  // ── Document-level ESC fallback (fires when textarea is not focused) ──────
  useEffect(() => {
    if (!sending) return
    function handler(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      // Skip if the event originated from the textarea itself — onKeyDown already handles it
      if (e.target === textareaRef.current) return
      e.preventDefault()
      handleEscPress()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [sending, escWarning]) // eslint-disable-line react-hooks/exhaustive-deps

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
    childSessionMapRef.current.clear()
    pendingTaskToolsRef.current.clear()
    setMessages([])
    setSending(false)
    runningToolRef.current = ''
    setRunningTool('')
    setAtReferences([])
    setAtQuery(null)
    // Reset replay state — clean break, no parent chain
    sessionStartIdxRef.current = 0
    parentSessionIdRef.current = undefined
    const s = await createSession('slides-it').catch(() => null)
    if (s) {
      setSessionId(s.id)
      saveSession(s.id, []).catch(() => {})
    }
  }

  useEffect(() => {
    const el = messagesContainerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  function resize() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  // ── @ detection ──────────────────────────────────────────────────────────
  function handleInput(e: React.FormEvent<HTMLTextAreaElement>) {
    // Don't touch atQuery while an IME composition is in progress — the
    // composing buffer may contain spaces or other chars that would falsely
    // dismiss the AtPopover mid-input.
    if (isComposing) {
      resize()
      return
    }

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

  /**
   * Handle paste events on the textarea.
   * If the clipboard contains image files (e.g. a screenshot via Cmd+V or
   * drag-and-drop from another app), upload them to the workspace and inject
   * @filename references so the AI receives their file paths.
   * Plain-text paste falls through to the browser default.
   */
  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData.items)
    const imageItems = items.filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    if (imageItems.length === 0) return  // plain text — let browser handle it

    e.preventDefault()
    const files: File[] = []
    for (const item of imageItems) {
      const file = item.getAsFile()
      if (file) {
        // Give the file a meaningful name if it has none (e.g. "image.png")
        const name = file.name && file.name !== 'image.png'
          ? file.name
          : `pasted-${Date.now()}.png`
        files.push(new File([file], name, { type: file.type }))
      }
    }
    if (files.length === 0) return

    try {
      const { uploaded } = await uploadFiles(files)
      // Inject @filename badges for each uploaded image
      for (const filename of uploaded) {
        setAtReferences((prev) => {
          // The server saves to workspace root; we need the full path.
          // workspacePath is available in the outer component scope.
          const fullPath = `${workspacePath}/${filename}`
          if (prev.find((r) => r.path === fullPath)) return prev
          return [...prev, { path: fullPath, name: filename }]
        })
      }
    } catch {
      // Upload failed silently — don't block the user
    }
  }

  // ── Shared input box ─────────────────────────────────────────────────────
  const inputBox = (
    <div className="relative">
      {/* AtPopover */}
      {atQuery !== null && (
        <AtPopover
          query={atQuery}
          workspacePath={workspacePath}
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
          onPaste={handlePaste}
          onKeyDown={(e) => {
            // Escape: close AtPopover if open; otherwise two-step abort
            if (e.key === 'Escape') {
              if (atQuery !== null) {
                e.preventDefault()
                setAtQuery(null)
                return
              }
              if (sending) {
                e.preventDefault()
                handleEscPress()
              }
              return
            }
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
              background: 'rgba(59,130,246,0.12)',
              border: '1px solid rgba(59,130,246,0.3)',
              color: '#3B82F6',
            } : {
              background: 'rgba(234,88,12,0.10)',
              border: '1px solid rgba(234,88,12,0.3)',
              color: '#EA580C',
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

          {escWarning ? (
            <p className="flex-1 text-[10px] font-medium" style={{ color: '#f97316' }}>
              Press ESC again to stop
            </p>
          ) : (
            <p className="flex-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Tab · @ · Enter · Esc
            </p>
          )}

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

  // ── Design button ─────────────────────────────────────────────────────────
  const designButton = onDesignChange ? (
    <button
      onClick={() => setDesignModalOpen(true)}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] transition-colors"
      style={{
        color: 'var(--text-muted)',
        border: '1px solid var(--border)',
        background: 'var(--bg-surface)',
        fontFamily: 'inherit',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
      title="Manage designs"
    >
      <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
      <span>design</span>
    </button>
  ) : null

  // ── Industry pill ──────────────────────────────────────────────────────
  const industryPill = onIndustryChange && industries.length > 1 ? (
    <div className="relative" ref={industryDropdownRef}>
      <button
        onClick={() => setIndustryOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] transition-colors"
        style={{
          color: activeIndustry && activeIndustry !== 'general' ? '#6366f1' : 'var(--text-muted)',
          border: activeIndustry && activeIndustry !== 'general'
            ? '1px solid rgba(99,102,241,0.3)'
            : '1px solid var(--border)',
          background: activeIndustry && activeIndustry !== 'general'
            ? 'rgba(99,102,241,0.08)'
            : 'var(--bg-surface)',
          fontFamily: 'inherit',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = activeIndustry && activeIndustry !== 'general' ? 'rgba(99,102,241,0.14)' : 'var(--bg-hover)')}
        onMouseLeave={e => (e.currentTarget.style.background = activeIndustry && activeIndustry !== 'general' ? 'rgba(99,102,241,0.08)' : 'var(--bg-surface)')}
        title="Switch industry context"
      >
        <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
        </svg>
        <span className="truncate max-w-[140px]">
          {activeIndustry || 'general'}
        </span>
        <svg
          className="w-2.5 h-2.5 flex-shrink-0 transition-transform"
          style={{ transform: industryOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {industryOpen && industries.length > 0 && (
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
          {industries.map((ind) => (
            <button
              key={ind.name}
              onClick={() => handleIndustrySelect(ind.name)}
              className="w-full text-left px-3 py-1.5 text-[11px] transition-colors flex items-center gap-2"
              style={{
                color: ind.name === activeIndustry ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: ind.name === activeIndustry ? 500 : 400,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {ind.name === activeIndustry
                ? <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--green-dot)' }} />
                : <span className="w-1.5 h-1.5 flex-shrink-0" />
              }
              <span className="flex-1 truncate">{ind.name}</span>
              {ind.description && (
                <span className="text-[9px] truncate max-w-[120px]" style={{ color: 'var(--text-muted)' }}>
                  {ind.description}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  ) : null

  // ── Model pill ───────────────────────────────────────────────────────────
  const modelPill = (
    <button
      onClick={() => setModelModalOpen(true)}
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
    </button>
  )

  // ── Model switch error toast ─────────────────────────────────────────────
  const modelErrorToast = modelSwitchError ? (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-xs font-medium shadow-lg pointer-events-none"
      style={{
        background: 'var(--error-bg)',
        border: '1px solid var(--error-border)',
        color: 'var(--error)',
        maxWidth: '360px',
        textAlign: 'center',
      }}
    >
      {modelSwitchError}
    </div>
  ) : null

  return (
    <div className="flex flex-col flex-1 min-h-0" style={{ background: 'var(--bg-app)' }}>

      {modelErrorToast}

      {/* Design modal */}
      <DesignModal
        open={designModalOpen}
        activeDesign={activeDesign ?? 'default'}
        onClose={() => setDesignModalOpen(false)}
        onActivate={(name) => {
          setDesignModalOpen(false)
          if (onDesignChange) handleDesignSelect(name)
        }}
      />

      {/* Model modal */}
      <ModelModal
        open={modelModalOpen}
        models={models}
        currentModel={currentModel}
        onClose={() => setModelModalOpen(false)}
        onSelect={(m) => handleModelSelect(m)}
      />

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
              {industryPill}
              {designButton}
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

          <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-1">
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                runningTool={runningTool}
                onQuestionReply={handleQuestionReply}
                onQuestionReject={handleQuestionReject}
              />
            ))}
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
              {industryPill}
              {designButton}
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

  // Todos bubble — render the dedicated TodoBubble component
  if (msg.role === 'todos') {
    return <TodoBubble todos={msg.todos ?? []} timestamp={msg.timestamp} />
  }

  // System bubble — replay separator / status messages
  if (msg.role === 'system') {
    return (
      <div className="flex items-center gap-3 py-3 px-4">
        <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
        <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
          {msg.error ?? msg.text}
        </span>
        <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
      </div>
    )
  }

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
          <MarkdownRenderer content={msg.text} className="chat-markdown text-sm" streaming={msg.streaming} />
        </Suspense>
      )}
    </div>
  )
}
