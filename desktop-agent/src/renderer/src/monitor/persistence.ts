/**
 * Persistent subscriber for the monitor bus.
 *
 * What it persists — ONLY new data not already captured elsewhere:
 *  - request_view → a request snapshot file
 *    (~/.desktop-agent/projects/<pid>/snapshots/<sid>/<callId>.json). The
 *    context_metrics dimension rides this snapshot (metrics + decisions), so
 *    it's not subscribed separately.
 *
 * What it does NOT persist (by design — see 设计文档 §② 持久化 "复用现有 trace"):
 *  - tool_call:    chat-store already writes a `tool_call` trace row via
 *                  safeAppendTrace. Re-subscribing here would DOUBLE-WRITE the
 *                  row and double-count it in StatsPanel's tool aggregation.
 *  - token_usage:  per-round usage already lives in the `llm_call` trace row's
 *                  `usage` field; a separate row is redundant.
 *  - turn_lifecycle: lightweight markers; persisted replay is nice-to-have but
 *                  not required, and writing them here would need its own
 *                  de-dup story. Deferred to the improvement backlog.
 *
 * These dimensions are still PUBLISHED to the bus (chat-store) so the LIVE
 * panel can show them; they just don't need a second writer here.
 *
 * Isolation contract (the bus is a process-singleton, shared across concurrent
 * turns): the handler guards `env.sessionId !== ctx.sessionId` and no-ops on
 * foreign events.
 *
 * Resilience contract:
 *  - Never throws to the bus (the bus wraps us anyway, but we keep it clean).
 *  - Write failures set `lastError` so the panel can surface a visible banner.
 *  - Teardown awaits drain() so in-flight IPC writes finish before the
 *    subscription ends — prevents orphan snapshots when a session is deleted
 *    mid-turn.
 *  - The two-step snapshot write (body → index) is intentionally NOT atomic;
 *    the replay side tolerates a missing snapshot (degrades to metrics-only).
 */
import { getMonitorBus } from './bus'
import type {
  DimKey,
  MonitorEnvelope,
  RequestSnapshot,
  SnapshotMeta
} from './types'

export interface PersistenceContext {
  projectId: string
  sessionId: string
}

/** Minimal bus surface this module depends on (subset of MonitorBus). */
export interface PersistenceBus {
  subscribePersistent(dim: DimKey, h: (env: MonitorEnvelope, payload: any) => Promise<void> | void): () => void
  drain(): Promise<void>
}

export interface PersistentSubscriber {
  /** Attach to the bus for the given project/session. Returns an async teardown
   *  that unsubscribes AND drains in-flight writes. */
  start(ctx: PersistenceContext): () => Promise<void>
  /** Last write failure surfaced for the panel's banner; null when healthy. */
  lastError(): string | null
}

/**
 * Build a PersistentSubscriber bound to an injected bus (tests can pass a fake).
 */
export function createPersistentSubscriber(deps: { bus: PersistenceBus }): PersistentSubscriber {
  let _lastError: string | null = null

  return {
    start(ctx: PersistenceContext): () => Promise<void> {
      const subs: Array<() => void> = []
      const subscribedDims: DimKey[] = []

      /** Subscribe with a session guard — foreign-turn events are ignored so a
       *  process-singleton bus doesn't cross-contaminate trace files. */
      function handle(
        dim: DimKey,
        fn: (env: MonitorEnvelope, payload: any) => Promise<void> | void
      ): void {
        subscribedDims.push(dim)
        subs.push(
          deps.bus.subscribePersistent(dim, (env, payload) => {
            // The bus fans out to every active subscriber; only act on events
            // belonging to THIS turn's session.
            if (env.sessionId !== ctx.sessionId) return
            return fn(env, payload)
          })
        )
      }

      handle('request_view', async (_env, payload: RequestSnapshot) => {
        if (!payload) return
        try {
          const res = await window.electronAPI.snapshotWrite(
            ctx.projectId,
            ctx.sessionId,
            payload.callId,
            payload as unknown as object
          )
          if (!res.success) throw new Error(res.error ?? 'snapshot:write failed')
          _lastError = null
        } catch (err: any) {
          _lastError = `[monitor] snapshot write failed: ${err?.message ?? String(err)}`
          console.warn(_lastError)
        }
      })

      // tool_call / token_usage / turn_lifecycle are NOT persisted here — see the
      // file header. They remain published to the bus for the LIVE panel; their
      // durable record lives in the existing trace (tool_call via chat-store,
      // usage via the llm_call row).

      return async () => {
        // 1) stop receiving new events, 2) let in-flight writes finish. Without
        // the drain, a snapshot:write IPC still in flight when the session is
        // deleted would recreate the snapshots/<sid>/ dir as an orphan.
        for (const unsub of subs) unsub()
        subs.length = 0
        await deps.bus.drain()
      }
    },
    lastError(): string | null {
      return _lastError
    }
  }
}

/**
 * Default wiring: binds the persistent subscriber to the process-singleton bus
 * and the real IPC-backed append functions. Used by chat-store at turn start.
 * Returns an async teardown that unsubscribes + drains.
 */
export function startDefaultPersistence(ctx: PersistenceContext): () => Promise<void> {
  return createPersistentSubscriber({ bus: getMonitorBus() }).start(ctx)
}

// Re-export for the panel to read SnapshotMeta without a separate import path.
export type { SnapshotMeta }
