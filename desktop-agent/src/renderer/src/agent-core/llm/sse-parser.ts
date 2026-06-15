export interface SSEEvent {
  event?: string
  data: string
}

export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      // Normalize CRLF → LF per line: some OpenAI-compatible proxies/endpoints
      // emit `data: {...}\r\n\r\n`. Without this, the event-terminating blank
      // line becomes '\r' (not '') and events never flush — the stream looks
      // stalled or drops frames.
      const lines = buffer.split('\n').map((l) => l.replace(/\r$/, ''))
      buffer = lines.pop() ?? ''

      let currentEvent: string | undefined
      let currentData = ''

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          currentData += (currentData ? '\n' : '') + line.slice(6)
        } else if (line === '' && currentData) {
          if (currentData.trim() === '[DONE]') return
          yield { event: currentEvent, data: currentData }
          currentEvent = undefined
          currentData = ''
        }
      }
    }

    // Final flush: decode any trailing multi-byte sequence the streaming
    // decoder was holding, then emit a dangling data line if the server closed
    // the connection without a terminating blank line (e.g. a final usage
    // chunk) — otherwise that last event (and its usage) is silently lost.
    buffer += decoder.decode()
    buffer = buffer.replace(/\r$/, '')
    if (buffer.trim() && buffer.startsWith('data: ')) {
      const data = buffer.slice(6).replace(/\r$/, '')
      if (data.trim() !== '[DONE]') yield { data }
    }
  } finally {
    reader.releaseLock()
  }
}
