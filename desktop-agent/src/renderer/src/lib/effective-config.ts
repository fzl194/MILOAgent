import type { SandboxMode, ApprovalPolicy, PermissionRule } from '../agent-core/types'
import { useConfigStore } from '../stores/config-store'
import { useProjectStore } from '../stores/project-store'

// The fully-resolved effective config for one turn: global base ← project
// overrides ← cwd. Centralized here so chat-store's turnConfig and buildSafety
// share a SINGLE merge (instead of each reading cfg + pcfg and re-deriving
// `pcfg ?? cfg`), and so the effective view can be computed for ANY project
// (by id) rather than being hard-wired to the active one.
export interface EffectiveConfig {
  /** The project id this effective config was resolved for. */
  projectId: string
  sandbox: SandboxMode
  approvalPolicy: ApprovalPolicy
  systemPrompt: string
  /** Workspace root for the safety boundary. A session override wins, else the project dir. */
  workspaceRoot: string | undefined
  /** The turn's cwd (the project dir, when bound and present). */
  cwd: string | undefined
  /** Project-scope permission rules. Session rules are layered on by the caller (permissionStore.merged). */
  projectRules: PermissionRule[]
}

export interface EffectiveConfigOptions {
  /** Override the workspace root (e.g. a session-level root). Falls back to the project dir. */
  workspaceOverride?: string
}

// Compose the effective system prompt: global base ← project prompt ← cwd note.
function buildSystemPrompt(base: string, projectPrompt: string | undefined, dir?: string): string {
  let s = base.trim()
  if (projectPrompt && projectPrompt.trim()) {
    s = s ? `${s}\n\n${projectPrompt.trim()}` : projectPrompt.trim()
  }
  if (!dir) return s
  const note = `# 工作目录\n你的当前工作目录是 \`${dir}\`。相对路径基于此解析，shell 命令默认在此目录下执行；请优先在此目录内工作。`
  return s ? `${s}\n\n${note}` : note
}

// Derive the effective config for a project (by id). Pure read from the config +
// project stores; no side effects. `workspaceOverride` (a session root) wins over
// the project dir for the safety boundary, but cwd is always the project dir.
export function getEffectiveConfig(projectId: string, opts?: EffectiveConfigOptions): EffectiveConfig {
  const cfg = useConfigStore.getState().config
  const ps = useProjectStore.getState()
  const proj = ps.projects.find((p) => p.id === projectId)
  const pcfg = proj?.config
  const projDir = proj?.dirPath && !ps.dirMissing[proj.id] ? proj.dirPath : undefined
  return {
    projectId,
    sandbox: pcfg?.sandbox ?? cfg.sandbox,
    approvalPolicy: pcfg?.approvalPolicy ?? cfg.approvalPolicy,
    systemPrompt: buildSystemPrompt(cfg.systemPrompt, pcfg?.systemPrompt, projDir),
    workspaceRoot: opts?.workspaceOverride ?? projDir,
    cwd: projDir,
    projectRules: pcfg?.rules ?? []
  }
}
