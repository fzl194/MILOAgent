import { create } from 'zustand'
import type { UsageEvent } from '../agent-core/types'

interface StatsState {
  events: UsageEvent[]
  isLoaded: boolean
  loadStats: () => Promise<void>
  recordEvent: (e: UsageEvent) => Promise<void>
}

export const useStatsStore = create<StatsState>((set) => ({
  events: [],
  isLoaded: false,

  loadStats: async () => {
    const res = await window.electronAPI.readStats()
    set({ events: (res.data as UsageEvent[]) || [], isLoaded: true })
  },

  recordEvent: async (e) => {
    await window.electronAPI.appendStat(e)
    set((st) => ({ events: [...st.events, e] }))
  },
}))
