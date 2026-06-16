import { create } from 'zustand'
import type { AgentConfig, SandboxMode, ApprovalPolicy } from '../agent-core/types'

// Central source of truth for the persisted AgentConfig (system prompt, agent
// limits, and the safety controls: sandbox mode / approval policy / workspace
// root). Both the Settings panel and the chat top-bar badge read from here, so a
// save is immediately reflected everywhere — chat-store also reads fresh values
// from here each turn instead of re-fetching over IPC.

// Bumped on any persisted-schema change. Legacy (pre-P1) disks carry no version
// → mergeConfig treats them as such for one-time migrations (see AgentConfig.configVersion).
const CURRENT_CONFIG_VERSION = 2

const DEFAULT_CONFIG: AgentConfig = {
  systemPrompt: '',
  // Personal default leans safe: writes and dangerous actions both ask first.
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request',
  // P1 harness rollout: off by default so behavior is unchanged until toggled.
  toolHarness: { enabled: false },
  // P1 context-org: default agent identity ON — the model now gets a role /
  // tool-use / safety preamble by default. Legacy (pre-configVersion) disks are
  // migrated to this default once; a user who later disables it stays disabled.
  identity: { enabled: true },
  configVersion: CURRENT_CONFIG_VERSION
}

const SANDBOX_VALUES = new Set(['read-only', 'workspace-write', 'full-access'])
const POLICY_VALUES = new Set(['auto', 'on-request', 'untrusted'])

export function mergeConfig(c: Record<string, any> | null | undefined): AgentConfig {
  if (!c) return { ...DEFAULT_CONFIG }
  // Legacy (pre-configVersion) disks were self-healed by P0 with identity OFF.
  // P1 flips the default ON, so a versionless disk is treated as "identity never
  // explicitly set" → apply the new default. A versioned disk honors the stored
  // value (so disabling identity later stays disabled across reloads).
  const legacyDisk = typeof c.configVersion !== 'number'
  const identityDefault = DEFAULT_CONFIG.identity?.enabled ?? false
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
    toolHarness: {
      enabled:
        typeof c.toolHarness?.enabled === 'boolean'
          ? c.toolHarness.enabled
          : (DEFAULT_CONFIG.toolHarness?.enabled ?? false)
    },
    identity: {
      enabled: legacyDisk
        ? identityDefault
        : typeof c.identity?.enabled === 'boolean'
          ? c.identity.enabled
          : identityDefault
    },
    configVersion: CURRENT_CONFIG_VERSION
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
