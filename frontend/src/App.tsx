import { useCallback, useEffect, useRef, useState } from 'react'
import TitleBar from './components/TitleBar'
import ChatPanel from './components/ChatPanel'
import PreviewPanel from './components/PreviewPanel'
import FileTree from './components/FileTree'
import WorkspaceSelector from './components/WorkspaceSelector'
import SettingsModal from './components/SettingsModal'
import ErrorBoundary from './components/ErrorBoundary'
import { getDesignSkill, getStatus, activateIndustry as apiActivateIndustry } from './lib/slides-server-api'

type Page = 'workspace' | 'chat' | 'loading'

export default function App() {
  const [page, setPage] = useState<Page>('loading')
  const [agentVersion, setAgentVersion] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [activeDesign, setActiveDesign] = useState('default')
  const [activeIndustry, setActiveIndustry] = useState('general')
  const [activeSkill, setActiveSkill] = useState('')
  const [previewFile, setPreviewFile] = useState<string | null>(null)
  const [fileTreeRefreshToken, setFileTreeRefreshToken] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelRefreshToken, setModelRefreshToken] = useState(0)

  // ── Resizable FileTree ──────────────────────────────────────────────────
  const [fileTreeWidth, setFileTreeWidth] = useState(224)
  const [isDividerHover, setIsDividerHover] = useState(false)
  const isDragging = useRef(false)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    setIsDividerHover(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!isDragging.current) return
      const clamped = Math.min(480, Math.max(160, e.clientX))
      setFileTreeWidth(clamped)
    }
    function onMouseUp() {
      if (!isDragging.current) return
      isDragging.current = false
      setIsDividerHover(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // Helper: fetch the combined system prompt for the given design + industry
  async function fetchSkill(design: string, industry: string): Promise<string> {
    try {
      const r = await getDesignSkill(design, industry)
      return r.skill
    } catch {
      return activeSkill
    }
  }

  // On mount: check if the server is already running with an active workspace.
  // If so, skip the workspace selector and go directly to chat.
  useEffect(() => {
    getStatus()
      .then((s) => {
        if (s.ready && s.workspace) {
          setWorkspacePath(s.workspace)
          setAgentVersion(s.version)
          fetchSkill('default', 'general').then((skill) => setActiveSkill(skill))
          setPage('chat')
        } else {
          setPage('workspace')
        }
      })
      .catch(() => {
        setPage('workspace')
      })
  }, [])

  function handleWorkspaceReady(workspace: string, version: string) {
    setWorkspacePath(workspace)
    setAgentVersion(version)
    setPage('chat')
    // Load the default design + industry skill on workspace start
    fetchSkill('default', 'general').then((skill) => setActiveSkill(skill))
  }

  async function handleDesignChange(name: string): Promise<string> {
    setActiveDesign(name)
    const skill = await fetchSkill(name, activeIndustry)
    setActiveSkill(skill)
    return skill
  }

  async function handleIndustryChange(name: string): Promise<string> {
    setActiveIndustry(name)
    await apiActivateIndustry(name)
    const skill = await fetchSkill(activeDesign, name)
    setActiveSkill(skill)
    return skill
  }

  function toRelative(absPath: string): string {
    return absPath.startsWith(workspacePath + '/')
      ? absPath.slice(workspacePath.length + 1)
      : absPath
  }

  if (page === 'loading') {
    return (
      <div
        className="h-screen flex items-center justify-center"
        style={{ background: 'var(--bg-app)' }}
      >
        <div
          className="animate-spin w-6 h-6 rounded-full border-2"
          style={{ borderColor: 'var(--border)', borderTopColor: 'var(--text-secondary)' }}
        />
      </div>
    )
  }

  if (page === 'workspace') {
    return <WorkspaceSelector onReady={handleWorkspaceReady} />
  }

  return (
    <ErrorBoundary>
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-app)' }}>
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onSettingsSaved={() => setModelRefreshToken((t) => t + 1)}
        />
      )}
      <TitleBar
        agentStatus="online"
        agentVersion={agentVersion}
        onSettingsOpen={() => setSettingsOpen(true)}
      />
      <div className="flex-1 flex min-h-0">
        <div
          className="flex flex-col min-h-0 shrink-0"
          style={{
            width: fileTreeWidth,
            position: 'relative',
            borderRight: '1px solid var(--border)',
          }}
        >
          <div className="flex-1 min-h-0 overflow-hidden">
            <FileTree
              workspacePath={workspacePath}
              refreshToken={fileTreeRefreshToken}
              onFileClick={(path) => {
                if (path.endsWith('.html')) setPreviewFile(toRelative(path))
              }}
            />
          </div>
          {/* Resize pill — floats inside the right edge of FileTree */}
          <div
            onMouseDown={handleMouseDown}
            onMouseEnter={() => setIsDividerHover(true)}
            onMouseLeave={() => setIsDividerHover(false)}
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: 12,
              height: '100%',
              cursor: 'col-resize',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                width: 4,
                height: 48,
                borderRadius: 9999,
                background: isDividerHover || isDragging.current
                  ? 'rgba(0,0,0,0.35)'
                  : 'rgba(0,0,0,0.15)',
                transition: 'background 0.15s',
              }}
            />
          </div>
        </div>
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <ChatPanel
            workspacePath={workspacePath}
            activeSkill={activeSkill}
            activeDesign={activeDesign}
            onDesignChange={handleDesignChange}
            activeIndustry={activeIndustry}
            onIndustryChange={handleIndustryChange}
            modelRefreshToken={modelRefreshToken}
            onHtmlGenerated={(path) => {
              setPreviewFile(toRelative(path))
              setFileTreeRefreshToken((t) => t + 1)
            }}
          />
        </div>
        <PreviewPanel htmlFile={previewFile} />
      </div>
    </div>
    </ErrorBoundary>
  )
}
