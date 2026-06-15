import { useMonitorStore } from '../../../stores/monitor-store'
import { useSessionStore } from '../../../stores/session-store'
import { useProjectStore } from '../../../stores/project-store'
import { DIMENSIONS, ALL_DIMENSIONS } from '../../../monitor/dimensions'
import type { DimKey } from '../../../monitor/types'

/**
 * Top bar: live ↔ replay mode toggle, replay-session selector, and the
 * dimension toggles (driven dynamically by the registry so new dimensions
 * appear here automatically — the "三步" extensibility contract).
 */
export function MonitorTopBar(): React.ReactElement {
  const mode = useMonitorStore((s) => s.mode)
  const dimensionEnabled = useMonitorStore((s) => s.dimensionEnabled)
  const toggleDimension = useMonitorStore((s) => s.toggleDimension)
  const enterLiveMode = useMonitorStore((s) => s.enterLiveMode)
  const enterReplayMode = useMonitorStore((s) => s.enterReplayMode)
  const replaySessionId = useMonitorStore((s) => s.replaySessionId)

  const sessions = useSessionStore((s) => s.sessions)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)

  // Group dimensions for the toggle row.
  const groups: Array<{ label: string; dims: DimKey[] }> = [
    { label: '上下文', dims: ALL_DIMENSIONS.filter((d) => DIMENSIONS[d].group === 'context') },
    { label: '工具', dims: ALL_DIMENSIONS.filter((d) => DIMENSIONS[d].group === 'tool') },
    { label: 'Token', dims: ALL_DIMENSIONS.filter((d) => DIMENSIONS[d].group === 'token') },
    { label: '生命周期', dims: ALL_DIMENSIONS.filter((d) => DIMENSIONS[d].group === 'lifecycle') }
  ]

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line/50 bg-panel/40 px-3 py-2">
      {/* Mode switch */}
      <div className="flex gap-1 rounded-lg bg-bg/40 p-0.5">
        <button
          onClick={enterLiveMode}
          className={`rounded-md px-3 py-1 text-xs transition ${mode === 'live' ? 'bg-card/80 text-fg' : 'text-faint hover:text-muted'}`}
        >
          ● 实时
        </button>
        <button
          onClick={() => {
            if (activeProjectId && replaySessionId) void enterReplayMode(activeProjectId, replaySessionId)
            else if (activeProjectId && sessions[0]) void enterReplayMode(activeProjectId, sessions[0].id)
          }}
          className={`rounded-md px-3 py-1 text-xs transition ${mode === 'replay' ? 'bg-card/80 text-fg' : 'text-faint hover:text-muted'}`}
        >
          ◷ 回看
        </button>
      </div>

      {/* Replay session selector */}
      {mode === 'replay' && (
        <select
          value={replaySessionId ?? ''}
          onChange={(e) => {
            if (activeProjectId && e.target.value) void enterReplayMode(activeProjectId, e.target.value)
          }}
          className="max-w-[220px] truncate rounded-lg border border-line/50 bg-bg/40 px-2 py-1 text-xs text-fg"
        >
          {sessions.length === 0 && <option value="">(无会话)</option>}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || s.id.slice(0, 8)}
            </option>
          ))}
        </select>
      )}

      {/* Dimension toggles — dynamic from the registry */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {groups.map((g) => (
          <div key={g.label} className="flex items-center gap-1">
            <span className="font-mono text-[9px] tracking-wider text-faint">{g.label}</span>
            {g.dims.map((d) => (
              <button
                key={d}
                onClick={() => toggleDimension(d)}
                className={`rounded-md px-2 py-0.5 text-[11px] transition ${
                  dimensionEnabled[d] ? 'bg-accent/20 text-accent' : 'bg-bg/30 text-faint line-through'
                }`}
                title={DIMENSIONS[d].label}
              >
                {DIMENSIONS[d].label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
