import type { Message } from '../types'

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
 *  their cache intact; long conversations still get trimmed before overflow. */
const ELIDED_TOOL_RESULT = '[旧工具结果已折叠 · old tool result elided by context trimming]'

export class ToolResultTrimCompactor implements Compactor {
  readonly name = 'tool-result-trim'
  constructor(private keep = 10, private fillThreshold = 0.5) {}

  shouldRun(metrics: ContextMetrics): boolean {
    return metrics.fillRatio > this.fillThreshold
  }

  run(view: Message[]): Message[] {
    const toolIndexes: number[] = []
    view.forEach((m, i) => {
      if (m.role === 'tool') toolIndexes.push(i)
    })
    if (toolIndexes.length <= this.keep) return view
    const drop = new Set(toolIndexes.slice(0, toolIndexes.length - this.keep))
    return view.map((m, i) =>
      // Only elide when it actually shrinks the view — a result shorter than the
      // placeholder would otherwise make the view larger.
      drop.has(i) && m.content.length > ELIDED_TOOL_RESULT.length
        ? { ...m, content: ELIDED_TOOL_RESULT }
        : m
    )
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
    let out = view
    // Keep at least the system message + one block so we never empty the view.
    while (out.length > ctx.maxMessages && out.length > 1) {
      out = dropOldestBlock(out)
    }
    return out
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
    let out = view
    const budget = Math.floor(ctx.window * this.ratio)
    let est = ctx.estimator.estimate(out)
    while (est > budget && out.length > 1) {
      out = dropOldestBlock(out)
      est = ctx.estimator.estimate(out)
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Strategy — orchestrates the compactor pipeline and exposes the async hook
// for expensive (LLM-based) compaction between turns.
// ---------------------------------------------------------------------------

export interface ContextStrategy {
  /** Produce the bounded view of the full history that will be sent to the LLM.
   *  Synchronous + cheap — only rule-based compactors run here. */
  toView(full: Message[]): Message[]
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
    // Thread the view through each compactor; recompute metrics after each so a
    // later compactor sees the post-trim state. Compactors are pure functions.
    let view = [...full]
    for (const c of this.compactors) {
      const m = computeMetrics(view, this.estimator, this.ctx.window)
      if (c.shouldRun(m, this.ctx)) view = c.run(view, this.ctx)
    }
    return view
  }

  // P2 seam: override this to perform an LLM handoff summary between turns.
  // The call site (loop.ts, between rounds) calls ContextManager.maybeCompact(),
  // which delegates here and commits a non-null result via replaceMessages().
  // No-op by default, so current behaviour is unchanged.
  async maybeCompact(): Promise<Message[] | null> {
    return null
  }
}
