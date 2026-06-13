import type { Message, OpenAIChatMessage } from '../types'

export class ContextManager {
  private messages: Message[] = []
  private maxMessages: number

  constructor(maxMessages: number) {
    this.maxMessages = maxMessages
  }

  add(message: Message): void {
    this.messages.push(message)
    // Trim from front, preserving message pair integrity
    while (this.messages.length > this.maxMessages) {
      // Never remove system message
      if (this.messages[0]?.role === 'system') {
        this.messages.splice(1, 1)
        continue
      }
      // If removing an assistant msg with toolCalls, also remove following tool msgs
      const removed = this.messages.shift()!
      while (
        this.messages.length > 0 &&
        this.messages[0]?.role === 'tool'
      ) {
        this.messages.shift()
      }
    }
  }

  getMessages(): Message[] {
    return [...this.messages]
  }

  clear(): void {
    this.messages = []
  }

  /**
   * Convert the internal message history to the OpenAI chat-completions shape,
   * enforcing the message invariant: every assistant tool_calls[id] must be
   * followed by a tool message with the same tool_call_id, and every tool
   * message must follow such a call.
   *
   * History can become inconsistent if a turn exits between committing an
   * assistant(tool_calls) and appending its tool result (an exception in the
   * tool loop, an app crash, or already-corrupted persisted state). Rather than
   * send an invalid array and eat an API 400 ("insufficient tool messages
   * following tool_calls message"), we self-heal: strip orphaned tool_calls
   * (demoting the assistant message to plain text, or dropping it if empty) and
   * drop orphaned tool results, logging a warning so the anomaly is visible.
   */
  toOpenAIMessages(): OpenAIChatMessage[] {
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
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i]

      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        // Collect the contiguous run of tool messages directly after this one.
        const following: Message[] = []
        let j = i + 1
        while (j < this.messages.length && this.messages[j].role === 'tool') {
          following.push(this.messages[j])
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
        for (const t of following) {
          if (t.toolCallId && keptIds.has(t.toolCallId)) {
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
    return out
  }
}
