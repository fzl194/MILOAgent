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

describe('decide — sandbox × policy × rules', () => {
  const ro = { sandbox: 'read-only' as const, workspaceRoot: '/repo' }
  const ww = { sandbox: 'workspace-write' as const, workspaceRoot: '/repo' }

  it('read-only only permits read_file', () => {
    expect(decide(classify('read_file', { path: '/repo/a' }, ro), 'read_file', ro, 'on-request', '/repo/a').action).toBe('auto')
    // Even a "safe" shell read is blocked under read-only.
    expect(decide(classify('run_shell', { command: 'ls' }, ro), 'run_shell', ro, 'on-request', 'ls').action).toBe('deny')
    expect(decide(classify('write_file', { path: '/repo/a', content: '' }, ro), 'write_file', ro, 'on-request', '/repo/a').action).toBe('deny')
  })

  it('write level depends on policy', () => {
    const w = classify('run_shell', { command: 'mkdir x' }, ww)
    expect(decide(w, 'run_shell', ww, 'auto', 'mkdir x').action).toBe('auto')
    expect(decide(w, 'run_shell', ww, 'on-request', 'mkdir x').action).toBe('ask')
    expect(decide(w, 'run_shell', ww, 'untrusted', 'mkdir x').action).toBe('ask')
  })

  it('dangerous always asks, even with an allow rule', () => {
    const d = classify('run_shell', { command: 'rm -rf x' }, ww)
    const ctxAllow = { ...ww, rules: [{ pattern: '^rm', action: 'allow' as const, tool: 'run_shell' }] }
    expect(decide(d, 'run_shell', ctxAllow, 'auto', 'rm -rf x').action).toBe('ask') // dangerous floor
    expect(decide(d, 'run_shell', ww, 'on-request', 'rm -rf x').action).toBe('ask')
  })

  it('network always asks', () => {
    const n = classify('run_shell', { command: 'curl http://x' }, ww)
    expect(decide(n, 'run_shell', ww, 'auto', 'curl http://x').action).toBe('ask')
  })

  it('an allow rule (session/project) auto-runs a remembered write', () => {
    const ctxRule = { ...ww, rules: [{ pattern: '^mkdir x$', action: 'allow' as const, tool: 'run_shell' }] }
    const w = classify('run_shell', { command: 'mkdir x' }, ctxRule)
    expect(decide(w, 'run_shell', ctxRule, 'on-request', 'mkdir x').action).toBe('auto')
  })

  it('deny beats allow regardless of order (true deny > allow)', () => {
    // allow listed BEFORE deny, same subject → deny must still win.
    const ctx = {
      ...ww,
      rules: [
        { pattern: '^mkdir', action: 'allow' as const, tool: 'run_shell' },
        { pattern: '^mkdir', action: 'deny' as const, tool: 'run_shell' }
      ]
    }
    const w = classify('run_shell', { command: 'mkdir x' }, ctx)
    expect(decide(w, 'run_shell', ctx, 'auto', 'mkdir x').action).toBe('deny')
  })

  it('a high-risk base command is never auto-run by an allow rule', () => {
    const ctx = { ...ww, rules: [{ pattern: '^rm', action: 'allow' as const, tool: 'run_shell' }] }
    // `rm somefile` (no -rf) classifies as write; under on-request an allow rule
    // would auto-run it, but rm is a high-risk base command so it must still ask.
    const w = classify('run_shell', { command: 'rm somefile' }, ctx)
    expect(decide(w, 'run_shell', ctx, 'on-request', 'rm somefile').action).toBe('ask')
  })

  it('a remembered write_file rule matches despite path-spelling differences', () => {
    // Rule pattern is stored normalized (as classify builds it): d:/proj/a.txt
    const ctx = {
      sandbox: 'workspace-write' as const,
      workspaceRoot: 'D:/proj',
      rules: [{ pattern: '^d:/proj/a\\.txt$', action: 'allow' as const, tool: 'write_file' }]
    }
    // Subject is the raw Windows-style path the loop forwards.
    const w = classify('write_file', { path: 'D:\\proj\\a.txt', content: '' }, ctx)
    expect(decide(w, 'write_file', ctx, 'on-request', 'D:\\proj\\a.txt').action).toBe('auto')
  })

  it('a deny rule hard-blocks (even what would otherwise be allowed)', () => {
    const ctxDeny = { ...ww, rules: [{ pattern: '^rm', action: 'deny' as const }] }
    const d = classify('run_shell', { command: 'rm -rf x' }, ctxDeny)
    expect(decide(d, 'run_shell', ctxDeny, 'auto', 'rm -rf x').action).toBe('deny')
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

describe('classify · remember-patterns (Claude-Code-style prefixes)', () => {
  const toEntries = (patterns: string[], name: string): AllowlistEntry[] =>
    patterns.map((pattern) => ({ pattern, name, scope: 'global', createdAt: 0 }))

  it('write_file falls back to its directory prefix when no cwd is set', () => {
    // WS has no cwd, so the pattern anchors on the file's own directory.
    const a = classify('write_file', { path: '/repo/sub/a.txt', content: '' }, WS)
    const entries = toEntries(a.patterns, 'write_file')
    expect(allowlistAllows(entries, 'write_file', { path: '/repo/sub/b.txt', content: '' })).toBe(true)
    expect(allowlistAllows(entries, 'write_file', { path: '/repo/sub/nested/c.txt', content: '' })).toBe(true)
    expect(allowlistAllows(entries, 'write_file', { path: '/repo/other/d.txt', content: '' })).toBe(false)
  })

  it('write_file anchors on the project root (cwd) so any subdir is covered', () => {
    // Regression for "must re-approve every subdirectory": with a project dir
    // (cwd) set, one approval must cover the whole project tree, not just the
    // file's immediate parent directory.
    const ctx = { sandbox: 'workspace-write' as const, workspaceRoot: '/proj', cwd: '/proj' }
    const a = classify('write_file', { path: '/proj/src/sub/a.txt', content: '' }, ctx)
    expect(a.patterns).toEqual(['^/proj/']) // anchored on the root, not /proj/src/sub
    const entries = toEntries(a.patterns, 'write_file')
    expect(allowlistAllows(entries, 'write_file', { path: '/proj/src/sub/b.txt', content: '' })).toBe(true)
    expect(allowlistAllows(entries, 'write_file', { path: '/proj/docs/nested/c.txt', content: '' })).toBe(true) // different top-level subdir — the bug
    expect(allowlistAllows(entries, 'write_file', { path: '/outside/d.txt', content: '' })).toBe(false) // outside project still not covered
  })

  it('run_shell remembers by base command prefix', () => {
    const m = classify('run_shell', { command: 'mkdir x' }, WS)
    const entries = toEntries(m.patterns, 'run_shell')
    expect(allowlistAllows(entries, 'run_shell', { command: 'mkdir y' })).toBe(true)
    expect(allowlistAllows(entries, 'run_shell', { command: 'mkdir -p a/b' })).toBe(true)
    expect(allowlistAllows(entries, 'run_shell', { command: 'rmdir x' })).toBe(false)
  })

  it('dangerous write_file (outside workspace) offers no remember-pattern', () => {
    expect(classify('write_file', { path: '/etc/x', content: '' }, WS).patterns).toEqual([])
  })
})
