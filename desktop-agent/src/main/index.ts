import { app, BrowserWindow, ipcMain, Menu, dialog } from 'electron'
import { join, resolve, isAbsolute } from 'path'
import { readFile, writeFile, mkdir, unlink, readdir, access, realpath, stat } from 'fs/promises'
import { appendFile } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'

const DATA_DIR = () => join(app.getPath('home'), '.desktop-agent')
const SESSIONS_DIR = () => join(DATA_DIR(), 'sessions')
const STATS_DIR = () => join(DATA_DIR(), 'stats')
const TRACES_DIR = () => join(DATA_DIR(), 'traces')
const PROJECTS_FILE = () => join(DATA_DIR(), 'projects.json')
let mainWindow: BrowserWindow | null = null

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

// Remove every file directly under a directory (non-recursive — flat files only;
// project-scoped subtrees are handled separately when they land). Used by the
// danger-zone wipe and the one-time project migration.
async function clearFlatFiles(dir: string): Promise<void> {
  const files = await readdir(dir).catch(() => [])
  for (const f of files) await unlink(join(dir, f)).catch(() => undefined)
}

// Enforce the default-project invariant on anything we persist: exactly one
// project has isDefault=true. The renderer is not trusted — main canonicalizes
// on every project:save so a malformed/empty/duplicate-default array can never
// reach disk.
function canonicalizeProjects(input: unknown): Record<string, unknown>[] {
  const arr = Array.isArray(input) ? (input as any[]) : []
  const valid = arr.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
  let sawDefault = false
  const out: Record<string, unknown>[] = valid.map((p: any) => {
    const isDefault = !!p.isDefault && !sawDefault ? ((sawDefault = true), true) : false
    return {
      id: p.id,
      name: p.name,
      dirPath: p.dirPath ?? null,
      isDefault,
      config: p.config,
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now()
    }
  })
  if (!sawDefault && out.length) out[0].isDefault = true
  if (!out.length) {
    const now = Date.now()
    out.push({ id: randomUUID(), name: '默认项目', dirPath: null, isDefault: true, createdAt: now, updatedAt: now })
  }
  return out
}

// Build the default project with a REAL working directory (<wsRoot>/default),
// creating the folder if needed. Shared by the one-time migration and
// data:clearAll so both leave the default project pointing at an existing dir
// (P4: the default project is never dirless).
async function buildDefaultProject(): Promise<Record<string, unknown>> {
  const cfg = await readJson<Record<string, any>>(join(DATA_DIR(), 'config.json'), {})
  const wsRoot =
    cfg && typeof cfg.workspaceRoot === 'string' && cfg.workspaceRoot.trim()
      ? cfg.workspaceRoot
      : join(DATA_DIR(), 'workspace')
  await mkdir(wsRoot, { recursive: true })
  const dir = join(wsRoot, 'default')
  await mkdir(dir, { recursive: true })
  const now = Date.now()
  return { id: randomUUID(), name: '默认项目', dirPath: await realpath(dir), isDefault: true, createdAt: now, updatedAt: now }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 600, show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true }
  })
  Menu.setApplicationMenu(null)
  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })
  // DevTools toggle shortcuts (menu is null → default F12 gone, so register manually)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.key === 'I' && input.control && input.shift)) {
      mainWindow!.webContents.toggleDevTools()
      event.preventDefault()
    }
  })
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function ensureDirs(): Promise<void> {
  await mkdir(SESSIONS_DIR(), { recursive: true })
  await mkdir(STATS_DIR(), { recursive: true })
  await mkdir(TRACES_DIR(), { recursive: true })
  await runMigrationOnce()
}

// One-time migration to the project-level model, guarded by an in-process mutex
// so concurrent IPC handlers share a single migration run (no double-wipe).
// Order matters for crash safety: clear legacy data FIRST, then write
// projects.json as the commit marker last. A crash mid-clear simply re-runs on
// the next launch; once the marker exists, migration never touches legacy data
// again.
let migratePromise: Promise<void> | null = null
function runMigrationOnce(): Promise<void> {
  if (!migratePromise) {
    migratePromise = (async () => {
      if (await pathExists(PROJECTS_FILE())) return
      await clearFlatFiles(SESSIONS_DIR())
      await clearFlatFiles(TRACES_DIR())
      await writeFile(join(STATS_DIR(), 'events.jsonl'), '', 'utf-8').catch(() => undefined)
      await unlink(join(DATA_DIR(), 'index.json')).catch(() => undefined)
      // Clear the legacy global allowlist (P4: permissions are now session/project rules).
      await unlink(join(DATA_DIR(), 'allowlist.json')).catch(() => undefined)
      // Seed the default project with a real working directory; commit marker last.
      await writeJson(PROJECTS_FILE(), [await buildDefaultProject()])
    })().catch((e) => {
      migratePromise = null // allow a retry on failure
      throw e
    })
  }
  return migratePromise
}

async function readJson<T>(p: string, fb: T): Promise<T> {
  try { return JSON.parse(await readFile(p, 'utf-8')) } catch { return fb }
}

async function writeJson(p: string, d: unknown): Promise<void> {
  await mkdir(join(p, '..'), { recursive: true })
  await writeFile(p, JSON.stringify(d, null, 2), 'utf-8')
}

// Resolve a (possibly relative) path against a working directory. Used so the
// agent's read_file/write_file calls honor the active project's directory: a
// relative path is interpreted under `cwd`, an absolute path is left as-is.
function resolveUnder(p: string, cwd?: string): string {
  return cwd && !isAbsolute(p) ? resolve(cwd, p) : p
}

// Serialize writes to stats/events.jsonl: append (per-turn recording) and prune
// (session deletion) both touch the same file; running them concurrently would
// lose events. This chain guarantees one writer at a time.
let statsWriteChain: Promise<void> = Promise.resolve()
function serializeStatsWrite(fn: () => Promise<void>): Promise<void> {
  const next = statsWriteChain.then(fn, fn)
  statsWriteChain = next.catch(() => undefined)
  return next
}

// ===== FS & Shell =====
ipcMain.handle('fs:readFile', async (_, p: string, cwd?: string) => {
  try { return { success: true, data: await readFile(resolveUnder(p, cwd), 'utf-8') } }
  catch (e: any) { return { success: false, error: e.message } }
})
ipcMain.handle('fs:writeFile', async (_, p: string, c: string, cwd?: string) => {
  try { const rp = resolveUnder(p, cwd); await mkdir(join(rp, '..'), { recursive: true }); await writeFile(rp, c, 'utf-8'); return { success: true } }
  catch (e: any) { return { success: false, error: e.message } }
})
// Tracks the currently-running shell so a user "stop" can kill it. Turns are
// serial, so a single slot is sufficient.
let currentShell: ChildProcess | null = null
const SHELL_TIMEOUT_MS = 30000
const SHELL_MAX_BUFFER = 1024 * 1024

// Kill a shell AND its child processes. `child.kill()` only signals the wrapper
// shell; on Windows (and often on Unix) spawned grandchildren (npm/python/…)
// survive. We kill the whole tree instead.
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) {
    try { child.kill() } catch { /* already gone */ }
    return
  }
  try {
    if (process.platform === 'win32') {
      // /T = include child tree, /F = force
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'])
    } else {
      // Child is spawned detached as its own process-group leader, so -pid kills
      // the entire group.
      try { process.kill(-pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
    }
  } catch {
    try { child.kill() } catch { /* gone */ }
  }
}

ipcMain.handle('shell:run', async (_, cmd: string, cwd?: string) => {
  // Validate the requested cwd up front: a missing/non-dir cwd would otherwise
  // surface as an opaque spawn error. Return a clear failure instead.
  if (cwd) {
    try {
      const st = await stat(cwd)
      if (!st.isDirectory()) return { success: false, error: '工作目录不是目录：' + cwd }
    } catch {
      return { success: false, error: '工作目录不存在：' + cwd }
    }
  }
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout
    const finish = (success: boolean, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      currentShell = null
      resolve({ success, error, data: { stdout, stderr } })
    }
    // detached on Unix makes the child a process-group leader so killTree can
    // kill the whole group; ignored on Windows (we use taskkill /T there).
    // cwd (when provided = the active project's directory) makes the shell run
    // inside that project; without it the shell would run in the app's launch dir.
    const child = spawn(cmd, { shell: true, detached: process.platform !== 'win32', ...(cwd ? { cwd } : {}) })
    currentShell = child
    child.stdout?.on('data', (d) => {
      stdout += d.toString()
      if (stdout.length > SHELL_MAX_BUFFER) stdout = stdout.slice(0, SHELL_MAX_BUFFER)
    })
    child.stderr?.on('data', (d) => {
      stderr += d.toString()
      if (stderr.length > SHELL_MAX_BUFFER) stderr = stderr.slice(0, SHELL_MAX_BUFFER)
    })
    child.on('error', (err) => finish(false, err.message))
    child.on('close', (code) => {
      // Non-zero exit mirrors the legacy exec() behaviour (surfaced as an error
      // result so the agent can react), with partial stdout/stderr preserved.
      finish(code === 0, code !== 0 ? `exit code ${code}` : undefined)
    })
    timer = setTimeout(() => killTree(child), SHELL_TIMEOUT_MS)
  })
})

ipcMain.handle('shell:cancel', async () => {
  if (currentShell) killTree(currentShell)
  return { success: true }
})

// ===== Dialog =====
ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return { success: true, data: null }
  return { success: true, data: result.filePaths[0] }
})

// ===== Config (all return { success, data }) =====
ipcMain.handle('config:read', async () => {
  return { success: true, data: await readJson(join(DATA_DIR(), 'config.json'), null) }
})
ipcMain.handle('config:write', async (_, cfg: object) => {
  try { await writeJson(join(DATA_DIR(), 'config.json'), cfg); return { success: true } }
  catch (e: any) { return { success: false, error: e.message } }
})

// ===== Allowlist (persisted "approve & remember" rules) =====
ipcMain.handle('allowlist:read', async () => {
  return { success: true, data: await readJson(join(DATA_DIR(), 'allowlist.json'), []) }
})
ipcMain.handle('allowlist:write', async (_, entries: unknown[]) => {
  try { await writeJson(join(DATA_DIR(), 'allowlist.json'), entries); return { success: true } }
  catch (e: any) { return { success: false, error: e.message } }
})

// ===== Projects =====
ipcMain.handle('project:list', async () => {
  await ensureDirs()
  return { success: true, data: await readJson(PROJECTS_FILE(), []) }
})
ipcMain.handle('project:save', async (_, projects: unknown[]) => {
  try { await ensureDirs(); await writeJson(PROJECTS_FILE(), canonicalizeProjects(projects)); return { success: true } }
  catch (e: any) { return { success: false, error: e.message } }
})

// Windows reserved folder names that can't be created / cause trouble.
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

// Create a new project folder under the workspace root and return its realpath.
// workspaceRoot comes from config.json; if unset, defaults to ~/.desktop-agent/workspace.
// The name is sanitized (illegal/control chars stripped, Windows-reserved names
// rejected) and the final folder is created with a NON-recursive mkdir as an
// atomic placeholder — concurrent same-name requests get EEXIST and roll to a
// -2/-3 suffix instead of both "winning" the same directory.
ipcMain.handle('project:createDir', async (_, name: string) => {
  try {
    const cfg = await readJson<Record<string, any>>(join(DATA_DIR(), 'config.json'), {})
    const wsRoot =
      cfg && typeof cfg.workspaceRoot === 'string' && cfg.workspaceRoot.trim()
        ? cfg.workspaceRoot
        : join(DATA_DIR(), 'workspace')
    // Ensure + validate the workspace root (must be a real directory).
    await mkdir(wsRoot, { recursive: true })
    const wsReal = await realpath(wsRoot)
    const wsStat = await stat(wsReal)
    if (!wsStat.isDirectory()) return { success: false, error: '工作区根不是目录：' + wsRoot }

    let safe =
      String(name || '')
        .replace(/[\x00-\x1f\\/:*?"<>|]/g, '_') // illegal + control chars
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.\s]+$/, '') // no trailing dots/spaces (Windows quirk)
        .slice(0, 80)
    if (!safe || safe === '.' || safe === '..' || WIN_RESERVED.test(safe)) safe = '项目'

    // Atomic placeholder: non-recursive mkdir on the final segment; EEXIST → suffix.
    let target = join(wsReal, safe)
    let i = 2
    for (;;) {
      try {
        await mkdir(target) // throws EEXIST if present; parent (wsReal) exists
        break
      } catch (e: any) {
        if (e?.code === 'EEXIST') {
          target = join(wsReal, `${safe}-${i++}`)
          continue
        }
        throw e
      }
    }
    return { success: true, data: await realpath(target) }
  } catch (e: any) { return { success: false, error: e.message } }
})

// Canonicalize an existing directory path (resolves symlinks +, on Windows, case)
// so two projects can't point at the "same" folder under different spellings.
ipcMain.handle('project:realpath', async (_, p: string) => {
  try { return { success: true, data: await realpath(p) } }
  catch (e: any) { return { success: false, error: e.message } }
})

// Does a project's bound directory still exist on disk? (missing detection)
ipcMain.handle('project:dirExists', async (_, p: string) => {
  return { success: true, data: await pathExists(p) }
})

// Ensure the default project has a real working directory (<wsRoot>/default),
// creating it if needed. Idempotent. Used for EXISTING installs whose default
// project predates P4 (dirPath=null) — the one-time migration only fires when
// projects.json is absent, so it can't fix an already-present default project.
ipcMain.handle('project:ensureDefaultDir', async () => {
  try {
    const cfg = await readJson<Record<string, any>>(join(DATA_DIR(), 'config.json'), {})
    const wsRoot =
      cfg && typeof cfg.workspaceRoot === 'string' && cfg.workspaceRoot.trim()
        ? cfg.workspaceRoot
        : join(DATA_DIR(), 'workspace')
    await mkdir(wsRoot, { recursive: true })
    const dir = join(wsRoot, 'default')
    await mkdir(dir, { recursive: true })
    return { success: true, data: await realpath(dir) }
  } catch (e: any) { return { success: false, error: e.message } }
})

// ===== Session permission rules (sessions/<sid>.rules.json, persisted) =====
const SESSION_RULES = (sid: string) => join(SESSIONS_DIR(), sid + '.rules.json')
ipcMain.handle('session-rules:read', async (_, sid: string) => {
  await ensureDirs()
  return { success: true, data: await readJson(SESSION_RULES(sid), []) }
})
ipcMain.handle('session-rules:write', async (_, sid: string, rules: unknown) => {
  try { await ensureDirs(); await writeJson(SESSION_RULES(sid), rules); return { success: true } }
  catch (e: any) { return { success: false, error: e.message } }
})
ipcMain.handle('session-rules:delete', async (_, sid: string) => {
  try { await unlink(SESSION_RULES(sid)); return { success: true } }
  catch (e: any) { return { success: e?.code === 'ENOENT' } }
})

// ===== Models =====
ipcMain.handle('models:list', async () => {
  return { success: true, data: await readJson(join(DATA_DIR(), 'models.json'), []) }
})
ipcMain.handle('models:save', async (_, models: unknown[]) => {
  try { await writeJson(join(DATA_DIR(), 'models.json'), models); return { success: true } }
  catch (e: any) { return { success: false, error: e.message } }
})

// ===== Sessions =====
ipcMain.handle('session:list', async () => {
  await ensureDirs()
  return { success: true, data: await readJson(join(DATA_DIR(), 'index.json'), []) }
})
ipcMain.handle('session:updateIndex', async (_, sessions: unknown[]) => {
  try { await ensureDirs(); await writeJson(join(DATA_DIR(), 'index.json'), sessions); return { success: true } }
  catch (e: any) { return { success: false, error: e.message } }
})
ipcMain.handle('session:readMessages', async (_, sid: string) => {
  return { success: true, data: await readJson(join(SESSIONS_DIR(), sid + '.json'), []) }
})
ipcMain.handle('session:writeMessages', async (_, sid: string, msgs: unknown[]) => {
  try { await ensureDirs(); await writeJson(join(SESSIONS_DIR(), sid + '.json'), msgs); return { success: true } }
  catch (e: any) { return { success: false, error: e.message } }
})
ipcMain.handle('session:deleteMessages', async (_, sid: string) => {
  try { await unlink(join(SESSIONS_DIR(), sid + '.json')); return { success: true } }
  catch (e: any) { return { success: false, error: e.message } }
})

// ===== Stats =====
ipcMain.handle('stats:append', async (_, event: object) => {
  await ensureDirs()
  let error: string | undefined
  await serializeStatsWrite(
    () =>
      new Promise<void>((resolve) => {
        appendFile(join(STATS_DIR(), 'events.jsonl'), JSON.stringify(event) + '\n', (err) => {
          if (err) error = (err as Error).message
          resolve()
        })
      })
  )
  return error ? { success: false, error } : { success: true }
})
ipcMain.handle('stats:read', async () => {
  await ensureDirs()
  try {
    const content = await readFile(join(STATS_DIR(), 'events.jsonl'), 'utf-8')
    // Parse line-by-line and skip malformed/truncated lines (e.g. a torn final
    // line written during a concurrent append) instead of failing the whole read.
    const events: unknown[] = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        events.push(JSON.parse(trimmed))
      } catch {
        /* skip a single corrupt line — keep the rest */
      }
    }
    return { success: true, data: events }
  } catch {
    return { success: true, data: [] }
  }
})

// ===== Traces (atomic event stream, one jsonl per session) =====
ipcMain.handle('trace:append', async (_, sid: string, event: object) => {
  await ensureDirs()
  return new Promise<{ success: boolean; error?: string }>((resolve) => {
    appendFile(join(TRACES_DIR(), sid + '.jsonl'), JSON.stringify(event) + '\n', (err) => {
      resolve(err ? { success: false, error: (err as Error).message } : { success: true })
    })
  })
})

ipcMain.handle('trace:read', async (_, sid: string) => {
  await ensureDirs()
  try {
    const content = await readFile(join(TRACES_DIR(), sid + '.jsonl'), 'utf-8')
    // Parse line-by-line and skip malformed/truncated lines (same tolerance as stats:read)
    const events: unknown[] = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        events.push(JSON.parse(trimmed))
      } catch {
        /* skip a single corrupt line — keep the rest */
      }
    }
    return { success: true, data: events }
  } catch {
    return { success: true, data: [] }
  }
})

ipcMain.handle('trace:delete', async (_, sid: string) => {
  try {
    await unlink(join(TRACES_DIR(), sid + '.jsonl'))
    return { success: true }
  } catch (e: any) {
    // ENOENT is fine — old sessions have no trace file
    return { success: e?.code === 'ENOENT' }
  }
})

// Remove a session's orphan events from stats (called on session delete)
ipcMain.handle('stats:pruneBySession', async (_, sid: string) => {
  await ensureDirs()
  try {
    await serializeStatsWrite(async () => {
      const content = await readFile(join(STATS_DIR(), 'events.jsonl'), 'utf-8')
      const kept = content
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim()
          if (!trimmed) return false
          try {
            return (JSON.parse(trimmed) as { sessionId?: string }).sessionId !== sid
          } catch {
            return false
          }
        })
        .join('\n')
      await writeFile(join(STATS_DIR(), 'events.jsonl'), kept + (kept ? '\n' : ''), 'utf-8')
    })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
})

// ===== Danger zone: wipe conversation/trace/stats data (keeps models.json) =====
ipcMain.handle('data:clearAll', async () => {
  try {
    await ensureDirs()
    // sessions/ holds BOTH <sid>.json messages and <sid>.rules.json permission
    // rules — clearing the directory wipes both. traces + stats go too.
    await clearFlatFiles(SESSIONS_DIR())
    await clearFlatFiles(TRACES_DIR())
    await writeFile(join(STATS_DIR(), 'events.jsonl'), '', 'utf-8')
    await writeJson(join(DATA_DIR(), 'index.json'), [])
    await unlink(join(DATA_DIR(), 'allowlist.json')).catch(() => undefined) // vestigial
    // Reset projects to a fresh default WITH a real working dir, and restore a
    // complete global AgentConfig (sandbox/policy are the project-fallback defaults).
    await writeJson(PROJECTS_FILE(), [await buildDefaultProject()])
    await writeJson(join(DATA_DIR(), 'config.json'), {
      systemPrompt: '',
      workspaceRoot: undefined,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request'
    })
    // NOTE: models.json is intentionally left untouched.
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
})

app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() }) })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
