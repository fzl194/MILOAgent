import { useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Message } from '../../agent-core/types'
import { ToolInvocationCard } from './ToolInvocationCard'

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
  message: Message
}

export function MessageBubble({ message }: Props): React.ReactNode {
  const isUser = message.role === 'user'
  const isTool = message.role === 'tool'

  if (isTool) {
    return <ToolInvocationCard message={message} />
  }

  // An assistant turn that produced only tool calls (no prose) renders nothing
  // here — the calls are already shown as a ToolGroup below; an empty bubble
  // with just tool-name chips is noise.
  if (!isUser && !message.content.trim()) {
    return null
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      {isUser ? (
        <div className="flex max-w-[82%] flex-row-reverse gap-2.5 rise">
          <div
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-on-accent"
            style={{
              backgroundImage: 'linear-gradient(135deg, var(--color-warn), var(--color-accent2))',
              boxShadow: '0 0 18px -4px var(--color-warn)'
            }}
          >
            U
          </div>
          <div className="flex min-w-0 flex-col items-end">
            <div className="label-tag mb-1 text-warn/80">YOU</div>
            <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm border border-warn/25 bg-elevated px-4 py-2.5 text-sm leading-relaxed text-fg shadow-lg">
              {message.content}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex max-w-[85%] gap-2.5 rise">
          <div
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-on-accent"
            style={{
              backgroundImage: 'linear-gradient(135deg, var(--color-accent), var(--color-accent2))',
              boxShadow: '0 0 18px -4px var(--color-accent)'
            }}
          >
            ◆
          </div>
          <div className="min-w-0">
            <div className="label-tag mb-1">MILO</div>
            <div className="md-body rounded-2xl rounded-tl-sm border border-line/70 bg-panel/60 px-4 py-3 shadow-lg backdrop-blur-sm">
              {message.content && (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={components}
                >
                  {message.content}
                </ReactMarkdown>
              )}
              {message.toolCalls && message.toolCalls.length > 0 && (
                <div className={`flex flex-wrap gap-1.5 ${message.content ? 'mt-2' : ''}`}>
                  {message.toolCalls.map((tc) => (
                    <span
                      key={tc.id}
                      className="inline-flex items-center gap-1 rounded-md border border-line bg-base/60 px-2 py-0.5 font-mono text-[10px] text-muted"
                    >
                      <span className="text-accent">⚙</span>
                      {tc.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
