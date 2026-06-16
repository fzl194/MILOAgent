import { useMonitorStore } from '../../../stores/monitor-store'
import { RequestViewList } from './RequestViewList'
import { CompactionDecisionList } from './CompactionDecisionList'
import { TokenDashboard } from './TokenDashboard'
import type { RequestSnapshot } from '../../../monitor/types'

/** Right pane: the full request view + compaction decisions + token dashboard
 *  for the selected callId. Empty state when nothing is selected. */
export function RequestDetailPane(props: {
  selectedCallId: string | null
  onSelect: (callId: string) => void
}): React.ReactElement {
  const snapshot = useMonitorStore((s) => s.selectedSnapshot)
  const lastError = useMonitorStore((s) => s.lastError)

  if (!props.selectedCallId) {
    return <EmptyDetail text="从左侧选择一次请求,查看模型当时实际看到的内容" />
  }
  if (!snapshot) {
    return (
      <EmptyDetail
        text={
          lastError
            ? `快照不可用 · ${lastError}(可能因两步写未完成或会话被删除)`
            : '加载中… 或该请求没有快照(回看模式下旧会话可能缺失)'
        }
      />
    )
  }
  return <SnapshotDetail snapshot={snapshot} />
}

function SnapshotDetail({ snapshot }: { snapshot: RequestSnapshot }): React.ReactElement {
  const stripped =
    (snapshot.selfHeal?.strippedCalls ?? 0) + (snapshot.selfHeal?.strippedResults ?? 0)
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      {/* Header: call attribution */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line/40 bg-bg/30 px-3 py-2">
        <span className="font-mono text-[10px] text-faint">callId</span>
        <span className="font-mono text-[10px] text-muted">{snapshot.callId.slice(0, 13)}</span>
        <span className="font-mono text-[10px] text-faint">round {snapshot.round}</span>
        <span className="font-mono text-[10px] text-faint">model {snapshot.modelConfigId.slice(0, 12) || '—'}</span>
        <span className="ml-auto font-mono text-[10px] text-faint">
          {snapshot.view.length} 条 · ~{snapshot.metrics.tokenEstimate} tok
        </span>
      </div>

      {/* Self-heal warning: the view below is the strategy's output; if self-heal
          changed it before POSTing (orphan tool_calls/results), flag it so the
          engineer isn't misled into thinking this exact array was sent. */}
      {stripped > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">
          ⚠ self-heal 移除了 {snapshot.selfHeal?.strippedCalls ?? 0} 个孤儿 tool_calls、{snapshot.selfHeal?.strippedResults ?? 0} 个孤儿 tool 结果。
          下方视图是策略产出;实际 POST 的消息数少于 {snapshot.view.length}。
        </div>
      )}

      {/* Token dashboard — P2 context-org: also receives the post-call usage
          patch (cachedTokens etc.) when the chat-store has joined it back. */}
      <TokenDashboard metrics={snapshot.metrics} config={snapshot.config} usagePatch={snapshot.usagePatch} />

      {/* Compaction decisions */}
      <CompactionDecisionList decisions={snapshot.decisions} />

      {/* The strategy-produced view (what the compaction pipeline emitted). */}
      <div className="min-h-0 flex-1">
        <div className="mb-1 font-mono text-[10px] tracking-wider text-faint">
          策略视图{stripped > 0 ? '(发送前 · self-heal 前)' : ''}({snapshot.view.length} 条)
        </div>
        <RequestViewList view={snapshot.view} droppedIds={collectDroppedIds(snapshot)} />
      </div>
    </div>
  )
}

function EmptyDetail({ text }: { text: string }): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <span className="text-center text-xs text-faint">{text}</span>
    </div>
  )
}

/** Flatten all dropped message IDs across decisions so the view list can badge them. */
function collectDroppedIds(snapshot: RequestSnapshot): Set<string> {
  const ids = new Set<string>()
  for (const d of snapshot.decisions) {
    for (const id of d.droppedMessageIds) ids.add(id)
  }
  return ids
}
