import { describe, expect, it } from 'vitest'

import { enforceWorkspacePath } from './fs-guard'

// P2 #1: 主进程 fs:writeFile 工作区护栏(对称 P1 read 修复)。
// 纯函数 `enforceWorkspacePath` 是 IPC handler 的安全核心,先单测所有
// 边界,再接进 main/index.ts。

describe('enforceWorkspacePath — P2 write defense (mirrors read)', () => {
  it('allows ANY path when sandbox is full-access (user opted in)', () => {
    expect(enforceWorkspacePath('C:/anywhere/x.txt', 'full-access', 'C:/ws').allowed).toBe(true)
    expect(enforceWorkspacePath('/etc/passwd', 'full-access', '/repo').allowed).toBe(true)
  })

  it('allows a path strictly inside the workspace root (workspace-write)', () => {
    expect(enforceWorkspacePath('C:/ws/sub/x.txt', 'workspace-write', 'C:/ws').allowed).toBe(true)
    expect(enforceWorkspacePath('C:/ws/x', 'workspace-write', 'C:/ws').allowed).toBe(true) // exact root
  })

  it('refuses a path OUTSIDE the workspace root (workspace-write) — the write CRITICAL', () => {
    const r = enforceWorkspacePath('C:/other/x.txt', 'workspace-write', 'C:/ws')
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('工作区')
  })

  it('refuses a sibling-prefix spoofing (workspace-write): C:/ws-evil is NOT under C:/ws', () => {
    expect(enforceWorkspacePath('C:/ws-evil/x', 'workspace-write', 'C:/ws').allowed).toBe(false)
    expect(enforceWorkspacePath('C:/wsthing', 'workspace-write', 'C:/ws').allowed).toBe(false)
  })

  it('refuses path-traversal escape (workspace-write): .. cannot prefix-spoof', () => {
    expect(enforceWorkspacePath('C:/ws/../other/x', 'workspace-write', 'C:/ws').allowed).toBe(false)
    expect(enforceWorkspacePath('C:/ws/sub/../../outside', 'workspace-write', 'C:/ws').allowed).toBe(false)
  })

  it('refuses path outside workspace under read-only sandbox (workspace boundary is sandbox-agnostic)', () => {
    expect(enforceWorkspacePath('C:/other/x', 'read-only', 'C:/ws').allowed).toBe(false)
  })

  it('allows path inside workspace under read-only (the guard is workspace-only; read-only is a separate classifier/safety concern)', () => {
    expect(enforceWorkspacePath('C:/ws/x', 'read-only', 'C:/ws').allowed).toBe(true)
  })
})
