import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  readFile: (p: string, cwd?: string) => ipcRenderer.invoke('fs:readFile', p, cwd),
  writeFile: (p: string, c: string, cwd?: string) => ipcRenderer.invoke('fs:writeFile', p, c, cwd),
  runShell: (cmd: string, cwd?: string) => ipcRenderer.invoke('shell:run', cmd, cwd),
  cancelShell: () => ipcRenderer.invoke('shell:cancel'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  readConfig: () => ipcRenderer.invoke('config:read'),
  writeConfig: (cfg: object) => ipcRenderer.invoke('config:write', cfg),
  // Projects
  listProjects: () => ipcRenderer.invoke('project:list'),
  saveProjects: (projects: unknown[]) => ipcRenderer.invoke('project:save', projects),
  createProjectDir: (name: string) => ipcRenderer.invoke('project:createDir', name),
  realpathProject: (p: string) => ipcRenderer.invoke('project:realpath', p),
  projectDirExists: (p: string) => ipcRenderer.invoke('project:dirExists', p),
  ensureDefaultProjectDir: () => ipcRenderer.invoke('project:ensureDefaultDir'),
  // Models
  listModels: () => ipcRenderer.invoke('models:list'),
  saveModels: (models: unknown[]) => ipcRenderer.invoke('models:save', models),
  // Sessions
  listSessions: () => ipcRenderer.invoke('session:list'),
  updateSessionIndex: (sessions: unknown[]) => ipcRenderer.invoke('session:updateIndex', sessions),
  readSessionMessages: (sid: string) => ipcRenderer.invoke('session:readMessages', sid),
  writeSessionMessages: (sid: string, msgs: unknown[]) => ipcRenderer.invoke('session:writeMessages', sid, msgs),
  deleteSessionMessages: (sid: string) => ipcRenderer.invoke('session:deleteMessages', sid),
  // Stats
  appendStat: (event: object) => ipcRenderer.invoke('stats:append', event),
  readStats: () => ipcRenderer.invoke('stats:read'),
  pruneStatsBySession: (sid: string) => ipcRenderer.invoke('stats:pruneBySession', sid),
  // Traces (atomic event stream per session)
  appendTrace: (sid: string, event: object) => ipcRenderer.invoke('trace:append', sid, event),
  readTrace: (sid: string) => ipcRenderer.invoke('trace:read', sid),
  deleteTrace: (sid: string) => ipcRenderer.invoke('trace:delete', sid),
  // Session permission rules (persisted per session)
  readSessionRules: (sid: string) => ipcRenderer.invoke('session-rules:read', sid),
  writeSessionRules: (sid: string, rules: unknown) => ipcRenderer.invoke('session-rules:write', sid, rules),
  deleteSessionRules: (sid: string) => ipcRenderer.invoke('session-rules:delete', sid),
  clearAllData: () => ipcRenderer.invoke('data:clearAll'),
} as const

export type ElectronAPI = typeof electronAPI
contextBridge.exposeInMainWorld('electronAPI', electronAPI)
