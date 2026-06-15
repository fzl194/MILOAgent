import { describe, it, expect, beforeEach } from 'vitest'
import { getEffectiveConfig, buildSystemPromptParts, buildSystemPrompt } from './effective-config'
import { useConfigStore } from '../stores/config-store'
import { useProjectStore } from '../stores/project-store'
import { DEFAULT_IDENTITY_PROMPT } from './identity-prompt'
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

// ---- P0 context-org: default identity + structural prefix/suffix seam ----
describe('system prompt assembly (P0 context-org)', () => {
  // Re-derive the exact cwd-note the assembly emits, so the golden lock below
  // fails on ANY byte drift in the OFF path (the behaviour-preservation guard).
  const cwdNote = (dir: string) =>
    `# 工作目录\n你的当前工作目录是 \`${dir}\`。相对路径基于此解析，shell 命令默认在此目录下执行；请优先在此目录内工作。`

  beforeEach(() => {
    useConfigStore.setState({
      config: { systemPrompt: '', sandbox: 'workspace-write', approvalPolicy: 'on-request' }
    })
    useProjectStore.setState({ projects: [], dirMissing: {}, activeProjectId: null })
  })

  it('OFF path is byte-identical to the legacy three-segment assembly (golden lock)', () => {
    useConfigStore.setState({
      config: { systemPrompt: 'GLOBAL', sandbox: 'workspace-write', approvalPolicy: 'on-request' }
    })
    seedProject({ id: 'p1', dirPath: '/repo', config: { systemPrompt: 'PROJECT' } })
    const expected = `GLOBAL\n\nPROJECT\n\n${cwdNote('/repo')}`
    expect(getEffectiveConfig('p1').systemPrompt).toBe(expected)
  })

  it('OFF path with nothing to say yields an empty string', () => {
    // Unknown projectId → cwd undefined, no project prompt, empty global base.
    expect(getEffectiveConfig('does-not-exist').systemPrompt).toBe('')
  })

  it('explicit identity:{enabled:false} is byte-identical to no identity key', () => {
    seedProject({ id: 'p1', dirPath: '/repo', config: { systemPrompt: 'PROJECT' } })
    useConfigStore.setState({
      config: { systemPrompt: 'GLOBAL', sandbox: 'workspace-write', approvalPolicy: 'on-request' }
    })
    const withoutKey = getEffectiveConfig('p1').systemPrompt
    useConfigStore.setState({
      config: {
        systemPrompt: 'GLOBAL',
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        identity: { enabled: false }
      }
    })
    expect(getEffectiveConfig('p1').systemPrompt).toBe(withoutKey)
  })

  it('identity ON prepends the default identity exactly once, before base/project/cwd', () => {
    useConfigStore.setState({
      config: {
        systemPrompt: 'GLOBAL',
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        identity: { enabled: true }
      }
    })
    seedProject({ id: 'p1', dirPath: '/repo', config: { systemPrompt: 'PROJECT' } })
    const s = getEffectiveConfig('p1').systemPrompt
    // Full default identity leads...
    expect(s.startsWith(DEFAULT_IDENTITY_PROMPT)).toBe(true)
    // ...before the legacy segments, in order.
    expect(s.indexOf('GLOBAL')).toBeLessThan(s.indexOf('PROJECT'))
    expect(s.indexOf('PROJECT')).toBeLessThan(s.indexOf('/repo'))
    // ...and appears exactly once (no duplication).
    const first = s.indexOf(DEFAULT_IDENTITY_PROMPT)
    expect(s.indexOf(DEFAULT_IDENTITY_PROMPT, first + 1)).toBe(-1)
  })

  it('buildSystemPromptParts exposes the prefix/suffix seam; OFF → empty prefix', () => {
    expect(buildSystemPromptParts({ base: 'B' })).toEqual({ prefix: '', suffix: 'B' })
    expect(buildSystemPromptParts({ base: 'B', identity: 'ID' })).toEqual({ prefix: 'ID', suffix: 'B' })
    // buildSystemPrompt stays a SINGLE string: the title-gen sub-request reuses
    // this exact value to keep the prefix cache aligned (commit 2428b16), so the
    // prefix/suffix split is a structural seam — never two wire messages.
    expect(buildSystemPrompt({ base: 'B', identity: 'ID' })).toBe('ID\n\nB')
    expect(buildSystemPrompt({ base: 'B' })).toBe('B')
    expect(buildSystemPrompt({ identity: 'ID' })).toBe('ID')
    expect(buildSystemPrompt({})).toBe('')
  })
})
