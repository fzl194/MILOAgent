import { create } from 'zustand'
import type { DimKey, MonitorEnvelope, RequestSnapshot, SnapshotMeta } from '../monitor/types'
import { DEFAULT_ENABLED, ALL_DIMENSIONS } from '../monitor/dimensions'
import { getMonitorBus } from '../monitor/bus'

/**
 * Monitor store — drives the runtime-monitor panel (admin → 监控 tab).
 *
 * Two modes:
 *  - live:   subscribes to the bus, accumulates events into `liveEvents`
 *            (ring-capped to bound memory for long sessions).
 *  - replay: loads a session's snapshot index from disk and fetches the full
 *            snapshot on demand when a row is selected.
 *
 * The store is the ONLY thing that holds a live bus subscription for the panel;
 * turning a dimension off filters what the UI shows (the bus still publishes,
 * the handler just skips). This keeps "disable a dimension" cheap and reversible.
 */

/** A single event in the live stream (envelope + raw payload, typed per-dim at render). */
export interface LiveMonitorEvent {
  dimension: DimKey
  envelope: MonitorEnvelope
  payload: unknown
}

/** Ring cap — bounds memory for high-frequency long sessions. */
const LIVE_EVENTS_CAP = 500

export type MonitorMode = 'live' | 'replay'
export type SubscriptionState = 'idle' | 'live' | 'replay-loading' | 'error'

interface MonitorState {
  mode: MonitorMode
  dimensionEnabled: Record<DimKey, boolean>
  liveEvents: LiveMonitorEvent[]
  /** Snapshot index for the replay-mode session (loaded from disk). */
  snapshotIndex: SnapshotMeta[]
  replaySessionId: string | null
  /** Currently-selected callId (drives the right detail pane). */
  selectedCallId: string | null
  /** The full snapshot for the selected callId (live: from liveEvents; replay: from disk). */
  selectedSnapshot: RequestSnapshot | null
  subscriptionState: SubscriptionState
  lastError: string | null

  // actions
  toggleDimension: (dim: DimKey) => void
  enterLiveMode: () => void
  exitLiveMode: () => void
  enterReplayMode: (projectId: string, sessionId: string) => Promise<void>
  selectCall: (projectId: string, callId: string) => Promise<void>
  clearSelection: () => void
}

/** Module-scope: the live bus subscriptions live outside the store so re-renders
 *  don't tear them down. Cleared by exitLiveMode. */
let liveUnsubs: Array<() => void> = []

function pushCapped(events: LiveMonitorEvent[], next: LiveMonitorEvent): LiveMonitorEvent[] {
  const combined = [...events, next]
  if (combined.length > LIVE_EVENTS_CAP) {
    return combined.slice(combined.length - LIVE_EVENTS_CAP)
  }
  return combined
}

export const useMonitorStore = create<MonitorState>((set, get) => ({
  mode: 'live',
  dimensionEnabled: { ...DEFAULT_ENABLED },
  liveEvents: [],
  snapshotIndex: [],
  replaySessionId: null,
  selectedCallId: null,
  selectedSnapshot: null,
  subscriptionState: 'idle',
  lastError: null,

  toggleDimension: (dim) => {
    set((s) => ({ dimensionEnabled: { ...s.dimensionEnabled, [dim]: !s.dimensionEnabled[dim] } }))
  },

  enterLiveMode: () => {
    // Idempotent re-entry: if already live and subscribed, do nothing — clicking
    // the ● 实时 button again must NOT wipe the accumulated event stream.
    if (get().mode === 'live' && liveUnsubs.length > 0) return

    // Tear down any prior subscription first.
    for (const unsub of liveUnsubs) unsub()
    liveUnsubs = []

    const bus = getMonitorBus()
    for (const dim of ALL_DIMENSIONS) {
      const unsub = bus.subscribe(dim, (envelope, payload) => {
        set((s) => ({
          liveEvents: pushCapped(s.liveEvents, { dimension: dim, envelope, payload }),
          subscriptionState: 'live'
        }))
      })
      liveUnsubs.push(unsub)
    }
    set({ mode: 'live', subscriptionState: 'live', liveEvents: [], selectedCallId: null, selectedSnapshot: null, snapshotIndex: [], replaySessionId: null, lastError: null })
  },

  exitLiveMode: () => {
    for (const unsub of liveUnsubs) unsub()
    liveUnsubs = []
    set({ subscriptionState: 'idle' })
  },

  enterReplayMode: async (projectId, sessionId) => {
    // Stop the live stream while replaying (avoid mixing live + replay rows).
    for (const unsub of liveUnsubs) unsub()
    liveUnsubs = []
    set({ mode: 'replay', subscriptionState: 'replay-loading', replaySessionId: sessionId, selectedCallId: null, selectedSnapshot: null, lastError: null })
    try {
      const res = await window.electronAPI.snapshotList(projectId, sessionId)
      set({ snapshotIndex: (res.data as SnapshotMeta[]) || [], subscriptionState: 'idle' })
    } catch (err: any) {
      set({ snapshotIndex: [], subscriptionState: 'error', lastError: err?.message ?? String(err) })
    }
  },

  selectCall: async (projectId, callId) => {
    set({ selectedCallId: callId, selectedSnapshot: null })
    const mode = get().mode
    if (mode === 'live') {
      // Find the most recent request_view event for this callId in the live buffer.
      const evt = [...get().liveEvents].reverse().find((e) => e.dimension === 'request_view' && e.envelope.callId === callId)
      if (evt) {
        set({ selectedSnapshot: evt.payload as RequestSnapshot })
      } else {
        set({ selectedSnapshot: null })
      }
      return
    }
    // replay: load the full snapshot from disk.
    const sid = get().replaySessionId
    if (!sid) return
    try {
      const res = await window.electronAPI.snapshotRead(projectId, sid, callId)
      // Race guard: the user may have selected a DIFFERENT row while this IPC
      // was in flight. Discard the stale result so it can't overwrite the newer
      // selection (which would make the detail pane show the wrong snapshot
      // while the left stream highlights another).
      if (get().selectedCallId !== callId) return
      if (res.success) {
        set({ selectedSnapshot: res.data as RequestSnapshot, lastError: null })
      } else {
        // Missing snapshot (dangling index / two-step write) → degrade to "view unavailable".
        set({ selectedSnapshot: null, lastError: res.error ?? 'snapshot unavailable' })
      }
    } catch (err: any) {
      if (get().selectedCallId !== callId) return
      set({ selectedSnapshot: null, lastError: err?.message ?? String(err) })
    }
  },

  clearSelection: () => set({ selectedCallId: null, selectedSnapshot: null })
}))
