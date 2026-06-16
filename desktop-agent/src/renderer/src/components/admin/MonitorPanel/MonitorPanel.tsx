import { useEffect, useState } from 'react'
import { useMonitorStore } from '../../../stores/monitor-store'
import { useProjectStore } from '../../../stores/project-store'
import { useSessionStore } from '../../../stores/session-store'
import { MonitorTopBar } from './MonitorTopBar'
import { LiveEventStream } from './LiveEventStream'
import { RequestDetailPane } from './RequestDetailPane'
import { TraceTimeline } from '../TraceTimeline'

/**
 * Runtime monitor panel — admin → 监控 tab.
 *
 * Layout: top bar (mode switch + dimension toggles) over a two-column body
 * (left = event stream / snapshot list, right = either the request detail
 * pane with compaction-decision + token breakdown, OR the per-session trace
 * timeline — toggled by a local sub-view chip on the right). See
 * docs/2026-06-15-desktop-agent-运行态监控面板设计.md §② 监控面板.
 *
 * Enters live mode on mount and tears down on unmount so the bus subscription
 * never leaks when the user switches tabs.
 *
 * Note on the "时间线" sub-view: TraceTimeline always reads the trace already
 * persisted to disk for a given sessionId. In *live* mode we feed it the
 * active chat session (so it shows trace as it accumulates in real time, with
 * a tiny lag equal to the IPC write). In *replay* mode we feed it the
 * session the user is reviewing. The sub-view name is about "which lens
 * (context-shape vs chronological events)" — NOT a third mode axis.
 */

/** Right-pane sub-view. Kept as a *local* useState so the top-level mode
 *  (live/replay) stays a single axis — sub-view is an orthogonal "what lens
 *  to view this session with" choice, not a third mode. */
type SubView = 'context' | 'timeline'

export function MonitorPanel(): React.ReactElement {
  const mode = useMonitorStore((s) => s.mode)
  const enterLiveMode = useMonitorStore((s) => s.enterLiveMode)
  const exitLiveMode = useMonitorStore((s) => s.exitLiveMode)
  const selectedCallId = useMonitorStore((s) => s.selectedCallId)
  const selectCall = useMonitorStore((s) => s.selectCall)
  const replaySessionId = useMonitorStore((s) => s.replaySessionId)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)

  const [subView, setSubView] = useState<SubView>('context')

  // All sessions, used only to find a project-scoped fallback when the
  // replaySessionId isn't set. Global `activeSessionId` is intentionally NOT
  // used as the live-mode fallback — it can point at a session from another
  // project (e.g. user switched projects without restarting a turn), and
  // TraceTimeline would then read the wrong bucket. We restrict fallback to
  // sessions belonging to the active project.
  const sessions = useSessionStore((s) => s.sessions)

  useEffect(() => {
    enterLiveMode()
    return () => exitLiveMode()
  }, [enterLiveMode, exitLiveMode])

  // Timeline session id, project-scoped. Prefer the replay target; else fall
  // back to the active chat session ONLY if it belongs to the active project;
  // else to the most-recently-updated session in the active project; else null
  // (TraceTimeline renders its own empty-state).
  const timelineSessionId = (() => {
    if (replaySessionId) return replaySessionId
    if (!activeProjectId) return null
    const projectSessions = sessions.filter((s) => s.projectId === activeProjectId)
    if (activeSessionId && projectSessions.some((s) => s.id === activeSessionId)) {
      return activeSessionId
    }
    return projectSessions.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null
  })()

  return (
    <div className="flex h-full flex-col gap-3">
      <MonitorTopBar />
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="w-[360px] shrink-0 overflow-hidden rounded-xl border border-line/50 bg-panel/40">
          <LiveEventStream />
        </div>
        {/* Right pane uses a two-row grid: the sub-view strip takes its own
            height, the content fills the rest — no `h-[calc(100%-Nrem)]`
            magic number to drift if padding changes. */}
        <div className="grid min-w-0 flex-1 grid-rows-[auto_1fr] overflow-hidden rounded-xl border border-line/50 bg-panel/40">
          {/* Right-pane sub-view switch. Visual language mirrors MonitorTopBar's
              mode toggle so the panel reads as one design system. */}
          <div className="flex items-center gap-1 border-b border-line/40 px-3 py-1.5">
            <span className="mr-1 font-mono text-[9px] tracking-wider text-faint">视图</span>
            <button
              type="button"
              onClick={() => setSubView('context')}
              className={`rounded-md px-2.5 py-0.5 text-xs transition ${
                subView === 'context' ? 'bg-card/80 text-fg' : 'text-faint hover:text-muted'
              }`}
            >
              📄 上下文
            </button>
            <button
              type="button"
              onClick={() => setSubView('timeline')}
              className={`rounded-md px-2.5 py-0.5 text-xs transition ${
                subView === 'timeline' ? 'bg-card/80 text-fg' : 'text-faint hover:text-muted'
              }`}
            >
              ◐ 时间线
            </button>
            {mode === 'replay' && (
              <span className="ml-auto font-mono text-[9px] text-faint">
                回看模式 · 该会话完整 trace
              </span>
            )}
          </div>
          {/* Sub-view content. No `key` is needed to force-remount:
              RequestDetailPane reads from the monitor store (cheap to re-subscribe
              on remount) and TraceTimeline re-fetches via its own sessionId
              useEffect when timelineSessionId changes. */}
          <div className="min-h-0 overflow-hidden">
            {subView === 'context' ? (
              <RequestDetailPane
                selectedCallId={selectedCallId}
                onSelect={(callId) => {
                  if (activeProjectId) void selectCall(activeProjectId, callId)
                }}
              />
            ) : activeProjectId && timelineSessionId ? (
              <div className="h-full overflow-y-auto p-3">
                <TraceTimeline projectId={activeProjectId} sessionId={timelineSessionId} />
              </div>
            ) : (
              <div className="py-4 text-center text-xs text-faint">
                选择一个会话查看时间线
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
