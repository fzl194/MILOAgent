import { useEffect, useMemo, useRef, useState } from 'react'
import type { Message } from '../../agent-core/types'
import { MessageBubble } from './MessageBubble'
import { StreamingIndicator } from './StreamingIndicator'
import { ApprovalCard } from './ApprovalCard'
import { ToolGroup } from './ToolGroup'
import { Markdown } from './Markdown'

interface MessageListProps {
  messages: Message[]
  currentText: string
  isStreaming: boolean
  activeToolCalls: string[]
}

const avatarStyle: React.CSSProperties = {
  backgroundImage: 'linear-gradient(135deg, var(--color-accent), var(--color-accent2))',
  boxShadow: '0 0 18px -4px var(--color-accent)'
}

/** Live streaming markdown preview. Two perf measures vs. rendering markdown
 *  straight off `text` every token:
 *   1. Re-parse is coalesced to ONCE PER ANIMATION FRAME — tokens arrive faster
 *      than frames, so rendering every delta re-parses markdown needlessly and
 *      janks. We snapshot the latest text into local state via rAF.
 *   2. Syntax highlighting is OFF while streaming (highlight.js auto-detection
 *      per parse is the single most expensive part). The finalized bubble
 *      re-renders WITH highlighting once the turn ends.
 *  The memoized `rendered` node also ensures that between frames — when `text`
 *  keeps changing but `shown` hasn't advanced yet — we don't re-parse at all. */
function StreamingPreview({ text }: { text: string }): React.ReactElement {
  const [shown, setShown] = useState(text)
  const latest = useRef(text)
  latest.current = text
  useEffect(() => {
    // Each token schedules one rAF; React cancels the previous effect's rAF on
    // re-run, so at most one is ever pending → at most one re-parse per frame.
    const id = requestAnimationFrame(() => setShown(latest.current))
    return () => cancelAnimationFrame(id)
  }, [text])
  const rendered = useMemo(() => <Markdown highlight={false}>{shown}</Markdown>, [shown])
  return (
    <div className="flex justify-start rise">
      <div className="flex max-w-[85%] gap-2.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-on-accent" style={avatarStyle}>
          ◆
        </div>
        <div className="min-w-0">
          <div className="label-tag mb-1">MILO</div>
          <div className="md-body rounded-2xl rounded-tl-sm border border-line/70 bg-panel/60 px-4 py-3 shadow-lg backdrop-blur-sm">
            {rendered}
            <span className="cursor-blink text-accent">▍</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function Hero(): React.ReactElement {
  return (
    <div className="flex min-h-[58vh] flex-col items-center justify-center text-center">
      <div
        className="floaty mb-5 flex h-16 w-16 items-center justify-center rounded-2xl text-2xl font-bold text-on-accent"
        style={{ backgroundImage: 'linear-gradient(135deg, var(--color-accent), var(--color-accent2))', boxShadow: '0 0 50px -12px var(--color-accent)' }}
      >
        ◆
      </div>
      <h1 className="brand sheen text-3xl font-bold tracking-[0.16em]">MILO CONSOLE</h1>
      <p className="mt-2 max-w-md text-sm text-muted">
        本地优先的桌面级 AI Agent · 自由调度文件与终端，全流程可视化
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {['READ / WRITE FILES', 'EXECUTE SHELL', 'STREAMING + TOOLS', 'MULTI-MODEL'].map((t) => (
          <span key={t} className="rounded-full border border-line bg-card/60 px-3 py-1 font-mono text-[10px] tracking-wider text-muted">
            {t}
          </span>
        ))}
      </div>
    </div>
  )
}

export function MessageList({ messages, currentText, isStreaming, activeToolCalls }: MessageListProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll on new content, but throttled to one animation frame. During
  // streaming, currentText changes per token — calling a synchronous scroll each
  // time caused layout thrashing that blocked render frames, so output arrived
  // in janky batches. rAF coalesces them into one smooth scroll per frame.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(id)
  }, [messages, currentText, activeToolCalls])

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-3xl space-y-4 p-4 lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl">
        {messages.length === 0 && !isStreaming && <Hero />}

        {(() => {
          // Group consecutive tool messages so a batch of parallel tool calls
          // renders as one compact row instead of a wall of cards.
          const out: React.ReactNode[] = []
          let i = 0
          while (i < messages.length) {
            const m = messages[i]
            if (m.role === 'tool') {
              const grp: Message[] = []
              while (i < messages.length && messages[i].role === 'tool') {
                grp.push(messages[i])
                i++
              }
              out.push(
                grp.length > 1 ? (
                  <ToolGroup key={grp[0].id} messages={grp} />
                ) : (
                  <MessageBubble key={grp[0].id} message={grp[0]} />
                )
              )
            } else {
              out.push(<MessageBubble key={m.id} message={m} />)
              i++
            }
          }
          return out
        })()}

        {activeToolCalls.length > 0 && (
          <div className="rise max-w-[85%] pl-[2.375rem]">
            <div className="glass flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-xs">
              <span className="inline-block animate-spin">⚙️</span>
              <span className="min-w-0 flex-1 truncate font-mono text-muted">
                {activeToolCalls.length > 1 ? (
                  <>
                    执行 {activeToolCalls.length} 个工具 · <span className="text-accent">{activeToolCalls.join(', ')}</span>
                  </>
                ) : (
                  <>
                    exec · <span className="text-accent">{activeToolCalls[0]}</span>
                  </>
                )}
              </span>
              <span className="ml-auto cursor-blink text-accent">▍</span>
            </div>
          </div>
        )}

        {isStreaming && currentText && <StreamingPreview text={currentText} />}

        {isStreaming && !currentText && activeToolCalls.length === 0 && <StreamingIndicator />}

        <ApprovalCard />
      </div>
    </div>
  )
}
