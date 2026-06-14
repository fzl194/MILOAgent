import { create } from 'zustand'
import type { Project, ProjectConfig } from '../agent-core/types'

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
  /** projectId → true when its bound directory no longer exists on disk. */
  dirMissing: Record<string, boolean>
  load: () => Promise<void>
  setActive: (id: string) => void
  create: (name: string, dirPath: string | null) => Promise<Project>
  /** Internal core: dedup by realpath, create record, refresh missing flags. */
  createProjectRecord: (name: string, dirPath: string) => Promise<Project>
  /** Create a project backed by a NEW folder under the workspace root. */
  createProjectNew: (name: string) => Promise<Project>
  /** Create a project pointing at an EXISTING folder (raw path → realpath). */
  createProjectFromExisting: (name: string, rawPath: string) => Promise<Project>
  /** Re-check every project's directory existence; updates `dirMissing`. */
  refreshDirMissing: () => Promise<void>
  rename: (id: string, name: string) => Promise<void>
  /** Merge a partial config patch into a project's overrides (effective = global ← project). */
  updateConfig: (id: string, patch: Partial<ProjectConfig>) => Promise<void>
  /** Re-point a project at a different existing directory (realpath + dedup). */
  updateDir: (id: string, dirPath: string) => Promise<void>
  remove: (id: string) => Promise<void>
  getDefault: () => Project | undefined
  getActive: () => Project | undefined
  persist: () => Promise<void>
}

// Serialize project creation so two rapid "create" calls (double-click, etc.)
// can't both pass the directory-uniqueness check and produce duplicate projects.
let createChain: Promise<unknown> = Promise.resolve()

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
  dirMissing: {},

  load: async () => {
    const res = await window.electronAPI.listProjects()
    const projects = canonicalize((res.data as Project[]) || [])

    // Normalize every bound dirPath to its realpath so directory-uniqueness
    // checks can't be spoofed by case/symlink/relative-path spellings in older
    // or hand-edited data. Failures (dir gone) leave the path as-is; the missing
    // flag will mark it.
    let changed = false
    for (const p of projects) {
      if (!p.dirPath) continue
      const r = await window.electronAPI.realpathProject(p.dirPath)
      if (r.success && r.data && r.data !== p.dirPath) {
        p.dirPath = r.data
        changed = true
      }
    }

    // Backfill the default project's working directory for installs that predate
    // P4 (dirPath was null). The one-time migration can't fix an already-present
    // projects.json, so do it here on every load — idempotent on the main side.
    const def = projects.find((p) => p.isDefault)
    if (def && !def.dirPath) {
      const r = await window.electronAPI.ensureDefaultProjectDir()
      if (r.success && r.data) {
        def.dirPath = r.data
        changed = true
      }
    }

    // Persist if canonicalized shape or any realpath differed from disk.
    const rawCount = (res.data as Project[] | null)?.length ?? -1
    if (changed || rawCount !== projects.length || JSON.stringify(res.data) !== JSON.stringify(projects)) {
      await window.electronAPI.saveProjects(projects)
    }
    const prevActive = get().activeProjectId
    const activeProjectId =
      prevActive && projects.some((p) => p.id === prevActive)
        ? prevActive
        : projects.find((p) => p.isDefault)?.id ?? projects[0]?.id ?? null
    set({ projects, activeProjectId, isLoaded: true })
    void get().refreshDirMissing()
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

  // Shared core for both creation flows: enforce directory uniqueness (by
  // realpath), then create the record and re-check directory existence. Runs
  // under createChain so concurrent calls are serialized (no double-create).
  createProjectRecord: (name, dirPath) => {
    const exec = async (): Promise<Project> => {
      if (get().projects.some((p) => p.dirPath && p.dirPath === dirPath)) {
        throw new Error('该目录已被其他项目占用')
      }
      const p = await get().create(name, dirPath)
      await get().refreshDirMissing()
      // Switch the user into the project they just created.
      set({ activeProjectId: p.id })
      return p
    }
    const next = createChain.then(exec) as Promise<Project>
    createChain = next.then(() => undefined, () => undefined)
    return next
  },

  createProjectNew: async (name) => {
    const res = await window.electronAPI.createProjectDir(name)
    if (!res.success || !res.data) throw new Error(res.error || '创建目录失败')
    return get().createProjectRecord(name, res.data)
  },

  createProjectFromExisting: async (name, rawPath) => {
    const rp = await window.electronAPI.realpathProject(rawPath)
    if (!rp.success || !rp.data) throw new Error(rp.error || '路径解析失败')
    return get().createProjectRecord(name, rp.data)
  },

  refreshDirMissing: async () => {
    const checks = await Promise.all(
      get()
        .projects.filter((p) => p.dirPath)
        .map(async (p) => {
          const r = await window.electronAPI.projectDirExists(p.dirPath as string)
          return [p.id, !r.data] as const
        })
    )
    const map: Record<string, boolean> = {}
    for (const [id, missing] of checks) map[id] = missing
    set({ dirMissing: map })
  },

  rename: async (id, name) => {
    set((st) => ({ projects: st.projects.map((p) => (p.id === id ? { ...p, name, updatedAt: Date.now() } : p)) }))
    await get().persist()
  },

  updateConfig: async (id, patch) => {
    set((st) => ({
      projects: st.projects.map((p) =>
        p.id === id ? { ...p, config: { ...(p.config ?? {}), ...patch }, updatedAt: Date.now() } : p
      )
    }))
    await get().persist()
  },

  updateDir: async (id, dirPath) => {
    // The default project is intentionally dirless; never bind a directory to it.
    if (get().projects.find((p) => p.id === id)?.isDefault) {
      throw new Error('默认项目不能绑定目录')
    }
    const rp = await window.electronAPI.realpathProject(dirPath)
    if (!rp.success || !rp.data) throw new Error(rp.error || '路径解析失败')
    const real = rp.data
    if (get().projects.some((p) => p.id !== id && p.dirPath === real)) {
      throw new Error('该目录已被其他项目占用')
    }
    set((st) => ({
      projects: st.projects.map((p) => (p.id === id ? { ...p, dirPath: real, updatedAt: Date.now() } : p))
    }))
    await get().persist()
    await get().refreshDirMissing()
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
    // P5: also delete the project's data bucket (traces + stats).
    await window.electronAPI.deleteProject(id)
    await get().persist()
    // NOTE: P1 keeps session/trace/stats files sid-keyed globally, so deleting a
    // project does not yet remove its sessions' files. Project-scoped cleanup
    // (and orphan removal) lands when storage moves under projects/<id>/.
  },

  getDefault: () => get().projects.find((p) => p.isDefault),
  getActive: () => get().projects.find((p) => p.id === get().activeProjectId)
}))
