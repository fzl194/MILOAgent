import type { CompactionDecision } from '../../../monitor/types'

/** Lists each compaction step's decision: who ran, what was dropped/elided,
 *  before/after token estimates. Empty when no compaction ran this request. */
export function CompactionDecisionList(props: { decisions: CompactionDecision[] }): React.ReactElement {
  const { decisions } = props
  if (decisions.length === 0) {
    return (
      <div className="rounded-lg border border-line/30 bg-bg/20 px-3 py-2">
        <div className="font-mono text-[10px] tracking-wider text-faint">裁剪决策</div>
        <div className="mt-0.5 text-[11px] text-faint">本次请求未触发任何压缩</div>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-line/30 bg-bg/20 px-3 py-2">
      <div className="mb-1.5 font-mono text-[10px] tracking-wider text-faint">
        裁剪决策 · {decisions.length} 步
      </div>
      <div className="flex flex-col gap-1.5">
        {decisions.map((d, i) => (
          <DecisionRow key={`${d.compactor}-${i}`} decision={d} />
        ))}
      </div>
    </div>
  )
}

function DecisionRow({ decision }: { decision: CompactionDecision }): React.ReactElement {
  const saved = decision.before - decision.after
  return (
    <div className="rounded-md border border-line/20 bg-bg/30 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[9px] text-amber-400">
          {decision.compactor}
        </span>
        <span className="text-[10px] text-muted">{decision.reason}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[9px] text-faint">
        <span>
          token {decision.before} → {decision.after}
        </span>
        {saved > 0 && <span className="text-emerald-400">省 {saved}</span>}
        {decision.elidedContent > 0 && <span>折叠 {decision.elidedContent} 字符</span>}
        {decision.droppedMessageIds.length > 0 && (
          <span>丢弃 {decision.droppedMessageIds.length} 条</span>
        )}
      </div>
    </div>
  )
}
