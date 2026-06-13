import { describe, it, expect } from 'vitest'
import { classify, decide, isInsideWorkspace, allowlistAllows } from './classifier'
import type { RiskLevel, AllowlistEntry } from '../types'

const WS = { sandbox: 'workspace-write' as const, workspaceRoot: '/repo' }
const shell = (command: string) => classify('run_shell', { command }, WS)
const levelOf = (command: string): RiskLevel => shell(command).level

describe('classify · run_shell — safe reads', () => {
  it('auto-runs plain read-only commands', () => {
    expect(levelOf('ls')).toBe('safe')
    expect(levelOf('ls -la /tmp')).toBe('safe')
    expect(levelOf('pwd')).toBe('safe')
    expect(levelOf('cat file.txt')).toBe('safe')
    expect(levelOf('grep foo bar.txt')).toBe('safe')
    expect(levelOf('wc -l file')).toBe('safe')
    expect(levelOf('dir')).toBe('safe') // windows
  })
})

describe('classify · run_shell — H1 bypass regression (must NOT be safe)', () => {
  // These all start with a token that used to be whitelisted, or use redirection,
  // and must not be auto-run.
  it('rejects redirection on a "safe" command', () => {
    expect(levelOf('cat a > b')).not.toBe('safe') // overwrite via redirect
    expect(levelOf('echo hi > file')).not.toBe('safe')
    expect(levelOf('echo hi >> file')).not.toBe('safe')
  })
  it('rejects pipes / command substitution / chaining on "safe" commands', () => {
    expect(levelOf('ls | tee out')).not.toBe('safe')
    expect(levelOf('echo $(whoami)')).not.toBe('safe') // $(...)
    expect(levelOf('echo `whoami`')).not.toBe('safe') // backtick
    expect(levelOf('true && rm -rf x')).not.toBe('safe')
    expect(levelOf('ls ; rm x')).not.toBe('safe')
  })
  it('does not auto-run git / sed / awk / find just because of the first token', () => {
    expect(levelOf('git status')).not.toBe('safe')
    expect(levelOf('git log')).not.toBe('safe')
    expect(levelOf('sed s/a/b/ f')).not.toBe('safe')
    expect(levelOf('awk "{print}" f')).not.toBe('safe')
    expect(levelOf('find . -name x')).not.toBe('safe')
  })
})

describe('classify · run_shell — dangerous', () => {
  it('flags destructive operations', () => {
    expect(levelOf('rm -rf x')).toBe('dangerous')
    expect(levelOf('rm -r x')).toBe('dangerous')
    expect(levelOf('dd if=img of=/dev/sda')).toBe('dangerous')
    expect(levelOf('git push --force')).toBe('dangerous')
    expect(levelOf('git push -f origin main')).toBe('dangerous')
    expect(levelOf('git reset --hard')).toBe('dangerous')
    expect(levelOf('git clean -fdx')).toBe('dangerous')
    expect(levelOf('find . -delete')).toBe('dangerous')
    expect(levelOf("sed -i 's/a/b/' f")).toBe('dangerous')
    expect(levelOf('format C:')).toBe('dangerous')
    expect(levelOf('shutdown now')).toBe('dangerous')
    expect(levelOf('chmod -R 777 /')).toBe('dangerous')
    expect(levelOf(':(){ :|:& };:')).toBe('dangerous')
  })
  it('never offers a remember-pattern for dangerous calls', () => {
    expect(shell('rm -rf x').patterns).toEqual([])
    expect(shell('git reset --hard').patterns).toEqual([])
  })
})

describe('classify · run_shell — network', () => {
  it('flags network-reaching commands', () => {
    expect(levelOf('curl http://example.com')).toBe('network')
    expect(levelOf('npm install lodash')).toBe('network')
    expect(levelOf('git clone https://github.com/a/b')).toBe('network')
    expect(levelOf('ssh host')).toBe('network')
    expect(levelOf('pip install x')).toBe('network')
  })
})

describe('classify · run_shell — plain write (default ask)', () => {
  it('classifies benign-but-mutating commands as write', () => {
    expect(levelOf('mkdir x')).toBe('write')
    expect(levelOf('touch x')).toBe('write')
    expect(levelOf('cp a b')).toBe('write')
    expect(levelOf('mv a b')).toBe('write')
    expect(levelOf('npm run build')).toBe('write')
  })
})

describe('classify · read_file / write_file', () => {
  it('read_file is always safe', () => {
    expect(classify('read_file', { path: '/etc/passwd' }, WS).level).toBe('safe')
  })
  it('write_file inside workspace is write', () => {
    expect(classify('write_file', { path: '/repo/a.txt', content: 'x' }, WS).level).toBe('write')
  })
  it('write_file outside workspace is dangerous', () => {
    expect(classify('write_file', { path: '/etc/x', content: 'x' }, WS).level).toBe('dangerous')
  })
})

describe('isInsideWorkspace — H2 dotdot bypass regression', () => {
  it('accepts paths inside the root', () => {
    expect(isInsideWorkspace('/repo/a.txt', '/repo')).toBe(true)
    expect(isInsideWorkspace('/repo', '/repo')).toBe(true)
    expect(isInsideWorkspace('/repo/sub/b.txt', '/repo')).toBe(true)
    expect(isInsideWorkspace('D:\\repo\\a.txt', 'D:\\repo')).toBe(true)
  })
  it('rejects sibling-prefix spoofing', () => {
    expect(isInsideWorkspace('/repo-evil/x', '/repo')).toBe(false) // prefix, not child
    expect(isInsideWorkspace('/etc/passwd', '/repo')).toBe(false)
  })
  it('resolves .. so traversal cannot escape', () => {
    expect(isInsideWorkspace('/repo/../etc/passwd', '/repo')).toBe(false)
    expect(isInsideWorkspace('D:\\repo\\..\\outside.txt', 'D:\\repo')).toBe(false)
    expect(isInsideWorkspace('/repo/sub/../../outside', '/repo')).toBe(false)
  })
  it('treats absent root as unrestricted', () => {
    expect(isInsideWorkspace('/anywhere', undefined)).toBe(true)
  })
})

describe('decide — sandbox × policy × allowlist', () => {
  const ro = { sandbox: 'read-only' as const, workspaceRoot: '/repo' }
  const ww = { sandbox: 'workspace-write' as const, workspaceRoot: '/repo' }

  it('read-only only permits read_file', () => {
    expect(decide(classify('read_file', { path: '/repo/a' }, ro), 'read_file', ro, 'on-request', false).action).toBe('auto')
    // Even a "safe" shell read is blocked under read-only.
    expect(decide(classify('run_shell', { command: 'ls' }, ro), 'run_shell', ro, 'on-request', false).action).toBe('deny')
    expect(decide(classify('write_file', { path: '/repo/a', content: '' }, ro), 'write_file', ro, 'on-request', false).action).toBe('deny')
  })

  it('write level depends on policy', () => {
    const w = classify('run_shell', { command: 'mkdir x' }, ww)
    expect(decide(w, 'run_shell', ww, 'auto', false).action).toBe('auto')
    expect(decide(w, 'run_shell', ww, 'on-request', false).action).toBe('ask')
    expect(decide(w, 'run_shell', ww, 'untrusted', false).action).toBe('ask')
  })

  it('dangerous always asks, even with allowlist hit', () => {
    const d = classify('run_shell', { command: 'rm -rf x' }, ww)
    expect(decide(d, 'run_shell', ww, 'auto', true).action).toBe('ask') // allowlist ignored for dangerous
    expect(decide(d, 'run_shell', ww, 'on-request', false).action).toBe('ask')
  })

  it('network always asks', () => {
    const n = classify('run_shell', { command: 'curl http://x' }, ww)
    expect(decide(n, 'run_shell', ww, 'auto', false).action).toBe('ask')
  })

  it('allowlist auto-runs a remembered write', () => {
    const w = classify('run_shell', { command: 'mkdir x' }, ww)
    expect(decide(w, 'run_shell', ww, 'on-request', true).action).toBe('auto')
  })
})

describe('allowlistAllows', () => {
  const entries: AllowlistEntry[] = [
    { pattern: '^mkdir x$', name: 'run_shell', scope: 'global', createdAt: 0 },
    { pattern: '^/repo/a$', name: 'write_file', scope: 'session', createdAt: 0 }
  ]
  it('matches the exact remembered shell command', () => {
    expect(allowlistAllows(entries, 'run_shell', { command: 'mkdir x' })).toBe(true)
    expect(allowlistAllows(entries, 'run_shell', { command: 'mkdir y' })).toBe(false)
  })
  it('matches the exact remembered file path (normalized)', () => {
    expect(allowlistAllows(entries, 'write_file', { path: '/repo/a', content: '' })).toBe(true)
    expect(allowlistAllows(entries, 'write_file', { path: '/repo/b', content: '' })).toBe(false)
  })
  it('ignores entries scoped to a different tool name', () => {
    expect(allowlistAllows(entries, 'read_file', { path: '/repo/a' })).toBe(false)
  })
})
