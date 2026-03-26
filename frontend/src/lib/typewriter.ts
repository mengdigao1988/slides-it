// Typewriter engine — see chat_design.md §4
// SSE delta chars are buffered here and consumed at MS_PER_CHAR rate
// to produce a smooth typing animation independent of network speed.

export const MS_PER_CHAR = Math.round(1000 / 30) // ~30 chars/sec

export type PendingMap = Map<string, string> // bubbleId → pending chars

/**
 * Append delta text for a bubble into the pending map.
 * Call startTypewriter() after to ensure the loop is running.
 */
export function enqueueDelta(pending: PendingMap, bubbleId: string, delta: string): void {
  pending.set(bubbleId, (pending.get(bubbleId) ?? '') + delta)
}

/**
 * Flush all pending chars for every bubble immediately (no animation).
 * Used on session.idle and on abort.
 */
export function flushAll(
  pending: PendingMap,
  setMessages: (fn: (prev: ChatMessage[]) => ChatMessage[]) => void,
): void {
  if (pending.size === 0) return
  setMessages((prev) =>
    prev.map((m) => {
      const chars = pending.get(m.id)
      if (!chars) return m
      pending.delete(m.id)
      return { ...m, text: m.text + chars }
    }),
  )
}

// Re-export ChatMessage so the engine and components share the same type
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming: boolean
  error: string | null
  timestamp: Date
  tools: ToolEntry[]
  attachmentNames?: string[]  // @ referenced file names, shown as badges
}

export interface ToolEntry {
  id: string
  name: string
  tool: string
  status: string
}
