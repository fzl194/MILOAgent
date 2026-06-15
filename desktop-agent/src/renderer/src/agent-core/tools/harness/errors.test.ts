import { describe, expect, it } from 'vitest'

import { FatalToolError, RecoverableToolError, isRecoverable } from './errors'

describe('isRecoverable', () => {
  it('is true for RecoverableToolError', () => {
    expect(isRecoverable(new RecoverableToolError('x'))).toBe(true)
  })

  it('is false for FatalToolError, plain Error, and non-errors', () => {
    expect(isRecoverable(new FatalToolError('x'))).toBe(false)
    expect(isRecoverable(new Error('x'))).toBe(false)
    expect(isRecoverable('string')).toBe(false)
    expect(isRecoverable(null)).toBe(false)
  })
})

describe('RecoverableToolError', () => {
  it('carries an optional hint for the model', () => {
    const e = new RecoverableToolError('bad path', 'try ls')
    expect(e.message).toBe('bad path')
    expect(e.hint).toBe('try ls')
  })

  it('omits hint when not provided', () => {
    expect(new RecoverableToolError('bad').hint).toBeUndefined()
  })
})
