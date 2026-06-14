import { create } from 'zustand'
import type { UsageEvent } from '../agent-core/types'
import { useProjectStore } from './project-store'

// P5: stats are physically split per-project (projects/<pid>/stats/events.jsonl).
// loadStats() reads ALL projects' stats and concatenates for the global view;
// recordEvent writes to the active project's stats file.
interface StatsState {
  events: UsageEvent[]
  isLoaded: boolean
  loadStats: () => Promise<void>
  recordEvent: (pid: string, e: UsageEvent) => Promise<void>
}

export const useStatsStore = create<StatsState>((set) => ({
  events: [],
  isLoaded: false,

  loadStats: async () => {
    const pids = useProjectStore.getState().projects.map((p) => p.id)
    const results = await Promise.all(pids.map((pid) => window.electronAPI.readStats(pid)))
    const events = results.flatMap((r) => (r.data as UsageEvent[]) || [])
    set({ events, isLoaded: true })
  },

  recordEvent: async (pid, e) => {
    await window.electronAPI.appendStat(pid, e)
    set((st) => ({ events: [...st.events, e] }))
  }
}))
