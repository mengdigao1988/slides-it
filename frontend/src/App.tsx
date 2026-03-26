import { useEffect, useState } from 'react'
import TitleBar from './components/TitleBar'
import ChatPanel from './components/ChatPanel'
import PreviewPanel from './components/PreviewPanel'
import FileTree from './components/FileTree'
import WorkspaceSelector from './components/WorkspaceSelector'
import SettingsModal from './components/SettingsModal'
import TemplatesModal from './components/TemplatesModal'
import { getTemplateSkill, getStatus } from './lib/slides-server-api'

type Page = 'workspace' | 'chat' | 'loading'

export default function App() {
  const [page, setPage] = useState<Page>('loading')
  const [agentVersion, setAgentVersion] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [activeTemplate, setActiveTemplate] = useState('default')
  const [activeSkill, setActiveSkill] = useState('')
  const [previewFile, setPreviewFile] = useState<string | null>(null)
  const [fileTreeRefreshToken, setFileTreeRefreshToken] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)

  // On mount: check if the server is already running with an active workspace.
  // If so, skip the workspace selector and go directly to chat.
  useEffect(() => {
    getStatus()
      .then((s) => {
        if (s.ready && s.workspace) {
          setWorkspacePath(s.workspace)
          setAgentVersion(s.opencode_version)
          getTemplateSkill('default').then((r) => setActiveSkill(r.skill)).catch(() => {})
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
    // Load the default template skill on workspace start
    getTemplateSkill('default').then((r) => setActiveSkill(r.skill)).catch(() => {})
  }

  async function handleTemplateChange(name: string): Promise<string> {
    setActiveTemplate(name)
    try {
      const r = await getTemplateSkill(name)
      setActiveSkill(r.skill)
      return r.skill
    } catch {
      return activeSkill
    }
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
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-app)' }}>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <TemplatesModal
        open={templatesOpen}
        activeTemplate={activeTemplate}
        onClose={() => setTemplatesOpen(false)}
        onActivate={(name) => {
          setTemplatesOpen(false)
          handleTemplateChange(name)
        }}
      />
      <TitleBar
        agentStatus="online"
        agentVersion={agentVersion}
        onSettingsOpen={() => setSettingsOpen(true)}
        onTemplatesManage={() => setTemplatesOpen(true)}
      />
      <div className="flex-1 flex min-h-0">
        <FileTree
          workspacePath={workspacePath}
          refreshToken={fileTreeRefreshToken}
          onFileClick={(path) => {
            if (path.endsWith('.html')) {
              // opencode /file/content only accepts relative paths from its cwd;
              // strip the workspace prefix to convert absolute → relative
              const rel = path.startsWith(workspacePath + '/')
                ? path.slice(workspacePath.length + 1)
                : path
              setPreviewFile(rel)
            }
          }}
        />
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <ChatPanel
            workspacePath={workspacePath}
            activeSkill={activeSkill}
            activeTemplate={activeTemplate}
            onTemplateChange={handleTemplateChange}
            onHtmlGenerated={(path) => {
              setPreviewFile(path)
              setFileTreeRefreshToken((t) => t + 1)
            }}
          />
        </div>
        <PreviewPanel htmlFile={previewFile} />
      </div>
    </div>
  )
}
