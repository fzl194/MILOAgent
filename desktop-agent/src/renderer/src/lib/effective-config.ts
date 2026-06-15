import type { SandboxMode, ApprovalPolicy, PermissionRule } from '../agent-core/types'
import { useConfigStore } from '../stores/config-store'
import { useProjectStore } from '../stores/project-store'
import { DEFAULT_IDENTITY_PROMPT } from './identity-prompt'

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

// Context-org (P0): the system prompt is assembled as a STABLE prefix (today:
// the default agent identity, when enabled) followed by a VOLATILE suffix
// (global base ← project prompt ← cwd note). The split is a STRUCTURAL seam for
// P1 (memory / date injection) and P2 (cache-friendly prefix) — it does NOT
// change the wire shape: buildSystemPrompt still returns ONE string, because the
// title-generation sub-request reuses this exact string (+ ALL_TOOLS) to keep
// the prefix cache aligned (commit 2428b16). When no identity is enabled the
// prefix is empty and the output is the suffix alone — byte-identical to the
// legacy single-string assembly. See
// docs/2026-06-15-desktop-agent-上下文组织管理演进.md.
export interface SystemPromptParts {
  /** Stable leading block. Today: the default identity, or '' when disabled. */
  prefix: string
  /** Volatile trailing block: user base ← project prompt ← cwd note. */
  suffix: string
}

export interface BuildSystemPromptOptions {
  base?: string
  projectPrompt?: string
  dir?: string
  /** Resolved identity text (already flag-gated by the caller). undefined/'' = off. */
  identity?: string
}

/** Produce the { prefix, suffix } split without joining. P1/P2 consume this when
 *  they need to treat the stable prefix as its own cache / memory slot. */
export function buildSystemPromptParts(opts: BuildSystemPromptOptions): SystemPromptParts {
  // Suffix — the legacy three-segment assembly, moved here verbatim so the OFF
  // path (no identity) is byte-identical to the pre-P0 behaviour.
  let suffix = (opts.base ?? '').trim()
  if (opts.projectPrompt && opts.projectPrompt.trim()) {
    suffix = suffix ? `${suffix}\n\n${opts.projectPrompt.trim()}` : opts.projectPrompt.trim()
  }
  if (opts.dir) {
    const note = `# 工作目录\n你的当前工作目录是 \`${opts.dir}\`。相对路径基于此解析，shell 命令默认在此目录下执行；请优先在此目录内工作。`
    suffix = suffix ? `${suffix}\n\n${note}` : note
  }
  return { prefix: opts.identity ?? '', suffix }
}

/** Compose the single system-prompt string sent on the wire. Empty prefix →
 *  suffix alone (OFF path, byte-identical to legacy). */
export function buildSystemPrompt(opts: BuildSystemPromptOptions): string {
  const { prefix, suffix } = buildSystemPromptParts(opts)
  if (prefix && suffix) return `${prefix}\n\n${suffix}`
  return prefix || suffix
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
    systemPrompt: buildSystemPrompt({
      base: cfg.systemPrompt,
      projectPrompt: pcfg?.systemPrompt,
      dir: projDir,
      // Single merge point resolves the identity flag; OFF → identity undefined,
      // so the DEFAULT_IDENTITY_PROMPT text never reaches the assembled prompt
      // (byte-identical to legacy).
      identity: cfg.identity?.enabled === true ? DEFAULT_IDENTITY_PROMPT : undefined
    }),
    workspaceRoot: opts?.workspaceOverride ?? projDir,
    cwd: projDir,
    projectRules: pcfg?.rules ?? []
  }
}
