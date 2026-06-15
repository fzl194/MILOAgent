import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MonitorBus, __setMonitorBusForTest, getMonitorBus } from '../bus'
import type { DimKey, MonitorEnvelope } from '../types'

function env(dim: DimKey, callId = 'c1'): MonitorEnvelope {
  return {
    turnId: 't1',
    callId,
    round: 0,
    sessionId: 's1',
    ts: 1,
    dimension: dim
  }
}

describe('MonitorBus', () => {
  let bus: MonitorBus
  beforeEach(() => {
    bus = new MonitorBus()
    __setMonitorBusForTest(null)
  })

  it('does NOT invoke the payload factory when no subscribers are present', () => {
    const factory = vi.fn(() => ({ expensive: 'payload' }))
    bus.publish('request_view', env('request_view'), factory)
    expect(factory).not.toHaveBeenCalled()
  })

  it('does NOT invoke the factory when no subscribers are present even if payloadCost is heavy', () => {
    // Simulate the heavy dimension path explicitly
    const factory = vi.fn(() => ({ view: 'huge' }))
    bus.publish('request_view', env('request_view'), factory)
    expect(factory).toHaveBeenCalledTimes(0)
  })

  it('invokes the factory and delivers to a live subscriber', () => {
    const received: Array<{ env: MonitorEnvelope; payload: unknown }> = []
    bus.subscribe('request_view', (e, p) => received.push({ env: e, payload: p }))

    const factory = vi.fn(() => ({ view: 'x' }))
    bus.publish('request_view', env('request_view'), factory)

    expect(factory).toHaveBeenCalledTimes(1)
    expect(received).toHaveLength(1)
    expect(received[0]!.payload).toEqual({ view: 'x' })
  })

  it('fan-out: multiple live subscribers each receive one copy', () => {
    const a = vi.fn()
    const b = vi.fn()
    bus.subscribe('request_view', a)
    bus.subscribe('request_view', b)

    const factory = vi.fn(() => ({ x: 1 }))
    bus.publish('request_view', env('request_view'), factory)

    expect(factory).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('a throwing live subscriber does not break other subscribers or throw to caller', () => {
    const failing = vi.fn(() => {
      throw new Error('boom')
    })
    const surviving = vi.fn()
    bus.subscribe('request_view', failing)
    bus.subscribe('request_view', surviving)

    expect(() => bus.publish('request_view', env('request_view'), () => ({ x: 1 }))).not.toThrow()
    expect(surviving).toHaveBeenCalledTimes(1)
  })

  it('a throwing payloadFactory is swallowed and does not deliver', () => {
    const handler = vi.fn()
    bus.subscribe('request_view', handler)

    const factory = vi.fn(() => {
      throw new Error('factory boom')
    })
    expect(() => bus.publish('request_view', env('request_view'), factory)).not.toThrow()
    expect(handler).not.toHaveBeenCalled()
  })

  it('envelope.dimension mismatch is rejected silently (no delivery, no throw)', () => {
    const handler = vi.fn()
    bus.subscribe('tool_call', handler)
    // caller passes dimension='tool_call' but envelope.dimension='request_view'
    const badEnv: MonitorEnvelope = { ...env('request_view'), dimension: 'request_view' as DimKey }
    bus.publish('tool_call', badEnv, () => ({ x: 1 }))
    expect(handler).not.toHaveBeenCalled()
  })

  it('unsubscribe stops further deliveries', () => {
    const handler = vi.fn()
    const unsub = bus.subscribe('request_view', handler)
    bus.publish('request_view', env('request_view'), () => ({ x: 1 }))
    expect(handler).toHaveBeenCalledTimes(1)
    unsub()
    bus.publish('request_view', env('request_view'), () => ({ x: 2 }))
    expect(handler).toHaveBeenCalledTimes(1) // not incremented
  })

  it('unsubscribe is idempotent', () => {
    const handler = vi.fn()
    const unsub = bus.subscribe('request_view', handler)
    unsub()
    unsub()
    bus.publish('request_view', env('request_view'), () => ({ x: 1 }))
    expect(handler).not.toHaveBeenCalled()
  })

  it('persistent subscribers run asynchronously and in order', async () => {
    const order: number[] = []
    const slow = vi.fn(async () => {
      await Promise.resolve()
      order.push(1)
    })
    const fast = vi.fn(() => {
      order.push(2)
    })
    bus.subscribePersistent('request_view', slow)
    bus.subscribePersistent('request_view', fast)

    bus.publish('request_view', env('request_view'), () => ({ x: 1 }))
    bus.publish('request_view', env('request_view', 'c2'), () => ({ x: 2 }))

    // Not yet drained
    expect(order).toEqual([])
    await bus.drain('request_view')
    expect(order).toEqual([1, 2, 1, 2])
    expect(slow).toHaveBeenCalledTimes(2)
    expect(fast).toHaveBeenCalledTimes(2)
  })

  it('a throwing persistent subscriber does not break the chain or subsequent publishes', async () => {
    const failing = vi.fn(async () => {
      throw new Error('persist boom')
    })
    const surviving = vi.fn(async () => {})
    bus.subscribePersistent('request_view', failing)
    bus.subscribePersistent('request_view', surviving)

    expect(() => bus.publish('request_view', env('request_view'), () => ({ x: 1 }))).not.toThrow()
    bus.publish('request_view', env('request_view', 'c2'), () => ({ x: 2 }))
    await bus.drain('request_view')
    expect(surviving).toHaveBeenCalledTimes(2)
  })

  it('a persistent subscriber with no live subscriber still triggers the factory', () => {
    const factory = vi.fn(() => ({ snap: true }))
    bus.subscribePersistent('request_view', async () => {})
    bus.publish('request_view', env('request_view'), factory)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('getMonitorBus returns a stable singleton across calls', () => {
    const a = getMonitorBus()
    const b = getMonitorBus()
    expect(a).toBe(b)
  })

  it('reset clears live and persistent subscribers', () => {
    const live = vi.fn()
    const persist = vi.fn(async () => {})
    bus.subscribe('request_view', live)
    bus.subscribePersistent('request_view', persist)
    expect(bus.liveCount('request_view')).toBe(1)
    expect(bus.persistentCount('request_view')).toBe(1)
    bus.reset()
    expect(bus.liveCount('request_view')).toBe(0)
    expect(bus.persistentCount('request_view')).toBe(0)
    bus.publish('request_view', env('request_view'), () => ({ x: 1 }))
    expect(live).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })
})
