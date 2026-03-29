import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github.css'

interface MarkdownRendererProps {
  content: string
  className?: string
  /** When true, skip rehype-highlight to reduce CPU cost during streaming. */
  streaming?: boolean
}

export default function MarkdownRenderer({ content, className, streaming }: MarkdownRendererProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={streaming ? [] : [rehypeHighlight]}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
