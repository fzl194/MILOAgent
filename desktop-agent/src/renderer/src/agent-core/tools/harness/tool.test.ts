import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'

import { RecoverableToolError } from './errors'
import { defineTool, runTool, type Tool, type ToolContext } from './tool'

const ctx: ToolContext = {}

/** Build a Tool with sane defaults; tests override only what they exercise. */
function mkTool(overrides: {
  call?: Tool['call']
  checkPermissions?: Tool['checkPermissions']
  validateInput?: Tool['validateInput']
  maxResultSizeChars?: number
} = {}): Tool {
  return defineTool({
    name: 't',
    description: 'd',
    inputSchema: z.object({ x: z.number() }),
    maxResultSizeChars: overrides.maxResultSizeChars ?? Infinity,
    // Default allow so runTool reaches call(); tests that exercise the deny
    // path override checkPermissions explicitly. defineTool's own fail-closed
    // default is covered in the describe('defineTool') block below.
    checkPermissions:
      overrides.checkPermissions ?? (async () => ({ behavior: 'allow' })),
    call:
      overrides.call ?? (async () => ({ content: 'ok', isError: false })),
    ...(overrides.validateInput ? { validateInput: overrides.validateInput } : {})
  })
}

describe('defineTool', () => {
  it('fills fail-closed defaults (isReadOnly / isConcurrencySafe false, checkPermissions deny)', async () => {
    // Use defineTool directly (not mkTool) — mkTool overrides checkPermissions
    // to allow for runTool convenience; here we assert the raw factory default.
    const t = defineTool({
      name: 't',
      description: 'd',
      inputSchema: z.object({ x: z.number() }),
      maxResultSizeChars: Infinity,
      call: async () => ({ content: 'ok', isError: false })
    })
    expect(t.isReadOnly({ x: 1 })).toBe(false)
    expect(t.isConcurrencySafe({ x: 1 })).toBe(false)
    expect((await t.checkPermissions({ x: 1 }, ctx)).behavior).toBe('deny')
  })
})

describe('runTool', () => {
  it('rejects invalid input via Zod with a model-facing message', async () => {
    const r = await runTool(mkTool(), { x: 'not a number' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('参数校验失败')
  })

  it('short-circuits when checkPermissions denies (call is not reached)', async () => {
    let called = false
    const t = mkTool({
      checkPermissions: async () => ({ behavior: 'deny', reason: 'nope' }),
      call: async () => {
        called = true
        return { content: 'ok', isError: false }
      }
    })
    const r = await runTool(t, { x: 1 }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toBe('nope')
    expect(r.denial?.behavior).toBe('deny')
    expect(called).toBe(false)
  })

  it('surfaces a RecoverableToolError from call() as isError, appending the hint', async () => {
    const t = mkTool({
      call: async () => {
        throw new RecoverableToolError('boom', 'retry like this')
      }
    })
    const r = await runTool(t, { x: 1 }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('boom')
    expect(r.content).toContain('建议:retry like this')
  })

  it('truncates content over maxResultSizeChars and flags truncated + bytes', async () => {
    const t = mkTool({
      maxResultSizeChars: 5,
      call: async () => ({ content: 'abcdefghij', isError: false })
    })
    const r = await runTool(t, { x: 1 }, ctx)
    expect(r.content).toBe('abcde')
    expect(r.truncated).toBe(true)
    expect(r.bytes).toBe(10)
  })

  it('Infinity maxResultSizeChars never truncates', async () => {
    const t = mkTool({ call: async () => ({ content: 'a'.repeat(10_000), isError: false }) })
    const r = await runTool(t, { x: 1 }, ctx)
    expect(r.truncated).toBeUndefined()
    expect(r.content.length).toBe(10_000)
  })
})
