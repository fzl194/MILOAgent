import { useState } from 'react'
import type { Message } from '../../../agent-core/types'

/** Renders the actual view sent to the model as a readable message sequence.
 *  Messages that were folded/dropped by a compactor are badged (by id match
 *  against the decisions' droppedMessageIds). Long tool results are collapsible. */
export function RequestViewList(props: { view: Message[]; droppedIds: Set<string> }): React.ReactElement {
  const { view, droppedIds } = props
  if (view.length === 0) {
    return <div className="px-2 py-4 text-center text-xs text-faint">(空视图)</div>
  }
  return (
    <div className="flex max-h-full flex-col gap-1.5 overflow-y-auto pr-1">
      {view.map((m) => (
        <ViewMessage key={m.id} msg={m} dropped={droppedIds.has(m.id)} />
      ))}
    </div>
  )
}

const ROLE_LABEL: Record<string, { label: string; cls: string }> = {
  system: { label: 'system', cls: 'bg-fuchsia-500/20 text-fuchsia-400' },
  user: { label: 'user', cls: 'bg-blue-500/20 text-blue-400' },
  assistant: { label: 'assistant', cls: 'bg-emerald-500/20 text-emerald-400' },
  tool: { label: 'tool', cls: 'bg-amber-500/20 text-amber-400' }
}

function ViewMessage(props: { msg: Message; dropped: boolean }): React.ReactElement {
  const { msg, dropped } = props
  const [open, setOpen] = useState(false)
  const role = ROLE_LABEL[msg.role] ?? { label: msg.role, cls: 'bg-bg/40 text-faint' }
  // Collapse very long content (e.g. big tool results) by default.
  const isLong = msg.content.length > 280
  const shown = open || !isLong ? msg.content : msg.content.slice(0, 280) + ' …(折叠)'

  return (
    <div className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${dropped ? 'border-amber-500/40 bg-amber-500/5' : 'border-line/30 bg-bg/20'}`}>
      <div className="mb-1 flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${role.cls}`}>{role.label}</span>
        {msg.toolName && <span className="font-mono text-[9px] text-faint">{msg.toolName}</span>}
        {dropped && <span className="rounded bg-amber-500/30 px-1 py-0.5 font-mono text-[8px] text-amber-300">已折叠</span>}
        {isLong && (
          <button onClick={() => setOpen((v) => !v)} className="ml-auto font-mono text-[9px] text-faint hover:text-muted">
            {open ? '收起' : '展开'}
          </button>
        )}
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted">{shown || '(无内容)'}</pre>
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {msg.toolCalls.map((tc) => (
            <span key={tc.id} className="rounded bg-card/40 px-1.5 py-0.5 font-mono text-[9px] text-faint">
              ⚒ {tc.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
