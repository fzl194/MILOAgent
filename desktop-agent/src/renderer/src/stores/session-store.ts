import { create } from 'zustand'
import type { Session, Message } from '../agent-core/types'
import { useStatsStore } from './stats-store'

interface SessionState {
  sessions: Session[]
  activeSessionId: string | null
  currentMessages: Message[]
  isLoaded: boolean
  loadSessions: () => Promise<void>
  createSession: (title: string, modelConfigId: string) => Promise<Session>
  switchSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  updateSessionModel: (id: string, modelConfigId: string) => Promise<void>
  setMessages: (msgs: Message[]) => void
  addMessage: (msg: Message) => void
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
    const sessions = ((res.data as Session[]) || []).sort((a: Session, b: Session) => b.updatedAt - a.updatedAt)
    set({ sessions, isLoaded: true })
  },

  createSession: async (title, modelConfigId) => {
    const s: Session = { id: crypto.randomUUID(), title, modelConfigId, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }
    set((st) => ({ sessions: [s, ...st.sessions], activeSessionId: s.id, currentMessages: [] }))
    await get().persistIndex()
    await window.electronAPI.writeSessionMessages(s.id, [])
    return s
  },

  switchSession: async (id) => {
    const prev = get().activeSessionId
    if (prev) await get().saveCurrentMessages()
    const res = await window.electronAPI.readSessionMessages(id)
    set({ activeSessionId: id, currentMessages: (res.data as Message[]) || [] })
  },

  deleteSession: async (id) => {
    const wasActive = get().activeSessionId === id
    await window.electronAPI.deleteSessionMessages(id)
    await window.electronAPI.deleteTrace(id)
    await window.electronAPI.pruneStatsBySession(id)

    const remaining = get().sessions.filter((s) => s.id !== id)
    // When the deleted session was the active one, activeSessionId moves to the
    // next session — load THAT session's messages too. Previously this set
    // currentMessages=[], leaving activeSessionId pointing at session B while its
    // in-memory messages were empty; the next saveCurrentMessages() (switch or
    // send) then overwrote B's file with [], wiping its messages — the
    // "deleting a conversation also wipes another session's messages" bug.
    const nextActiveId = wasActive ? (remaining[0]?.id ?? null) : null
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

  renameSession: async (id, title) => {
    set((st) => ({ sessions: st.sessions.map((s) => s.id === id ? { ...s, title, updatedAt: Date.now() } : s) }))
    await get().persistIndex()
  },

  updateSessionModel: async (id, modelConfigId) => { set((st) => ({ sessions: st.sessions.map((s) => s.id === id ? { ...s, modelConfigId, updatedAt: Date.now() } : s) })); await get().persistIndex() },

  setMessages: (msgs) => set({ currentMessages: msgs }),
  addMessage: (msg) => set((st) => ({ currentMessages: [...st.currentMessages, msg] })),

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
