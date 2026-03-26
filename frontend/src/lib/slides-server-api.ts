// slides-it local server API
// Uses relative paths so it works in both dev (Vite proxy → localhost:3001)
// and production (same-origin, served by FastAPI on localhost:3000).

const BASE = ''  // relative — no hardcoded host

export interface DirEntry {
  name: string
  path: string
  has_children: boolean
}

export interface FsEntry {
  name: string
  path: string
  type: 'directory' | 'file'
  has_children: boolean
}

export interface StatusResponse {
  ready: boolean
  workspace: string
  opencode_version: string
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
      msg = body.detail ?? body.message ?? msg
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export function listDirs(path: string): Promise<DirEntry[]> {
  return request<DirEntry[]>(`/api/dirs?path=${encodeURIComponent(path)}`)
}

/** List directories AND files in a directory. */
export function listEntries(path: string): Promise<FsEntry[]> {
  return request<FsEntry[]>(`/api/ls?path=${encodeURIComponent(path)}`)
}

export function startWorkspace(directory: string): Promise<{ status: string; workspace: string }> {
  return request(`/api/start`, {
    method: 'POST',
    body: JSON.stringify({ directory }),
  })
}

export function getStatus(): Promise<StatusResponse> {
  return request<StatusResponse>('/api/status')
}

/**
 * Upload files into the active workspace.
 */
export async function uploadFiles(
  files: File[],
  targetDir = '',
): Promise<{ uploaded: string[] }> {
  const form = new FormData()
  for (const file of files) {
    form.append('files', file)
  }
  const url = targetDir
    ? `/api/upload?target_dir=${encodeURIComponent(targetDir)}`
    : '/api/upload'
  const res = await fetch(url, { method: 'POST', body: form })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json()
      msg = body.detail ?? body.message ?? msg
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.json() as Promise<{ uploaded: string[] }>
}

export interface ModelsResponse {
  models: string[]
  current: string
}

export function getModels(): Promise<ModelsResponse> {
  return request<ModelsResponse>('/api/models')
}

export function setModel(modelID: string): Promise<{ modelID: string }> {
  return request<{ modelID: string }>('/api/model', {
    method: 'PUT',
    body: JSON.stringify({ modelID }),
  })
}

export interface TemplateSkillResponse {
  skill: string
}

/**
 * Fetch the combined system prompt (core SKILL.md + template SKILL.md)
 * for the given template name.
 */
export function getTemplateSkill(name: string): Promise<TemplateSkillResponse> {
  return request<TemplateSkillResponse>(`/api/template/${encodeURIComponent(name)}/skill`)
}

export interface TemplatePreviewResponse {
  html: string
}

export function getTemplatePreview(name: string): Promise<TemplatePreviewResponse> {
  return request<TemplatePreviewResponse>(`/api/template/${encodeURIComponent(name)}/preview`)
}

export interface TemplateEntry {
  name: string
  description: string
  author: string
  version: string
  builtin: boolean
  active: boolean
  has_preview: boolean
}

export function listTemplates(): Promise<TemplateEntry[]> {
  return request<TemplateEntry[]>('/api/templates')
}

export function installTemplate(source: string): Promise<{ name: string; status: string }> {
  return request<{ name: string; status: string }>('/api/templates/install', {
    method: 'POST',
    body: JSON.stringify({ source }),
  })
}

export function removeTemplate(name: string): Promise<{ name: string; status: string }> {
  return request<{ name: string; status: string }>(`/api/templates/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

export function activateTemplate(name: string): Promise<{ name: string; status: string }> {
  return request<{ name: string; status: string }>(`/api/templates/${encodeURIComponent(name)}/activate`, {
    method: 'PUT',
  })
}

export interface SettingsResponse {
  providerID: string
  apiKeyMasked: string
  baseURL: string
  customModel: string
}

export interface SettingsRequest {
  providerID: string
  apiKey: string
  baseURL: string
  customModel: string
  clearKey: boolean
}

export function getSettings(): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings')
}

export function saveSettings(s: SettingsRequest): Promise<{ status: string }> {
  return request<{ status: string }>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(s),
  })
}

/** Return the persisted session ID and message history for the current workspace. */
export function getSession(): Promise<{ session_id: string | null; messages: object[] }> {
  return request<{ session_id: string | null; messages: object[] }>('/api/session')
}

/** Persist the active session ID and message history to .slides-it/history.json. */
export function saveSession(sessionId: string, messages: object[]): Promise<{ status: string }> {
  return request<{ status: string }>('/api/session', {
    method: 'PUT',
    body: JSON.stringify({ session_id: sessionId, messages }),
  })
}

