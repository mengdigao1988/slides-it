import { useState } from 'react'
import type { QuestionRequest, QuestionInfo } from '../lib/typewriter'

interface QuestionBlockProps {
  question: QuestionRequest
  onReply: (requestId: string, answers: string[][]) => Promise<void> | void
  onReject: (requestId: string) => void
  /** If true, the question has already been answered — show read-only summary */
  answered?: boolean
  answeredLabels?: string[][]
}

export default function QuestionBlock({
  question,
  onReply,
  onReject,
  answered,
  answeredLabels,
}: QuestionBlockProps) {
  // answers[i] = array of selected labels for question i
  const [answers, setAnswers] = useState<string[][]>(
    () => question.questions.map(() => [])
  )
  const [customInputs, setCustomInputs] = useState<string[]>(
    () => question.questions.map(() => '')
  )
  const [submitting, setSubmitting] = useState(false)

  // A question is answered if it has at least one selection or a non-empty custom input
  function isAnswered(i: number): boolean {
    return answers[i].length > 0 || customInputs[i].trim() !== ''
  }

  const allAnswered = question.questions.every((_, i) => isAnswered(i))

  function toggleOption(qi: number, label: string, multiple: boolean) {
    setAnswers((prev) => {
      const next = [...prev]
      const cur = next[qi]
      if (multiple) {
        next[qi] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]
      } else {
        next[qi] = cur[0] === label ? [] : [label]
      }
      return next
    })
  }

  function setCustom(qi: number, val: string) {
    setCustomInputs((prev) => { const n = [...prev]; n[qi] = val; return n })
    // clear option selection when typing custom
    if (val.trim()) {
      setAnswers((prev) => { const n = [...prev]; n[qi] = []; return n })
    }
  }

  async function handleSubmit() {
    setSubmitting(true)
    // Build final answers: use custom input if filled, else use selected labels
    const finalAnswers = question.questions.map((_, i) => {
      const custom = customInputs[i].trim()
      if (custom) return [custom]
      return answers[i]
    })
    try {
      await onReply(question.id, finalAnswers)
    } finally {
      setSubmitting(false)
    }
  }

  // ── Read-only answered state ──────────────────────────────────────────────
  if (answered && answeredLabels) {
    return (
      <div
        className="mt-2 rounded-xl overflow-hidden"
        style={{ border: '1px solid var(--border)' }}
      >
        {question.questions.map((q, i) => (
          <div
            key={i}
            className="px-3 py-2.5 flex items-start gap-2"
            style={{
              borderBottom: i < question.questions.length - 1 ? '1px solid var(--border)' : undefined,
              background: 'var(--bg-sidebar)',
            }}
          >
            <span className="text-[10px] mt-0.5 flex-shrink-0" style={{ color: 'var(--green-dot)' }}>✓</span>
            <div className="min-w-0">
              <p className="text-[11px] font-medium mb-0.5" style={{ color: 'var(--text-secondary)' }}>
                {q.header}
              </p>
              <p className="text-[11px]" style={{ color: 'var(--text-primary)' }}>
                {(answeredLabels[i] ?? []).join(', ') || '—'}
              </p>
            </div>
          </div>
        ))}
      </div>
    )
  }

  // ── Interactive question form ──────────────────────────────────────────────
  return (
    <div
      className="mt-2 rounded-xl overflow-hidden"
      style={{ border: '1px solid var(--border)' }}
    >
      {question.questions.map((q: QuestionInfo, qi: number) => {
        const allowCustom = q.custom !== false
        const isMultiple = !!q.multiple

        return (
          <div
            key={qi}
            className="px-3 py-3"
            style={{
              borderBottom: qi < question.questions.length - 1 ? '1px solid var(--border)' : undefined,
              background: 'var(--bg-surface)',
            }}
          >
            {/* Question header */}
            <p className="text-[11px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              {q.header}
            </p>

            {/* Options */}
            <div className="flex flex-col gap-1">
              {q.options.map((opt) => {
                const selected = answers[qi].includes(opt.label)
                return (
                  <button
                    key={opt.label}
                    onClick={() => toggleOption(qi, opt.label, isMultiple)}
                    className="flex items-start gap-2 w-full text-left px-2.5 py-2 rounded-lg transition-colors"
                    style={{
                      background: selected ? 'var(--bg-user-msg)' : 'var(--bg-sidebar)',
                      border: `1px solid ${selected ? 'var(--border-strong)' : 'var(--border)'}`,
                      fontFamily: 'inherit',
                    }}
                    onMouseEnter={e => {
                      if (!selected) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLElement).style.background = selected ? 'var(--bg-user-msg)' : 'var(--bg-sidebar)'
                    }}
                  >
                    {/* Radio / checkbox indicator */}
                    <span
                      className="flex-shrink-0 mt-0.5"
                      style={{
                        width: '12px', height: '12px',
                        borderRadius: isMultiple ? '3px' : '50%',
                        border: `1.5px solid ${selected ? 'var(--text-primary)' : 'var(--border-strong)'}`,
                        background: selected ? 'var(--text-primary)' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {selected && (
                        <svg width="7" height="7" viewBox="0 0 8 8" fill="none">
                          {isMultiple
                            ? <path d="M1.5 4L3.5 6L6.5 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            : <circle cx="4" cy="4" r="2" fill="white" />
                          }
                        </svg>
                      )}
                    </span>
                    <span>
                      <span className="text-xs font-medium block" style={{ color: 'var(--text-primary)' }}>
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="text-[10px] leading-snug block" style={{ color: 'var(--text-muted)' }}>
                          {opt.description}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}

              {/* Custom input */}
              {allowCustom && (
                <div className="relative">
                  <input
                    type="text"
                    value={customInputs[qi]}
                    onChange={(e) => setCustom(qi, e.target.value)}
                    placeholder="Type your own answer…"
                    className="w-full text-xs px-2.5 py-2 rounded-lg outline-none transition-colors"
                    style={{
                      background: customInputs[qi] ? 'var(--bg-user-msg)' : 'var(--bg-sidebar)',
                      border: `1px solid ${customInputs[qi] ? 'var(--border-strong)' : 'var(--border)'}`,
                      color: 'var(--text-primary)',
                      fontFamily: 'inherit',
                    }}
                    onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-strong)')}
                    onBlur={e => (e.currentTarget.style.borderColor = customInputs[qi] ? 'var(--border-strong)' : 'var(--border)')}
                  />
                </div>
              )}
            </div>
          </div>
        )
      })}

      {/* Footer: submit + skip */}
      <div
        className="px-3 py-2.5 flex items-center justify-between gap-2"
        style={{ background: 'var(--bg-sidebar)', borderTop: '1px solid var(--border)' }}
      >
        <button
          onClick={() => onReject(question.id)}
          className="text-[11px] transition-colors"
          style={{ color: 'var(--text-muted)', fontFamily: 'inherit' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
        >
          Skip
        </button>
        <button
          onClick={handleSubmit}
          disabled={!allAnswered || submitting}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
          style={{
            background: 'var(--btn-send)',
            color: '#fff',
            fontFamily: 'inherit',
          }}
          onMouseEnter={e => { if (allAnswered && !submitting) (e.currentTarget as HTMLElement).style.background = 'var(--btn-send-hover)' }}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--btn-send)'}
        >
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
      </div>
    </div>
  )
}
