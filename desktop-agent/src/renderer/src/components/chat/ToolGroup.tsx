import { useState } from 'react'
import type { Message } from '../../agent-core/types'
import { ToolInvocationCard } from './ToolInvocationCard'

/** A batch of consecutive tool calls rendered as ONE compact row by default.
 *  Without this, a single model response that fans out into several tool calls
 *  stacks into a wall of cards. Expand to see each call's card (itself
 *  collapsed). */
export function ToolGroup({ messages }: { messages: Message[] }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const names = Array.from(new Set(messages.map((m) => m.toolName || 'tool')))
  const errors = messages.filter((m) => m.isError).length
  const totalMs = messages.reduce((s, m) => s + (m.durationMs ?? 0), 0)

  return (
    <div className="rise max-w-[85%] pl-[2.375rem]">
      <div className="rounded-xl border border-line bg-card/40 shadow-sm backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
          title={open ? '收起' : '展开详情'}
        >
          <span className="shrink-0 font-mono text-[11px] text-muted">⚙ {messages.length} 个工具调用</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{names.join(' · ')}</span>
          {errors > 0 && <span className="shrink-0 font-mono text-[10px] text-danger">{errors} 失败</span>}
          {totalMs > 0 && <span className="shrink-0 font-mono text-[10px] text-faint">{totalMs}ms</span>}
          <span className="shrink-0 font-mono text-[10px] text-faint">{open ? '▾' : '▸'}</span>
        </button>
        {open && (
          <div className="space-y-2 border-t border-line/60 px-3 py-2">
            {messages.map((m) => (
              <ToolInvocationCard key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
