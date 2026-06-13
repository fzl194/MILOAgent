import { useState } from 'react'
import type { Message, RiskLevel } from '../../agent-core/types'

const RISK_TONE: Record<RiskLevel, { label: string; color: string }> = {
  safe: { label: 'SAFE', color: 'var(--color-ok)' },
  write: { label: 'WRITE', color: 'var(--color-accent)' },
  network: { label: 'NET', color: 'var(--color-warn)' },
  dangerous: { label: 'DANGER', color: 'var(--color-danger)' }
}

/** Try to recover stdout/stderr from a run_shell result content. */
function parseShellOutput(content: string): { stdout: string; stderr: string } | null {
  try {
    const o = JSON.parse(content)
    if (o && typeof o === 'object' && ('stdout' in o || 'stderr' in o)) {
      return { stdout: String(o.stdout ?? ''), stderr: String(o.stderr ?? '') }
    }
  } catch {
    /* not JSON — treat content as raw output */
  }
  return null
}

function extOf(path: string): string {
  const m = String(path).match(/\.([A-Za-z0-9]+)$/)
  return m ? m[1].toLowerCase() : ''
}

/** One-line at-a-glance summary for a tool call (shown when collapsed). */
function summary(name: string, args: Record<string, unknown>): { icon: string; text: string } {
  if (name === 'run_shell') return { icon: '$', text: String(args.command ?? '') }
  if (name === 'write_file') return { icon: '✎', text: String(args.path ?? '') }
  if (name === 'read_file') return { icon: '📖', text: String(args.path ?? '') }
  return { icon: '⚙', text: '' }
}

function CopyButton({ text }: { text: string }): React.ReactElement {
  const [status, setStatus] = useState<'idle' | 'copied'>('idle')
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setStatus('copied')
          window.setTimeout(() => setStatus('idle'), 1200)
        } catch {
          setStatus('idle')
        }
      }}
      className="rounded border border-line bg-card/70 px-1.5 py-0.5 font-mono text-[10px] text-muted transition hover:text-fg"
    >
      {status === 'copied' ? '已复制' : '复制'}
    </button>
  )
}

/** Rich rendering of a single tool invocation. Collapsed by default so a run of
 *  many tool calls reads as a compact list of one-liners; click the header to
 *  expand the full output. */
export function ToolInvocationCard({ message }: { message: Message }): React.ReactElement {
  const name = message.toolName
  const args = message.toolArgs ?? {}
  const risk = message.riskLevel ? RISK_TONE[message.riskLevel] : null
  const ms = message.durationMs
  // Default collapsed — multiple tools must not flood the conversation.
  const [open, setOpen] = useState(false)

  // Legacy tool messages (no toolName metadata) → compact toggle.
  if (!name) {
    return (
      <div className="rise">
        <div className="glass rounded-xl">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs"
          >
            <span className="text-warn">{message.isError ? '✕' : '⚙'}</span>
            <span className="label-tag">{message.isError ? 'tool · error' : 'tool · result'}</span>
            <span className="ml-auto font-mono text-[10px] text-faint">{open ? '收起 ▾' : '展开 ▸'}</span>
          </button>
          {open && (
            <pre className="mx-3 mb-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-term-bg p-2.5 font-mono text-[11px] leading-relaxed text-muted">
              {message.content}
            </pre>
          )}
        </div>
      </div>
    )
  }

  const headerTone = message.isError ? 'var(--color-danger)' : risk?.color ?? 'var(--color-faint)'
  const sum = summary(name, args)

  // Full-detail body, only when expanded.
  let body: React.ReactNode = null
  if (name === 'run_shell') {
    const parsed = parseShellOutput(message.content)
    const stdout = parsed?.stdout ?? (/^\{/.test(message.content) ? '' : message.content)
    const stderr = parsed?.stderr ?? ''
    body = (
      <div className="space-y-1">
        {stdout && (
          <pre className="overflow-x-auto rounded-lg border border-line bg-term-bg p-2.5 font-mono text-[11px] leading-relaxed text-muted">
            {stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout}
          </pre>
        )}
        {stderr && (
          <pre className="overflow-x-auto rounded-lg border border-danger/30 bg-danger/5 p-2 font-mono text-[11px] leading-relaxed text-danger">
            {stderr}
          </pre>
        )}
        {!stdout && !stderr && <div className="font-mono text-[10px] text-faint">（无输出）</div>}
        <div className="flex justify-end">
          <CopyButton text={stdout || stderr || message.content} />
        </div>
      </div>
    )
  } else if (name === 'write_file') {
    const c = String(args.content ?? '')
    body = (
      <div className="space-y-1">
        <pre className="overflow-x-auto rounded-lg border border-line bg-term-bg p-2.5 font-mono text-[11px] leading-relaxed text-muted">
          {c}
        </pre>
        <div className="flex items-center justify-between font-mono text-[10px] text-faint">
          <span>{c.split('\n').length} 行</span>
          <CopyButton text={c} />
        </div>
      </div>
    )
  } else if (name === 'read_file') {
    const lang = extOf(String(args.path ?? ''))
    body = message.content ? (
      <div className="space-y-1">
        <pre className="overflow-x-auto rounded-lg border border-line bg-term-bg p-2.5 font-mono text-[11px] leading-relaxed text-muted">
          {message.content}
        </pre>
        <div className="flex items-center justify-between font-mono text-[10px] text-faint">
          <span>
            {message.content.split('\n').length} 行{lang ? ' · ' + lang : ''}
          </span>
          <CopyButton text={message.content} />
        </div>
      </div>
    ) : (
      <div className="font-mono text-[10px] text-faint">（空文件）</div>
    )
  } else {
    body = (
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-term-bg p-2.5 font-mono text-[11px] leading-relaxed text-muted">
        {message.content}
      </pre>
    )
  }

  return (
    <div className="rise">
      <div
        className="rounded-xl border bg-card/60 shadow-md backdrop-blur-sm"
        style={{ borderColor: `color-mix(in srgb, ${headerTone} 35%, transparent)` }}
      >
        {/* Compact, clickable header — this is all you see by default. */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
          title={open ? '收起' : '展开详情'}
        >
          <span className="shrink-0 font-mono text-[11px]" style={{ color: headerTone }}>
            {message.isError ? '✕' : '⚙'} {name}
          </span>
          {risk && (
            <span
              className="shrink-0 rounded border px-1 py-0.5 font-mono text-[9px] tracking-wider"
              style={{ color: risk.color, borderColor: `color-mix(in srgb, ${risk.color} 40%, transparent)` }}
            >
              {risk.label}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">
            <span className="text-accent">{sum.icon}</span> {sum.text}
          </span>
          {ms !== undefined && <span className="shrink-0 font-mono text-[10px] text-faint">{ms}ms</span>}
          <span className="shrink-0 font-mono text-[10px] text-faint">{open ? '▾' : '▸'}</span>
        </button>
        {open && <div className="border-t border-line/60 px-3 py-2">{body}</div>}
      </div>
    </div>
  )
}
