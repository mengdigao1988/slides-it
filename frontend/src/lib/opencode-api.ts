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

/** A file attachment sent as base64 data URI in a prompt */
export interface FilePart {
  type: 'file'
  mime: string
  filename: string
  /** Full data URI: "data:{mime};base64,{b64}" */
  url: string
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
  fileParts?: FilePart[],
): Promise<void> {
  const parts: object[] = [{ type: 'text', text }]
  if (fileParts) {
    for (const fp of fileParts) {
      parts.push(fp)
    }
  }
  return request<void>(`/session/${sessionId}/prompt_async`, {
    method: 'POST',
    body: JSON.stringify({
      parts,
      ...(modelID ? { modelID } : {}),
      ...(agent ? { agent } : {}),
    }),
  })
}

export function abortSession(sessionId: string): Promise<void> {
  return request<void>(`/session/${sessionId}/abort`, { method: 'POST' })
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  ts: 'text/plain', tsx: 'text/plain',
  js: 'text/plain', jsx: 'text/plain',
  py: 'text/plain', rb: 'text/plain', go: 'text/plain',
  rs: 'text/plain', java: 'text/plain', c: 'text/plain', cpp: 'text/plain',
  sh: 'text/plain', bash: 'text/plain',
  md: 'text/markdown', txt: 'text/plain',
  json: 'application/json', yaml: 'text/plain', yml: 'text/plain',
  toml: 'text/plain', env: 'text/plain',
  html: 'text/html', css: 'text/css', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
}

export function guessMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return MIME_MAP[ext] ?? 'text/plain'
}

/**
 * Read a file via opencode and return a FilePart ready for sendPrompt.
 */
export async function fileToFilePart(path: string): Promise<FilePart> {
  const name = path.split('/').pop() ?? path
  const mime = guessMime(name)
  const { content } = await getFileContent(path)
  const b64 = btoa(unescape(encodeURIComponent(content)))
  return {
    type: 'file',
    mime,
    filename: name,
    url: `data:${mime};base64,${b64}`,
  }
}

