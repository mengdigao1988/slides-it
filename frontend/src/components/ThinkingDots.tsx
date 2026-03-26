export default function ThinkingDots() {
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
