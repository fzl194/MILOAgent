import { describe, it, expect, beforeEach } from 'vitest'
import { getEffectiveConfig } from './effective-config'
import { useConfigStore } from '../stores/config-store'
import { useProjectStore } from '../stores/project-store'
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
