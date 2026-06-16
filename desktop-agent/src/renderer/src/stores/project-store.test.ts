import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadProjectClaudeMd } from './project-store'

// loadProjectClaudeMd reads project-root memory files via window.electronAPI.
// It is best-effort: every failure (missing file, >2MB truncation, IPC error)
// must be swallowed → '' so a memory read can NEVER abort a turn.
type ReadResult = { success?: boolean; data?: string; truncated?: boolean; bytes?: number }

function stubReadFile(map: Record<string, ReadResult | Error>): void {
  ;(globalThis as { window?: unknown }).window = {
    electronAPI: {
      readFile: vi.fn(async (p: string) => {
        const v = map[p]
        if (v instanceof Error) throw v
        return v ?? { success: false }
      })
    }
  }
}

describe('loadProjectClaudeMd', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('null/empty dirPath → empty string (no IPC)', async () => {
    expect(await loadProjectClaudeMd(null)).toBe('')
    expect(await loadProjectClaudeMd('')).toBe('')
    expect(await loadProjectClaudeMd(undefined)).toBe('')
  })

  it('concatenates all found candidates, each with a 来源 header, --- separated', async () => {
    stubReadFile({
      '/proj/CLAUDE.md': { success: true, data: '根指令' },
      '/proj/AGENTS.md': { success: true, data: 'agent 指令' },
      '/proj/.claude/CLAUDE.md': { success: true, data: '项目级指令' }
    })
    const out = await loadProjectClaudeMd('/proj')
    expect(out).toContain('# 来源：CLAUDE.md\n根指令')
    expect(out).toContain('# 来源：AGENTS.md\nagent 指令')
    expect(out).toContain('# 来源：.claude/CLAUDE.md\n项目级指令')
    expect(out.includes('\n\n---\n\n')).toBe(true)
  })

  it('only-existing file → just that segment, no empty slots', async () => {
    stubReadFile({ '/p/AGENTS.md': { success: true, data: 'only' } })
    const out = await loadProjectClaudeMd('/p')
    expect(out).toBe('# 来源：AGENTS.md\nonly')
    expect(out).not.toContain('CLAUDE.md')
  })

  it('truncated (>2MB) file → hint string, not silent drop', async () => {
    stubReadFile({ '/p/CLAUDE.md': { success: false, truncated: true, bytes: 3_000_000 } })
    const out = await loadProjectClaudeMd('/p')
    expect(out).toContain('过大')
    expect(out).toContain('3')
    expect(out).toContain('read_file')
  })

  it('readFile throws → swallowed, returns empty string (never aborts a turn)', async () => {
    stubReadFile({ '/p/CLAUDE.md': new Error('IPC boom') })
    expect(await loadProjectClaudeMd('/p')).toBe('')
  })

  it('no candidates found → empty string', async () => {
    stubReadFile({})
    expect(await loadProjectClaudeMd('/p')).toBe('')
  })

  it('strips a trailing slash before joining the candidate path', async () => {
    const calls: string[] = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        readFile: vi.fn(async (p: string) => {
          calls.push(p)
          return { success: false }
        })
      }
    }
    await loadProjectClaudeMd('/proj/')
    // No double slash; trailing slash stripped.
    expect(calls).toContain('/proj/CLAUDE.md')
    expect(calls.some((c) => c.includes('//'))).toBe(false)
  })
})
