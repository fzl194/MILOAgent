import { describe, expect, it } from 'vitest'

import { decideShellOutputPersist } from './persist'

// P2 #2: shell large-output persist-to-disk. The pure `decideShellOutputPersist`
// decides inline vs persisted and shapes the preview; the main-process handler
// does the actual writeFile. Keeping the decision pure + testable, I/O in the
// caller.

describe('decideShellOutputPersist', () => {
  it('returns INLINE when content is under the threshold (no disk write)', () => {
    const r = decideShellOutputPersist('short output', {
      id: 'abc', baseDir: '/d', maxChars: 100, previewBytes: 20,
    })
    expect(r.kind).toBe('inline')
    if (r.kind === 'inline') expect(r.content).toBe('short output')
  })

  it('returns INLINE at the exact threshold (off-by-one: <= is inline)', () => {
    const r = decideShellOutputPersist('x'.repeat(100), {
      id: 'e', baseDir: '/d', maxChars: 100, previewBytes: 20,
    })
    expect(r.kind).toBe('inline')
  })

  it('returns PERSISTED with preview+path+bytes+truncated when content exceeds threshold', () => {
    const big = 'x'.repeat(500)
    const r = decideShellOutputPersist(big, {
      id: 'xyz', baseDir: '/d/tool-results', maxChars: 200, previewBytes: 50,
    })
    expect(r.kind).toBe('persisted')
    if (r.kind === 'persisted') {
      expect(r.bytes).toBe(500)
      expect(r.truncated).toBe(true)
      expect(r.path).toContain('xyz')
      expect(r.path).toContain('.txt')
      expect(r.preview).toContain('...') // truncation marker
    }
  })

  it('aligns preview to the last newline within the window (never cuts mid-line)', () => {
    // First 12 chars: 'aaaa\nbbbb\ncc'. Last '\n' inside the window is at
    // index 9 (end of 'bbbb\n'). The preview must NOT contain the partial
    // 'cc' — it should stop at the last newline, then append the marker.
    const content = 'aaaa\nbbbb\ncccc\n' + 'd'.repeat(100)
    const r = decideShellOutputPersist(content, {
      id: 'p', baseDir: '/d', maxChars: 10, previewBytes: 12,
    })
    expect(r.kind).toBe('persisted')
    if (r.kind === 'persisted') {
      expect(r.preview.startsWith('aaaa\nbbbb\n')).toBe(true)
      expect(r.preview).not.toContain('cc') // did not include the partial third line
    }
  })

  it('empty content returns INLINE empty (no file write for nothing)', () => {
    const r = decideShellOutputPersist('', {
      id: '0', baseDir: '/d', maxChars: 100, previewBytes: 20,
    })
    expect(r.kind).toBe('inline')
  })

  it('persisted path includes the id and .txt extension (caller passes id)', () => {
    const r = decideShellOutputPersist('y'.repeat(300), {
      id: 'call-123-abc', baseDir: '/d', maxChars: 100, previewBytes: 30,
    })
    expect(r.kind).toBe('persisted')
    if (r.kind === 'persisted') {
      expect(r.path).toContain('call-123-abc')
      expect(r.path.endsWith('.txt')).toBe(true)
    }
  })
})
