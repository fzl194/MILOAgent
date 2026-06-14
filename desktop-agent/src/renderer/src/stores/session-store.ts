import { create } from 'zustand'
import type { Session, Message } from '../agent-core/types'
import { useStatsStore } from './stats-store'
import { useProjectStore } from './project-store'
import { usePermissionStore } from './permission-store'

interface SessionState {
  sessions: Session[]
  activeSessionId: string | null
  currentMessages: Message[]
  isLoaded: boolean
  loadSessions: () => Promise<void>
  createSession: (title: string, modelConfigId: string) => Promise<Session>
  switchSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  deleteSessionsByProject: (projectId: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  updateSessionModel: (id: string, modelConfigId: string) => Promise<void>
  ensureActiveSessionInProject: (projectId: string) => Promise<void>
  setMessages: (msgs: Message[]) => void
  addMessage: (msg: Message) => void
  updateToolMessage: (toolCallId: string, patch: Partial<Message>) => void
  saveCurrentMessages: () => Promise<void>
  persistIndex: () => Promise<void>
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  currentMessages: [],
  isLoaded: false,

  loadSessions: async () => {
    const res = await window.electronAPI.listSessions()
    const ps = useProjectStore.getState()
    const defaultProjectId = ps.getDefault()?.id ?? ps.projects[0]?.id ?? ''
    let changed = false
    const sessions = ((res.data as Session[]) || [])
      .map((s) => {
        // Legacy sessions (pre-project) without a projectId are adopted by the
        // default project so they don't vanish from the sidebar.
        if (!s.projectId) { changed = true; return { ...s, projectId: defaultProjectId } }
        return s
      })
      .sort((a: Session, b: Session) => b.updatedAt - a.updatedAt)
    set({ sessions, isLoaded: true })
    if (changed) await get().persistIndex()
  },

  createSession: async (title, modelConfigId) => {
    // New sessions belong to the active project (default if none selected).
    // If the project store isn't loaded yet (UI race), load it first.
    const ps = useProjectStore.getState()
    let projectId = ps.activeProjectId ?? ps.getDefault()?.id
    if (!projectId) {
      await ps.load()
      projectId = useProjectStore.getState().activeProjectId ?? useProjectStore.getState().getDefault()?.id
    }
    if (!projectId) throw new Error('No active project to create the session in')
    const s: Session = { id: crypto.randomUUID(), title, modelConfigId, projectId, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }
    set((st) => ({ sessions: [s, ...st.sessions], activeSessionId: s.id, currentMessages: [] }))
    await get().persistIndex()
    await window.electronAPI.writeSessionMessages(s.id, [])
    void usePermissionStore.getState().loadForSession(s.id)
    return s
  },

  switchSession: async (id) => {
    const prev = get().activeSessionId
    if (prev) await get().saveCurrentMessages()
    const res = await window.electronAPI.readSessionMessages(id)
    set({ activeSessionId: id, currentMessages: (res.data as Message[]) || [] })
    void usePermissionStore.getState().loadForSession(id)
  },

  deleteSession: async (id) => {
    const wasActive = get().activeSessionId === id
    const deleted = get().sessions.find((s) => s.id === id)
    const projectOfDeleted = deleted?.projectId
    await window.electronAPI.deleteSessionMessages(id)
    await window.electronAPI.deleteTrace(projectOfDeleted ?? '', id)
    await window.electronAPI.deleteSessionRules(id)
    await window.electronAPI.pruneStatsBySession(projectOfDeleted ?? '', id)

    const remaining = get().sessions.filter((s) => s.id !== id)
    // When the deleted session was active, move to the next session IN THE SAME
    // project (most recent), so the chat panel never jumps to another project.
    const sameProject = projectOfDeleted
      ? remaining.filter((s) => s.projectId === projectOfDeleted).sort((a, b) => b.updatedAt - a.updatedAt)
      : remaining
    const nextActiveId = wasActive ? (sameProject[0]?.id ?? null) : null
    const nextMessages: Message[] = nextActiveId
      ? ((await window.electronAPI.readSessionMessages(nextActiveId)).data as Message[]) || []
      : []

    set({
      sessions: remaining,
      activeSessionId: wasActive ? nextActiveId : get().activeSessionId,
      currentMessages: wasActive ? nextMessages : get().currentMessages
    })
    await get().persistIndex()
    await useStatsStore.getState().loadStats()
  },

  // Bulk-delete every session belonging to a project (messages + permission
  // rules + index records). Used by project deletion so a project's sessions
  // don't become invisible orphans. trace/stats are NOT touched here — main's
  // project:delete wipes the whole projects/<pid>/ bucket (all traces + stats)
  // as a single recursive rm. If the active session belonged to the doomed
  // project it is cleared here; the caller re-aligns it via
  // ensureActiveSessionInProject after switching the active project.
  deleteSessionsByProject: async (projectId) => {
    const { sessions, activeSessionId } = get()
    const doomed = sessions.filter((s) => s.projectId === projectId)
    if (!doomed.length) return
    for (const s of doomed) {
      await window.electronAPI.deleteSessionMessages(s.id)
      await window.electronAPI.deleteSessionRules(s.id)
    }
    const remaining = sessions.filter((s) => s.projectId !== projectId)
    const activeStillValid = remaining.some((s) => s.id === activeSessionId)
    set({
      sessions: remaining,
      activeSessionId: activeStillValid ? activeSessionId : null,
      currentMessages: activeStillValid ? get().currentMessages : []
    })
    await get().persistIndex()
  },

  renameSession: async (id, title) => {
    set((st) => ({ sessions: st.sessions.map((s) => s.id === id ? { ...s, title, updatedAt: Date.now() } : s) }))
    await get().persistIndex()
  },

  updateSessionModel: async (id, modelConfigId) => { set((st) => ({ sessions: st.sessions.map((s) => s.id === id ? { ...s, modelConfigId, updatedAt: Date.now() } : s) })); await get().persistIndex() },

  // Called when the active PROJECT changes: if the currently-active session
  // doesn't belong to the new project, drop into the project's most-recent
  // session (or clear if it has none). Prevents the chat panel from showing a
  // session that isn't in the sidebar's selected project.
  ensureActiveSessionInProject: async (projectId) => {
    const { activeSessionId, sessions } = get()
    const belongs = sessions.some((s) => s.id === activeSessionId && s.projectId === projectId)
    if (belongs) return
    const latest = sessions
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (latest) {
      await get().switchSession(latest.id)
    } else {
      await get().saveCurrentMessages()
      set({ activeSessionId: null, currentMessages: [] })
    }
  },

  setMessages: (msgs) => set({ currentMessages: msgs }),
  addMessage: (msg) => set((st) => ({ currentMessages: [...st.currentMessages, msg] })),
  // Update a tool message in place (matched by toolCallId) — used to transition
  // a tool-call card from 'running' to 'success'/'failed' on the SAME element
  // rather than removing+re-adding it.
  updateToolMessage: (toolCallId, patch) =>
    set((st) => ({
      currentMessages: st.currentMessages.map((m) =>
        m.role === 'tool' && m.toolCallId === toolCallId ? { ...m, ...patch } : m
      )
    })),

  saveCurrentMessages: async () => {
    const { activeSessionId, currentMessages } = get()
    if (!activeSessionId) return
    await window.electronAPI.writeSessionMessages(activeSessionId, currentMessages)
    set((st) => ({
      sessions: st.sessions.map((s) => s.id === activeSessionId ? { ...s, messageCount: currentMessages.filter((m) => m.role === 'user' || m.role === 'assistant').length, updatedAt: Date.now() } : s)
    }))
    await get().persistIndex()
  },

  persistIndex: async () => { await window.electronAPI.updateSessionIndex(get().sessions) },
}))
