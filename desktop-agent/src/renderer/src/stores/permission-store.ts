import { create } from 'zustand'
import type { PermissionRule } from '../agent-core/types'

// Unified, layered permission rules. Session-scope rules live here and are
// PERSISTED per session (sessions/<sid>.rules.json); project-scope rules live
// on the Project record. `merged()` returns [session, ...project] so decide()
// evaluates session-first (deny > ask > allow, first match). This replaces the
// old split between the in-memory/global allowlist and per-project commandRules.
interface PermissionState {
  activeSessionId: string | null
  sessionRules: PermissionRule[]
  loadForSession: (sid: string) => Promise<void>
  clearForSession: () => void
  addSessionRules: (rules: PermissionRule[]) => Promise<void>
  /** Merge session + project rules (session first) for the active session. */
  merged: (projectRules?: PermissionRule[]) => PermissionRule[]
}

// Serialize session-rules persistence so concurrent "remember" approvals don't
// lose rules via last-write-wins.
let sessionRulesWriteChain: Promise<void> = Promise.resolve()

export const usePermissionStore = create<PermissionState>((set, get) => ({
  activeSessionId: null,
  sessionRules: [],

  loadForSession: async (sid) => {
    const prev = get().activeSessionId
    if (prev === sid) return
    const res = await window.electronAPI.readSessionRules(sid)
    // Concurrency guard: a rapid A→B session switch can let A's IPC resolve
    // after B's, overwriting B's rules with A's. If the active session changed
    // to something other than what we're loading, this result is stale — bail.
    const nowActive = get().activeSessionId
    if (nowActive !== prev && nowActive !== sid) return
    set({ activeSessionId: sid, sessionRules: (res.data as PermissionRule[]) || [] })
  },

  clearForSession: () => set({ activeSessionId: null, sessionRules: [] }),

  addSessionRules: (rules) => {
    // Serialize read-modify-write so concurrent "remember" approvals can't lose
    // rules via last-write-wins.
    const run = sessionRulesWriteChain.then(async () => {
      const sid = get().activeSessionId
      if (!sid) return
      const existing = get().sessionRules
      const deduped = rules.filter(
        (r) => !existing.some((e) => e.pattern === r.pattern && e.action === r.action && e.tool === r.tool)
      )
      if (!deduped.length) return
      const next = [...existing, ...deduped]
      set({ sessionRules: next })
      await window.electronAPI.writeSessionRules(sid, next)
    })
    sessionRulesWriteChain = run.then(() => undefined, () => undefined)
    return run
  },

  merged: (projectRules) => [...get().sessionRules, ...(projectRules ?? [])]
}))
