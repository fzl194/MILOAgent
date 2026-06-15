import { create } from 'zustand'
import type { UsageEvent } from '../agent-core/types'
import { useProjectStore } from './project-store'

// P5: stats are physically split per-project (projects/<pid>/stats/events.jsonl).
// loadStats() reads ALL projects' stats — `events` is the concatenated global
// view; `eventsByProject` keeps the bucket-of-origin so the stats panel can
// filter by project without re-reading from disk. recordEvent writes to the
// active project's stats file and updates both views.
interface StatsState {
  events: UsageEvent[]
  /** Per-project events, keyed by projectId. */
  eventsByProject: Record<string, UsageEvent[]>
  isLoaded: boolean
  loadStats: () => Promise<void>
  recordEvent: (pid: string, e: UsageEvent) => Promise<void>
}

export const useStatsStore = create<StatsState>((set) => ({
  events: [],
  eventsByProject: {},
  isLoaded: false,

  loadStats: async () => {
    const projects = useProjectStore.getState().projects
    const results = await Promise.all(
      projects.map((p) =>
        window.electronAPI.readStats(p.id).then((r) => [p.id, (r.data as UsageEvent[]) || []] as const)
      )
    )
    const eventsByProject: Record<string, UsageEvent[]> = {}
    const events: UsageEvent[] = []
    for (const [pid, evs] of results) {
      eventsByProject[pid] = evs
      events.push(...evs)
    }
    set({ events, eventsByProject, isLoaded: true })
  },

  recordEvent: async (pid, e) => {
    // Stats are observational — a write failure must never surface as a chat
    // error or leave disk/memory inconsistent. Write first; only update the
    // in-memory view if the write succeeded. Swallow + log on failure (the
    // event is absent from the panel, but a successful turn stays successful).
    try {
      await window.electronAPI.appendStat(pid, e)
    } catch (err) {
      console.error('[stats] appendStat failed; skipping in-memory update', err)
      return
    }
    set((st) => ({
      events: [...st.events, e],
      eventsByProject: { ...st.eventsByProject, [pid]: [...(st.eventsByProject[pid] ?? []), e] }
    }))
  }
}))
