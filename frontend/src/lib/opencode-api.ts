// OpenCode Server API client
// All communication with opencode serve (localhost:4096) goes through here.

import { getFileBase64 } from './slides-server-api'

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
  system?: string,
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
 * Determine if a file should be sent as a binary FilePart (image/PDF)
 * or referenced by path in the message text.
 *
 * Claude (Anthropic) only supports file attachments for:
 *   - Images: png, jpg, jpeg, gif, webp, svg
 *   - Documents: pdf
 * All other file types (code, html, text, etc.) must be referenced by path
 * so the agent can read them with its own tools.
 */
const BINARY_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'])

export function isAttachableAsFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return BINARY_EXTS.has(ext)
}

/**
 * Read a binary file (image/PDF) via the slides-it server and return a FilePart.
 * Only call this for files where isAttachableAsFile() returns true.
 *
 * Uses /api/file-base64 (reads raw bytes server-side) instead of opencode's
 * /file/content (text-only) to avoid base64 corruption of binary data.
 */
export async function fileToFilePart(path: string): Promise<FilePart> {
  const name = path.split('/').pop() ?? path
  const { base64, mime } = await getFileBase64(path)
  return {
    type: 'file',
    mime,
    filename: name,
    url: `data:${mime};base64,${base64}`,
  }
}

