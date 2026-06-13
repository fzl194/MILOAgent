import { describe, it, expect, vi } from 'vitest'
import { ContextManager } from './context'
import type { Message } from '../types'

// Helper: build a Message with sensible defaults, overriding via partial.
function msg(role: Message['role'], partial: Partial<Message> = {}): Message {
  return { id: Math.random().toString(36).slice(2), role, content: '', timestamp: 0, ...partial }
}

describe('ContextManager.toOpenAIMessages — invariant self-heal', () => {
  it('preserves a fully-paired assistant tool_calls + tool result', () => {
    const ctx = new ContextManager(50)
    ctx.add(msg('user', { content: 'hi' }))
    ctx.add(
      msg('assistant', {
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }]
      })
    )
    ctx.add(msg('tool', { content: 'file contents', toolCallId: 'call_1' }))

    const out = ctx.toOpenAIMessages()
    const asst = out.find((m) => m.role === 'assistant')
    expect(asst?.tool_calls?.length).toBe(1)
    expect(asst?.tool_calls?.[0].id).toBe('call_1')
    expect(out.find((m) => m.role === 'tool')?.tool_call_id).toBe('call_1')
  })

  it('strips an orphan assistant tool_calls (no tool result), keeps text, and warns', () => {
    const ctx = new ContextManager(50)
    ctx.add(msg('user', { content: 'do it' }))
    ctx.add(
      msg('assistant', {
        content: 'writing...',
        toolCalls: [{ id: 'call_x', name: 'write_file', arguments: '{}' }]
      })
    )

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = ctx.toOpenAIMessages()

    const asst = out.find((m) => m.role === 'assistant')
    expect(asst?.tool_calls).toBeUndefined() // tool_calls stripped
    expect(asst?.content).toBe('writing...') // text retained
    expect(out.some((m) => m.role === 'tool')).toBe(false) // no tool msg emitted
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('drops an orphan assistant message entirely when it has no text to keep', () => {
    const ctx = new ContextManager(50)
    ctx.add(msg('user', { content: 'go' }))
    ctx.add(
      msg('assistant', {
        content: '',
        toolCalls: [{ id: 'call_y', name: 'write_file', arguments: '{}' }]
      })
    )

    const out = ctx.toOpenAIMessages()
    expect(out.filter((m) => m.role === 'assistant').length).toBe(0)
  })

  it('keeps only the resolved tool_call when some are orphaned', () => {
    const ctx = new ContextManager(50)
    ctx.add(msg('user', { content: 'go' }))
    ctx.add(
      msg('assistant', {
        content: '',
        toolCalls: [
          { id: 'a', name: 'read_file', arguments: '{}' },
          { id: 'b', name: 'read_file', arguments: '{}' }
        ]
      })
    )
    ctx.add(msg('tool', { content: 'res-a', toolCallId: 'a' })) // only 'a' answered

    const out = ctx.toOpenAIMessages()
    const asst = out.find((m) => m.role === 'assistant')
    expect(asst?.tool_calls?.map((t) => t.id)).toEqual(['a'])
    expect(out.filter((m) => m.role === 'tool').length).toBe(1)
  })

  it('strips an orphan tool result (no preceding assistant tool_calls)', () => {
    const ctx = new ContextManager(50)
    ctx.add(msg('user', { content: 'hi' }))
    ctx.add(msg('tool', { content: 'dangling', toolCallId: 'ghost' }))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = ctx.toOpenAIMessages()
    expect(out.some((m) => m.role === 'tool')).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('leaves normal user/system/assistant-text messages untouched', () => {
    const ctx = new ContextManager(50)
    ctx.add(msg('system', { content: 'you are helpful' }))
    ctx.add(msg('user', { content: 'hello' }))
    ctx.add(msg('assistant', { content: 'hi there' }))

    const out = ctx.toOpenAIMessages()
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
    expect(out.map((m) => m.content)).toEqual(['you are helpful', 'hello', 'hi there'])
  })

  it('strips tool_calls when their tool result is non-adjacent (a user msg intervenes)', () => {
    const ctx = new ContextManager(50)
    ctx.add(msg('user', { content: 'go' }))
    ctx.add(
      msg('assistant', { content: '', toolCalls: [{ id: 'a', name: 'read_file', arguments: '{}' }] })
    )
    ctx.add(msg('user', { content: 'wait' })) // breaks adjacency
    ctx.add(msg('tool', { content: 'late-result', toolCallId: 'a' }))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = ctx.toOpenAIMessages()
    // assistant tool_calls stripped (no contiguous result); the late tool result is an orphan too
    expect(out.some((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0)).toBe(false)
    expect(out.some((m) => m.role === 'tool')).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('drops a tool result that appears before its assistant tool_calls', () => {
    const ctx = new ContextManager(50)
    ctx.add(msg('user', { content: 'hi' }))
    ctx.add(msg('tool', { content: 'orphan', toolCallId: 'a' })) // no preceding assistant
    ctx.add(
      msg('assistant', { content: '', toolCalls: [{ id: 'a', name: 'read_file', arguments: '{}' }] })
    )

    const out = ctx.toOpenAIMessages()
    expect(out.some((m) => m.role === 'tool')).toBe(false)
    expect(out.some((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0)).toBe(false)
  })

  it('pairs duplicate tool_call ids per assistant block (does not collapse across blocks)', () => {
    const ctx = new ContextManager(50)
    ctx.add(msg('assistant', { content: '', toolCalls: [{ id: 'dup', name: 'read_file', arguments: '{}' }] }))
    ctx.add(msg('tool', { content: 'r1', toolCallId: 'dup' }))
    ctx.add(msg('assistant', { content: '', toolCalls: [{ id: 'dup', name: 'read_file', arguments: '{}' }] }))
    ctx.add(msg('tool', { content: 'r2', toolCallId: 'dup' }))

    const out = ctx.toOpenAIMessages()
    expect(out.filter((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0).length).toBe(2)
    expect(out.filter((m) => m.role === 'tool').length).toBe(2) // each assistant keeps its own result
  })
})
