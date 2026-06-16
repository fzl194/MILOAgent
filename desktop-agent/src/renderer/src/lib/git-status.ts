/**
 * P2 context-org — git status tail injection.
 *
 * `git status` is a per-turn-varying piece of context: the user may have
 * committed, switched branches, or edited files between turns. It MUST go
 * into the volatile slot (latest user message tail) — putting it in the
 * system prompt prefix would invalidate the cache every turn.
 *
 * Design contract:
 *  - READ-ONLY. Bypasses the safety classifier entirely (it cannot mutate).
 *  - Best-effort: missing git, non-git dir, IPC error, 3s timeout → silently
 *    return ''. Memory is best-effort, the same way project memory is.
 *  - Cached per projectId for 60s — an active user typing in a repo
 *    shouldn't pay for one IPC per keystroke.
 *  - The format is a single <git status>…</git status> block, or '' when
 *    there's nothing to say (e.g. clean repo, no git, timeout).
 *
 * The wrapping (block tags, trimming) is the formatter's job; the IPC just
 * returns raw stdout. The cache stores raw stdout; we re-wrap each call so
 * the formatter stays the single source of truth for the output shape.
 *
 * See docs/2026-06-15-desktop-agent-上下文组织管理演进.md (P2).
 */

/** Max stdout the main process will hand back; the IPC enforces the cap. */
const MAX_STDOUT_CHARS = 4096

/** Per-project cache TTL. 60s balances IPC cost against staleness. */
const CACHE_TTL_MS = 60_000

interface CacheEntry {
  stdout: string
  at: number
}

/** Module-scoped cache. Cleared on `clearGitStatusCache` (tests, "new project"). */
const cache = new Map<string, CacheEntry>()

/**
 * Wrap raw `git status` stdout in the tail-block shape. Empty input → empty
 * output. Pure; the unit tests pin the exact format.
 */
export function formatGitStatusBlock(stdout: string): string {
  const trimmed = stdout.trim()
  if (!trimmed) return ''
  return `<git status>\n${trimmed}\n</git status>`
}

/** Read the cached stdout for a project if still fresh. */
export function getCachedGitStatus(projectId: string, now: number = Date.now()): string | undefined {
  const entry = cache.get(projectId)
  if (!entry) return undefined
  if (now - entry.at > CACHE_TTL_MS) {
    cache.delete(projectId)
    return undefined
  }
  return entry.stdout
}

/** Store a fresh stdout for a project. No TTL check here — caller decides. */
export function setCachedGitStatus(projectId: string, stdout: string, now: number = Date.now()): void {
  cache.set(projectId, { stdout, at: now })
}

/** Drop a single project's cache (e.g. on project delete / dir change). */
export function invalidateGitStatusCache(projectId?: string): void {
  if (projectId === undefined) {
    cache.clear()
  } else {
    cache.delete(projectId)
  }
}

/**
 * Fetch (or hit cache for) the tail block for a turn. Returns '' on any
 * failure — never throws and never blocks the turn. The IPC failure modes
 * (ENOENT, timeout, non-git dir) are all swallowed here so chat-store can
 * blindly concatenate the result.
 *
 * `effectiveCwd` may be undefined for sessions with no project / no dir.
 * `projectId` keys the cache; pass '' to disable caching (effectively a
 * one-shot read).
 */
export async function fetchGitStatusTail(
  effectiveCwd: string | undefined,
  projectId: string
): Promise<string> {
  // Cache hit (and still fresh) → re-wrap without an IPC.
  if (projectId) {
    const cached = getCachedGitStatus(projectId)
    if (cached !== undefined) return formatGitStatusBlock(cached)
  }
  // No cwd → nothing to read; cache the '' so we don't keep retrying.
  if (!effectiveCwd) {
    if (projectId) setCachedGitStatus(projectId, '')
    return ''
  }

  let stdout: string | null = null
  try {
    const res = await window.electronAPI.gitStatus(effectiveCwd)
    if (res?.success && typeof res.data?.stdout === 'string') {
      stdout = res.data.stdout
    }
  } catch {
    // IPC / bus failure: best-effort, swallow. The IPC handler itself also
    // catches errors and returns { success: false } — the catch here is just
    // belt-and-suspenders for the renderer-side bridge.
  }

  if (stdout == null) {
    if (projectId) setCachedGitStatus(projectId, '')
    return ''
  }
  // Defensive cap: even though the IPC already caps, a future contract change
  // shouldn't be able to blow up the system prompt.
  const capped = stdout.length > MAX_STDOUT_CHARS ? stdout.slice(0, MAX_STDOUT_CHARS) : stdout
  if (projectId) setCachedGitStatus(projectId, capped)
  return formatGitStatusBlock(capped)
}
