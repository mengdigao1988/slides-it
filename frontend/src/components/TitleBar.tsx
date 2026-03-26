interface TitleBarProps {
  agentStatus: 'checking' | 'online' | 'offline'
  agentVersion: string
  onSettingsOpen: () => void
  onTemplatesManage: () => void
}

export default function TitleBar({
  agentStatus,
  agentVersion,
  onSettingsOpen,
  onTemplatesManage,
}: TitleBarProps) {
  const dotColor =
    agentStatus === 'online' ? 'var(--green-dot)'
    : agentStatus === 'checking' ? '#CA8A04'
    : '#DC2626'

  return (
    <div
      className="px-5 py-2.5 flex items-center gap-3 flex-shrink-0"
      style={{
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {/* Status dot + version */}
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${agentStatus === 'checking' ? 'animate-pulse' : ''}`}
          style={{ background: dotColor }}
        />
        {agentVersion && (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            v{agentVersion}
          </span>
        )}
      </div>

      {/* Title */}
      <span
        className="flex-1 text-center select-none"
        style={{
          fontFamily: "'Söhne', ui-sans-serif, -apple-system, sans-serif",
          fontSize: '1rem',
          fontWeight: 600,
          letterSpacing: '-0.01em',
          color: 'var(--text-primary)',
        }}
      >
        slides-it
      </span>

      {/* Right side: manage templates + settings */}
      <div className="flex items-center gap-2">
        {/* Manage templates button */}
        <button
          onClick={onTemplatesManage}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg transition-colors"
          style={{
            color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
            background: 'transparent',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          title="Manage templates"
        >
          <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 6h16M4 10h16M4 14h16M4 18h16" />
          </svg>
          Templates
        </button>

        {/* Settings gear */}
        <button
          onClick={onSettingsOpen}
          className="w-7 h-7 flex items-center justify-center rounded-lg transition-colors"
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
    </div>
  )
}
