interface ThinkingDotsProps {
  toolName?: string  // if set, show tool label instead of bouncing dots
}

// Format "read_file" → "Reading file…"
function toolLabel(name: string): string {
  const map: Record<string, string> = {
    read_file: 'Reading file',
    write_file: 'Writing file',
    edit_file: 'Editing file',
    list_directory: 'Listing directory',
    search_files: 'Searching files',
    grep: 'Searching',
    bash: 'Running command',
    execute_command: 'Running command',
    web_search: 'Searching web',
    web_fetch: 'Fetching URL',
    computer: 'Using computer',
  }
  const friendly = map[name]
  if (friendly) return friendly + '…'
  // Fallback: "some_tool_name" → "Some tool name…"
  return name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) + '…'
}

export default function ThinkingDots({ toolName }: ThinkingDotsProps) {
  if (toolName) {
    return (
      <span className="inline-flex items-center gap-1.5 h-4">
        <svg
          className="w-3 h-3 flex-shrink-0 animate-spin"
          style={{ color: 'var(--text-muted)' }}
          fill="none" viewBox="0 0 24 24"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3V4a10 10 0 100 20v-2a8 8 0 01-8-8z" />
        </svg>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {toolLabel(toolName)}
        </span>
      </span>
    )
  }

  return (
    <span className="inline-flex gap-1 items-center h-4">
      <span className="w-1.5 h-1.5 rounded-full animate-bounce [animation-delay:0ms]"
        style={{ background: 'var(--text-muted)' }} />
      <span className="w-1.5 h-1.5 rounded-full animate-bounce [animation-delay:150ms]"
        style={{ background: 'var(--text-muted)' }} />
      <span className="w-1.5 h-1.5 rounded-full animate-bounce [animation-delay:300ms]"
        style={{ background: 'var(--text-muted)' }} />
    </span>
  )
}
