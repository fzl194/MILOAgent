import type { Message } from '../types'
import type { CompactionDecision } from '../../monitor/types'

// ---------------------------------------------------------------------------
// Context management v2 — pluggable "view over truth source".
//
// Principle: the session file (full message history) is the single source of
// truth. What gets sent to the LLM is a *view* produced by a ContextStrategy.
// Compaction/trimming only ever shapes that view; it never mutates the full
// history. Today this ships a cheap, no-LLM pipeline (tool-result trimming +
// token-budget backstop). The seam lets future tiers slot in WITHOUT a rewrite:
//   - P2: a Codex-style handoff summary — override the async `maybeCompact` hook
//         on the strategy. The call site (loop.ts, between rounds) and the
//         in-memory commit (ContextManager.replaceMessages) are wired. P2 ALSO
//         needs to persist the summary into the session truth source (a
//         loop→store compaction event) so it survives across turns; that wiring
//         is intentionally deferred until a real compactor exists.
//   - P3: Claude-Code-style cache-aware trimming / nine-section summary — add a
//         new Compactor into the pipeline.
// Reference: docs/2026-06-13-desktop-agent-上下文管理调研与选型.md
// ---------------------------------------------------------------------------

/** Conservative fallback context window (tokens) when a model doesn't declare one. */
export const DEFAULT_CONTEXT_WINDOW = 32_000

/** Estimates token usage for a message set. Rough today; swappable for a real
 *  tokenizer (gpt-tokenizer / provider-specific) by implementing this interface. */
export interface TokenEstimator {
  estimate(messages: Message[]): number
}

/** Cheap char/word-based estimator with no dependencies. Matches the heuristic
 *  already used for stats (~1.5 chars/token for CJK, ~1 word/token otherwise).
 *  It errs slightly high, which is the safe direction for budget enforcement. */
export class RoughTokenEstimator implements TokenEstimator {
  estimate(messages: Message[]): number {
    let tokens = 0
    for (const m of messages) {
      tokens += 4 // per-message structural overhead (role, delimiters)
      tokens += estimateText(m.content || '')
      if (m.toolCalls) {
        for (const tc of m.toolCalls) tokens += estimateText(tc.arguments || '') + 4
      }
    }
    return Math.round(tokens)
  }
}

function estimateText(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) || []).length
  const words = text.replace(/[一-鿿]/g, ' ').split(/\s+/).filter(Boolean).length
  return Math.round(cjk / 1.5 + words)
}

// ---------------------------------------------------------------------------
// Metrics + Compactor interfaces
// ---------------------------------------------------------------------------

export interface ContextMetrics {
  tokenEstimate: number
  window: number // the active model's context window, in tokens
  fillRatio: number // tokenEstimate / window
  messageCount: number
}

/** Immutable inputs handed to every Compactor. */
export interface CompactionContext {
  estimator: TokenEstimator
  window: number
  maxMessages: number
}

/** A single compaction step. Compactors are chained by the strategy; each
 *  receives the previous one's output and MUST preserve assistant↔tool pairing. */
export interface Compactor {
  readonly name: string
  /** Whether this compactor should act on the current (already-compacted) view. */
  shouldRun(metrics: ContextMetrics, ctx: CompactionContext): boolean
  /** Return a possibly-trimmed view. Pure: does not mutate the input array. */
  run(view: Message[], ctx: CompactionContext): Message[]
  /**
   * Optional: run WITH a structured decision record (what was dropped/elided and
   * why). Default implementations fall back to plain `run` with no decision —
   * so compactors that don't care about monitoring are unaffected. The strategy's
   * `toViewWithDecisions` aggregates these into a complete picture for the
   * monitor panel (see docs/2026-06-15-desktop-agent-运行态监控面板设计.md).
   */
  runWithDecision?(view: Message[], ctx: CompactionContext): { view: Message[]; decision?: CompactionDecision }
}

export function computeMetrics(
  messages: Message[],
  estimator: TokenEstimator,
  window: number
): ContextMetrics {
  const tokenEstimate = estimator.estimate(messages)
  return {
    tokenEstimate,
    window,
    fillRatio: window > 0 ? tokenEstimate / window : 1,
    messageCount: messages.length
  }
}

// ---------------------------------------------------------------------------
// Block helpers — the heart of the Gap C fix. Trimming removes WHOLE blocks (a
// single message, or an assistant(tool_calls) + its contiguous tool results), so
// it preserves pairing for valid contiguous histories. For already-corrupted
// non-contiguous input it may leave a residual orphan tool, which the self-heal
// pass in ContextManager.toOpenAIMessages then strips as a backstop.
// ---------------------------------------------------------------------------

/** Drop the oldest removable block from the front. A "block" is either one
 *  message, or an assistant(tool_calls) plus its contiguous run of tool results.
 *  A leading system message is never removed. Pure: returns a new array. */
export function dropOldestBlock(messages: Message[]): Message[] {
  if (messages.length === 0) return messages
  const start = messages[0].role === 'system' ? 1 : 0
  if (start >= messages.length) return messages
  let end = start + 1
  if (messages[start].role === 'assistant' && messages[start].toolCalls?.length) {
    while (end < messages.length && messages[end].role === 'tool') end++
  }
  return messages.slice(0, start).concat(messages.slice(end))
}

// ---------------------------------------------------------------------------
// Compactors
// ---------------------------------------------------------------------------

/** Claude-Code Tier 1 (micro-compaction): replace OLD tool *results* with a
 *  placeholder, but keep the tool_call (so the model still knows it read that
 *  file / ran that command and can re-invoke if needed). Protects the most
 *  recent `keep` tool results. Zero LLM cost.
 *
 *  Cache-aware: only runs when fillRatio > threshold (NOT every request). Running
 *  every turn mutates mid-array content → invalidates prefix cache even for short
 *  conversations. By deferring to a fill threshold, short conversations keep
 *  their cache intact; long conversations still get trimmed before overflow.
 *
 *  The placeholder string is shared with the FRC notice in the system prompt
 *  (see ./fold-notice.ts) so a rename here MUST be matched in the notice text
 *  — the system prompt literally tells the model to expect this string. */
import { OLD_TOOL_RESULT_FOLDED_PLACEHOLDER as ELIDED_TOOL_RESULT } from './fold-notice'

export class ToolResultTrimCompactor implements Compactor {
  readonly name = 'tool-result-trim'
  constructor(private keep = 10, private fillThreshold = 0.5) {}

  shouldRun(metrics: ContextMetrics): boolean {
    return metrics.fillRatio > this.fillThreshold
  }

  run(view: Message[]): Message[] {
    return this.compute(view).view
  }

  /** Returns the trimmed view plus a structured decision (which message IDs got
   *  their content elided, and how many characters were folded away). */
  runWithDecision(view: Message[]): { view: Message[]; decision?: CompactionDecision } {
    return this.compute(view)
  }

  private compute(view: Message[]): { view: Message[]; decision?: CompactionDecision } {
    const toolIndexes: number[] = []
    view.forEach((m, i) => {
      if (m.role === 'tool') toolIndexes.push(i)
    })
    if (toolIndexes.length <= this.keep) return { view }

    const drop = new Set(toolIndexes.slice(0, toolIndexes.length - this.keep))
    const droppedMessageIds: string[] = []
    let elidedContent = 0
    const next = view.map((m, i) => {
      // Guard content.length: a tool message with missing/empty content (typed
      // non-optional, but defensively tolerated elsewhere) must not throw and
      // crash the whole toView pipeline mid-turn.
      const len = m.content?.length ?? 0
      // Only elide when it actually shrinks the view — a result shorter than the
      // placeholder would otherwise make the view larger.
      if (drop.has(i) && len > ELIDED_TOOL_RESULT.length) {
        droppedMessageIds.push(m.id)
        elidedContent += len - ELIDED_TOOL_RESULT.length
        return { ...m, content: ELIDED_TOOL_RESULT }
      }
      return m
    })
    // Nothing was actually elided (e.g. every candidate was already shorter than
    // the placeholder) → behave as a no-op run, consistent with the sibling
    // compactors which only emit a decision when they changed something.
    if (droppedMessageIds.length === 0) return { view: next }
    return {
      view: next,
      decision: {
        compactor: this.name,
        ran: true,
        droppedMessageIds,
        elidedContent,
        reason: `tool results exceeded keep=${this.keep}; folded ${droppedMessageIds.length} old results`,
        before: 0, // filled in by the strategy (it has the estimator)
        after: 0
      }
    }
  }
}

/** Caps total message count by dropping oldest blocks (pair-preserving). An
 *  opt-in alternative to the token budget; composes with the other compactors
 *  instead of mutating the truth source on add(). */
export class CountTrimCompactor implements Compactor {
  readonly name = 'count-trim'

  shouldRun(metrics: ContextMetrics, ctx: CompactionContext): boolean {
    return metrics.messageCount > ctx.maxMessages
  }

  run(view: Message[], ctx: CompactionContext): Message[] {
    return this.compute(view, ctx).view
  }

  runWithDecision(view: Message[], ctx: CompactionContext): { view: Message[]; decision?: CompactionDecision } {
    return this.compute(view, ctx)
  }

  private compute(view: Message[], ctx: CompactionContext): { view: Message[]; decision?: CompactionDecision } {
    let out = view
    const droppedIds: string[] = []
    // Keep at least the system message + one block so we never empty the view.
    while (out.length > ctx.maxMessages && out.length > 1) {
      const removed = collectDroppedIds(out)
      out = dropOldestBlock(out)
      droppedIds.push(...removed)
    }
    if (droppedIds.length === 0) return { view: out }
    return {
      view: out,
      decision: {
        compactor: this.name,
        ran: true,
        droppedMessageIds: droppedIds,
        elidedContent: 0,
        reason: `message count ${view.length} > max ${ctx.maxMessages}; dropped ${droppedIds.length} messages`,
        before: 0,
        after: 0
      }
    }
  }
}

/** Hard backstop: if estimated tokens still exceed `ratio * window` after the
 *  other compactors, keep dropping oldest blocks until under budget. This
 *  prevents MULTI-MESSAGE overflow. Caveat: if a single remaining message
 *  (e.g. a huge tool result) alone exceeds the window, the loop stops at length
 *  1 and that message is still sent — mitigated by capping tool-result size at
 *  the source (a separate follow-up), not by truncating mid-content here. */
export class TokenBudgetBackstop implements Compactor {
  readonly name = 'token-budget'
  constructor(private ratio = 0.8) {}

  shouldRun(metrics: ContextMetrics): boolean {
    return metrics.fillRatio > this.ratio
  }

  run(view: Message[], ctx: CompactionContext): Message[] {
    return this.compute(view, ctx).view
  }

  /** Returns the trimmed view plus a structured decision (which blocks were
   *  dropped, before/after token estimates). */
  runWithDecision(view: Message[], ctx: CompactionContext): { view: Message[]; decision?: CompactionDecision } {
    return this.compute(view, ctx)
  }

  private compute(view: Message[], ctx: CompactionContext): { view: Message[]; decision?: CompactionDecision } {
    const before = ctx.estimator.estimate(view)
    let out = view
    const budget = Math.floor(ctx.window * this.ratio)
    const droppedIds: string[] = []
    let est = ctx.estimator.estimate(out)
    while (est > budget && out.length > 1) {
      // Capture what dropOldestBlock is about to remove so the decision records it.
      const removed = collectDroppedIds(out)
      out = dropOldestBlock(out)
      droppedIds.push(...removed)
      est = ctx.estimator.estimate(out)
    }
    if (droppedIds.length === 0) return { view: out }
    return {
      view: out,
      decision: {
        compactor: this.name,
        ran: true,
        droppedMessageIds: droppedIds,
        elidedContent: 0, // budget backstop drops blocks outright, never elides
        reason: `token estimate ${before} > budget ${budget} (${this.ratio}×window); dropped ${droppedIds.length} messages`,
        before,
        after: est
      }
    }
  }
}

/** Identifies the message id(s) that dropOldestBlock will remove on the next
 *  call, WITHOUT removing them — used to populate the decision record. Mirrors
 *  dropOldestBlock's block logic exactly (single message OR assistant+tool run). */
function collectDroppedIds(messages: Message[]): string[] {
  if (messages.length === 0) return []
  const start = messages[0]!.role === 'system' ? 1 : 0
  if (start >= messages.length) return []
  let end = start + 1
  if (messages[start]!.role === 'assistant' && messages[start]!.toolCalls?.length) {
    while (end < messages.length && messages[end]!.role === 'tool') end++
  }
  const ids: string[] = []
  for (let i = start; i < end; i++) ids.push(messages[i]!.id)
  return ids
}

// ---------------------------------------------------------------------------
// Strategy — orchestrates the compactor pipeline and exposes the async hook
// for expensive (LLM-based) compaction between turns.
// ---------------------------------------------------------------------------

export interface ContextStrategy {
  /** Produce the bounded view of the full history that will be sent to the LLM.
   *  Synchronous + cheap — only rule-based compactors run here. */
  toView(full: Message[]): Message[]
  /**
   * Optional: produce the bounded view PLUS a structured record of every
   * compaction decision that shaped it. The monitor panel uses this to show
   * "what was folded / dropped and why" alongside the request view
   * (see docs/2026-06-15-desktop-agent-运行态监控面板设计.md).
   *
   * Default implementations fall back to `{ view: this.toView(full), decisions: [] }`
   * — so strategies that don't participate in monitoring keep working unchanged.
   */
  toViewWithDecisions?(full: Message[]): { view: Message[]; decisions: CompactionDecision[] }
  /** Metrics for the full history (for UI / observability / threshold checks). */
  metrics(full: Message[]): ContextMetrics
  /** Between-turn hook for EXPENSIVE compaction (LLM summarization). No-op in
   *  P0/P1. P2 (Codex-style handoff summary) implements this and returns a
   *  compacted message list to replace the tail; returning null keeps history. */
  maybeCompact?(full: Message[], metrics: ContextMetrics): Promise<Message[] | null>
}

export interface DefaultContextStrategyOptions {
  estimator?: TokenEstimator
  /** The active model's context window in tokens. Falls back to DEFAULT_CONTEXT_WINDOW. */
  contextWindow?: number
  /** Optional hard cap on message count — only used if you add CountTrimCompactor
   *  to the pipeline. Defaults to no cap (the token budget is the real bound). */
  maxMessages?: number
  /** How many recent tool results to keep verbatim (ToolResultTrimCompactor). */
  keepRecentToolResults?: number
  /** Trim threshold as a fraction of the context window (TokenBudgetBackstop). */
  budgetRatio?: number
}

export class DefaultContextStrategy implements ContextStrategy {
  private readonly estimator: TokenEstimator
  private readonly ctx: CompactionContext
  private readonly compactors: Compactor[]

  constructor(opts: DefaultContextStrategyOptions) {
    this.estimator = opts.estimator ?? new RoughTokenEstimator()
    const window = opts.contextWindow && opts.contextWindow > 0 ? opts.contextWindow : DEFAULT_CONTEXT_WINDOW
    this.ctx = { estimator: this.estimator, window, maxMessages: opts.maxMessages ?? Infinity }
    // Token budget is the real safety bound (prevents context-overflow 400s);
    // tool-result trimming is the high-value, zero-LLM-cost reducer. The legacy
    // message-COUNT cap (CountTrimCompactor) is intentionally NOT in the default
    // pipeline: with a token budget it is redundant and would drop usable context
    // even when tokens are fine. The class stays exported for opt-in use.
    // (maxToolRounds — a separate, orthogonal agent-LOOP bound — lives in loop.ts.)
    this.compactors = [
      new ToolResultTrimCompactor(opts.keepRecentToolResults ?? 10),
      new TokenBudgetBackstop(opts.budgetRatio ?? 0.8)
    ]
  }

  metrics(full: Message[]): ContextMetrics {
    return computeMetrics(full, this.estimator, this.ctx.window)
  }

  toView(full: Message[]): Message[] {
    return this.toViewWithDecisions(full).view
  }

  /**
   * Threads the view through each compactor, aggregating each step's decision.
   * This is now the canonical path — `toView` is a thin wrapper around it so the
   * two never drift. Compactors that don't implement `runWithDecision` (or where
   * it returns no decision) contribute nothing to the decisions array — the
   * monitor panel simply shows fewer rows for those strategies.
   *
   * `before` / `after` token estimates are filled here (the strategy owns the
   * estimator); compactors that already set them (TokenBudgetBackstop,
   * CountTrimCompactor's before/after are filled below) are honored, while
   * ToolResultTrimCompactor leaves them at 0 for the strategy to populate.
   */
  toViewWithDecisions(full: Message[]): { view: Message[]; decisions: CompactionDecision[] } {
    let view = [...full]
    const decisions: CompactionDecision[] = []
    for (const c of this.compactors) {
      const m = computeMetrics(view, this.estimator, this.ctx.window)
      if (!c.shouldRun(m, this.ctx)) continue

      const beforeTokens = this.estimator.estimate(view)
      if (c.runWithDecision) {
        const { view: next, decision } = c.runWithDecision(view, this.ctx)
        view = next
        if (decision) {
          // Fill before/after if the compactor left them at 0 (ToolResultTrimCompactor
          // doesn't have the estimator; the strategy does). Trust non-zero values.
          const afterTokens = this.estimator.estimate(view)
          decisions.push({
            ...decision,
            before: decision.before || beforeTokens,
            after: decision.after || afterTokens
          })
        }
      } else {
        view = c.run(view, this.ctx)
      }
    }
    return { view, decisions }
  }

  // P2 seam: override this to perform an LLM handoff summary between turns.
  // The call site (loop.ts, between rounds) calls ContextManager.maybeCompact(),
  // which delegates here and commits a non-null result via replaceMessages().
  // No-op by default, so current behaviour is unchanged.
  async maybeCompact(): Promise<Message[] | null> {
    return null
  }
}
