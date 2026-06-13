import { create } from 'zustand'
import type { Project } from '../agent-core/types'

// Project-level management. A Project is a named record pointing at a working
// directory (dirPath); the directory path is the project's logical identity
// (Codex/Claude "project = cwd"). Exactly one project is the Default
// (dirPath=null) so users can chat without creating a project.
//
// P1 scope: model + CRUD + active selection + default seeding. Project-scoped
// storage layout, config overrides, and new-project flows land in later phases.
interface ProjectState {
  projects: Project[]
  activeProjectId: string | null
  isLoaded: boolean
  load: () => Promise<void>
  setActive: (id: string) => void
  create: (name: string, dirPath: string | null) => Promise<Project>
  rename: (id: string, name: string) => Promise<void>
  remove: (id: string) => Promise<void>
  getDefault: () => Project | undefined
  getActive: () => Project | undefined
  persist: () => Promise<void>
}

function makeDefault(): Project {
  const now = Date.now()
  return { id: crypto.randomUUID(), name: '默认项目', dirPath: null, isDefault: true, createdAt: now, updatedAt: now }
}

// Enforce exactly-one-default invariant (mirrors main's canonicalizeProjects).
function canonicalize(list: Project[]): Project[] {
  let sawDefault = false
  const out = list.map((p) => {
    const isDefault = p.isDefault && !sawDefault ? ((sawDefault = true), true) : false
    return { ...p, isDefault }
  })
  if (!sawDefault && out.length) out[0].isDefault = true
  if (!out.length) out.push(makeDefault())
  return out
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  isLoaded: false,

  load: async () => {
    const res = await window.electronAPI.listProjects()
    let projects = canonicalize((res.data as Project[]) || [])
    // Persist the canonicalized form if main's array was malformed (0/multi default).
    const rawCount = (res.data as Project[] | null)?.length ?? -1
    if (rawCount !== projects.length || JSON.stringify(res.data) !== JSON.stringify(projects)) {
      await window.electronAPI.saveProjects(projects)
    }
    const prevActive = get().activeProjectId
    const activeProjectId =
      prevActive && projects.some((p) => p.id === prevActive)
        ? prevActive
        : projects.find((p) => p.isDefault)?.id ?? projects[0]?.id ?? null
    set({ projects, activeProjectId, isLoaded: true })
  },

  // Reject unknown ids so activeProjectId can never dangle; fall back to default.
  setActive: (id) => {
    const exists = get().projects.some((p) => p.id === id)
    if (!exists) return
    set({ activeProjectId: id })
  },

  persist: async () => {
    await window.electronAPI.saveProjects(canonicalize(get().projects))
  },

  create: async (name, dirPath) => {
    const now = Date.now()
    const p: Project = { id: crypto.randomUUID(), name, dirPath, isDefault: false, createdAt: now, updatedAt: now }
    set((st) => ({ projects: [...st.projects, p], activeProjectId: st.activeProjectId ?? p.id }))
    await get().persist()
    return p
  },

  rename: async (id, name) => {
    set((st) => ({ projects: st.projects.map((p) => (p.id === id ? { ...p, name, updatedAt: Date.now() } : p)) }))
    await get().persist()
  },

  remove: async (id) => {
    const target = get().projects.find((p) => p.id === id)
    if (!target || target.isDefault) return // never delete the default project
    set((st) => {
      const projects = st.projects.filter((p) => p.id !== id)
      const activeProjectId =
        st.activeProjectId === id ? projects.find((p) => p.isDefault)?.id ?? projects[0]?.id ?? null : st.activeProjectId
      return { projects, activeProjectId }
    })
    await get().persist()
    // NOTE: P1 keeps session/trace/stats files sid-keyed globally, so deleting a
    // project does not yet remove its sessions' files. Project-scoped cleanup
    // (and orphan removal) lands when storage moves under projects/<id>/.
  },

  getDefault: () => get().projects.find((p) => p.isDefault),
  getActive: () => get().projects.find((p) => p.id === get().activeProjectId)
}))
