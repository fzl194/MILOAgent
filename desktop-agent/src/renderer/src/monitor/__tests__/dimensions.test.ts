import { describe, it, expect } from 'vitest'
import { DIMENSIONS, DEFAULT_ENABLED, ALL_DIMENSIONS } from '../dimensions'
import type { DimKey } from '../types'

describe('dimension registry', () => {
  it('exports all five initial dimensions', () => {
    expect(ALL_DIMENSIONS).toEqual([
      'request_view',
      'context_metrics',
      'tool_call',
      'token_usage',
      'turn_lifecycle'
    ])
  })

  it('every DimKey has a metadata row', () => {
    const keys: DimKey[] = ['request_view', 'context_metrics', 'tool_call', 'token_usage', 'turn_lifecycle']
    for (const k of keys) {
      expect(DIMENSIONS[k]).toBeDefined()
      expect(DIMENSIONS[k]!.key).toBe(k)
      expect(typeof DIMENSIONS[k]!.label).toBe('string')
      expect(['context', 'tool', 'token', 'lifecycle']).toContain(DIMENSIONS[k]!.group)
    }
  })

  it('every key has a default-enabled flag', () => {
    for (const k of ALL_DIMENSIONS) {
      expect(typeof DEFAULT_ENABLED[k]).toBe('boolean')
    }
  })

  it('the snapshot-persisted dimensions are exactly request_view + context_metrics', () => {
    const snapshotDims = ALL_DIMENSIONS.filter((k) => DIMENSIONS[k]!.persistStrategy === 'snapshot')
    expect(snapshotDims.sort()).toEqual(['context_metrics', 'request_view'])
  })

  it('request_view is the only heavy payload', () => {
    const heavy = ALL_DIMENSIONS.filter((k) => DIMENSIONS[k]!.payloadCost === 'heavy')
    expect(heavy).toEqual(['request_view'])
  })

  it('trace-only dimensions are tool_call, token_usage, turn_lifecycle', () => {
    const traceOnly = ALL_DIMENSIONS.filter((k) => DIMENSIONS[k]!.persistStrategy === 'trace-only')
    expect(traceOnly.sort()).toEqual(['token_usage', 'tool_call', 'turn_lifecycle'])
  })
})
