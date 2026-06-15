import { describe, expect, it } from 'vitest'

import { formatReadFailure, isBinaryText, withLineNumbers } from './read-file'

describe('withLineNumbers', () => {
  it('numbers each line cat -n style (6-wide, tab-separated)', () => {
    expect(withLineNumbers('a\nb')).toBe('     1\ta\n     2\tb')
  })

  it('handles a single line', () => {
    expect(withLineNumbers('hello')).toBe('     1\thello')
  })
})

describe('isBinaryText', () => {
  it('is true when the content contains a NUL byte', () => {
    expect(isBinaryText('abc\0def')).toBe(true)
  })

  it('is false for plain text', () => {
    expect(isBinaryText('just text')).toBe(false)
  })
})

describe('formatReadFailure', () => {
  it('oversized file (truncated) → message names the size, hint points to ranged reads', () => {
    const r = formatReadFailure({ error: 'too big', truncated: true, bytes: 3_000_000 })
    expect(r.message).toContain('3000000')
    expect(r.hint).toContain('sed')
  })

  it('ENOENT error → hint suggests listing the directory', () => {
    const r = formatReadFailure({ error: 'ENOENT: no such file or directory' })
    expect(r.message).toContain('读取失败')
    expect(r.hint).toContain('ls')
  })

  it('other error → message only, no hint', () => {
    const r = formatReadFailure({ error: 'permission denied' })
    expect(r.message).toContain('permission denied')
    expect(r.hint).toBeUndefined()
  })
})
