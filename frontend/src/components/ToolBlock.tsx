import type { ToolEntry } from '../lib/typewriter'

interface ToolBlockProps { tool: ToolEntry }

export default function ToolBlock({ tool }: ToolBlockProps) {
  const isError = tool.status === 'error'
  const isRunning = tool.status === 'running'

  const style = isError
    ? { background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)' }
    : { background: 'var(--bg-sidebar)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }

  return (
    <div
      className={`font-mono text-xs px-3 py-2 rounded mb-1 ${isRunning ? 'animate-pulse' : ''}`}
      style={style}
    >
      <span className="opacity-50 mr-1.5">
        {isRunning ? '⟳' : isError ? '✗' : '✓'}
      </span>
      {tool.tool || tool.name}
    </div>
  )
}
