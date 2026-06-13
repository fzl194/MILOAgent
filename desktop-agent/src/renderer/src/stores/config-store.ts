import { create } from 'zustand'
import type { AgentConfig, SandboxMode, ApprovalPolicy } from '../agent-core/types'

// Central source of truth for the persisted AgentConfig (system prompt, agent
// limits, and the safety controls: sandbox mode / approval policy / workspace
// root). Both the Settings panel and the chat top-bar badge read from here, so a
// save is immediately reflected everywhere — chat-store also reads fresh values
// from here each turn instead of re-fetching over IPC.
const DEFAULT_CONFIG: AgentConfig = {
  maxToolRounds: 5,
  maxContextMessages: 20,
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
    maxToolRounds: typeof c.maxToolRounds === 'number' ? c.maxToolRounds : DEFAULT_CONFIG.maxToolRounds,
    maxContextMessages:
      typeof c.maxContextMessages === 'number' ? c.maxContextMessages : DEFAULT_CONFIG.maxContextMessages,
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
    set({ config: mergeConfig(res.data), isLoaded: true })
  },

  save: async (patch) => {
    const next = { ...get().config, ...patch }
    set({ config: next })
    await window.electronAPI.writeConfig(next)
  }
}))
