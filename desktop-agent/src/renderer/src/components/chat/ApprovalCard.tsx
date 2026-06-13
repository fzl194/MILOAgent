import { useChatStore } from '../../stores/chat-store'
import type { ApprovalRequest, RiskLevel } from '../../agent-core/types'

const LEVEL_META: Record<RiskLevel, { label: string; tone: string; icon: string }> = {
  safe: { label: '安全', tone: 'var(--color-ok)', icon: '✓' },
  write: { label: '写入', tone: 'var(--color-accent)', icon: '✎' },
  network: { label: '网络', tone: 'var(--color-warn)', icon: '⇅' },
  dangerous: { label: '危险', tone: 'var(--color-danger)', icon: '⚠' }
}

function preview(req: ApprovalRequest): string {
  if (req.name === 'run_shell') return String(req.args.command ?? '')
  if (req.name === 'write_file') return `${req.args.path ?? ''}\n\n${String(req.args.content ?? '').slice(0, 400)}${String(req.args.content ?? '').length > 400 ? '\n…' : ''}`
  if (req.name === 'read_file') return String(req.args.path ?? '')
  return JSON.stringify(req.args, null, 2)
}

export function ApprovalCard(): React.ReactElement | null {
  const pending = useChatStore((s) => s.pendingApprovals)
  const resolve = useChatStore((s) => s.resolveApproval)
  if (pending.length === 0) return null

  return (
    <div className="space-y-2.5">
      {pending.map((req) => {
        const meta = LEVEL_META[req.level]
        const canRemember = req.patterns.length > 0 // dangerous calls have no patterns
        return (
          <div key={req.reqId} className="mx-auto max-w-3xl rise">
            <div
              className="rounded-xl border bg-card/70 p-3.5 shadow-lg backdrop-blur-sm"
              style={{ borderColor: `color-mix(in srgb, ${meta.tone} 45%, transparent)` }}
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm" style={{ color: meta.tone }}>{meta.icon}</span>
                <span className="font-mono text-[11px] tracking-wider" style={{ color: meta.tone }}>
                  APPROVAL · {meta.label}
                </span>
                <span className="font-mono text-[11px] text-fg">· {req.name}</span>
                <span className="ml-auto font-mono text-[10px] text-faint">{req.reason}</span>
              </div>

              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-term-bg p-2.5 font-mono text-[11px] leading-relaxed text-muted">
                {preview(req)}
              </pre>

              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                <button
                  onClick={() => resolve(req.reqId, { approved: false })}
                  className="rounded-lg border border-line bg-base/60 px-3 py-1.5 text-xs text-muted transition hover:border-danger/50 hover:text-danger"
                >
                  拒绝
                </button>
                {canRemember && (
                  <>
                    <button
                      onClick={() => resolve(req.reqId, { approved: true, remember: true, scope: 'session' })}
                      className="rounded-lg border border-line bg-base/60 px-3 py-1.5 text-xs text-muted transition hover:border-accent/50 hover:text-fg"
                      title="本会话内同类自动放行（持久化，重启保留）"
                    >
                      批准·记住(会话)
                    </button>
                    <button
                      onClick={() => resolve(req.reqId, { approved: true, remember: true, scope: 'project' })}
                      className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent transition hover:bg-accent/20"
                      title="本项目内同类自动放行（对该项目所有会话生效）"
                    >
                      批准·记住(项目)
                    </button>
                  </>
                )}
                <button
                  onClick={() => resolve(req.reqId, { approved: true })}
                  className="btn btn-primary px-3 py-1.5 text-xs"
                >
                  批准
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
