import type { Project } from '../agent-core/types'

export interface ElectronAPI {
  readFile: (p: string) => Promise<{ success: boolean; data?: string; error?: string }>
  writeFile: (p: string, c: string) => Promise<{ success: boolean; error?: string }>
  runShell: (cmd: string) => Promise<{ success: boolean; data?: { stdout: string; stderr: string }; error?: string }>
  cancelShell: () => Promise<{ success: boolean }>
  pickFolder: () => Promise<{ success: boolean; data?: string | null }>
  readConfig: () => Promise<{ success: boolean; data: Record<string, any> | null }>
  writeConfig: (cfg: object) => Promise<{ success: boolean; error?: string }>
  readAllowlist: () => Promise<{ success: boolean; data?: any[] }>
  writeAllowlist: (entries: unknown[]) => Promise<{ success: boolean; error?: string }>
  listProjects: () => Promise<{ success: boolean; data?: Project[] }>
  saveProjects: (projects: Project[]) => Promise<{ success: boolean; error?: string }>
  listModels: () => Promise<{ success: boolean; data?: any[] }>
  saveModels: (models: unknown[]) => Promise<{ success: boolean; error?: string }>
  listSessions: () => Promise<{ success: boolean; data?: any[] }>
  updateSessionIndex: (sessions: unknown[]) => Promise<{ success: boolean; error?: string }>
  readSessionMessages: (sid: string) => Promise<{ success: boolean; data?: any[] }>
  writeSessionMessages: (sid: string, msgs: unknown[]) => Promise<{ success: boolean; error?: string }>
  deleteSessionMessages: (sid: string) => Promise<{ success: boolean; error?: string }>
  appendStat: (event: object) => Promise<{ success: boolean; error?: string }>
  readStats: () => Promise<{ success: boolean; data?: any[] }>
  pruneStatsBySession: (sid: string) => Promise<{ success: boolean; error?: string }>
  // Traces (atomic event stream per session)
  appendTrace: (sid: string, event: object) => Promise<{ success: boolean; error?: string }>
  readTrace: (sid: string) => Promise<{ success: boolean; data?: any[] }>
  deleteTrace: (sid: string) => Promise<{ success: boolean }>
  clearAllData: () => Promise<{ success: boolean; error?: string }>
}

declare global { interface Window { electronAPI: ElectronAPI } }
