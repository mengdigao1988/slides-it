// OpenCode Server API client
// All communication with opencode serve (localhost:4096) goes through here.

const BASE = 'http://localhost:4096'

export interface Health {
  healthy: boolean
  version: string
}

export interface Session {
  id: string
  title: string
  directory: string
}

export interface MessageInfo {
  id: string
  role: 'user' | 'assistant'
  sessionID: string
  error?: { name: string; data: { message: string } }
}

export interface Part {
  id: string
  type: 'text' | 'tool' | 'reasoning' | string
  text?: string
  tool?: string
  status?: string
  messageID: string
  sessionID: string
}

export interface MessageWithParts {
  info: MessageInfo
  parts: Part[]
}

export interface FileNode {
  path: string
  name: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

export interface PathInfo {
  cwd: string
  root: string
  home: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json()
      msg =
        body.detail ??
        body.message ??
        (Array.isArray(body.error)
          ? body.error.map((e: { message: string }) => e.message).join('; ')
          : typeof body.error === 'string'
          ? body.error
          : msg)
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export function getHealth(): Promise<Health> {
  return request<Health>('/global/health')
}

export function getPath(): Promise<PathInfo> {
  return request<PathInfo>('/path')
}

export function createSession(title: string): Promise<Session> {
  return request<Session>('/session', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

export function getMessages(sessionId: string): Promise<MessageWithParts[]> {
  return request<MessageWithParts[]>(`/session/${sessionId}/message`)
}

export function sendPrompt(
  sessionId: string,
  text: string,
  modelID?: string,
  agent?: 'build' | 'plan',
  system?: string,
): Promise<void> {
  const parts: object[] = [{ type: 'text', text }]
  return request<void>(`/session/${sessionId}/prompt_async`, {
    method: 'POST',
    body: JSON.stringify({
      parts,
      ...(modelID && modelID.includes('/') ? {
        model: {
          providerID: modelID.split('/')[0],
          modelID: modelID.slice(modelID.indexOf('/') + 1),
        },
      } : {}),
      ...(agent ? { agent } : {}),
      ...(system ? { system } : {}),
    }),
  })
}

export function abortSession(sessionId: string): Promise<void> {
  return request<void>(`/session/${sessionId}/abort`, { method: 'POST' })
}

/**
 * Reply to an AskUserQuestion tool call.
 * answers: one string[] per question, each containing the selected label(s).
 */
export function replyQuestion(requestId: string, answers: string[][]): Promise<void> {
  return request<void>(`/question/${encodeURIComponent(requestId)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ answers }),
  })
}

/** Reject (skip) a pending question request. */
export function rejectQuestion(requestId: string): Promise<void> {
  return request<void>(`/question/${encodeURIComponent(requestId)}/reject`, {
    method: 'POST',
  })
}

export function listFiles(path: string): Promise<FileNode[]> {
  return request<FileNode[]>(`/file?path=${encodeURIComponent(path)}`)
}

/**
 * Search for files by name in the workspace.
 * opencode's /find/file returns string[] (paths), not FileNode[].
 */
export async function findFiles(query: string, limit = 10): Promise<{ path: string; name: string }[]> {
  if (!query) return []
  const raw = await request<string[]>(
    `/find/file?query=${encodeURIComponent(query)}&limit=${limit}`,
  )
  return (raw ?? []).map((p) => ({
    path: p,
    name: p.split('/').pop() ?? p,
  }))
}

/**
 * Read the content of a file via opencode.
 * Returns { content: string }.
 */
export function getFileContent(path: string): Promise<{ content: string }> {
  return request<{ content: string }>(
    `/file/content?path=${encodeURIComponent(path)}`,
  )
}

export function connectEventStream(): EventSource {
  return new EventSource(`${BASE}/event`)
}

export interface Todo {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
}

export interface FileDiff {
  file: string
  additions: number
  deletions: number
}

export function getTodos(sessionId: string): Promise<Todo[]> {
  return request<Todo[]>(`/session/${sessionId}/todo`)
}

export function getSessionDiff(sessionId: string): Promise<FileDiff[]> {
  return request<FileDiff[]>(`/session/${sessionId}/diff`)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject context into a session without triggering an AI reply.
 * Used to restore conversation history on page refresh / restart.
 */
export function injectContext(
  sessionId: string,
  contextText: string,
  system?: string,
): Promise<void> {
  return request<void>(`/session/${sessionId}/prompt_async`, {
    method: 'POST',
    body: JSON.stringify({
      noReply: true,
      parts: [{ type: 'text', text: contextText }],
      ...(system ? { system } : {}),
    }),
  })
}

