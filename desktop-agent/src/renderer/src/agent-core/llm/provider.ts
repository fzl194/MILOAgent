import type { LLMConfig, ToolDefinition, StreamEvent, OpenAIChatMessage, UsageStats } from '../types'
import { parseSSEStream } from './sse-parser'

// Minimal shape of an OpenAI-compatible streaming chunk (only the fields we read)
interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

export class LLMProvider {
  constructor(private config: LLMConfig) {}

  async *chat(
    messages: OpenAIChatMessage[],
    tools?: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: true,
      // Ask the endpoint to emit a final chunk with token usage. Providers that
      // don't recognise it simply ignore the field, so it is safe to always send.
      stream_options: { include_usage: true }
    }

    if (this.config.temperature !== undefined) body.temperature = this.config.temperature
    if (this.config.maxTokens !== undefined) body.max_tokens = this.config.maxTokens

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`LLM API ${response.status}: ${errText}`)
    }

    if (!response.body) throw new Error('No response body')

    const toolCallAccumulators = new Map<
      number,
      { id: string; name: string; arguments: string }
    >()
    let textContent = ''
    let pendingUsage: UsageStats | null = null
    let pendingFinishReason: string | null = null

    for await (const sse of parseSSEStream(response.body)) {
      let chunk: OpenAIStreamChunk
      try {
        chunk = JSON.parse(sse.data) as OpenAIStreamChunk
      } catch {
        continue
      }

      // The usage chunk arrives with an empty choices array — capture it BEFORE
      // the `if (!delta) continue` guard below would skip the whole chunk.
      if (chunk.usage) {
        pendingUsage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens,
          cachedTokens: typeof (chunk.usage as any)?.prompt_tokens_details?.cached_tokens === 'number'
            ? (chunk.usage as any).prompt_tokens_details.cached_tokens
            : undefined
        }
      }

      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      const finishReason = choice?.finish_reason
      if (finishReason) pendingFinishReason = finishReason

      if (delta?.content) {
        textContent += delta.content
        yield { type: 'text_delta', data: delta.content }
      }

      // Reasoning models (GLM, DeepSeek-R1, etc.) send thinking tokens separately.
      const reasoning = (delta as any)?.reasoning_content || (delta as any)?.reasoning
      if (reasoning) {
        yield { type: 'reasoning_delta', data: reasoning }
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          if (!toolCallAccumulators.has(idx)) {
            toolCallAccumulators.set(idx, {
              id: tc.id ?? '',
              name: '',
              arguments: ''
            })
          }
          const acc = toolCallAccumulators.get(idx)!
          if (tc.id) acc.id = tc.id
          // Use assignment instead of += for name (only sent once per spec)
          if (tc.function?.name && !acc.name) acc.name = tc.function.name
          if (tc.function?.arguments) acc.arguments += tc.function.arguments

          yield {
            type: 'tool_call_delta',
            data: { index: idx, ...acc }
          }
        }
      }

      // Flush accumulated tool calls once the model signals tool_calls. Do NOT
      // return here — the usage chunk may still be in flight, so keep reading
      // until the stream terminates at [DONE] (handled by parseSSEStream).
      if (finishReason === 'tool_calls') {
        for (const [, tc] of toolCallAccumulators) {
          yield { type: 'tool_call_end', data: tc }
        }
      }
    }

    // Stream ended ([DONE]). Emit a single done event carrying the full result.
    yield {
      type: 'done',
      data: {
        textContent,
        toolCalls: [...toolCallAccumulators.values()],
        finishReason: pendingFinishReason ?? 'stop',
        usage: pendingUsage
      }
    }
  }
}
