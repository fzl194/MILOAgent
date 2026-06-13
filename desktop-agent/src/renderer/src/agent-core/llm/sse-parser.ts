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
      const lines = buffer.split('\n')
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

    if (buffer.trim() && buffer.startsWith('data: ')) {
      const data = buffer.slice(6)
      if (data.trim() !== '[DONE]') yield { data }
    }
  } finally {
    reader.releaseLock()
  }
}
