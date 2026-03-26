import { useEffect, useState } from 'react'
import TitleBar from './components/TitleBar'
import ChatPanel from './components/ChatPanel'
import PreviewPanel from './components/PreviewPanel'
import FileTree from './components/FileTree'
import WorkspaceSelector from './components/WorkspaceSelector'
import SettingsModal from './components/SettingsModal'

type Page = 'workspace' | 'chat'

export default function App() {
  const [page, setPage] = useState<Page>('workspace')
  const [agentVersion, setAgentVersion] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [activeTemplate, setActiveTemplate] = useState('default')
  const [previewFile, setPreviewFile] = useState<string | null>(null)
  const [fileTreeRefreshToken, setFileTreeRefreshToken] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Graceful shutdown: when the browser tab/window closes, tell the server to exit.
  useEffect(() => {
    const handleUnload = () => {
      navigator.sendBeacon('/api/shutdown')
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
  }, [])

  function handleWorkspaceReady(workspace: string, version: string) {
    setWorkspacePath(workspace)
    setAgentVersion(version)
    setPage('chat')
  }

  if (page === 'workspace') {
    return <WorkspaceSelector onReady={handleWorkspaceReady} />
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-app)' }}>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <TitleBar
        agentStatus="online"
        agentVersion={agentVersion}
        activeTemplate={activeTemplate}
        onTemplateChange={setActiveTemplate}
        onSettingsOpen={() => setSettingsOpen(true)}
      />
      <div className="flex-1 flex min-h-0">
        <FileTree
          workspacePath={workspacePath}
          refreshToken={fileTreeRefreshToken}
        />
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <ChatPanel
            workspacePath={workspacePath}
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
