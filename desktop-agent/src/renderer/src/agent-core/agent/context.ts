import type { Message, OpenAIChatMessage } from '../types'
import type { ContextStrategy, ContextMetrics } from './context-strategy'
import type { CompactionDecision } from '../../monitor/types'

/**
 * ContextManager — the in-memory truth source for one turn's conversation.
 *
 * It holds the FULL message history (append-only). The bounded view that
 * actually gets sent to the LLM is produced on demand by the injected
 * {@link ContextStrategy} (tool-result trimming + token-budget backstop).
 * Trimming never happens in add() — doing so was the "Gap C" bug,
 * where front-trimming could orphan tool messages and trigger API 400s.
 *
 * See docs/2026-06-13-desktop-agent-上下文管理调研与选型.md.
 */
export class ContextManager {
  private messages: Message[] = []
  private strategy: ContextStrategy

  constructor(strategy: ContextStrategy) {
    this.strategy = strategy
  }

  /** Truth source: append-only. No trimming here.
   *
   *  Invariant: a `system` message ALWAYS leads the conversation. The loop loads
   *  existing history first (which does NOT persist the system prompt), then
   *  adds the system message — so a plain push would land it BEHIND the prior
   *  user/assistant turns, corrupting the order sent to the model (system ends
   *  up mid-conversation). System messages are unshifted to the front to keep
   *  them in position 0 regardless of when they're added. Non-system messages
   *  append normally. */
  add(message: Message): void {
    if (message.role === 'system') {
      this.messages.unshift(message)
    } else {
      this.messages.push(message)
    }
  }

  getMessages(): Message[] {
    return [...this.messages]
  }

  clear(): void {
    this.messages = []
  }

  /** Metrics over the FULL history (for UI / threshold checks). */
  metrics(): ContextMetrics {
    return this.strategy.metrics(this.messages)
  }

  /** Bounded view of the full history (internal Message type) after the
   *  strategy's cheap compactors have run. */
  toView(): Message[] {
    return this.strategy.toView(this.messages)
  }

  /**
   * Produce the full request bundle in ONE pass — the internal view, the
   * structured compaction decisions, the wire-format OpenAI messages (self-
   * healed), and the metrics for the (post-compaction) view. Used by the agent
   * loop's monitor hook so it doesn't pay twice for view construction.
   *
   * Falls back to plain `toView` with empty decisions when the strategy hasn't
   * opted into `toViewWithDecisions` — so monitoring is additive, never breaks
   * a strategy that pre-dates it.
   * See docs/2026-06-15-desktop-agent-运行态监控面板设计.md §② 采集点.
   */
  produceRequest(): {
    view: Message[]
    decisions: CompactionDecision[]
    openaiMessages: OpenAIChatMessage[]
    metrics: ContextMetrics
    /** How many messages self-heal dropped/stripped when producing the wire
     *  payload. Non-zero means the actual POST differed from `view` — the
     *  monitor panel uses this to warn that the displayed view ≠ what was sent. */
    selfHeal: { strippedCalls: number; strippedResults: number }
  } {
    const resolved = this.strategy.toViewWithDecisions
      ? this.strategy.toViewWithDecisions(this.messages)
      : { view: this.strategy.toView(this.messages), decisions: [] as CompactionDecision[] }
    const { messages: openaiMessages, strippedCalls, strippedResults } = this.toOpenAIMessagesFromView(resolved.view)
    const metrics = this.strategy.metrics(resolved.view)
    return {
      view: resolved.view,
      decisions: resolved.decisions,
      openaiMessages,
      metrics,
      selfHeal: { strippedCalls, strippedResults }
    }
  }

  /** Between-turn compaction hook (delegates to the strategy). Returns a
   *  compacted message list to replace the truth source, or null to keep it.
   *  No-op unless the strategy implements expensive (LLM) compaction (P2). */
  async maybeCompact(): Promise<Message[] | null> {
    // Call BOUND (this.strategy.maybeCompact?.(...)) — extracting the method
    // first would lose its binding and crash a class-based P2 strategy that
    // reads `this`.
    return this.strategy.maybeCompact?.(this.messages, this.strategy.metrics(this.messages)) ?? null
  }

  /** Replace the full history. Used by the compaction hook to commit a summary
   *  back into the truth source. */
  replaceMessages(replacement: Message[]): void {
    this.messages = [...replacement]
  }

  /**
   * Convert the (compacted) view to the OpenAI chat-completions shape, enforcing
   * the tool_calls pairing invariant as a final safety net. History can still be
   * inconsistent (an exception mid-turn, a crash, or pre-existing corrupted
   * state); rather than send an invalid array and eat an API 400 ("insufficient
   * tool messages following tool_calls message"), we self-heal: strip orphaned
   * tool_calls (demoting the assistant message to plain text, or dropping it if
   * empty) and drop orphaned tool results, logging a warning when it happens.
   */
  toOpenAIMessages(): OpenAIChatMessage[] {
    return this.toOpenAIMessagesFromView(this.toView()).messages
  }

  /**
   * Self-heal a (already-compacted) view into the OpenAI chat-completions shape,
   * enforcing the tool_calls pairing invariant as a final safety net. History
   * can still be inconsistent (an exception mid-turn, a crash, or pre-existing
   * corrupted state); rather than send an invalid array and eat an API 400
   * ("insufficient tool messages following tool_calls message"), we self-heal:
   * strip orphaned tool_calls (demoting the assistant message to plain text, or
   * dropping it if empty) and drop orphaned tool results, logging a warning.
   *
   * Factored out of toOpenAIMessages so produceRequest() can reuse it on a view
   * it already built (with decisions), without paying for toView twice.
   */
  private toOpenAIMessagesFromView(view: Message[]): { messages: OpenAIChatMessage[]; strippedCalls: number; strippedResults: number } {
    let strippedCalls = 0
    let strippedResults = 0
    const out: OpenAIChatMessage[] = []

    // Single forward pass. The OpenAI invariant requires each assistant
    // tool_calls message to be IMMEDIATELY followed by its matching tool
    // messages, so we validate per assistant block against its own contiguous
    // run of tool messages — NOT by global id intersection, which could keep a
    // non-adjacent pair (e.g. assistant(tool_calls) → user → tool) that the API
    // still rejects. Per-block validation also avoids collapsing duplicate ids
    // across separate assistant messages.
    for (let i = 0; i < view.length; i++) {
      const m = view[i]

      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        // Collect the contiguous run of tool messages directly after this one.
        const following: Message[] = []
        let j = i + 1
        while (j < view.length && view[j].role === 'tool') {
          following.push(view[j])
          j++
        }
        const answeredHere = new Set(
          following.map((t) => t.toolCallId).filter((id): id is string => Boolean(id))
        )
        const kept = m.toolCalls.filter((tc) => answeredHere.has(tc.id))
        strippedCalls += m.toolCalls.length - kept.length

        if (kept.length === 0) {
          // No tool_call answered contiguously → demote to plain text (drop if
          // empty); the following tool messages are orphaned by this drop too.
          if (m.content && m.content.trim()) {
            out.push({ role: 'assistant', content: m.content })
          }
          strippedResults += following.length
          i = j - 1 // consume the run; the for-loop's i++ then advances past it
          continue
        }

        const keptIds = new Set(kept.map((tc) => tc.id))
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: kept.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments }
          }))
        })
        // Emit at most ONE tool result per kept id — duplicate tool_call_ids
        // (from corruption/bugs) would otherwise yield an invalid array.
        const emittedToolIds = new Set<string>()
        for (const t of following) {
          if (t.toolCallId && keptIds.has(t.toolCallId) && !emittedToolIds.has(t.toolCallId)) {
            emittedToolIds.add(t.toolCallId)
            out.push({ role: 'tool', content: t.content, tool_call_id: t.toolCallId })
          } else {
            strippedResults++
          }
        }
        i = j - 1
        continue
      }

      // A tool message not consumed by the assistant block above has no
      // contiguous preceding assistant tool_calls → orphan, must be dropped.
      if (m.role === 'tool') {
        strippedResults++
        continue
      }

      out.push({ role: m.role, content: m.content })
    }

    if (strippedCalls > 0 || strippedResults > 0) {
      console.warn(
        `[context] self-heal: stripped ${strippedCalls} orphaned tool_calls ` +
          `and ${strippedResults} orphaned tool result(s) to keep the message ` +
          `history valid (prevents API 400 "insufficient tool messages")`
      )
    }
    return { messages: out, strippedCalls, strippedResults }
  }
}
