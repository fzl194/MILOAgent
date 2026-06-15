import type { ContextMetrics } from '../../../agent-core/agent/context-strategy'

/** Token fill gauge + window/message-count breakdown. The fill bar is the
 *  headline number — it answers "how full was the context window this request?". */
export function TokenDashboard(props: {
  metrics: ContextMetrics
  config: { contextWindow: number; temperature?: number; maxTokens?: number }
}): React.ReactElement {
  const { metrics, config } = props
  const fillPct = Math.min(100, Math.round(metrics.fillRatio * 100))
  // Colour shifts as the window fills: green → amber → red past the budget ratio.
  const barCls = fillPct < 50 ? 'bg-emerald-500' : fillPct < 80 ? 'bg-amber-500' : 'bg-red-500'

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
    </div>
  )
}
