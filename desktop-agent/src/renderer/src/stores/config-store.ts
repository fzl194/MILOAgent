import { create } from 'zustand'
import type { AgentConfig, SandboxMode, ApprovalPolicy } from '../agent-core/types'

// Central source of truth for the persisted AgentConfig (system prompt, agent
// limits, and the safety controls: sandbox mode / approval policy / workspace
// root). Both the Settings panel and the chat top-bar badge read from here, so a
// save is immediately reflected everywhere — chat-store also reads fresh values
// from here each turn instead of re-fetching over IPC.
const DEFAULT_CONFIG: AgentConfig = {
  systemPrompt: '',
  // Personal default leans safe: writes and dangerous actions both ask first.
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request',
  workspaceRoot: undefined
}

const SANDBOX_VALUES = new Set(['read-only', 'workspace-write', 'full-access'])
const POLICY_VALUES = new Set(['auto', 'on-request', 'untrusted'])

function mergeConfig(c: Record<string, any> | null | undefined): AgentConfig {
  if (!c) return { ...DEFAULT_CONFIG }
  return {
    systemPrompt: typeof c.systemPrompt === 'string' ? c.systemPrompt : DEFAULT_CONFIG.systemPrompt,
    // Validate enums — a corrupted config.json must not let an unknown sandbox
    // mode reach the runtime safety logic.
    sandbox:
      typeof c.sandbox === 'string' && SANDBOX_VALUES.has(c.sandbox)
        ? (c.sandbox as SandboxMode)
        : DEFAULT_CONFIG.sandbox,
    approvalPolicy:
      typeof c.approvalPolicy === 'string' && POLICY_VALUES.has(c.approvalPolicy)
        ? (c.approvalPolicy as ApprovalPolicy)
        : DEFAULT_CONFIG.approvalPolicy,
    workspaceRoot: typeof c.workspaceRoot === 'string' ? c.workspaceRoot : undefined
  }
}

interface ConfigState {
  config: AgentConfig
  isLoaded: boolean
  load: () => Promise<void>
  /** Apply a patch in-memory AND persist to disk (single source of truth). */
  save: (patch: Partial<AgentConfig>) => Promise<void>
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: { ...DEFAULT_CONFIG },
  isLoaded: false,

  load: async () => {
    const res = await window.electronAPI.readConfig()
    const merged = mergeConfig(res.data)
    set({ config: merged, isLoaded: true })
    // Self-heal the on-disk config: older writes (and pre-fix clearAll) left a
    // partial file (e.g. only { systemPrompt }). Persist the complete AgentConfig
    // so the FILE — not just code defaults — actually holds sandbox/policy/etc.
    const raw = res.data as Record<string, unknown> | null
    if (!raw || JSON.stringify(merged) !== JSON.stringify(raw)) {
      try {
        await window.electronAPI.writeConfig(merged)
      } catch {
        /* in-memory config is still correct even if the heal write fails */
      }
    }
  },

  save: async (patch) => {
    const next = { ...get().config, ...patch }
    set({ config: next })
    await window.electronAPI.writeConfig(next)
  }
}))
