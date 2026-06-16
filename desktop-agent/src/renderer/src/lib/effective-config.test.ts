import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { getEffectiveConfig, buildSystemPromptParts, buildSystemPrompt, formatToday } from './effective-config'
import { useConfigStore } from '../stores/config-store'
import { useProjectStore } from '../stores/project-store'
import { DEFAULT_IDENTITY_PROMPT } from './identity-prompt'
import { FOLD_NOTICE_TEXT as FOLD_NOTICE, OLD_TOOL_RESULT_FOLDED_PLACEHOLDER } from '../agent-core/agent/fold-notice'
import type { Project } from '../agent-core/types'

// getEffectiveConfig reads live store state, so seed the stores directly.
function seedProject(p: Partial<Project> & { id: string }): void {
  useProjectStore.setState((s) => ({
    projects: [
      ...s.projects.filter((x) => x.id !== p.id),
      { name: 'P', isDefault: false, createdAt: 0, updatedAt: 0, ...p } as Project
    ]
  }))
}

describe('getEffectiveConfig', () => {
  beforeEach(() => {
    useConfigStore.setState({
      config: { systemPrompt: '', sandbox: 'workspace-write', approvalPolicy: 'on-request' }
    })
    useProjectStore.setState({ projects: [], dirMissing: {}, activeProjectId: null })
  })

  it('uses global base when the project has no overrides', () => {
    seedProject({ id: 'p1', dirPath: '/repo' })
    const eff = getEffectiveConfig('p1')
    expect(eff.sandbox).toBe('workspace-write')
    expect(eff.approvalPolicy).toBe('on-request')
    expect(eff.cwd).toBe('/repo')
    expect(eff.workspaceRoot).toBe('/repo')
  })

  it('project overrides win over global', () => {
    seedProject({ id: 'p1', dirPath: '/repo', config: { sandbox: 'full-access', approvalPolicy: 'auto' } })
    const eff = getEffectiveConfig('p1')
    expect(eff.sandbox).toBe('full-access')
    expect(eff.approvalPolicy).toBe('auto')
  })

  it('stacks systemPrompt: global + project + cwd note', () => {
    useConfigStore.setState({
      config: { systemPrompt: 'GLOBAL', sandbox: 'workspace-write', approvalPolicy: 'on-request' }
    })
    seedProject({ id: 'p1', dirPath: '/repo', config: { systemPrompt: 'PROJECT' } })
    const eff = getEffectiveConfig('p1')
    expect(eff.systemPrompt).toContain('GLOBAL')
    expect(eff.systemPrompt).toContain('PROJECT')
    expect(eff.systemPrompt).toContain('/repo')
  })

  it('workspaceOverride wins for the boundary, but cwd stays the project dir', () => {
    seedProject({ id: 'p1', dirPath: '/repo' })
    const eff = getEffectiveConfig('p1', { workspaceOverride: '/session/root' })
    expect(eff.workspaceRoot).toBe('/session/root')
    expect(eff.cwd).toBe('/repo')
  })

  it('dirMissing makes cwd/workspaceRoot undefined and drops the cwd note', () => {
    seedProject({ id: 'p1', dirPath: '/repo' })
    useProjectStore.setState({ dirMissing: { p1: true } })
    const eff = getEffectiveConfig('p1')
    expect(eff.cwd).toBeUndefined()
    expect(eff.workspaceRoot).toBeUndefined()
    expect(eff.systemPrompt).not.toContain('/repo')
  })

  it('projectRules fall back to []', () => {
    seedProject({ id: 'p1', dirPath: '/repo' })
    expect(getEffectiveConfig('p1').projectRules).toEqual([])
  })

  it('propagates actual project rules', () => {
    seedProject({
      id: 'p1',
      dirPath: '/repo',
      config: { rules: [{ pattern: 'npm test', action: 'allow', tool: 'run_shell' }] }
    })
    const eff = getEffectiveConfig('p1')
    expect(eff.projectRules).toHaveLength(1)
    expect(eff.projectRules[0].pattern).toBe('npm test')
  })

  it('unknown projectId still resolves against global (cwd undefined)', () => {
    const eff = getEffectiveConfig('does-not-exist')
    expect(eff.sandbox).toBe('workspace-write')
    expect(eff.cwd).toBeUndefined()
  })

  it('resolves by the passed projectId (not the active one)', () => {
    useConfigStore.setState({
      config: { systemPrompt: 'GLOBAL', sandbox: 'workspace-write', approvalPolicy: 'on-request' }
    })
    seedProject({ id: 'A', dirPath: '/a', config: { sandbox: 'read-only', systemPrompt: 'A-PROMPT' } })
    useProjectStore.setState({ activeProjectId: 'A' })
    const eff = getEffectiveConfig('A')
    expect(eff.projectId).toBe('A')
    // systemPrompt order: global → project → cwd note
    expect(eff.systemPrompt.indexOf('GLOBAL')).toBeLessThan(eff.systemPrompt.indexOf('A-PROMPT'))
    expect(eff.systemPrompt.indexOf('A-PROMPT')).toBeLessThan(eff.systemPrompt.indexOf('/a'))
  })

  it('uses the passed projectId even when a DIFFERENT project is active', () => {
    seedProject({ id: 'A', dirPath: '/a', config: { sandbox: 'read-only' } })
    seedProject({ id: 'B', dirPath: '/b', config: { sandbox: 'full-access' } })
    useProjectStore.setState({ activeProjectId: 'A' })
    const eff = getEffectiveConfig('B')
    expect(eff.projectId).toBe('B')
    expect(eff.sandbox).toBe('full-access')
    expect(eff.cwd).toBe('/b')
  })
})

// ---- P1 context-org: identity (default ON) + memory + currentDate injection ----
describe('system prompt assembly (P1 context-org)', () => {
  const cwdNote = (dir: string) =>
    `# 工作目录\n你的当前工作目录是 \`${dir}\`。相对路径基于此解析，shell 命令默认在此目录下执行；请优先在此目录内工作。`

  beforeEach(() => {
    useConfigStore.setState({
      config: { systemPrompt: '', sandbox: 'workspace-write', approvalPolicy: 'on-request' }
    })
    useProjectStore.setState({ projects: [], dirMissing: {}, activeProjectId: null })
  })

  // --- buildSystemPromptParts: pure, pinned inputs (the byte-exact golden lock) ---
  it('legacy assembly (no memory/date/identity) is byte-exact', () => {
    // Pinned inputs → no Date → the true regression lock for the suffix body.
    // The fold-notice block is appended unconditionally since P3.
    expect(buildSystemPromptParts({ base: 'GLOBAL', projectPrompt: 'PROJECT', dir: '/repo' })).toEqual({
      prefix: '',
      suffix: `GLOBAL\n\nPROJECT\n\n${cwdNote('/repo')}\n\n${FOLD_NOTICE}`
    })
  })

  it('currentDate block sits at the suffix head, before base', () => {
    expect(buildSystemPromptParts({ base: 'B', currentDate: '2026-06-16' })).toEqual({
      prefix: '',
      suffix: '# 当前日期\n今天是 2026-06-16。\n\nB\n\n' + FOLD_NOTICE
    })
  })

  it('memory block precedes currentDate', () => {
    expect(
      buildSystemPromptParts({ base: 'B', memory: '# 来源：CLAUDE.md\nX', currentDate: '2026-06-16' })
    ).toEqual({
      prefix: '',
      suffix: '# 项目记忆\n# 来源：CLAUDE.md\nX\n\n# 当前日期\n今天是 2026-06-16。\n\nB\n\n' + FOLD_NOTICE
    })
  })

  it('full order: identity prefix → memory → currentDate → base → project → cwd → fold-notice', () => {
    const s = buildSystemPrompt({
      identity: 'ID',
      memory: 'MEM',
      currentDate: '2026-06-16',
      base: 'BASE',
      projectPrompt: 'PROJ',
      dir: '/d'
    })
    expect(s.indexOf('ID')).toBeLessThan(s.indexOf('项目记忆'))
    expect(s.indexOf('项目记忆')).toBeLessThan(s.indexOf('2026-06-16'))
    expect(s.indexOf('2026-06-16')).toBeLessThan(s.indexOf('BASE'))
    expect(s.indexOf('BASE')).toBeLessThan(s.indexOf('PROJ'))
    expect(s.indexOf('PROJ')).toBeLessThan(s.indexOf('/d'))
    expect(s.indexOf('/d')).toBeLessThan(s.indexOf('上下文折叠通知'))
  })

  // P3 FRC: the fold-notice block is unconditional. Empty input → the notice
  // is the entire suffix. This is intentional — the model needs to know that
  // tool results can be folded even on the very first message of a session.
  it('empty inputs → empty prefix; suffix is just the fold-notice (unconditional)', () => {
    // buildSystemPrompt stays ONE string: the title-gen sub-request reuses this
    // exact value (+ ALL_TOOLS) to keep the prefix cache aligned (commit 2428b16),
    // so the prefix/suffix split is a structural seam — never two wire messages.
    expect(buildSystemPromptParts({})).toEqual({ prefix: '', suffix: FOLD_NOTICE })
    expect(buildSystemPrompt({})).toBe(FOLD_NOTICE)
    expect(buildSystemPrompt({ identity: 'ID', base: 'B' })).toBe('ID\n\nB\n\n' + FOLD_NOTICE)
    expect(buildSystemPrompt({ identity: 'ID' })).toBe('ID\n\n' + FOLD_NOTICE)
  })

  // P3 FRC: the notice text references the placeholder verbatim — a rename
  // in fold-notice.ts would silently break the model's ability to recognize
  // the placeholder. This test guards against that drift.
  it('fold-notice text references the placeholder string (no drift allowed)', () => {
    expect(FOLD_NOTICE).toContain(OLD_TOOL_RESULT_FOLDED_PLACEHOLDER)
    const out = buildSystemPrompt({ base: 'X' })
    expect(out).toContain(OLD_TOOL_RESULT_FOLDED_PLACEHOLDER)
  })

  it('formatToday formats a Date as local YYYY-MM-DD', () => {
    expect(formatToday(new Date(2026, 5, 16))).toBe('2026-06-16') // month is 0-based
    expect(formatToday(new Date(2026, 0, 9))).toBe('2026-01-09')
  })

  // --- getEffectiveConfig: store + real Date (fake-timer pinned) ---
  describe('getEffectiveConfig integration', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 5, 16, 12, 0, 0))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('currentDate is always injected, even with identity off', () => {
      useConfigStore.setState({
        config: { systemPrompt: 'GLOBAL', sandbox: 'workspace-write', approvalPolicy: 'on-request' }
      })
      seedProject({ id: 'p1', dirPath: '/repo' })
      expect(getEffectiveConfig('p1').systemPrompt).toContain('# 当前日期\n今天是 2026-06-16。')
    })

    it('identity ON + memory + currentDate + base/project/cwd in order', () => {
      useConfigStore.setState({
        config: {
          systemPrompt: 'GLOBAL',
          sandbox: 'workspace-write',
          approvalPolicy: 'on-request',
          identity: { enabled: true }
        }
      })
      seedProject({ id: 'p1', dirPath: '/repo', config: { systemPrompt: 'PROJECT' } })
      const s = getEffectiveConfig('p1', { memory: 'CLAUDE_MEM' }).systemPrompt
      expect(s.startsWith(DEFAULT_IDENTITY_PROMPT)).toBe(true)
      // identity(prefix) → memory → currentDate → base → project → cwd
      expect(s.indexOf('# 项目记忆')).toBeLessThan(s.indexOf('2026-06-16'))
      expect(s.indexOf('2026-06-16')).toBeLessThan(s.indexOf('GLOBAL'))
      expect(s.indexOf('GLOBAL')).toBeLessThan(s.indexOf('PROJECT'))
      expect(s.indexOf('PROJECT')).toBeLessThan(s.indexOf('/repo'))
      // identity appears exactly once.
      const first = s.indexOf(DEFAULT_IDENTITY_PROMPT)
      expect(s.indexOf(DEFAULT_IDENTITY_PROMPT, first + 1)).toBe(-1)
    })
  })
})
