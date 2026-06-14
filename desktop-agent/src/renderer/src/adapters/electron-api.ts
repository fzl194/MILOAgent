import type { Project } from '../agent-core/types'

export interface ElectronAPI {
  readFile: (p: string, cwd?: string) => Promise<{ success: boolean; data?: string; error?: string }>
  writeFile: (p: string, c: string, cwd?: string) => Promise<{ success: boolean; error?: string }>
  runShell: (cmd: string, cwd?: string) => Promise<{ success: boolean; data?: { stdout: string; stderr: string }; error?: string }>
  cancelShell: () => Promise<{ success: boolean }>
  pickFolder: () => Promise<{ success: boolean; data?: string | null }>
  readConfig: () => Promise<{ success: boolean; data: Record<string, any> | null }>
  writeConfig: (cfg: object) => Promise<{ success: boolean; error?: string }>
  listProjects: () => Promise<{ success: boolean; data?: Project[] }>
  saveProjects: (projects: Project[]) => Promise<{ success: boolean; error?: string }>
  createProjectDir: (name: string) => Promise<{ success: boolean; data?: string; error?: string }>
  realpathProject: (p: string) => Promise<{ success: boolean; data?: string; error?: string }>
  projectDirExists: (p: string) => Promise<{ success: boolean; data?: boolean; error?: string }>
  ensureDefaultProjectDir: () => Promise<{ success: boolean; data?: string; error?: string }>
  listModels: () => Promise<{ success: boolean; data?: any[] }>
  saveModels: (models: unknown[]) => Promise<{ success: boolean; error?: string }>
  listSessions: () => Promise<{ success: boolean; data?: any[] }>
  updateSessionIndex: (sessions: unknown[]) => Promise<{ success: boolean; error?: string }>
  readSessionMessages: (sid: string) => Promise<{ success: boolean; data?: any[] }>
  writeSessionMessages: (sid: string, msgs: unknown[]) => Promise<{ success: boolean; error?: string }>
  deleteSessionMessages: (sid: string) => Promise<{ success: boolean; error?: string }>
  appendStat: (pid: string, event: object) => Promise<{ success: boolean; error?: string }>
  readStats: (pid: string) => Promise<{ success: boolean; data?: any[] }>
  pruneStatsBySession: (pid: string, sid: string) => Promise<{ success: boolean; error?: string }>
  // Traces (per-project, per-session)
  appendTrace: (pid: string, sid: string, event: object) => Promise<{ success: boolean; error?: string }>
  readTrace: (pid: string, sid: string) => Promise<{ success: boolean; data?: any[] }>
  deleteTrace: (pid: string, sid: string) => Promise<{ success: boolean }>
  // Delete a project's data bucket
  deleteProject: (pid: string) => Promise<{ success: boolean; error?: string }>
  readSessionRules: (sid: string) => Promise<{ success: boolean; data?: any[] }>
  writeSessionRules: (sid: string, rules: unknown) => Promise<{ success: boolean; error?: string }>
  deleteSessionRules: (sid: string) => Promise<{ success: boolean }>
  clearAllData: () => Promise<{ success: boolean; error?: string }>
}

declare global { interface Window { electronAPI: ElectronAPI } }
