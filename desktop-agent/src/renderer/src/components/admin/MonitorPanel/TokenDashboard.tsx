import type { ContextMetrics } from '../../../agent-core/agent/context-strategy'
import type { RequestSnapshot } from '../../../monitor/types'

/** Token fill gauge + window/message-count breakdown. The fill bar is the
 *  headline number — it answers "how full was the context window this request?".
 *  Also surfaces the post-call API usage (when available via `usagePatch`) so
 *  `cachedTokens` (OpenAI-compatible prompt caching) is visible — the pre-call
 *  estimate cannot know the cache hit count. Replay mode has no patch → we
 *  show '—' for the post-call fields. */
export function TokenDashboard(props: {
  metrics: ContextMetrics
  config: { contextWindow: number; temperature?: number; maxTokens?: number }
  /** P2 context-org: optional post-call usage. undefined in replay mode. */
  usagePatch?: RequestSnapshot['usagePatch']
}): React.ReactElement {
  const { metrics, config, usagePatch } = props
  const fillPct = Math.min(100, Math.round(metrics.fillRatio * 100))
  // Colour shifts as the window fills: green → amber → red past the budget ratio.
  const barCls = fillPct < 50 ? 'bg-emerald-500' : fillPct < 80 ? 'bg-amber-500' : 'bg-red-500'

  // Cache hit ratio: 0 / undefined / 0 input → no useful number. Otherwise
  // cachedTokens / inputTokens, rounded to 1 decimal. Hidden when the API
  // didn't return cachedTokens (older GLM/DeepSeek versions) — showing a
  // misleading 0% would be worse than the explicit dash.
  const hasCache = usagePatch?.cachedTokens != null && usagePatch.inputTokens > 0
  const cachePct = hasCache
    ? Math.round(((usagePatch!.cachedTokens as number) / usagePatch!.inputTokens) * 1000) / 10
    : null

  return (
    <div className="rounded-lg border border-line/30 bg-bg/20 px-3 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mono text-[10px] tracking-wider text-faint">Token 度量(粗估)</span>
        <span className="font-mono text-[10px] text-faint">
          {metrics.tokenEstimate} / {metrics.window} · {metrics.messageCount} 条
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-bg/50">
        <div className={`h-full ${barCls} transition-all`} style={{ width: `${fillPct}%` }} />
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-[9px] text-faint">
        <span>窗口填充 {fillPct}%</span>
        <span>
          contextWindow {config.contextWindow}
          {config.temperature != null && ` · temp ${config.temperature}`}
          {config.maxTokens != null && ` · maxTokens ${config.maxTokens}`}
        </span>
      </div>
      {/* P2 context-org: post-call API usage. Pre-call estimate above is one
          thing; the real numbers (incl. cached_tokens) only exist AFTER the
          model responds. In replay mode this row is dash-only. */}
      <div className="mt-1.5 flex items-center justify-between font-mono text-[9px] text-faint">
        <span>API 用量</span>
        <span>
          {usagePatch
            ? `in ${usagePatch.inputTokens} · out ${usagePatch.outputTokens}${usagePatch.cachedTokens ? ` · cache ${usagePatch.cachedTokens}${cachePct != null ? ` (${cachePct}%)` : ''}` : ''} · ${usagePatch.usageSource}`
            : '— (replay / 待响应)'}
        </span>
      </div>
    </div>
  )
}
