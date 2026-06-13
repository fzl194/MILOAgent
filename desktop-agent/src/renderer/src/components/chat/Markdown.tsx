import { useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

function CodeBlock({ children }: { children?: React.ReactNode }): React.ReactElement {
  const ref = useRef<HTMLPreElement>(null)
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = async (): Promise<void> => {
    const text = ref.current?.innerText ?? ''
    try {
      await navigator.clipboard.writeText(text)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
    window.setTimeout(() => setStatus('idle'), 1200)
  }

  return (
    <div className="group relative my-2.5">
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-2 z-10 rounded-md border border-line bg-card/80 px-2 py-0.5 font-mono text-[10px] text-muted opacity-0 transition hover:text-fg group-hover:opacity-100"
      >
        {status === 'copied' ? '已复制' : status === 'failed' ? '失败' : '复制'}
      </button>
      <pre
        ref={ref}
        className="overflow-x-auto rounded-xl border border-line bg-term-bg p-3.5 text-xs leading-relaxed shadow-lg"
      >
        {children}
      </pre>
    </div>
  )
}

const components: Components = {
  pre({ children }) {
    return <CodeBlock>{children}</CodeBlock>
  }
}

interface Props {
  children: string
  /** Apply syntax highlighting. Defaults to true; the live streaming preview
   *  passes false because re-running highlight.js every frame is the dominant
   *  per-token cost. The finalized bubble re-parses WITH highlighting. */
  highlight?: boolean
}

/** Shared markdown renderer (remark-gfm + highlight.js + copyable code blocks).
 *  Used by BOTH the finalized assistant bubble and the live streaming preview, so
 *  partial output renders as real markdown while streaming (no "raw text then pop"
 *  at the end) and there's zero layout shift when the stream finishes. */
export function Markdown({ children, highlight = true }: Props): React.ReactElement {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={highlight ? [rehypeHighlight] : []} components={components}>
      {children}
    </ReactMarkdown>
  )
}
