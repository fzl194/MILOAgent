import { useEffect, useState } from 'react'
import type { TraceEvent } from '../../agent-core/types'

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

export function TraceTimeline({ sessionId }: { sessionId: string }): React.ReactElement {
  const [events, setEvents] = useState<TraceEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId) {
      setEvents([])
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res = await window.electronAPI.readTrace(sessionId)
        if (!cancelled) setEvents((res.data || []) as TraceEvent[])
      } catch (e) {
        if (!cancelled) {
          setError((e as Error)?.message ?? String(e))
          setEvents([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  if (!sessionId) {
    return <div className="py-4 text-center text-xs text-faint">选择一个会话查看时间线</div>
  }
  if (loading) {
    return <div className="py-4 text-center font-mono text-[10px] text-faint">LOADING…</div>
  }
  if (error) {
    return <div className="py-4 text-center text-xs text-danger">加载失败:{error}</div>
  }
  if (events.length === 0) {
    return <div className="py-4 text-center text-xs text-faint">该会话暂无 trace(可能创建于本次统计升级之前)</div>
  }

  const fmtTime = (ts: unknown): string => (isNum(ts) ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '')
  const fmtDur = (ms: unknown): string => {
    if (!isNum(ms)) return ''
    return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'
  }

  return (
    <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
      {events.map((ev, i) => {
        if (ev.type === 'session_meta') {
          return (
            <div key={`meta-${ev.startedAt ?? i}`} className="flex items-center gap-2 rounded-md border border-line/50 bg-card/30 px-2.5 py-1.5 text-[11px]">
              <span className="text-accent">📋</span>
              <span className="text-muted">会话开始</span>
              <span className="truncate font-mono text-faint">{ev.model}</span>
              <span className="ml-auto font-mono text-[9px] text-faint">{fmtTime(ev.startedAt)}</span>
            </div>
          )
        }
        if (ev.type === 'llm_call') {
          const inT = ev.usage?.inputTokens ?? 0
          const outT = ev.usage?.outputTokens ?? 0
          return (
            <div key={ev.callId ?? `llm-${i}`} className="flex items-center gap-2 rounded-md border border-line/50 bg-card/30 px-2.5 py-1.5 text-[11px]">
              <span style={{ color: 'var(--color-accent2)' }}>🤖</span>
              <span className="text-muted">LLM · 第{(ev.round ?? 0) + 1}轮</span>
              <span className="font-mono text-faint">↑{inT} ↓{outT}</span>
              <span className="font-mono text-[9px] text-faint">{ev.finishReason}</span>
              <span className="ml-auto font-mono text-[9px] text-faint">{fmtDur(ev.durationMs)}</span>
            </div>
          )
        }
        // tool_call (explicit; unknown future event types are skipped)
        if (ev.type !== 'tool_call') return null
        const danger = ev.riskLevel === 'dangerous'
        return (
          <div key={ev.toolCallId ?? `tool-${i}`} className="flex items-center gap-2 rounded-md border border-line/50 bg-card/30 px-2.5 py-1.5 text-[11px]">
            <span className={ev.isError || danger ? 'text-danger' : 'text-warn'}>⚙</span>
            <span className="font-mono text-muted">{ev.name}</span>
            {ev.isError ? (
              <span className="text-[10px] text-danger">失败</span>
            ) : ev.approvedBy ? (
              <span className="text-[9px] text-faint">{ev.approvedBy}</span>
            ) : null}
            <span className="ml-auto font-mono text-[9px] text-faint">{fmtDur(ev.durationMs)}</span>
          </div>
        )
      })}
    </div>
  )
}
