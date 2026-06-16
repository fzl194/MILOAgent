import { memo, useEffect, useMemo, useRef } from 'react'
import { useMonitorStore } from '../../../stores/monitor-store'
import { useProjectStore } from '../../../stores/project-store'
import { DIMENSIONS } from '../../../monitor/dimensions'
import type { DimKey, MonitorEnvelope, SnapshotMeta } from '../../../monitor/types'
import type { TokenUsageEvent, TurnLifecycleEvent } from '../../../monitor/types'
import type { ApprovalSource, RiskLevel } from '../../../agent-core/types'
import { APPROVAL_TONE, RISK_TONE, badgeStyle, type ToneMeta } from '../../../agent-core/risk-tone'

/** Surface-specific labels for monitor event-stream badges. The shared
 *  `risk-tone.ts` module provides color tokens only; labels live with each
 *  consumer so different surfaces can diverge (e.g. chat card may use
 *  localized text later) without re-coordinating. */
const RISK_LABEL: Record<RiskLevel, string> = {
  safe: 'SAFE',
  write: 'WRITE',
  network: 'NET',
  dangerous: 'DANGER'
}

const APPROVAL_LABEL: Record<ApprovalSource, string> = {
  user: 'USER',
  auto: 'AUTO',
  allowlist: 'LIST',
  denied: 'DENIED'
}

/** A row's textual summary is paired with a small set of inline-styled badges.
 *  Style is injected via `style` (not Tailwind classes) so it picks up the
 *  active light/dark theme and matches the chat `ToolInvocationCard` colors. */
interface RowSummary {
  primary: string
  badges: Array<{ label: string; tone: ToneMeta; title?: string }>
}

/** Keyed by `${callId}-${dimension}` — same value the row uses as React key.
 *  Re-keying (e.g. session switch, dimension toggle hiding a row) drops the
 *  cached entry naturally; nothing leaks across events. */
type SummaryMap = ReadonlyMap<string, RowSummary>

/** Left pane: live event stream (live mode) or snapshot list (replay mode).
 *  Auto-scrolls to the newest row in live mode. */
export function LiveEventStream(): React.ReactElement {
  const mode = useMonitorStore((s) => s.mode)
  const liveEvents = useMonitorStore((s) => s.liveEvents)
  const dimensionEnabled = useMonitorStore((s) => s.dimensionEnabled)
  const snapshotIndex = useMonitorStore((s) => s.snapshotIndex)
  const selectedCallId = useMonitorStore((s) => s.selectedCallId)
  const selectCall = useMonitorStore((s) => s.selectCall)
  const subscriptionState = useMonitorStore((s) => s.subscriptionState)
  const lastError = useMonitorStore((s) => s.lastError)
  const pid = useProjectStore((s) => s.activeProjectId)

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el && mode === 'live') {
      const id = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
      return () => cancelAnimationFrame(id)
    }
  }, [liveEvents, mode])

  // Memoize the filtered view so a parent re-render (e.g. selection change) does
  // NOT re-filter the whole stream; only dimension toggles / new events do.
  const visible = useMemo(
    () => liveEvents.filter((e) => dimensionEnabled[e.dimension]),
    [liveEvents, dimensionEnabled]
  )

  // Pre-compute every row's summary once per `visible` change. This is the
  // fix for HIGH H2: without it, `EventRow` (memo'd) would see a fresh
  // RowSummary reference on every render of the parent and re-render all rows
  // — the whole point of memo was to avoid that.
  const summaries = useMemo<SummaryMap>(() => {
    const m = new Map<string, RowSummary>()
    for (let i = 0; i < visible.length; i++) {
      const e = visible[i]
      const k = `${e.envelope.callId}-${e.dimension}-${i}`
      m.set(k, summarize(e.dimension, e.payload))
    }
    return m
  }, [visible])

  const isError = mode === 'replay' && subscriptionState === 'error'

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line/40 px-3 py-2 font-mono text-[10px] tracking-wider text-faint">
        {mode === 'live' ? `实时事件流 · ${visible.length}` : `请求快照 · ${snapshotIndex.length}`}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {isError ? (
          <EmptyHint text={`加载失败 · ${lastError ?? '未知错误'}(点 ● 实时 返回)`} />
        ) : mode === 'live' ? (
          visible.length === 0 ? (
            <EmptyHint text="等待事件… 发一条消息触发 agent" />
          ) : (
            visible.map((e, i) => {
              const k = `${e.envelope.callId}-${e.dimension}-${i}`
              return (
                <EventRow
                  key={k}
                  dimension={e.dimension}
                  envelope={e.envelope}
                  summary={summaries.get(k)!}
                  selected={selectedCallId === e.envelope.callId}
                  onClick={() => {
                    if (pid) void selectCall(pid, e.envelope.callId)
                  }}
                />
              )
            })
          )
        ) : snapshotIndex.length === 0 ? (
          <EmptyHint text="该会话没有请求快照" />
        ) : (
          snapshotIndex
            .slice()
            .reverse()
            .map((m) => (
              <SnapshotRow
                key={m.callId}
                meta={m}
                selected={selectedCallId === m.callId}
                onClick={() => {
                  if (pid) void selectCall(pid, m.callId)
                }}
              />
            ))
        )}
      </div>
    </div>
  )
}

function EmptyHint({ text }: { text: string }): React.ReactElement {
  return <div className="px-3 py-8 text-center text-xs text-faint">{text}</div>
}

/** Memoized so a row only re-renders when ITS props change — a new event landing
 *  in the stream won't re-render every prior row. The parent's `summaries`
 *  Map is stable per `visible`, so the `summary` prop reference is stable too. */
const EventRow = memo(function EventRow(props: {
  dimension: DimKey
  envelope: MonitorEnvelope
  summary: RowSummary
  selected: boolean
  onClick: () => void
}): React.ReactElement {
  const { dimension, envelope, summary, selected, onClick } = props
  const dim = DIMENSIONS[dimension]
  return (
    <button
      onClick={onClick}
      className={`flex w-full flex-col gap-0.5 border-b border-line/20 px-3 py-1.5 text-left transition hover:bg-card/30 ${
        selected ? 'bg-accent/10' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${dimColor(dimension)}`}>{dim.label}</span>
        <span className="font-mono text-[10px] text-faint">r{envelope.round}</span>
        <span className="ml-auto font-mono text-[9px] text-faint">{fmtTime(envelope.ts)}</span>
      </div>
      <div className="flex items-center gap-1.5">
        {summary.badges.map((b, i) => (
          <span
            key={i}
            title={b.title}
            className="shrink-0 rounded border px-1 py-0.5 font-mono text-[9px] tracking-wider"
            style={badgeStyle(b.tone)}
          >
            {b.label}
          </span>
        ))}
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{summary.primary}</span>
      </div>
    </button>
  )
})

const SnapshotRow = memo(function SnapshotRow(props: {
  meta: SnapshotMeta
  selected: boolean
  onClick: () => void
}): React.ReactElement {
  const { meta, selected, onClick } = props
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 border-b border-line/20 px-3 py-1.5 text-left transition hover:bg-card/30 ${
        selected ? 'bg-accent/10' : ''
      }`}
    >
      <span className="rounded bg-accent/20 px-1.5 py-0.5 font-mono text-[9px] text-accent">请求</span>
      <span className="font-mono text-[10px] text-faint">r{meta.round}</span>
      <span className="truncate font-mono text-[10px] text-faint">{meta.modelConfigId.slice(0, 12)}</span>
      <span className="ml-auto font-mono text-[9px] text-faint">{fmtTime(meta.ts)}</span>
    </button>
  )
})

function summarize(dimension: DimKey, payload: unknown): RowSummary {
  if (!payload) return { primary: '—', badges: [] }
  switch (dimension) {
    case 'request_view': {
      const p = payload as { view?: unknown[]; metrics?: { tokenEstimate?: number; fillRatio?: number } }
      const msgs = p.view?.length ?? 0
      const tok = p.metrics?.tokenEstimate ?? 0
      const fill = p.metrics?.fillRatio ? `${Math.round(p.metrics.fillRatio * 100)}%` : '?'
      return { primary: `${msgs} 条消息 · ~${tok} tok · 填充 ${fill}`, badges: [] }
    }
    case 'context_metrics': {
      const p = payload as { metrics?: { fillRatio?: number }; decisions?: unknown[] }
      const fill = p.metrics?.fillRatio ? `${Math.round(p.metrics.fillRatio * 100)}%` : '?'
      const decs = p.decisions?.length ?? 0
      return { primary: `填充 ${fill} · ${decs} 个裁剪决策`, badges: [] }
    }
    case 'tool_call': {
      const p = payload as {
        name?: string
        isError?: boolean
        durationMs?: number
        riskLevel?: RiskLevel
        approvedBy?: ApprovalSource
      }
      const badges: RowSummary['badges'] = []
      if (p.riskLevel) {
        badges.push({ label: RISK_LABEL[p.riskLevel], tone: RISK_TONE[p.riskLevel], title: `风险:${p.riskLevel}` })
      }
      if (p.approvedBy) {
        badges.push({ label: APPROVAL_LABEL[p.approvedBy], tone: APPROVAL_TONE[p.approvedBy], title: `审批:${p.approvedBy}` })
      }
      const parts: string[] = []
      parts.push(p.name ?? '?')
      if (p.isError) parts.push('失败')
      if (p.durationMs != null) parts.push(`${p.durationMs}ms`)
      return { primary: parts.join(' · '), badges }
    }
    case 'token_usage': {
      const p = payload as TokenUsageEvent
      return {
        primary: `↑${p.inputTokens} ↓${p.outputTokens}${p.cachedTokens ? ` · cache ${p.cachedTokens}` : ''} · ${p.usageSource}`,
        badges: []
      }
    }
    case 'turn_lifecycle': {
      const p = payload as TurnLifecycleEvent
      return { primary: `${p.stage}${p.reason ? ` · ${p.reason}` : ''}`, badges: [] }
    }
  }
}

function dimColor(d: DimKey): string {
  switch (d) {
    case 'request_view':
      return 'bg-accent/20 text-accent'
    case 'context_metrics':
      return 'bg-blue-500/20 text-blue-400'
    case 'tool_call':
      return 'bg-amber-500/20 text-amber-400'
    case 'token_usage':
      return 'bg-emerald-500/20 text-emerald-400'
    case 'turn_lifecycle':
      return 'bg-fuchsia-500/20 text-fuchsia-400'
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
