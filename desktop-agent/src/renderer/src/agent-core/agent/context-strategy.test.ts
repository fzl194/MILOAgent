import { describe, it, expect } from 'vitest'
import {
  RoughTokenEstimator,
  ToolResultTrimCompactor,
  CountTrimCompactor,
  TokenBudgetBackstop,
  DefaultContextStrategy,
  dropOldestBlock,
  computeMetrics,
  type CompactionContext
} from './context-strategy'
import type { Message } from '../types'

// --- fixtures ----------------------------------------------------------------
let n = 0
function mk(role: Message['role'], partial: Partial<Message> = {}): Message {
  return { id: 'm' + n++, role, content: '', timestamp: 0, ...partial }
}
const u = (content: string) => mk('user', { content })
const sys = (content = 'SYS') => mk('system', { content })
const asst = (content: string) => mk('assistant', { content })
const asstTC = (ids: string[]) =>
  mk('assistant', { content: '', toolCalls: ids.map((id) => ({ id, name: 'read_file', arguments: '{}' })) })
const tool = (id: string, content = 'result') => mk('tool', { toolCallId: id, content })

const est = new RoughTokenEstimator()
const ctx = (over: Partial<CompactionContext> = {}): CompactionContext => ({
  estimator: est,
  window: 1_000_000,
  maxMessages: 1000,
  ...over
})

// --- dropOldestBlock (the Gap C fix, generalised) ---------------------------
describe('dropOldestBlock', () => {
  it('drops the first non-system message', () => {
    const out = dropOldestBlock([u('a'), u('b'), u('c')])
    expect(out.map((m) => m.content)).toEqual(['b', 'c'])
  })

  it('protects a leading system message and drops the one after it', () => {
    const out = dropOldestBlock([sys(), u('a'), u('b')])
    expect(out.map((m) => m.content)).toEqual(['SYS', 'b'])
  })

  it('drops an assistant(tool_calls) together with its trailing tool results', () => {
    const out = dropOldestBlock([asstTC(['x', 'y']), tool('x'), tool('y'), u('r')])
    expect(out.length).toBe(1)
    expect(out[0].content).toBe('r') // asst + both tools removed as one block
  })

  it('drops a lone tool message (orphan) without touching the rest', () => {
    const out = dropOldestBlock([tool('orphan'), u('a')])
    expect(out.map((m) => m.content)).toEqual(['a'])
  })
})

// --- ToolResultTrimCompactor (Claude Tier 1) --------------------------------
describe('ToolResultTrimCompactor', () => {
  it('elides old tool results beyond `keep`, keeps the recent ones, leaves tool_calls intact', () => {
    const c = new ToolResultTrimCompactor(2)
    const big = 'B'.repeat(100) // longer than the elision placeholder so it actually gets elided
    const view = [asstTC(['t1', 't2', 't3']), tool('t1', big), tool('t2', big), tool('t3', big)]
    const out = c.run(view)
    expect(out[0].toolCalls?.length).toBe(3) // declaration untouched
    expect(out[1].content).toMatch(/折叠|elided/) // t1 elided (oldest beyond keep=2)
    expect(out[2].content).toBe(big) // kept
    expect(out[3].content).toBe(big) // kept
  })

  it('does nothing when tool results are within the keep window', () => {
    const c = new ToolResultTrimCompactor(5)
    const view = [asstTC(['a']), tool('a', 'r')]
    expect(c.run(view)).toEqual(view)
  })
})

// --- CountTrimCompactor ------------------------------------------------------
describe('CountTrimCompactor', () => {
  it('caps message count, dropping an assistant+tools block together (no orphan)', () => {
    const c = new CountTrimCompactor()
    const localCtx = ctx({ maxMessages: 3 })
    const view = [asstTC(['x']), tool('x'), u('q'), asst('final')] // 4 messages
    const metrics = computeMetrics(view, est, localCtx.window)
    expect(c.shouldRun(metrics, localCtx)).toBe(true)
    const out = c.run(view, localCtx)
    expect(out.length).toBe(2) // asst(tc)+tool dropped as a block → [u('q'), asst('final')]
    expect(out.map((m) => m.content)).toEqual(['q', 'final'])
  })
})

// --- TokenBudgetBackstop -----------------------------------------------------
describe('TokenBudgetBackstop', () => {
  it('drops oldest blocks until the estimate is within budget', () => {
    const localCtx = ctx({ window: 100, maxMessages: 1000 })
    const c = new TokenBudgetBackstop(0.8) // budget = 80 tokens
    const pad = 'word '.repeat(40) // ~40 tokens per message
    const view = [u('A' + pad), u('B' + pad), u('C' + pad), u('D' + pad)]
    const out = c.run(view, localCtx)
    const e = est.estimate(out)
    expect(e).toBeLessThanOrEqual(80)
    expect(out.length).toBeLessThan(view.length)
    expect(out.length).toBeGreaterThanOrEqual(1)
  })

  it('leaves a small history untouched', () => {
    const localCtx = ctx({ window: 1_000_000, maxMessages: 1000 })
    const c = new TokenBudgetBackstop(0.8)
    const view = [u('hi'), asst('hello')]
    expect(c.run(view, localCtx)).toEqual(view)
  })
})

// --- DefaultContextStrategy.toView (integration) ----------------------------
describe('DefaultContextStrategy.toView', () => {
  it('applies tool-result elision while keeping tool_call declarations', () => {
    const s = new DefaultContextStrategy({
      contextWindow: 1_000_000,
      maxMessages: 1000,
      keepRecentToolResults: 2
    })
    const big = 'Z'.repeat(100) // longer than the elision placeholder
    const full = [asstTC(['a', 'b', 'c', 'd']), tool('a', big), tool('b', big), tool('c', big), tool('d', big)]
    const view = s.toView(full)
    expect(view[0].toolCalls?.length).toBe(4)
    expect(view.find((m) => m.toolCallId === 'a')?.content).toMatch(/折叠|elided/)
    expect(view.find((m) => m.toolCallId === 'd')?.content).toBe(big)
  })

  it('trims via the token budget when the window is exceeded (system is kept)', () => {
    const s = new DefaultContextStrategy({ contextWindow: 200, maxMessages: 1000 })
    const big = 'word '.repeat(60) // ~60 tokens each
    const full = [sys(), u(big), u(big), u(big), u(big)]
    const view = s.toView(full)
    // budget = floor(200 * 0.8) = 160; trimming drops oldest non-system blocks
    expect(est.estimate(view)).toBeLessThanOrEqual(160)
    expect(view.some((m) => m.role === 'system')).toBe(true)
  })

  it('keeps a small history unchanged', () => {
    const s = new DefaultContextStrategy({ contextWindow: 1_000_000, maxMessages: 1000 })
    const full = [sys(), u('hi'), asst('hello')]
    expect(s.toView(full).map((m) => m.content)).toEqual(['SYS', 'hi', 'hello'])
  })
})

// --- RoughTokenEstimator -----------------------------------------------------
describe('RoughTokenEstimator', () => {
  it('returns a positive estimate that grows with content', () => {
    const small = est.estimate([u('hi')])
    const big = est.estimate([u('hello world '.repeat(100))])
    expect(small).toBeGreaterThan(0)
    expect(big).toBeGreaterThan(small)
  })
})
