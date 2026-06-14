import { useEffect, useMemo, useState } from 'react'
import { useStatsStore } from '../../stores/stats-store'
import { useModelStore } from '../../stores/model-store'
import { useSessionStore } from '../../stores/session-store'
import { useProjectStore } from '../../stores/project-store'
import { loadPricing, savePricing, computeCost, lookupPricing, formatCost, type ModelPricing } from '../../lib/pricing'

/** Convert an epoch-ms timestamp to a YYYY-MM-DD day string, tolerating bad input. */
function toDayKey(ts: unknown): string | null {
  const d = new Date(Number(ts))
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/** Nearest-rank percentile of a (sorted asc) list. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1)
  return sorted[Math.min(idx, sorted.length - 1)]
}

interface Bucket {
  label: string
  tokens: number
}

/** Token buckets for the trend chart. Granularity adapts to the range:
 *  "today" → hourly (24 buckets); any multi-day range → daily buckets.
 *  This is why "today" now shows an intra-day curve instead of a single point. */
function bucketEvents(
  events: Array<{ timestamp: number; inputTokens?: number; outputTokens?: number }>,
  range: 'today' | '7d' | '14d' | '30d' | 'custom',
  customStart: string,
  customEnd: string
): Bucket[] {
  const tok = (e: { inputTokens?: number; outputTokens?: number }) => (e.inputTokens || 0) + (e.outputTokens || 0)
  const valid = (e: { timestamp: number }) => typeof e.timestamp === 'number' && Number.isFinite(e.timestamp)
  const now = new Date()

  if (range === 'today') {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const buckets: Bucket[] = Array.from({ length: 24 }, (_, h) => ({
      label: (h < 10 ? '0' + h : h) + ':00',
      tokens: 0
    }))
    for (const e of events) {
      if (!valid(e)) continue
      const h = Math.floor((e.timestamp - dayStart) / 3_600_000)
      if (h >= 0 && h < 24) buckets[h].tokens += tok(e)
    }
    return buckets
  }

  // daily buckets
  let startMs: number
  let endMs: number
  if (range === '7d' || range === '14d' || range === '30d') {
    const n = range === '7d' ? 7 : range === '14d' ? 14 : 30
    endMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - 1
    startMs = endMs - n * 86_400_000 + 1
  } else {
    startMs = customStart ? new Date(customStart + 'T00:00:00').getTime() : 0
    endMs = customEnd ? new Date(customEnd + 'T23:59:59').getTime() : Date.now()
  }
  const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const map = new Map<string, number>()
  for (const e of events) {
    if (!valid(e) || e.timestamp < startMs || e.timestamp > endMs) continue
    const k = dayKey(e.timestamp)
    map.set(k, (map.get(k) || 0) + tok(e))
  }
  const out: Bucket[] = []
  const cur = new Date(Math.max(startMs, 0))
  cur.setHours(0, 0, 0, 0)
  const endDay = dayKey(endMs)
  for (let i = 0; i < 400; i++) {
    const k = dayKey(cur.getTime())
    out.push({ label: k.slice(5), tokens: map.get(k) || 0 })
    if (k === endDay) break
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

/** Catmull-Rom → cubic-bezier smooth path through points (SVG user coords).
 *  Control points + endpoints are clamped to [0,40] so overshoot from spiky data
 *  can't push the curve outside the viewBox (no negative dips). */
function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length === 0) return ''
  const clampY = (y: number) => Math.max(0, Math.min(40, y))
  if (pts.length === 1) return `M ${pts[0][0]},${clampY(pts[0][1])}`
  let d = `M ${pts[0][0]},${clampY(pts[0][1])}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] || p2
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = clampY(p1[1] + (p2[1] - p0[1]) / 6)
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = clampY(p2[1] - (p3[1] - p1[1]) / 6)
    d += ` C ${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${clampY(p2[1])}`
  }
  return d
}

/** Adaptive token formatting: 123 → 123, 12300 → 12.3K, 1230000 → 1.2M. */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1) + 'K'
  return String(Math.round(n))
}

const isValidDur = (d: unknown): d is number => typeof d === 'number' && Number.isFinite(d) && d >= 0
const isValidToken = (t: unknown): t is number => typeof t === 'number' && Number.isFinite(t) && t >= 0

interface ToolStat {
  count: number
  errors: number
  totalMs: number
  durationCount: number
}

interface ModelStat {
  count: number
  input: number
  output: number
  totalMs: number
  cost: number
  priced: boolean
}

export function StatsPanel(): React.ReactElement {
  const events = useStatsStore((s) => s.events)
  const isLoaded = useStatsStore((s) => s.isLoaded)
  const loadStats = useStatsStore((s) => s.loadStats)
  const models = useModelStore((s) => s.models)
  const sessions = useSessionStore((s) => s.sessions)
  const projects = useProjectStore((s) => s.projects)
  const eventsByProject = useStatsStore((s) => s.eventsByProject)
  // Project filter: 'all' = aggregate every project; otherwise a single projectId.
  const [selectedProjectId, setSelectedProjectId] = useState<string | 'all'>('all')
  // If the selected project disappears (deleted), fall back to the global view.
  useEffect(() => {
    if (selectedProjectId !== 'all' && !projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId('all')
    }
  }, [projects, selectedProjectId])
  const filteredEvents = selectedProjectId === 'all' ? events : eventsByProject[selectedProjectId] ?? []
  const [toolStats, setToolStats] = useState<Record<string, ToolStat>>({})
  const [loadError, setLoadError] = useState<string | null>(null)

  // Pricing table (localStorage-backed, isolated from main process)
  const [pricingTable, setPricingTable] = useState<Record<string, ModelPricing>>(() => loadPricing())
  const [showPricing, setShowPricing] = useState(false)
  const [range, setRange] = useState<'today' | '7d' | '14d' | '30d' | 'custom'>('7d')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')

  useEffect(() => {
    setLoadError(null)
    loadStats().catch((e: unknown) => setLoadError(String((e as Error)?.message ?? e)))
  }, [loadStats])

  // Aggregate tool-level stats from per-session trace files (atomic tool_call rows).
  // Read concurrently; a single session failing must not abort the whole aggregate.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const acc: Record<string, ToolStat> = {}
      const scoped = sessions.filter((s) => selectedProjectId === 'all' || s.projectId === selectedProjectId)
      const results = await Promise.allSettled(scoped.map((s) => window.electronAPI.readTrace(s.projectId, s.id)))
      for (const r of results) {
        if (r.status !== 'fulfilled') continue // skip a failed session, keep the rest
        for (const ev of (r.value.data || []) as Array<{
          type?: string
          name?: string
          isError?: boolean
          durationMs?: number
        }>) {
          if (ev.type === 'tool_call' && ev.name) {
            if (!acc[ev.name]) acc[ev.name] = { count: 0, errors: 0, totalMs: 0, durationCount: 0 }
            acc[ev.name].count++
            if (ev.isError) acc[ev.name].errors++
            if (isValidDur(ev.durationMs)) {
              acc[ev.name].totalMs += ev.durationMs
              acc[ev.name].durationCount++
            }
          }
        }
      }
      if (!cancelled) setToolStats(acc)
    })()
    return () => {
      cancelled = true
    }
  }, [sessions, selectedProjectId])

  const summary = useMemo(() => {
    const modelStats: Record<string, ModelStat> = {}
    const dailyTokens: Record<string, number> = {}
    const durations: number[] = []
    let totalInput = 0
    let totalOutput = 0
    let totalTools = 0
    let totalMs = 0
    let apiCount = 0
    let nonApiCount = 0
    let totalCost = 0
    let unpricedTokens = 0
    for (const e of filteredEvents) {
      const mid = e.modelConfigId ?? 'unknown'
      if (!modelStats[mid]) modelStats[mid] = { count: 0, input: 0, output: 0, totalMs: 0, cost: 0, priced: false }
      modelStats[mid].count++
      const inT = isValidToken(e.inputTokens) ? e.inputTokens : 0
      const outT = isValidToken(e.outputTokens) ? e.outputTokens : 0
      modelStats[mid].input += inT
      modelStats[mid].output += outT
      totalInput += inT
      totalOutput += outT
      totalTools += typeof e.toolCalls === 'number' && Number.isFinite(e.toolCalls) && e.toolCalls >= 0 ? e.toolCalls : 0
      // Single, consistent duration validity filter for averages AND percentiles
      // (and for the per-model latency). Negative / non-finite durations never enter.
      if (isValidDur(e.durationMs)) {
        durations.push(e.durationMs)
        totalMs += e.durationMs
        modelStats[mid].totalMs += e.durationMs
      }
      if (e.usageSource === 'api') apiCount++
      else if (e.usageSource) nonApiCount++
      const day = toDayKey(e.timestamp)
      if (day) dailyTokens[day] = (dailyTokens[day] || 0) + inT + outT
    }
    // NOTE: cost is looked up from the CURRENT model config. If a model is later
    // renamed / deleted, historical events will be re-priced under the new name
    // or show as unpriced. A precise fix needs a trace-time model name persisted
    // on UsageEvent — out of scope here (touches another agent's files).
    for (const [mid, m] of Object.entries(modelStats)) {
      const mdl = models.find((x) => x.id === mid)
      const p = mdl ? lookupPricing(mdl.model, pricingTable) : undefined
      if (p) {
        m.cost = computeCost(m.input, m.output, p)
        totalCost += m.cost
        m.priced = true
      } else {
        m.priced = false
        unpricedTokens += m.input + m.output
      }
    }
    durations.sort((a, b) => a - b)
    return {
      turns: filteredEvents.length,
      totalInput,
      totalOutput,
      totalTools,
      totalMs,
      avgMs: durations.length ? totalMs / durations.length : 0,
      modelStats,
      dailyTokens,
      apiCount,
      nonApiCount,
      totalCost,
      unpricedTokens,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99)
    }
  }, [filteredEvents, models, pricingTable])

  const updatePricing = (model: string, field: keyof ModelPricing, raw: number): void => {
    // Normalize at the data layer (the input's min=0 is a UX hint, not a guarantee)
    const value = Number.isFinite(raw) && raw >= 0 ? raw : 0
    const next = { ...pricingTable }
    // Preserve an inherited (lookup) value for the unedited field, so editing
    // only "input" doesn't zero out "output".
    const existing = next[model] ?? lookupPricing(model, pricingTable) ?? { inputPer1M: 0, outputPer1M: 0 }
    next[model] = { ...existing, [field]: value }
    setPricingTable(next)
    savePricing(next)
  }

  // Token trend: buckets adapt granularity to the range (today→hourly, else daily)
  // and render as a smoothed curve with a gradient fill.
  const buckets = useMemo(
    () => bucketEvents(filteredEvents, range, customStart, customEnd),
    [filteredEvents, range, customStart, customEnd]
  )
  const maxBucket = Math.max(1, ...buckets.map((b) => b.tokens))
  const totalInRange = buckets.reduce((s, b) => s + b.tokens, 0)
  const modelEntries = Object.entries(summary.modelStats).sort((a, b) => b[1].cost - a[1].cost || b[1].count - a[1].count)
  const maxModelTokens = Math.max(1, ...modelEntries.map(([, m]) => m.input + m.output))
  const toolEntries = Object.entries(toolStats).sort((a, b) => b[1].count - a[1].count)
  const totalDataPoints = summary.apiCount + summary.nonApiCount

  if (loadError) {
    return (
      <div className="rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
        统计数据加载失败：{loadError}
        <button
          type="button"
          onClick={() => {
            setLoadError(null)
            loadStats().catch((e: unknown) => setLoadError(String((e as Error)?.message ?? e)))
          }}
          className="ml-2 underline"
        >
          重试
        </button>
      </div>
    )
  }

  if (!isLoaded) {
    return <div className="py-10 text-center font-mono text-xs tracking-wider text-faint">LOADING…</div>
  }

  const card = (label: string, value: string, sub?: string): React.ReactElement => (
    <div className="rounded-xl border border-line bg-card/50 p-3.5 transition hover:border-accent/30">
      <div className="label-tag mb-1.5">{label}</div>
      <div className="font-mono text-2xl font-semibold text-fg">{value}</div>
      {sub && <div className="mt-1 font-mono text-[10px] text-faint">{sub}</div>}
    </div>
  )

  const latencies: { label: string; v: number }[] = [
    { label: '平均', v: summary.avgMs },
    { label: 'P50', v: summary.p50 },
    { label: 'P95', v: summary.p95 },
    { label: 'P99', v: summary.p99 }
  ]

  return (
    <div className="space-y-4">
      {/* Project filter */}
      <div className="flex items-center gap-2">
        <span className="label-tag">项目</span>
        <select
          value={selectedProjectId}
          onChange={(e) => setSelectedProjectId(e.target.value)}
          className="field max-w-xs py-0.5 font-mono text-[11px]"
        >
          <option value="all">全部</option>
          {[...projects]
            .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name + (p.isDefault ? '（默认）' : '')}
              </option>
            ))}
        </select>
      </div>

      {/* Overview */}
      <div className="grid grid-cols-2 gap-3">
        {card('总 TOKEN', ((summary.totalInput + summary.totalOutput) / 1000).toFixed(1) + 'k', `↑${summary.totalInput} · ↓${summary.totalOutput}`)}
        {card('总成本', formatCost(summary.totalCost), summary.unpricedTokens > 0 ? `${(summary.unpricedTokens / 1000).toFixed(1)}k 未定价` : undefined)}
        {card('对话轮数', String(summary.turns))}
        {card('工具调用', String(summary.totalTools))}
      </div>

      {/* Latency distribution (per turn) */}
      <div className="rounded-xl border border-line bg-card/40 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-fg">延迟分布</span>
          <span className="label-tag">每轮对话</span>
        </div>
        <div className="grid grid-cols-4 gap-2 text-center">
          {latencies.map((x) => (
            <div key={x.label}>
              <div className="font-mono text-base font-semibold text-fg">{(x.v / 1000).toFixed(1)}s</div>
              <div className="label-tag mt-0.5">{x.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Data quality (real vs estimated token sources) */}
      {totalDataPoints > 0 && (
        <div className="rounded-xl border border-line bg-card/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-fg">数据质量</span>
            <span className="label-tag">TOKEN 来源</span>
          </div>
          <div className="flex h-2 overflow-hidden rounded-full bg-base">
            {summary.apiCount > 0 && (
              <div className="h-full" style={{ width: `${(summary.apiCount / totalDataPoints) * 100}%`, background: 'var(--color-accent)' }} />
            )}
            {summary.nonApiCount > 0 && (
              <div className="h-full" style={{ width: `${(summary.nonApiCount / totalDataPoints) * 100}%`, background: 'var(--color-warn)' }} />
            )}
          </div>
          <div className="mt-1.5 flex gap-4 font-mono text-[10px] text-faint">
            <span>
              <span className="text-accent">●</span> 真实 {summary.apiCount}
            </span>
            <span>
              <span className="text-warn">●</span> 估算/部分 {summary.nonApiCount}
            </span>
          </div>
        </div>
      )}

      {/* Per-model breakdown: tokens · calls · cost */}
      <div className="rounded-xl border border-line bg-card/40 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-fg">模型用量</span>
          <button
            type="button"
            onClick={() => setShowPricing((v) => !v)}
            className="font-mono text-[10px] text-accent transition hover:text-fg"
          >
            {showPricing ? '收起定价' : '编辑定价'}
          </button>
        </div>
        {modelEntries.length === 0 && <div className="py-3 text-center text-xs text-faint">暂无数据</div>}
        {modelEntries.map(([id, m]) => {
          const mdl = models.find((x) => x.id === id)
          const tokens = m.input + m.output
          return (
            <div key={id} className="mb-2.5 last:mb-0">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-muted">{mdl?.name || (id || '?').slice(0, 8)}</span>
                <span className="font-mono text-[10px] text-faint">
                  {(tokens / 1000).toFixed(1)}k · {m.count}次 · {m.priced ? formatCost(m.cost) : '未定价'}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-base">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${(tokens / maxModelTokens) * 100}%`, background: 'linear-gradient(90deg, var(--color-accent), var(--color-accent2))' }}
                />
              </div>
            </div>
          )
        })}

        {/* Inline pricing editor (controlled inputs) */}
        {showPricing && (
          <div className="mt-3 space-y-2 border-t border-line/60 pt-3">
            <div className="label-tag">USD / 1M TOKENS · 修改自动保存</div>
            {models.length === 0 && <div className="text-xs text-faint">先在「模型管理」添加模型</div>}
            {models.map((m) => {
              const cur = pricingTable[m.model] ?? lookupPricing(m.model, pricingTable) ?? { inputPer1M: 0, outputPer1M: 0 }
              return (
                <div key={m.id} className="flex items-center gap-2 text-xs">
                  <span className="w-36 truncate font-mono text-muted" title={m.model}>{m.model}</span>
                  <label className="flex items-center gap-1">
                    <span className="text-faint">入</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={cur.inputPer1M}
                      onChange={(e) => updatePricing(m.model, 'inputPer1M', parseFloat(e.target.value))}
                      className="field w-20 py-0.5 font-mono text-[11px]"
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="text-faint">出</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={cur.outputPer1M}
                      onChange={(e) => updatePricing(m.model, 'outputPer1M', parseFloat(e.target.value))}
                      className="field w-20 py-0.5 font-mono text-[11px]"
                    />
                  </label>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Tool breakdown (aggregated from trace tool_call rows) */}
      <div className="rounded-xl border border-line bg-card/40 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-fg">工具调用</span>
          <span className="label-tag">次数 · 错误率 · 延迟</span>
        </div>
        {toolEntries.length === 0 && <div className="py-3 text-center text-xs text-faint">暂无工具调用记录</div>}
        {toolEntries.map(([name, t]) => {
          const errRate = t.count ? (t.errors / t.count) * 100 : 0
          const avgMs = t.durationCount ? t.totalMs / t.durationCount : 0
          return (
            <div key={name} className="mb-2 flex items-center justify-between text-xs last:mb-0">
              <span className="font-mono text-muted">{name}</span>
              <span className="font-mono text-[10px] text-faint">
                {t.count}次 · {avgMs > 0 ? avgMs.toFixed(0) + 'ms' : '-'}
                {errRate > 0 && <span className="ml-1 text-danger">· {errRate.toFixed(0)}%错</span>}
              </span>
            </div>
          )
        })}
      </div>

      {/* Daily token trend */}
      <div className="rounded-xl border border-line bg-card/40 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-fg">TOKEN 趋势</span>
          <div className="flex items-center gap-1">
            {(['today', '7d', '14d', '30d'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`rounded-md px-2 py-0.5 font-mono text-[10px] transition ${range === r ? 'bg-card/70 text-fg' : 'text-faint hover:text-muted'}`}
              >
                {r === 'today' ? '今天' : r}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setRange('custom')}
              className={`rounded-md px-2 py-0.5 font-mono text-[10px] transition ${range === 'custom' ? 'bg-card/70 text-fg' : 'text-faint hover:text-muted'}`}
            >
              自定义
            </button>
          </div>
        </div>
        {range === 'custom' && (
          <div className="mb-3 flex items-center gap-2 text-xs text-faint">
            <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="field w-36 py-0.5 font-mono text-[11px]" />
            <span>→</span>
            <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="field w-36 py-0.5 font-mono text-[11px]" />
          </div>
        )}
        {buckets.length === 0 || totalInRange === 0 ? (
          <div className="py-6 text-center text-xs text-faint">暂无数据</div>
        ) : buckets.length === 1 ? (
          <div className="py-6 text-center font-mono text-xs text-muted">{buckets[0].tokens} tokens · {buckets[0].label}</div>
        ) : (
          <div className="flex gap-2">
            {/* y-axis: adaptive K/M labels (top = max, mid = half, bottom = 0) */}
            <div className="flex h-28 shrink-0 flex-col justify-between py-0.5 font-mono text-[9px] text-faint">
              <span>{formatTokens(maxBucket)}</span>
              <span>{formatTokens(maxBucket / 2)}</span>
              <span>0</span>
            </div>
            <div className="min-w-0 flex-1">
              <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-28 w-full">
                <defs>
                  <linearGradient id="tokenFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
                  </linearGradient>
                  <linearGradient id="tokenLine" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="var(--color-accent)" />
                    <stop offset="100%" stopColor="var(--color-accent2)" />
                  </linearGradient>
                </defs>
                {(() => {
                  const pts: Array<[number, number]> = buckets.map((b, i) => [
                    (i / (buckets.length - 1)) * 100,
                    38 - (b.tokens / maxBucket) * 34
                  ])
                  const line = smoothPath(pts)
                  return (
                    <>
                      <path d={`${line} L 100,40 L 0,40 Z`} fill="url(#tokenFill)" stroke="none" />
                      <path d={line} fill="none" stroke="url(#tokenLine)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
                    </>
                  )
                })()}
              </svg>
              <div className="mt-1 flex justify-between font-mono text-[10px] text-faint">
                <span>{buckets[0].label}</span>
                {buckets.length > 4 && <span>{buckets[Math.floor(buckets.length / 2)].label}</span>}
                <span>{buckets[buckets.length - 1].label}</span>
              </div>
            </div>
          </div>
        )}
      </div>

    </div>
  )
}
