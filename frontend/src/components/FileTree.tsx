import { useCallback, useEffect, useRef, useState } from 'react'
import { listEntries, uploadFiles, type FsEntry } from '../lib/slides-server-api'

interface FileTreeProps {
  workspacePath: string
  refreshToken?: number
  onFileClick?: (path: string) => void
}

type LiveMode = 'off' | 'polling'

const colorMap: Record<string, string> = {
  py: '#3B82F6', ts: '#60A5FA', tsx: '#60A5FA',
  js: '#F59E0B', jsx: '#F59E0B',
  json: '#10B981', md: '#6B7280', txt: '#9CA3AF',
  yml: '#EF4444', yaml: '#EF4444', toml: '#F97316',
  css: '#EC4899', html: '#F97316', sh: '#22C55E',
}
function fileColor(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return colorMap[ext] ?? '#9CA3AF'
}

interface TreeNodeState {
  node: FsEntry
  children: TreeNodeState[] | null
  open: boolean
  loading: boolean
}
function toState(node: FsEntry): TreeNodeState {
  return { node, children: null, open: false, loading: false }
}
function updateTree(
  nodes: TreeNodeState[],
  path: string,
  fn: (n: TreeNodeState) => TreeNodeState,
): TreeNodeState[] {
  return nodes.map((n) => {
    if (n.node.path === path) return fn(n)
    if (n.children) return { ...n, children: updateTree(n.children, path, fn) }
    return n
  })
}
function findNode(nodes: TreeNodeState[], path: string): TreeNodeState | null {
  for (const n of nodes) {
    if (n.node.path === path) return n
    if (n.children) {
      const f = findNode(n.children, path)
      if (f) return f
    }
  }
  return null
}

export default function FileTree({ workspacePath, refreshToken, onFileClick }: FileTreeProps) {
  const [roots, setRoots] = useState<TreeNodeState[]>([])
  const [error, setError] = useState('')
  const [liveMode, setLiveMode] = useState<LiveMode>('off')
  const [isDragOver, setIsDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const pollingRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)

  const loadRoots = useCallback(async () => {
    if (!workspacePath) return
    try {
      const entries = await listEntries(workspacePath)
      setRoots(entries.map(toState))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [workspacePath])

  useEffect(() => { loadRoots() }, [loadRoots])
  useEffect(() => { if (refreshToken && refreshToken > 0) loadRoots() }, [refreshToken, loadRoots])

  function toggleLiveSync() {
    if (liveMode !== 'off') {
      if (pollingRef.current) clearInterval(pollingRef.current)
      pollingRef.current = null
      setLiveMode('off')
      return
    }
    pollingRef.current = window.setInterval(loadRoots, 4000)
    setLiveMode('polling')
  }
  useEffect(() => () => { if (pollingRef.current) clearInterval(pollingRef.current) }, [])

  async function toggleDir(path: string) {
    const nodes = roots
    const current = findNode(nodes, path)
    if (!current) return
    if (current.open) {
      setRoots((p) => updateTree(p, path, (n) => ({ ...n, open: false })))
      return
    }
    if (current.children !== null) {
      setRoots((p) => updateTree(p, path, (n) => ({ ...n, open: true })))
      return
    }
    setRoots((p) => updateTree(p, path, (n) => ({ ...n, open: true, loading: true })))
    try {
      const children = await listEntries(path)
      setRoots((p) =>
        updateTree(p, path, (n) => ({
          ...n,
          loading: false,
          children: children.map(toState),
        })),
      )
    } catch {
      setRoots((p) => updateTree(p, path, (n) => ({ ...n, loading: false, children: [] })))
    }
  }

  async function handleUpload(files: FileList | File[]) {
    const fileArr = Array.from(files)
    if (!fileArr.length) return
    setUploading(true)
    try {
      await uploadFiles(fileArr)
      await loadRoots()
    } catch (e) {
      setError(`Upload failed: ${(e as Error).message}`)
    } finally {
      setUploading(false)
    }
  }

  function onDragEnter(e: React.DragEvent) {
    e.preventDefault()
    dragCounterRef.current += 1
    if (dragCounterRef.current === 1) setIsDragOver(true)
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault()
    dragCounterRef.current -= 1
    if (dragCounterRef.current === 0) setIsDragOver(false)
  }
  function onDragOver(e: React.DragEvent) { e.preventDefault() }
  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragOver(false)
    if (e.dataTransfer.files.length > 0) handleUpload(e.dataTransfer.files)
  }

  return (
    <div
      className="w-56 flex-shrink-0 flex flex-col overflow-hidden relative"
      style={{
        background: isDragOver ? 'var(--bg-hover)' : 'var(--bg-sidebar)',
        borderRight: `1px solid ${isDragOver ? 'var(--btn-send)' : 'var(--border)'}`,
        transition: 'background 0.15s, border-color 0.15s',
      }}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && handleUpload(e.target.files)}
      />

      {/* Header */}
      <div
        className="px-3 py-2 flex items-center justify-between flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <span
          className="text-[10px] font-mono truncate flex-1"
          style={{ color: 'var(--text-muted)' }}
          title={workspacePath}
        >
          {workspacePath.split('/').pop() || workspacePath}
        </span>
        <div className="flex items-center gap-1.5 ml-2 flex-shrink-0">
          {/* Upload button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center transition-colors"
            style={{ color: 'var(--text-muted)' }}
            title="Upload files to workspace"
          >
            {uploading ? (
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            )}
          </button>

          {/* Live sync toggle */}
          <button
            onClick={toggleLiveSync}
            className="text-[10px] flex items-center gap-1 transition-colors"
            style={{ color: liveMode !== 'off' ? 'var(--green-dot)' : 'var(--text-muted)' }}
          >
            {liveMode !== 'off' && (
              <span
                className="w-1.5 h-1.5 rounded-full animate-pulse"
                style={{ background: 'var(--green-dot)' }}
              />
            )}
            {liveMode === 'off' ? 'sync' : 'live'}
          </button>
        </div>
      </div>

      {/* Drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div
            className="text-[11px] font-medium px-3 py-2 rounded-lg"
            style={{
              color: 'var(--btn-send)',
              border: '1.5px dashed var(--btn-send)',
              background: 'var(--bg-surface)',
            }}
          >
            Drop to upload
          </div>
        </div>
      )}

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {error && (
          <p className="text-[10px] px-3 py-2" style={{ color: 'var(--error)' }}>
            {error}
          </p>
        )}
        {!error && roots.length === 0 && workspacePath && (
          <p className="text-[10px] px-3 py-4 text-center" style={{ color: 'var(--text-muted)' }}>
            Empty folder
          </p>
        )}
        {roots.map((n) => (
          <TreeNode
            key={n.node.path}
            state={n}
            depth={0}
            onToggleDir={toggleDir}
            onFileClick={onFileClick}
          />
        ))}
      </div>
    </div>
  )
}

// ── TreeNode ────────────────────────────────────────────────────────────────
function TreeNode({
  state,
  depth,
  onToggleDir,
  onFileClick,
}: {
  state: TreeNodeState
  depth: number
  onToggleDir: (path: string) => void
  onFileClick?: (path: string) => void
}) {
  const { node, open, loading } = state
  const isDir = node.type === 'directory'

  return (
    <>
      <button
        style={{ paddingLeft: `${4 + depth * 12}px` }}
        className="flex items-center gap-1.5 w-full text-left px-1 py-0.5 rounded transition-colors"
        onClick={() => (isDir ? onToggleDir(node.path) : onFileClick?.(node.path))}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        {/* Chevron — only for dirs */}
        {isDir ? (
          <svg
            className={`w-2.5 h-2.5 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            style={{ color: 'var(--text-muted)' }}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        ) : (
          <span className="w-2.5 h-2.5 flex-shrink-0" />
        )}

        {/* Icon */}
        {isDir ? (
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"
            style={{ color: '#F59E0B' }}>
            {open
              ? <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
              : <path fillRule="evenodd" d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clipRule="evenodd" />
            }
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"
            style={{ color: fileColor(node.name) }}>
            <path fillRule="evenodd"
              d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
              clipRule="evenodd" />
          </svg>
        )}

        {/* Label */}
        <span
          className="text-xs truncate"
          style={{ color: isDir ? 'var(--text-primary)' : 'var(--text-secondary)' }}
        >
          {node.name}
        </span>

        {/* Spinner while loading children */}
        {loading && (
          <svg
            className="w-3 h-3 animate-spin ml-auto flex-shrink-0"
            style={{ color: 'var(--text-muted)' }}
            fill="none" viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        )}
      </button>

      {/* Children */}
      {open && state.children && state.children.map((child) => (
        <TreeNode
          key={child.node.path}
          state={child}
          depth={depth + 1}
          onToggleDir={onToggleDir}
          onFileClick={onFileClick}
        />
      ))}
    </>
  )
}
