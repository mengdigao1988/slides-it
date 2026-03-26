import { useCallback, useEffect, useRef, useState } from 'react'
import { listDirs, startWorkspace, getStatus, type DirEntry } from '../lib/slides-server-api'
import SettingsModal from './SettingsModal'

interface WorkspaceSelectorProps {
  onReady: (workspace: string, opencodeVersion: string) => void
}

interface TreeNode {
  entry: DirEntry
  children: TreeNode[] | null
  open: boolean
  loading: boolean
}

const HOME = '~'
const QUICK_ACCESS = [
  { label: 'Home', path: '~' },
  { label: 'Desktop', path: '~/Desktop' },
  { label: 'Documents', path: '~/Documents' },
]

function toNode(entry: DirEntry): TreeNode {
  return { entry, children: null, open: false, loading: false }
}
function updateTree(nodes: TreeNode[], path: string, fn: (n: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map((n) => {
    if (n.entry.path === path) return fn(n)
    if (n.children) return { ...n, children: updateTree(n.children, path, fn) }
    return n
  })
}
function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.entry.path === path) return n
    if (n.children) { const f = findNode(n.children, path); if (f) return f }
  }
  return null
}

export default function WorkspaceSelector({ onReady }: WorkspaceSelectorProps) {
  const [roots, setRoots] = useState<TreeNode[]>([])
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const pollRef = useRef<number | null>(null)
  const rootsRef = useRef<TreeNode[]>([])
  rootsRef.current = roots

  useEffect(() => {
    listDirs(HOME)
      .then((entries) => { setRoots(entries.map(toNode)); setLoading(false) })
      .catch((e) => { setError(e.message); setLoading(false) })
  }, [])

  const toggleNode = useCallback(async (nodePath: string) => {
    const node = findNode(rootsRef.current, nodePath)
    if (!node) return
    if (node.open) { setRoots((p) => updateTree(p, nodePath, (n) => ({ ...n, open: false }))); return }
    if (node.children !== null) { setRoots((p) => updateTree(p, nodePath, (n) => ({ ...n, open: true }))); return }
    setRoots((p) => updateTree(p, nodePath, (n) => ({ ...n, open: true, loading: true })))
    try {
      const entries = await listDirs(nodePath)
      setRoots((p) => updateTree(p, nodePath, (n) => ({ ...n, loading: false, children: entries.map(toNode) })))
    } catch {
      setRoots((p) => updateTree(p, nodePath, (n) => ({ ...n, loading: false, children: [] })))
    }
  }, [])

  async function jumpTo(path: string) {
    setLoading(true); setError('')
    try { const e = await listDirs(path); setRoots(e.map(toNode)) }
    catch (e) { setError((e as Error).message) }
    setLoading(false)
  }

  async function handleOpen() {
    if (!selected) return
    setStarting(true); setError('')
    try {
      await startWorkspace(selected)
      const deadline = Date.now() + 30_000
      pollRef.current = window.setInterval(async () => {
        try {
          const s = await getStatus()
          if (s.ready) {
            clearInterval(pollRef.current!)
            pollRef.current = null
            setStarting(false)
            onReady(s.workspace, s.opencode_version)
            return
          }
        } catch {}
        if (Date.now() > deadline) {
          clearInterval(pollRef.current!)
          pollRef.current = null
          setStarting(false)
          setError('opencode did not start within 30 s. Check your installation and try again.')
        }
      }, 800)
    } catch (e) { setError((e as Error).message); setStarting(false) }
  }

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  return (
    <div
      className="h-screen flex flex-col items-center justify-center"
      style={{ background: 'var(--bg-app)' }}
    >
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <div
        className="w-full max-w-xl flex flex-col rounded-2xl overflow-hidden"
        style={{
          height: '580px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.08)',
        }}
      >
        {/* Header */}
        <div
          className="px-6 py-5 flex items-start justify-between flex-shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div>
            <h1 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              Choose workspace folder
            </h1>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Generated slides will be saved here
            </p>
          </div>
          {/* Settings gear */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="w-7 h-7 flex items-center justify-center rounded-lg transition-colors flex-shrink-0 ml-2"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            title="Settings"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>

        {/* Quick access */}
        <div className="px-4 py-2 flex items-center gap-1.5 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-[10px] uppercase tracking-wider mr-1" style={{ color: 'var(--text-muted)' }}>
            Quick
          </span>
          {QUICK_ACCESS.map((q) => (
            <button
              key={q.path}
              onClick={() => jumpTo(q.path)}
              className="text-xs px-2.5 py-1 rounded-lg transition-colors"
              style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {q.label}
            </button>
          ))}
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-y-auto py-1">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <div
                className="animate-spin w-5 h-5 rounded-full border-2"
                style={{ borderColor: 'var(--border)', borderTopColor: 'var(--text-secondary)' }}
              />
            </div>
          )}
          {!loading && roots.length === 0 && (
            <p className="text-xs text-center py-8" style={{ color: 'var(--text-muted)' }}>
              No folders found
            </p>
          )}
          {!loading && roots.map((node) => (
            <DirNode
              key={node.entry.path}
              node={node}
              depth={0}
              selected={selected}
              onSelect={setSelected}
              onToggle={toggleNode}
              onOpen={handleOpen}
            />
          ))}
        </div>

        {/* Footer */}
        <div
          className="px-4 py-3 flex items-center gap-3 flex-shrink-0"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <span className="flex-1 text-xs font-mono truncate" style={{ color: 'var(--text-muted)' }}>
            {selected || 'No folder selected'}
          </span>
          {error && <span className="text-xs" style={{ color: 'var(--error)' }}>{error}</span>}
          <button
            onClick={handleOpen}
            disabled={!selected || starting}
            className="flex items-center gap-2 px-4 py-1.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-30"
            style={{ background: 'var(--btn-send)', color: '#fff' }}
            onMouseEnter={e => { if (selected && !starting) e.currentTarget.style.background = 'var(--btn-send-hover)' }}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--btn-send)')}
          >
            {starting ? (
              <>
                <span
                  className="animate-spin w-3 h-3 rounded-full border border-white border-t-transparent"
                />
                Starting…
              </>
            ) : 'Open →'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── DirNode ────────────────────────────────────────────────────────────────
function DirNode({ node, depth, selected, onSelect, onToggle, onOpen }: {
  node: TreeNode; depth: number; selected: string
  onSelect: (p: string) => void
  onToggle: (p: string) => void
  onOpen: () => void
}) {
  const isSel = node.entry.path === selected

  return (
    <>
      <button
        className="flex items-center gap-1.5 w-full text-left px-1 py-0.5 transition-colors"
        onClick={() => { onSelect(node.entry.path); onToggle(node.entry.path) }}
        onDoubleClick={() => { onSelect(node.entry.path); onOpen() }}
        onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={e => { e.currentTarget.style.background = isSel ? 'var(--bg-user-msg)' : 'transparent' }}
        style={{
          paddingLeft: `${8 + depth * 16}px`,
          background: isSel ? 'var(--bg-user-msg)' : 'transparent',
          borderLeft: `2px solid ${isSel ? 'var(--border-strong)' : 'transparent'}`,
        }}
      >
        <svg
          className={`w-2.5 h-2.5 flex-shrink-0 transition-transform
            ${!node.entry.has_children ? 'opacity-0' : ''}
            ${node.open ? 'rotate-90' : ''}`}
          style={{ color: 'var(--text-muted)' }}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>

        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"
          style={{ color: '#F59E0B' }}>
          {node.open
            ? <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            : <path fillRule="evenodd" d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clipRule="evenodd" />
          }
        </svg>

        <span className="text-xs truncate" style={{ color: isSel ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: isSel ? 500 : 400 }}>
          {node.entry.name}
        </span>

        {node.loading && (
          <svg className="w-3 h-3 animate-spin ml-auto flex-shrink-0" style={{ color: 'var(--text-muted)' }} fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        )}
      </button>

      {node.open && node.children && node.children.map((child) => (
        <DirNode key={child.entry.path} node={child} depth={depth + 1}
          selected={selected} onSelect={onSelect} onToggle={onToggle} onOpen={onOpen} />
      ))}
    </>
  )
}
