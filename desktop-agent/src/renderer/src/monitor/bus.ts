/**
 * MonitorBus — process-level singleton pub/sub for runtime monitoring events.
 *
 * Design contract (see docs/2026-06-15-desktop-agent-运行态监控面板设计.md §②):
 *  1. **Lazy publish**: callers pass a `payloadFactory` thunk. The factory is
 *     invoked ONLY when the dimension has either a live subscriber OR a
 *     persistent subscriber. The expensive `request_view` payload (full
 *     message view + decisions) is constructed zero times when no one is
 *     listening.
 *  2. **Fan-out**: each publish hits every subscriber of that dimension in
 *     subscription order. The publish site is invoked once per event — no
 *     re-execution at consumer boundaries.
 *  3. **Never throws**: every dispatch site is wrapped in try/catch. Subscriber
 *     errors are swallowed and logged via console.warn, so a misbehaving
 *     subscriber cannot corrupt the agent loop or break persistence.
 *  4. **Process-singleton**: lives for the lifetime of the renderer process
 *     (not per turn). AgentLoop instances import `getMonitorBus()` and the
 *     same bus survives across turn rebuilds.
 */
import type { DimKey, MonitorEnvelope } from './types'
import { DIMENSIONS } from './dimensions'

/** A live subscriber: receives the payload synchronously inside publish(). */
export type LiveHandler<T = unknown> = (envelope: MonitorEnvelope, payload: T) => void

/**
 * A persistent subscriber: receives the payload asynchronously via a serialized
 * queue. Used by the persistence layer to write snapshots / trace events
 * without blocking the agent loop. Errors here set the panel's
 * `subscriptionState` to 'error' — they do NOT throw.
 */
export type PersistentHandler<T = unknown> = (envelope: MonitorEnvelope, payload: T) => Promise<void> | void

/**
 * Lazy payload factory. The bus calls this only when at least one subscriber
 * is present (live OR persistent). When no one is listening, the factory is
 * not invoked — saving the cost of constructing e.g. the full request view.
 */
export type PayloadFactory<T = unknown> = () => T

export class MonitorBus {
  private readonly liveSubs = new Map<DimKey, Set<LiveHandler<any>>>()
  private readonly persistentSubs = new Map<DimKey, Set<PersistentHandler<any>>>()
  /** Per-dimension async queue. Persistent handlers run in FIFO order. */
  private readonly persistentQueues = new Map<DimKey, Promise<void>>()

  /**
   * Publish an event on `dimension`. `payloadFactory` is invoked only when at
   * least one subscriber is registered AND the dimension has subscribers.
   * If `payloadFactory` is omitted, the live handlers receive `undefined`
   * (useful for fire-and-forget markers like turn_lifecycle/aborted).
   */
  publish<T>(
    dimension: DimKey,
    envelope: MonitorEnvelope,
    payloadFactory?: PayloadFactory<T>
  ): void {
    const live = this.liveSubs.get(dimension)
    const persistent = this.persistentSubs.get(dimension)
    const hasLive = !!live && live.size > 0
    const hasPersistent = !!persistent && persistent.size > 0
    if (!hasLive && !hasPersistent) return // lazy: factory never called

    let payload: T | undefined
    if (payloadFactory !== undefined) {
      try {
        payload = payloadFactory()
      } catch (err) {
        console.warn(`[monitor/bus] payloadFactory threw for ${dimension}`, err)
        return
      }
    }

    // Validate envelope.dimension matches — easy to forget at call sites.
    if (envelope.dimension !== dimension) {
      console.warn(
        `[monitor/bus] envelope.dimension mismatch: arg=${dimension} env=${envelope.dimension}`
      )
      return
    }

    if (hasLive && live) {
      for (const h of live) {
        try {
          h(envelope, payload)
        } catch (err) {
          console.warn(`[monitor/bus] live subscriber threw on ${dimension}`, err)
        }
      }
    }

    if (hasPersistent && persistent) {
      // Clone the Set — handlers may unsubscribe during dispatch.
      const snapshot = Array.from(persistent)
      const prev = this.persistentQueues.get(dimension) ?? Promise.resolve()
      const next = prev
        .catch(() => {
          /* swallow prior chain error so the queue keeps moving */
        })
        .then(async () => {
          for (const h of snapshot) {
            try {
              await h(envelope, payload)
            } catch (err) {
              console.warn(`[monitor/bus] persistent subscriber threw on ${dimension}`, err)
            }
          }
        })
      this.persistentQueues.set(dimension, next)
    }
  }

  /**
   * Subscribe synchronously. Returns an unsubscribe function (idempotent).
   * Subscribers are NOT notified of past events — the bus is live-only.
   */
  subscribe<T>(dimension: DimKey, handler: LiveHandler<T>): () => void {
    let set = this.liveSubs.get(dimension)
    if (!set) {
      set = new Set()
      this.liveSubs.set(dimension, set)
    }
    set.add(handler as LiveHandler<any>)
    return () => {
      set?.delete(handler as LiveHandler<any>)
    }
  }

  /**
   * Subscribe via the serialized async queue. Used by the persistence layer.
   * Returns an unsubscribe function (idempotent).
   */
  subscribePersistent<T>(dimension: DimKey, handler: PersistentHandler<T>): () => void {
    let set = this.persistentSubs.get(dimension)
    if (!set) {
      set = new Set()
      this.persistentSubs.set(dimension, set)
    }
    set.add(handler as PersistentHandler<any>)
    return () => {
      set?.delete(handler as PersistentHandler<any>)
    }
  }

  /**
   * Wait for all currently-queued persistent handlers to drain. Useful in tests
   * to assert async writes complete before tearing down. Production code rarely
   * needs this — the persistence layer is fire-and-forget by design.
   */
  async drain(dimension?: DimKey): Promise<void> {
    if (dimension) {
      await this.persistentQueues.get(dimension)
      return
    }
    await Promise.all(Array.from(this.persistentQueues.values()))
  }

  /**
   * Test / debug helper: count of live subscribers for a dimension. NOT used
   * by production code — callers should not gate behavior on this.
   */
  liveCount(dimension: DimKey): number {
    return this.liveSubs.get(dimension)?.size ?? 0
  }

  persistentCount(dimension: DimKey): number {
    return this.persistentSubs.get(dimension)?.size ?? 0
  }

  /**
   * Remove all subscribers. Mainly for tests; production code never calls this.
   * Persistent queues are NOT cleared — pending writes will still complete.
   */
  reset(): void {
    this.liveSubs.clear()
    this.persistentSubs.clear()
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton — survives AgentLoop rebuilds within the renderer.
// ---------------------------------------------------------------------------

let _bus: MonitorBus | null = null

/**
 * Returns the process-singleton MonitorBus. Lazy-initialised on first call.
 * AgentLoop / chat-store / MonitorPanel all import this; the same bus
 * connects publishers and subscribers across turn boundaries.
 */
export function getMonitorBus(): MonitorBus {
  if (!_bus) _bus = new MonitorBus()
  return _bus
}

/**
 * Test-only: replace the singleton. Used by monitor/bus.test.ts to verify
 * lazy initialization. Production code never calls this.
 */
export function __setMonitorBusForTest(bus: MonitorBus | null): void {
  _bus = bus
}

// Re-export dimension metadata for convenience — keeps the import surface tight.
export { DIMENSIONS }
