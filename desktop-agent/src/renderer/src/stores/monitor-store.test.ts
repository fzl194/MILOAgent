import { describe, it, expect, beforeEach, vi } from 'vitest'

// Stub window.electronAPI before importing the store (the store itself doesn't
// touch it on construction, but `selectCall` calls snapshotRead in replay mode).
const snapshotRead = vi.fn()
const snapshotList = vi.fn()
;(globalThis as any).window = {
  electronAPI: {
    snapshotRead,
    snapshotList
  }
}

// Reset store between tests — zustand stores are singletons.
import { useMonitorStore } from './monitor-store'
import { __setMonitorBusForTest } from '../monitor/bus'
import type { RequestSnapshot } from '../monitor/types'

function makeSnapshot(callId: string): RequestSnapshot {
  return {
    callId,
    turnId: 't1',
    round: 0,
    sessionId: 's1',
    ts: 1,
    modelConfigId: 'm1',
    view: [],
    openaiMessages: [],
    metrics: { tokenEstimate: 100, window: 8000, fillRatio: 0.0125, messageCount: 1 },
    decisions: [],
    config: { contextWindow: 8000 }
  }
}

describe('monitor-store — P2 context-org usagePatch', () => {
  beforeEach(() => {
    useMonitorStore.setState({
      mode: 'live',
      liveEvents: [],
      snapshotIndex: [],
      replaySessionId: null,
      selectedCallId: null,
      selectedSnapshot: null,
      usagePatches: {},
      subscriptionState: 'idle',
      lastError: null
    })
    __setMonitorBusForTest(null)
  })

  it('starts with usagePatches empty', () => {
    expect(useMonitorStore.getState().usagePatches).toEqual({})
  })

  it('recordUsagePatch stores the patch under callId', () => {
    useMonitorStore.getState().recordUsagePatch('c1', {
      inputTokens: 200,
      outputTokens: 80,
      cachedTokens: 150,
      usageSource: 'api'
    })
    expect(useMonitorStore.getState().usagePatches['c1']).toEqual({
      inputTokens: 200,
      outputTokens: 80,
      cachedTokens: 150,
      usageSource: 'api'
    })
  })

  it('recordUsagePatch is a no-op for falsy callId/patch', () => {
    useMonitorStore.getState().recordUsagePatch('', { inputTokens: 1, outputTokens: 1, usageSource: 'api' })
    expect(useMonitorStore.getState().usagePatches).toEqual({})
    useMonitorStore.getState().recordUsagePatch('c1', undefined as any)
    expect(useMonitorStore.getState().usagePatches).toEqual({})
  })

  it('a second recordUsagePatch for the same callId overwrites (idempotent on re-done)', () => {
    const api = useMonitorStore.getState()
    api.recordUsagePatch('c1', { inputTokens: 100, outputTokens: 50, cachedTokens: 30, usageSource: 'api' })
    api.recordUsagePatch('c1', { inputTokens: 200, outputTokens: 80, cachedTokens: 150, usageSource: 'api' })
    expect(useMonitorStore.getState().usagePatches['c1']?.inputTokens).toBe(200)
    expect(useMonitorStore.getState().usagePatches['c1']?.cachedTokens).toBe(150)
  })

  it('recordUsagePatch re-joins onto selectedSnapshot when the patched call is currently shown', () => {
    useMonitorStore.setState({ selectedCallId: 'c1', selectedSnapshot: makeSnapshot('c1') })
    useMonitorStore.getState().recordUsagePatch('c1', {
      inputTokens: 200,
      outputTokens: 80,
      cachedTokens: 150,
      usageSource: 'api'
    })
    const sel = useMonitorStore.getState().selectedSnapshot
    expect(sel).not.toBeNull()
    expect(sel!.callId).toBe('c1')
    expect(sel!.usagePatch).toEqual({
      inputTokens: 200,
      outputTokens: 80,
      cachedTokens: 150,
      usageSource: 'api'
    })
  })

  it('recordUsagePatch does NOT touch selectedSnapshot when the patched call differs', () => {
    useMonitorStore.setState({ selectedCallId: 'c1', selectedSnapshot: makeSnapshot('c1') })
    useMonitorStore.getState().recordUsagePatch('c2', {
      inputTokens: 200,
      outputTokens: 80,
      cachedTokens: 150,
      usageSource: 'api'
    })
    expect(useMonitorStore.getState().selectedSnapshot?.usagePatch).toBeUndefined()
    expect(useMonitorStore.getState().usagePatches['c2']).toBeDefined()
  })

  it('selectCall (live) joins the stored usagePatch onto the snapshot', async () => {
    // Pre-seed: a request_view for callId c1 in the live buffer, and a usage patch
    useMonitorStore.setState({
      mode: 'live',
      liveEvents: [
        {
          dimension: 'request_view',
          envelope: {
            turnId: 't1',
            callId: 'c1',
            round: 0,
            sessionId: 's1',
            ts: 1,
            dimension: 'request_view'
          },
          payload: makeSnapshot('c1')
        }
      ],
      usagePatches: {
        c1: { inputTokens: 200, outputTokens: 80, cachedTokens: 150, usageSource: 'api' }
      }
    })
    await useMonitorStore.getState().selectCall('p1', 'c1')
    const sel = useMonitorStore.getState().selectedSnapshot
    expect(sel).not.toBeNull()
    expect(sel!.usagePatch?.cachedTokens).toBe(150)
  })

  it('selectCall (live) returns the snapshot unchanged when no patch is stored', async () => {
    useMonitorStore.setState({
      mode: 'live',
      liveEvents: [
        {
          dimension: 'request_view',
          envelope: {
            turnId: 't1',
            callId: 'c1',
            round: 0,
            sessionId: 's1',
            ts: 1,
            dimension: 'request_view'
          },
          payload: makeSnapshot('c1')
        }
      ]
    })
    await useMonitorStore.getState().selectCall('p1', 'c1')
    expect(useMonitorStore.getState().selectedSnapshot?.usagePatch).toBeUndefined()
  })

  it('enterReplayMode clears usagePatches (replay is a different session; patches do not apply)', async () => {
    useMonitorStore.setState({
      usagePatches: { c1: { inputTokens: 1, outputTokens: 1, usageSource: 'api' } }
    })
    snapshotList.mockResolvedValue({ success: true, data: [] })
    await useMonitorStore.getState().enterReplayMode('p1', 's2')
    expect(useMonitorStore.getState().usagePatches).toEqual({})
  })
})
