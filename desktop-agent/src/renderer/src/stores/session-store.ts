import { create } from 'zustand'
import type { Session, Message } from '../agent-core/types'
import { useStatsStore } from './stats-store'
import { useProjectStore } from './project-store'
import { usePermissionStore } from './permission-store'
import { useChatStore } from './chat-store'

interface SessionState {
  sessions: Session[]
  activeSessionId: string | null
  currentMessages: Message[]
  /** Per-session message cache (lazy-loaded on switch). The source of truth a
   *  running turn reads/writes; `currentMessages` is only the display pointer at
   *  messagesBySession[activeSessionId]. Writes target a specific session's cache
   *  so a turn running in session A is untouched while the user views session B. */
  messagesBySession: Record<string, Message[]>
  isLoaded: boolean
  loadSessions: () => Promise<void>
  createSession: (title: string, modelConfigId: string) => Promise<Session>
  switchSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  deleteSessionsByProject: (projectId: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  updateSessionModel: (id: string, modelConfigId: string) => Promise<void>
  ensureActiveSessionInProject: (projectId: string) => Promise<void>
  setMessages: (msgs: Message[], sid?: string) => void
  addMessage: (msg: Message, sid?: string) => void
  updateToolMessage: (toolCallId: string, patch: Partial<Message>, sid?: string) => void
  saveCurrentMessages: (sid?: string) => Promise<void>
  persistIndex: () => Promise<void>
}

// Serialize switches by intent: clicking A then B before A's lazy load resolves
// lets B win (higher token); A's late set is dropped so it can't clobber the
// session the user actually wants to view.
let switchToken = 0

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  currentMessages: [],
  messagesBySession: {},
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
    // Pre-seed an empty cache so the new session never hits the lazy-load path.
    set((st) => ({ sessions: [s, ...st.sessions], messagesBySession: { ...st.messagesBySession, [s.id]: [] }, activeSessionId: s.id, currentMessages: [] }))
    await get().persistIndex()
    await window.electronAPI.writeSessionMessages(s.id, [])
    void usePermissionStore.getState().loadForSession(s.id)
    return s
  },

  switchSession: async (id) => {
    // Lazy-load this session's messages on first view. Switching is PURE VIEW:
    // it does NOT save the previous session — its in-memory cache is preserved,
    // and any turn running in it persists on its own completion. This is what
    // decouples switching from in-flight turns (the cross-session bug fix).
    const token = ++switchToken
    if (!get().messagesBySession[id]) {
      const res = await window.electronAPI.readSessionMessages(id)
      if (token !== switchToken) return  // a newer switch superseded this one
      set((st) => ({ messagesBySession: { ...st.messagesBySession, [id]: (res.data as Message[]) || [] } }))
    }
    if (token !== switchToken) return
    set((st) => ({ activeSessionId: id, currentMessages: st.messagesBySession[id] ?? [] }))
    void usePermissionStore.getState().loadForSession(id)
  },

  deleteSession: async (id) => {
    // If the doomed session is mid-turn, stop that turn first so it stops
    // writing to a key we're about to delete.
    if (id === useChatStore.getState().streamingSessionId) {
      useChatStore.getState().stop()
    }
    const wasActive = get().activeSessionId === id
    const deleted = get().sessions.find((s) => s.id === id)
    const projectOfDeleted = deleted?.projectId
    await window.electronAPI.deleteSessionMessages(id)
    await window.electronAPI.deleteTrace(projectOfDeleted ?? '', id)
    await window.electronAPI.deleteSessionRules(id)
    await window.electronAPI.pruneStatsBySession(projectOfDeleted ?? '', id)

    const remaining = get().sessions.filter((s) => s.id !== id)
    // Drop the cache entry; move nextActive to the same project's most-recent,
    // reading from cache (lazy-loading if needed) so currentMessages reflects it.
    const sameProject = projectOfDeleted
      ? remaining.filter((s) => s.projectId === projectOfDeleted).sort((a, b) => b.updatedAt - a.updatedAt)
      : remaining
    const nextActiveId = wasActive ? (sameProject[0]?.id ?? null) : null
    const cacheWithout = { ...get().messagesBySession }
    delete cacheWithout[id]
    if (nextActiveId && !cacheWithout[nextActiveId]) {
      const res = await window.electronAPI.readSessionMessages(nextActiveId)
      cacheWithout[nextActiveId] = (res.data as Message[]) || []
    }
    set({
      sessions: remaining,
      messagesBySession: cacheWithout,
      activeSessionId: wasActive ? nextActiveId : get().activeSessionId,
      currentMessages: wasActive ? (nextActiveId ? cacheWithout[nextActiveId] ?? [] : []) : get().currentMessages
    })
    await get().persistIndex()
    await useStatsStore.getState().loadStats()
  },

  // Bulk-delete every session belonging to a project (messages + permission
  // rules + index records). Used by project deletion. trace/stats are wiped by
  // main's project:delete whole-bucket rm. Cache entries for the doomed
  // sessions are dropped.
  deleteSessionsByProject: async (projectId) => {
    const { sessions, activeSessionId } = get()
    const doomed = sessions.filter((s) => s.projectId === projectId)
    if (!doomed.length) return
    // If any doomed session is mid-turn, stop it first so the turn stops
    // writing to keys we're about to delete.
    const streaming = useChatStore.getState().streamingSessionId
    if (streaming && doomed.some((s) => s.id === streaming)) {
      useChatStore.getState().stop()
    }
    for (const s of doomed) {
      await window.electronAPI.deleteSessionMessages(s.id)
      await window.electronAPI.deleteSessionRules(s.id)
    }
    const remaining = sessions.filter((s) => s.projectId !== projectId)
    const cacheWithout = { ...get().messagesBySession }
    for (const s of doomed) delete cacheWithout[s.id]
    const activeStillValid = remaining.some((s) => s.id === activeSessionId)
    set({
      sessions: remaining,
      messagesBySession: cacheWithout,
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
  // session (or clear if it has none).
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
      set({ activeSessionId: null, currentMessages: [] })
    }
  },

  setMessages: (msgs, sid) => set((st) => {
    const target = sid ?? st.activeSessionId
    if (!target || !st.sessions.some((s) => s.id === target)) return {}
    return {
      messagesBySession: { ...st.messagesBySession, [target]: msgs },
      currentMessages: target === st.activeSessionId ? msgs : st.currentMessages
    }
  }),

  addMessage: (msg, sid) => set((st) => {
    const target = sid ?? st.activeSessionId
    if (!target || !st.sessions.some((s) => s.id === target)) return {}
    const next = [...(st.messagesBySession[target] ?? []), msg]
    return {
      messagesBySession: { ...st.messagesBySession, [target]: next },
      // Only touch the display pointer when writing to the viewed session — a
      // background turn writing its own session must not re-render the panel.
      currentMessages: target === st.activeSessionId ? next : st.currentMessages
    }
  }),

  // Update a tool message in place (matched by toolCallId) — used to transition
  // a tool-call card from 'running' to 'success'/'failed' on the SAME element.
  updateToolMessage: (toolCallId, patch, sid) => set((st) => {
    const target = sid ?? st.activeSessionId
    if (!target || !st.sessions.some((s) => s.id === target)) return {}
    const next = (st.messagesBySession[target] ?? []).map((m) =>
      m.role === 'tool' && m.toolCallId === toolCallId ? { ...m, ...patch } : m
    )
    return {
      messagesBySession: { ...st.messagesBySession, [target]: next },
      currentMessages: target === st.activeSessionId ? next : st.currentMessages
    }
  }),

  saveCurrentMessages: async (sid) => {
    const target = sid ?? get().activeSessionId
    if (!target) return
    const msgs = get().messagesBySession[target]
    if (!msgs) return                       // never-loaded session: nothing to persist
    if (!get().sessions.some((s) => s.id === target)) return  // ghost guard (deleted mid-turn)
    await window.electronAPI.writeSessionMessages(target, msgs)
    set((st) => ({
      sessions: st.sessions.map((s) => s.id === target ? { ...s, messageCount: msgs.filter((m) => m.role === 'user' || m.role === 'assistant').length, updatedAt: Date.now() } : s)
    }))
    await get().persistIndex()
  },

  persistIndex: async () => { await window.electronAPI.updateSessionIndex(get().sessions) },
}))
