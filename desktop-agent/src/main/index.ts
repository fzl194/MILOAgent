import { app, BrowserWindow, ipcMain, Menu, dialog } from 'electron'
import { join, resolve, isAbsolute } from 'path'
import { readFile, writeFile, mkdir, unlink, readdir, access, realpath, stat, rm } from 'fs/promises'
import { appendFile } from 'fs'
import { spawn, execFile, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { enforceWorkspacePath, type Sandbox } from './fs-guard'
import { decideShellOutputPersist } from './persist'

const DATA_DIR = () => join(app.getPath('home'), '.desktop-agent')
const WORKSPACE_DIR = () => join(DATA_DIR(), 'workspace')
const SESSIONS_DIR = () => join(DATA_DIR(), 'sessions')
const STATS_DIR = () => join(DATA_DIR(), 'stats')
const TRACES_DIR = () => join(DATA_DIR(), 'traces')
const PROJECTS_FILE = () => join(DATA_DIR(), 'projects.json')
// Per-project data buckets (P5): projects/<pid>/traces/<sid>.jsonl + projects/<pid>/stats/events.jsonl
const PROJECTS_DATA_DIR = () => join(DATA_DIR(), 'projects')
const projectTracesDir = (pid: string) => join(PROJECTS_DATA_DIR(), pid, 'traces')
const projectStatsFile = (pid: string) => join(PROJECTS_DATA_DIR(), pid, 'stats', 'events.jsonl')
// Per-request snapshots: projects/<pid>/snapshots/<sid>/<callId>.json (+ a
// lightweight <sid>/index.jsonl so list doesn't have to read every full snapshot).
const projectSnapshotsDir = (pid: string) => join(PROJECTS_DATA_DIR(), pid, 'snapshots')
const sessionSnapshotsDir = (pid: string, sid: string) => join(projectSnapshotsDir(pid), sid)
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
  await mkdir(WORKSPACE_DIR(), { recursive: true })
  const dir = join(WORKSPACE_DIR(), 'default')
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
  await migrateStatsToProjects()
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

// One-time migration: distribute global traces/ + stats/events.jsonl into
// per-project buckets (projects/<pid>/traces + projects/<pid>/stats), resolving
// each session's projectId from the sessions index (fallback: default project).
// Idempotent — only acts while global traces/ has files or global stats is non-empty.
let statsMigrated = false
async function migrateStatsToProjects(): Promise<void> {
  if (statsMigrated) return
  const sessions = await readJson<Array<{ id: string; projectId?: string }>>(join(DATA_DIR(), 'index.json'), [])
  const projects = await readJson<Array<{ id: string; isDefault?: boolean }>>(PROJECTS_FILE(), [])
  const sidToPid = new Map<string, string>()
  for (const s of sessions) if (s.id && s.projectId) sidToPid.set(s.id, s.projectId)
  const defaultPid = projects.find((p) => p.isDefault)?.id ?? projects[0]?.id ?? 'default'
  const resolvePid = (sid?: string): string => (sid && sidToPid.get(sid)) || defaultPid

  // Trace files → projects/<pid>/traces/<sid>.jsonl
  const traceFiles = await readdir(TRACES_DIR()).catch(() => [])
  for (const f of traceFiles) {
    if (!f.endsWith('.jsonl')) continue
    const sid = f.slice(0, -6)
    const pid = resolvePid(sid)
    await mkdir(projectTracesDir(pid), { recursive: true })
    try {
      await writeFile(join(projectTracesDir(pid), f), await readFile(join(TRACES_DIR(), f), 'utf-8'), 'utf-8')
      await unlink(join(TRACES_DIR(), f))
    } catch { /* best effort */ }
  }

  // Stats events → projects/<pid>/stats/events.jsonl
  try {
    const raw = await readFile(join(STATS_DIR(), 'events.jsonl'), 'utf-8')
    if (raw.trim()) {
      const byPid = new Map<string, string[]>()
      for (const line of raw.split('\n')) {
        const t = line.trim()
        if (!t) continue
        let ev: any
        try { ev = JSON.parse(t) } catch { continue }
        const pid = resolvePid(ev?.sessionId)
        if (!byPid.has(pid)) byPid.set(pid, [])
        byPid.get(pid)!.push(t)
      }
      for (const [pid, lines] of byPid) {
        await mkdir(join(projectStatsFile(pid), '..'), { recursive: true })
        await writeFile(projectStatsFile(pid), lines.join('\n') + '\n', 'utf-8')
      }
      await writeFile(join(STATS_DIR(), 'events.jsonl'), '', 'utf-8') // clear global
    }
  } catch { /* no global stats file */ }
  statsMigrated = true
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
// read_file main-process defense layer (P1). The renderer's approval gate is a
// policy, not a boundary — a bypassed renderer could otherwise read anything.
// Here we refuse device/special files, cap size, and canonicalize (resolve
// symlinks / '..' so they can't prefix-spoof a path check). write/shell get the
// same treatment in P2.
const READ_MAX_BYTES = 2 * 1024 * 1024 // 2 MB; larger files are refused whole.

// Device / special files that must never be read as text. Windows reserves
// CON/PRN/AUX/NUL/COM1-9/LPT1-9 as the final path segment; Unix uses /dev/*.
function isDevicePath(p: string): boolean {
  // Win32 raw device/NT namespaces (\\.\PhysicalDrive0, \\?\C:) and the console
  // aliases CONIN$/CONOUT$ can read/write raw disks/console — reject outright,
  // before the reserved-name segment check below.
  if (/^\\\\[.?]\\/.test(p) || /^(CONIN|CONOUT)\$/i.test(p)) return true
  const seg = p.replace(/\\/g, '/').split('/').pop() ?? ''
  if (process.platform === 'win32') {
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(seg)
  }
  const norm = p.replace(/\\/g, '/')
  return norm === '/dev' || norm.startsWith('/dev/')
}

// Resolve symlinks / short paths to a canonical absolute path. Falls back to
// the input if the path doesn't exist yet (caller then hits a normal ENOENT).
async function canonicalize(p: string): Promise<string> {
  try { return await realpath(p) } catch { return p }
}

// Workspace boundary for the read defense. Mirrors the renderer's effective
// workspaceRoot fallback so main and renderer converge on the same boundary.
// Defense-in-depth for read_file (P1 review): a bypassed renderer must NOT be
// able to read ~/.ssh, ~/.desktop-agent/models.json, or any other path outside
// the workspace when sandbox !== 'full-access'.
// Shared sandbox + workspace-root resolver (I/O). Used by both read and write
// IPC handlers so the two defenses never drift. The pure guard
// (enforceWorkspacePath) lives in fs-guard and is unit-tested there.
async function getSandboxAndRoot(): Promise<{ sandbox: Sandbox; root: string }> {
  const cfg = await readJson<{ sandbox?: Sandbox; workspaceRoot?: string }>(join(DATA_DIR(), 'config.json'), {})
  const sandbox: Sandbox =
    cfg.sandbox === 'read-only' || cfg.sandbox === 'workspace-write' || cfg.sandbox === 'full-access'
      ? cfg.sandbox
      : 'workspace-write'
  const root = (cfg.workspaceRoot && cfg.workspaceRoot.trim()) || join(DATA_DIR(), 'workspace')
  return { sandbox, root }
}

ipcMain.handle('fs:readFile', async (_, p: string, cwd?: string) => {
  try {
    const resolved = resolveUnder(p, cwd)
    if (isDevicePath(resolved)) return { success: false, error: '拒绝读取设备/特殊文件:' + resolved }
    // Re-check after canonicalizing: a benign-looking path can symlink to a device.
    const canon = await canonicalize(resolved)
    if (isDevicePath(canon)) return { success: false, error: '拒绝读取设备/特殊文件(canonicalized)' }
    // Workspace boundary (defense-in-depth). sandbox === 'full-access' opts
    // out; otherwise canon must be inside the canonicalized workspace root.
    // The pure guard also resolves `..`/`.` for string-level safety.
    const { sandbox, root } = await getSandboxAndRoot()
    const rootCanon = await canonicalize(root)
    const check = enforceWorkspacePath(canon, sandbox, rootCanon)
    if (!check.allowed) return { success: false, error: check.reason ?? '拒绝读取工作区之外的文件' }
    const st = await stat(canon)
    // Refuse oversized files without reading them (avoids loading 100s of MB
    // into memory). truncated/bytes let the renderer steer the model to a
    // ranged read; older consumers ignore these extra fields.
    if (st.size > READ_MAX_BYTES) {
      return { success: false, error: `文件过大(${st.size} 字节,上限 ${READ_MAX_BYTES} 字节)`, truncated: true, bytes: st.size }
    }
    const data = await readFile(canon, 'utf-8')
    return { success: true, data, bytes: st.size }
  } catch (e: any) { return { success: false, error: e.message } }
})
// P2 #1: writeFile now has the same defense-in-depth as readFile. The
// previous handler was a single line with NO checks (a bypassed renderer
// could overwrite ~/.ssh/authorized_keys, ~/.desktop-agent/models.json, or
// any system file). Canonicalize + device re-check + workspace guard
// (enforceWorkspacePath) before mkdir+write. full-access opts out.
ipcMain.handle('fs:writeFile', async (_, p: string, content: string, cwd?: string) => {
  try {
    const resolved = resolveUnder(p, cwd)
    if (isDevicePath(resolved)) return { success: false, error: '拒绝写入设备/特殊文件:' + resolved }
    const canon = await canonicalize(resolved)
    if (isDevicePath(canon)) return { success: false, error: '拒绝写入设备/特殊文件(canonicalized)' }
    const { sandbox, root } = await getSandboxAndRoot()
    const rootCanon = await canonicalize(root)
    const check = enforceWorkspacePath(canon, sandbox, rootCanon)
    if (!check.allowed) return { success: false, error: check.reason ?? '拒绝写入工作区之外的文件' }
    // mkdir parent (recursive) then write — atomic enough for a personal
    // desktop agent. canon for a non-existent file falls back to the raw
    // resolved path (canonicalize returns input on ENOENT), so `..` is still
    // the correct parent.
    await mkdir(join(canon, '..'), { recursive: true })
    await writeFile(canon, content, 'utf-8')
    return { success: true }
  } catch (e: any) { return { success: false, error: e.message } }
})
// Tracks the currently-running shell so a user "stop" can kill it. Turns are
// serial, so a single slot is sufficient.
let currentShell: ChildProcess | null = null
const SHELL_TIMEOUT_MS = 30000
const SHELL_MAX_BUFFER = 1024 * 1024

// P2 #2: large shell output is persisted to disk to prevent context blowup
// from build logs etc. Threshold = harness shell maxResultSizeChars (30K);
// beyond it we write the full combined output to tool-results/<uuid>.txt and
// return the aligned preview (with a "full at <path>" marker) to the model.
// The model can re-read the full file via read_file.
const TOOL_RESULTS_DIR = () => join(DATA_DIR(), 'tool-results')
const SHELL_PERSIST_THRESHOLD = 30 * 1024
const SHELL_PREVIEW_BYTES = 2 * 1024

/** P2 context-org: cap the `git status` stdout handed back to the renderer. */
const GIT_STATUS_MAX_CHARS = 4 * 1024

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
    // finish is async so it can writeFile the persisted result before
    // resolving. Event handlers ignore the returned promise (`void finish`).
    const finish = async (success: boolean, error?: string): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      currentShell = null
      // P2 #2: if combined output exceeds the threshold, persist the full
      // content to disk and return the preview (with a "full at <path>"
      // marker) as stdout. stderr is folded into the combined preview to
      // avoid duplication. The `persisted` field carries structured metadata
      // for tracing / future harness use. If the write fails, fall back to
      // the inline (hard-capped) stdout/stderr.
      const combined = stdout + stderr
      let data: { stdout: string; stderr: string; persisted?: { path: string; bytes: number; preview: string; truncated: true } } = { stdout, stderr }
      if (combined.length > SHELL_PERSIST_THRESHOLD) {
        const decision = decideShellOutputPersist(combined, {
          id: randomUUID(),
          baseDir: TOOL_RESULTS_DIR(),
          maxChars: SHELL_PERSIST_THRESHOLD,
          previewBytes: SHELL_PREVIEW_BYTES,
        })
        if (decision.kind === 'persisted') {
          try {
            await writeFile(decision.path, combined, 'utf-8')
            data = {
              stdout: decision.preview,
              stderr: '',
              persisted: { path: decision.path, bytes: decision.bytes, preview: decision.preview, truncated: true },
            }
          } catch {
            data = { stdout, stderr }
          }
        }
      }
      resolve({ success, error, data })
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
    child.on('error', (err) => { void finish(false, err.message) })
    child.on('close', (code) => {
      // Non-zero exit mirrors the legacy exec() behaviour (surfaced as an error
      // result so the agent can react), with partial stdout/stderr preserved.
      void finish(code === 0, code !== 0 ? `exit code ${code}` : undefined)
    })
    timer = setTimeout(() => killTree(child), SHELL_TIMEOUT_MS)
  })
})

ipcMain.handle('shell:cancel', async () => {
  if (currentShell) killTree(currentShell)
  return { success: true }
})

// ===== Git status (read-only, P2 context-org) =====
//
// Injected into the tail of the latest user message every turn so the model
// sees the working tree state without us having to put git in the system
// prompt prefix (which would invalidate OpenAI-compatible prefix caching
// every round — see docs/2026-06-15-desktop-agent-上下文组织管理演进.md).
//
// Bypasses the safety classifier entirely: this IPC is read-only, has no
// mutating side effect, and the `git` binary cannot be coerced into a shell
// because we use `execFile` (no shell) and an arg array (no injection).
ipcMain.handle('git:status', async (_, cwd: string | undefined) => {
  if (!cwd) return { success: false, error: 'cwd 未提供' }
  try {
    const st = await stat(cwd)
    if (!st.isDirectory()) return { success: false, error: 'cwd 不是目录:' + cwd }
  } catch {
    return { success: false, error: 'cwd 不存在:' + cwd }
  }

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (success: boolean, error?: string): void => {
      if (settled) return
      settled = true
      // Strip ANSI color codes (e.g. `git status --branch` may emit them in
      // some terminal configs) and cap the response size to a few KB so a
      // pathological repo can't blow up the system prompt.
      const clean = stdout.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').slice(0, GIT_STATUS_MAX_CHARS)
      resolve({ success, error, data: { stdout: clean, stderr: stderr.slice(0, GIT_STATUS_MAX_CHARS) } })
    }
    // execFile (NOT exec) so the args are passed literally — no shell
    // interpolation. `git status` returns non-zero in some edge cases (e.g.
    // not a repo), but the call doesn't fail outright; we treat the
    // non-zero exit as a soft error and return the (possibly empty) stdout
    // so the renderer can decide what to do.
    const child = execFile('git', ['status', '--porcelain=v1', '--branch'], {
      cwd,
      timeout: 3000,
      windowsHide: true
    })
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => finish(false, err.message))
    child.on('close', (code) => {
      // Non-zero exit (most often: "not a git repository") → still surface
      // whatever stdout we have, just mark success=false so the renderer's
      // cache can record a "no repo" miss instead of an empty success.
      if (code === 0) finish(true)
      else finish(false, `git exit ${code}`)
    })
  })
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
// Create a new project folder under the workspace dir (~/.desktop-agent/workspace)
// and return its realpath. The name is sanitized (illegal/control chars stripped,
// Windows-reserved names rejected) and the final folder is created with a
// NON-recursive mkdir as an atomic placeholder — concurrent same-name requests
// get EEXIST and roll to a -2/-3 suffix instead of both "winning" the same dir.
ipcMain.handle('project:createDir', async (_, name: string) => {
  try {
    await mkdir(WORKSPACE_DIR(), { recursive: true })
    const wsReal = await realpath(WORKSPACE_DIR())
    const wsStat = await stat(wsReal)
    if (!wsStat.isDirectory()) return { success: false, error: '工作区不是目录：' + WORKSPACE_DIR() }

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
  catch (e: any) { return { success: e?.code === 'ENOENT' } }
})

// ===== Stats (per-project: projects/<pid>/stats/events.jsonl) =====
ipcMain.handle('stats:append', async (_, pid: string, event: object) => {
  await ensureDirs()
  await mkdir(join(projectStatsFile(pid), '..'), { recursive: true })
  let error: string | undefined
  await serializeStatsWrite(
    () =>
      new Promise<void>((resolve) => {
        appendFile(projectStatsFile(pid), JSON.stringify(event) + '\n', (err) => {
          if (err) error = (err as Error).message
          resolve()
        })
      })
  )
  return error ? { success: false, error } : { success: true }
})
ipcMain.handle('stats:read', async (_, pid: string) => {
  await ensureDirs()
  try {
    const content = await readFile(projectStatsFile(pid), 'utf-8')
    const events: unknown[] = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { events.push(JSON.parse(trimmed)) } catch { /* skip corrupt line */ }
    }
    return { success: true, data: events }
  } catch {
    return { success: true, data: [] }
  }
})
ipcMain.handle('stats:pruneBySession', async (_, pid: string, sid: string) => {
  await ensureDirs()
  try {
    await serializeStatsWrite(async () => {
      let content = ''
      try { content = await readFile(projectStatsFile(pid), 'utf-8') } catch { return }
      const kept = content.split('\n').filter((line) => {
        const trimmed = line.trim()
        if (!trimmed) return false
        try { return (JSON.parse(trimmed) as { sessionId?: string }).sessionId !== sid } catch { return false }
      }).join('\n')
      await writeFile(projectStatsFile(pid), kept + (kept ? '\n' : ''), 'utf-8')
    })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
})

// ===== Traces (per-project: projects/<pid>/traces/<sid>.jsonl) =====
ipcMain.handle('trace:append', async (_, pid: string, sid: string, event: object) => {
  await ensureDirs()
  await mkdir(projectTracesDir(pid), { recursive: true })
  return new Promise<{ success: boolean; error?: string }>((resolve) => {
    appendFile(join(projectTracesDir(pid), sid + '.jsonl'), JSON.stringify(event) + '\n', (err) => {
      resolve(err ? { success: false, error: (err as Error).message } : { success: true })
    })
  })
})
ipcMain.handle('trace:read', async (_, pid: string, sid: string) => {
  await ensureDirs()
  try {
    const content = await readFile(join(projectTracesDir(pid), sid + '.jsonl'), 'utf-8')
    const events: unknown[] = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { events.push(JSON.parse(trimmed)) } catch { /* skip */ }
    }
    return { success: true, data: events }
  } catch {
    return { success: true, data: [] }
  }
})
ipcMain.handle('trace:delete', async (_, pid: string, sid: string) => {
  try {
    await unlink(join(projectTracesDir(pid), sid + '.jsonl'))
    return { success: true }
  } catch (e: any) {
    return { success: e?.code === 'ENOENT' }
  }
})

// ===== Request snapshots (per-project: projects/<pid>/snapshots/<sid>/<callId>.json)
// One full-request snapshot per llm_call, for the monitor panel's replay mode.
// The body can be large (full message view + decisions), so list reads a
// sidecar index.jsonl instead of every snapshot file; read loads one on demand.
ipcMain.handle('snapshot:write', async (_, pid: string, sid: string, callId: string, data: object) => {
  try {
    const dir = sessionSnapshotsDir(pid, sid)
    await mkdir(dir, { recursive: true })
    // Two-step write (snapshot body → index row). Not atomic — the replay side
    // tolerates a missing snapshot (degrades to "view unavailable, metrics only")
    // and a dangling index row (file read returns success:false). This matches
    // the design doc's "持久化非强一致 / 容忍快照缺失" trade-off.
    await writeFile(join(dir, callId + '.json'), JSON.stringify(data), 'utf-8')
    const meta = {
      callId: (data as { callId?: string }).callId ?? callId,
      ts: (data as { ts?: number }).ts ?? Date.now(),
      modelConfigId: (data as { modelConfigId?: string }).modelConfigId ?? '',
      round: (data as { round?: number }).round ?? 0,
      turnId: (data as { turnId?: string }).turnId ?? ''
    }
    await new Promise<void>((resolve, reject) => {
      appendFile(join(dir, 'index.jsonl'), JSON.stringify(meta) + '\n', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('snapshot:list', async (_, pid: string, sid: string) => {
  try {
    const content = await readFile(join(sessionSnapshotsDir(pid, sid), 'index.jsonl'), 'utf-8')
    const metas: unknown[] = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { metas.push(JSON.parse(trimmed)) } catch { /* skip malformed row */ }
    }
    return { success: true, data: metas }
  } catch {
    // No index yet (new session / never monitored) → empty list, not an error.
    return { success: true, data: [] }
  }
})

ipcMain.handle('snapshot:read', async (_, pid: string, sid: string, callId: string) => {
  try {
    const content = await readFile(join(sessionSnapshotsDir(pid, sid), callId + '.json'), 'utf-8')
    return { success: true, data: JSON.parse(content) }
  } catch (e: any) {
    // Missing snapshot (dangling index row, or never written) → signal "view
    // unavailable" to the panel rather than erroring; the panel shows metrics
    // only when this happens (design doc: 容忍快照缺失).
    return { success: false, error: e?.code === 'ENOENT' ? 'snapshot not found' : e.message }
  }
})

ipcMain.handle('snapshot:deleteSession', async (_, pid: string, sid: string) => {
  try {
    await rm(sessionSnapshotsDir(pid, sid), { recursive: true, force: true })
    return { success: true }
  } catch (e: any) {
    return { success: e?.code === 'ENOENT' }
  }
})

// ===== Delete a project's entire data bucket (traces + stats) =====
ipcMain.handle('project:delete', async (_, pid: string) => {
  try {
    await rm(join(PROJECTS_DATA_DIR(), pid), { recursive: true, force: true })
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
    // rules — clearing the directory wipes both. Per-project traces+stats live
    // under projects/<pid>/ — wipe the whole bucket dir.
    await clearFlatFiles(SESSIONS_DIR())
    await rm(PROJECTS_DATA_DIR(), { recursive: true, force: true })
    await mkdir(PROJECTS_DATA_DIR(), { recursive: true })
    await writeJson(join(DATA_DIR(), 'index.json'), [])
    await unlink(join(DATA_DIR(), 'allowlist.json')).catch(() => undefined) // vestigial
    // Reset projects to a fresh default WITH a real working dir, and restore a
    // complete global AgentConfig (sandbox/policy are the project-fallback defaults).
    await writeJson(PROJECTS_FILE(), [await buildDefaultProject()])
    await writeJson(join(DATA_DIR(), 'config.json'), {
      systemPrompt: '',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      // Restore the COMPLETE AgentConfig so the file (the single source of
      // truth) holds every field the store self-heals from — omitting these
      // left a partial file that only recovered via mergeConfig on next load.
      toolHarness: { enabled: false },
      identity: { enabled: false }
    })
    // NOTE: models.json is intentionally left untouched.
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
})

app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() }) })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
