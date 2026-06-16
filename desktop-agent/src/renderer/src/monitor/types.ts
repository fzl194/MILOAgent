/**
 * Shared types for the runtime monitoring bus.
 *
 * Design contract (see docs/2026-06-15-desktop-agent-运行态监控面板设计.md):
 *  - Every event carries a stable envelope (turnId / callId / round / sessionId / ts / dimension)
 *    so concurrent turns and mid-stream model switches stay isolated.
 *  - `details` is intentionally loose (Record<string, unknown>) — we want each dimension
 *    to evolve freely without bumping the bus protocol.
 *  - CompactionDecision / RequestSnapshot are part of the snapshot payload (see
 *    monitor/persistence.ts), not the envelope. The envelope stays tiny and uniform.
 */
import type { Message } from '../agent-core/types'
import type { ContextMetrics } from '../agent-core/agent/context-strategy'

// ---------------------------------------------------------------------------
// Dimension keys
// ---------------------------------------------------------------------------

/**
 * Initial five dimensions. Adding a new one = three steps only:
 *  1) add the key here
 *  2) publish at the right code site (e.g. loop.ts onRequestReady)
 *  3) render a card in components/admin/MonitorPanel
 *
 * No bus / interface changes required.
 */
export type DimKey =
  | 'request_view'      // full request view + decisions + metrics (one per llm_call)
  | 'context_metrics'   // context-window fill + compaction-decisions tail (same payload as request_view's metrics slice)
  | 'tool_call'         // tool execution (params/result/risk/approval/duration)
  | 'token_usage'       // per-round usage: input / output / source / cached
  | 'turn_lifecycle'    // turn start / round_end / aborted

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface MonitorEnvelope {
  turnId: string
  callId: string
  round: number
  sessionId: string
  ts: number
  dimension: DimKey
  /** Loose per-dimension context. Carries things like `reason` for aborted turns. */
  details?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Compaction decision (visible to the monitor panel)
// ---------------------------------------------------------------------------

/**
 * A single compaction step's record. Compactors populate this when they run
 * (see Compactor.runWithDecision in context-strategy.ts).
 */
export interface CompactionDecision {
  /** Compactor.name (e.g. 'tool-result-trim', 'token-budget'). */
  compactor: string
  /** Whether the compactor actually applied on this view. */
  ran: boolean
  /** Message IDs that were dropped or had their content elided. */
  droppedMessageIds: string[]
  /** Total characters of content that was elided (folded to placeholder). 0 when nothing was elided. */
  elidedContent: number
  /** Human-readable reason — e.g. "fillRatio=0.82 > 0.50", "token budget exceeded". */
  reason: string
  /** Token estimate BEFORE this step ran. */
  before: number
  /** Token estimate AFTER this step ran. */
  after: number
}

// ---------------------------------------------------------------------------
// Request snapshot (the full "what was sent to the model" record)
// ---------------------------------------------------------------------------

/**
 * Captured at AgentLoop.onRequestReady — exactly what was about to be sent to the
 * provider plus the decisions that shaped it. Persisted by the persistent subscriber
 * to ~/.desktop-agent/projects/<pid>/snapshots/<sid>/<callId>.json.
 */
export interface RequestSnapshot {
  callId: string
  turnId: string
  round: number
  sessionId: string
  ts: number
  /** Model used for this call. Mid-stream model switches land on different callIds. */
  modelConfigId: string
  /** Internal Message[] view (post-compaction, what the strategy emitted). */
  view: Message[]
  /** Wire-format OpenAIChatMessage[] — exactly what was POSTed. */
  openaiMessages: unknown[]
  /** Context metrics for the request (token estimate, window, fillRatio, messageCount). */
  metrics: ContextMetrics
  /** Per-compactor decisions that produced `view` from the full history. */
  decisions: CompactionDecision[]
  /** How many messages self-heal stripped when producing the wire payload.
   *  Non-zero means `openaiMessages` (what was actually POSTed) differs from
   *  `view` (what the strategy produced) — the panel warns when this is set. */
  selfHeal?: { strippedCalls: number; strippedResults: number }
  /** Snapshot of the model config relevant to this call (for replay context). */
  config: {
    contextWindow: number
    temperature?: number
    maxTokens?: number
  }
  /** P2 context-org: post-call usage patch. Captured at `onRequestReady` the
   *  snapshot cannot carry the API-returned `cached_tokens` (the API hasn't
   *  responded yet); the chat-store's `done` handler records the actual usage
   *  via `monitorStore.recordUsagePatch(callId, usage)`, and the monitor
   *  store joins it back onto the matching snapshot by callId. Absent in
   *  replay mode (no live usage to patch). */
  usagePatch?: {
    inputTokens: number
    outputTokens: number
    totalTokens?: number
    cachedTokens?: number
    /** Mirrors `TokenUsageEvent.usageSource` — honest, never silently upgraded. */
    usageSource: 'api' | 'partial' | 'estimated'
  }
}

/**
 * Lightweight metadata returned by snapshot:list — the panel only needs these
 * to populate the left event stream in replay mode. The full snapshot is loaded
 * on demand via snapshot:read.
 */
export interface SnapshotMeta {
  callId: string
  ts: number
  modelConfigId: string
  round: number
  turnId: string
}

// ---------------------------------------------------------------------------
// Trace event pointer (request_snapshot) — keeps the trace file the index of truth
// ---------------------------------------------------------------------------

/**
 * Written by chat-store alongside each request snapshot so the trace timeline
 * stays self-describing. The actual snapshot body lives in the snapshots
 * directory; the trace only carries the pointer.
 */
export interface RequestSnapshotTrace {
  type: 'request_snapshot'
  callId: string
  turnId: string
  sessionId: string
  round: number
  /** Relative path under the project's snapshots root, e.g. "<sid>/<callId>.json". */
  snapshotPath: string
  ts: number
}

// ---------------------------------------------------------------------------
// Token usage payload (the bus-level shape; independent from the existing
// UsageEvent that already lives in stats/events.jsonl — that one is per-turn
// aggregate; this one is per-round.)
// ---------------------------------------------------------------------------

export interface TokenUsageEvent {
  callId: string
  turnId: string
  round: number
  sessionId: string
  ts: number
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cachedTokens?: number
  /** Where the number came from. Honest, never silently upgraded. */
  usageSource: 'api' | 'partial' | 'estimated'
  /** The model that produced this usage row. */
  modelConfigId: string
}

// ---------------------------------------------------------------------------
// Turn lifecycle payload
// ---------------------------------------------------------------------------

export type TurnLifecycleStage = 'started' | 'round_end' | 'finished' | 'aborted'

export interface TurnLifecycleEvent {
  callId: string
  turnId: string
  round: number
  sessionId: string
  ts: number
  stage: TurnLifecycleStage
  reason?: string
  modelConfigId: string
}
