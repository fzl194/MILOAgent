import { useEffect } from 'react'
import { useMonitorStore } from '../../../stores/monitor-store'
import { useProjectStore } from '../../../stores/project-store'
import { MonitorTopBar } from './MonitorTopBar'
import { LiveEventStream } from './LiveEventStream'
import { RequestDetailPane } from './RequestDetailPane'

/**
 * Runtime monitor panel — admin → 监控 tab.
 *
 * Layout: top bar (mode switch + dimension toggles) over a two-column body
 * (left = event stream / snapshot list, right = request detail with the
 * compaction-decision + token breakdown). See
 * docs/2026-06-15-desktop-agent-运行态监控面板设计.md §② 监控面板.
 *
 * Enters live mode on mount and tears down on unmount so the bus subscription
 * never leaks when the user switches tabs.
 */
export function MonitorPanel(): React.ReactElement {
  const mode = useMonitorStore((s) => s.mode)
  const enterLiveMode = useMonitorStore((s) => s.enterLiveMode)
  const exitLiveMode = useMonitorStore((s) => s.exitLiveMode)
  const selectedCallId = useMonitorStore((s) => s.selectedCallId)
  const selectCall = useMonitorStore((s) => s.selectCall)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)

  useEffect(() => {
    enterLiveMode()
    return () => exitLiveMode()
  }, [enterLiveMode, exitLiveMode])

  return (
    <div className="flex h-full flex-col gap-3">
      <MonitorTopBar />
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="w-[360px] shrink-0 overflow-hidden rounded-xl border border-line/50 bg-panel/40">
          <LiveEventStream />
        </div>
        <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-line/50 bg-panel/40">
          <RequestDetailPane
            selectedCallId={selectedCallId}
            onSelect={(callId) => {
              if (activeProjectId) void selectCall(activeProjectId, callId)
            }}
          />
        </div>
      </div>
    </div>
  )
}
