import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  formatGitStatusBlock,
  getCachedGitStatus,
  setCachedGitStatus,
  invalidateGitStatusCache,
  fetchGitStatusTail
} from './git-status'

describe('formatGitStatusBlock', () => {
  it('wraps non-empty stdout in <git status> tags', () => {
    expect(formatGitStatusBlock('## main\n M foo.txt\n')).toBe(
      '<git status>\n## main\n M foo.txt\n</git status>'
    )
  })

  it('trims leading/trailing whitespace before wrapping', () => {
    expect(formatGitStatusBlock('  \n## main\n  ')).toBe(
      '<git status>\n## main\n</git status>'
    )
  })

  it('returns empty string for empty / whitespace-only input', () => {
    expect(formatGitStatusBlock('')).toBe('')
    expect(formatGitStatusBlock('   \n\n  ')).toBe('')
  })
})

describe('cache TTL', () => {
  beforeEach(() => {
    invalidateGitStatusCache()
  })

  it('setCachedGitStatus → getCachedGitStatus returns the same value while fresh', () => {
    setCachedGitStatus('p1', '## main', 1000)
    expect(getCachedGitStatus('p1', 30_000)).toBe('## main')
  })

  it('getCachedGitStatus evicts the entry past the TTL (60s default)', () => {
    setCachedGitStatus('p1', '## main', 1000)
    // 60s + 1ms past → expired
    expect(getCachedGitStatus('p1', 1000 + 60_000 + 1)).toBeUndefined()
    // After eviction, the entry is gone (not just falsy)
    expect(getCachedGitStatus('p1', 1000 + 60_000 + 2)).toBeUndefined()
  })

  it('getCachedGitStatus returns undefined for an unknown project', () => {
    expect(getCachedGitStatus('nope')).toBeUndefined()
  })

  it('invalidateGitStatusCache(projectId) drops just that project', () => {
    setCachedGitStatus('p1', 'a', 1000)
    setCachedGitStatus('p2', 'b', 1000)
    invalidateGitStatusCache('p1')
    expect(getCachedGitStatus('p1', 1000)).toBeUndefined()
    expect(getCachedGitStatus('p2', 1000)).toBe('b')
  })

  it('invalidateGitStatusCache() with no arg clears everything', () => {
    setCachedGitStatus('p1', 'a', 1000)
    setCachedGitStatus('p2', 'b', 1000)
    invalidateGitStatusCache()
    expect(getCachedGitStatus('p1', 1000)).toBeUndefined()
    expect(getCachedGitStatus('p2', 1000)).toBeUndefined()
  })
})

describe('fetchGitStatusTail', () => {
  beforeEach(() => {
    invalidateGitStatusCache()
  })

  function stubGitStatus(impl: (cwd: string) => Promise<{ success: boolean; data?: { stdout: string }; error?: string }>) {
    ;(globalThis as any).window = {
      electronAPI: { gitStatus: vi.fn(impl) }
    }
  }

  it('returns the cached block without calling the IPC when fresh', async () => {
    setCachedGitStatus('p1', '## main')
    stubGitStatus(vi.fn())
    const out = await fetchGitStatusTail('/repo', 'p1')
    expect(out).toBe('<git status>\n## main\n</git status>')
    expect((window as any).electronAPI.gitStatus).not.toHaveBeenCalled()
  })

  it('returns empty string and caches "" when cwd is undefined', async () => {
    stubGitStatus(vi.fn())
    const out = await fetchGitStatusTail(undefined, 'p1')
    expect(out).toBe('')
    expect((window as any).electronAPI.gitStatus).not.toHaveBeenCalled()
    // Cached miss so we don't retry every turn
    expect(getCachedGitStatus('p1')).toBe('')
  })

  it('calls the IPC when no cache hit and wraps the result', async () => {
    stubGitStatus(async () => ({ success: true, data: { stdout: '## main\n M foo' } }))
    const out = await fetchGitStatusTail('/repo', 'p1')
    expect(out).toBe('<git status>\n## main\n M foo\n</git status>')
    expect(getCachedGitStatus('p1')).toBe('## main\n M foo')
  })

  it('returns empty string and caches "" on IPC { success: false } (non-git dir / ENOENT)', async () => {
    stubGitStatus(async () => ({ success: false, error: 'not a git repo' }))
    const out = await fetchGitStatusTail('/repo', 'p1')
    expect(out).toBe('')
    expect(getCachedGitStatus('p1')).toBe('')
  })

  it('returns empty string when the IPC throws (best-effort: never aborts a turn)', async () => {
    stubGitStatus(async () => { throw new Error('IPC boom') })
    const out = await fetchGitStatusTail('/repo', 'p1')
    expect(out).toBe('')
    expect(getCachedGitStatus('p1')).toBe('')
  })

  it('defensively caps stdout at 4 KB even if the IPC hands back more', async () => {
    const huge = 'x'.repeat(8000)
    stubGitStatus(async () => ({ success: true, data: { stdout: huge } }))
    const out = await fetchGitStatusTail('/repo', 'p1')
    // Capped to 4096 chars; wrapped inside <git status> tags. The wrap adds
    // a tiny bit of overhead (~30 chars), so the total is ~4096 + 30.
    expect(out.length).toBeLessThan(4200)
    expect(out.length).toBeGreaterThan(4096)
    // The cached value is the capped raw stdout
    expect(getCachedGitStatus('p1')?.length).toBe(4096)
  })

  it('skips caching but still calls the IPC when projectId is empty', async () => {
    // empty projectId = "don't cache", not "skip the IPC". The IPC still runs
    // so a turn without a project can still get a status read; the result just
    // isn't persisted to the cache for the next turn.
    stubGitStatus(async () => ({ success: true, data: { stdout: '## main' } }))
    const out = await fetchGitStatusTail('/repo', '')
    expect(out).toBe('<git status>\n## main\n</git status>')
    expect((window as any).electronAPI.gitStatus).toHaveBeenCalledTimes(1)
    // And nothing landed in the cache (no projectId = no key)
    expect(getCachedGitStatus('')).toBeUndefined()
  })
})
