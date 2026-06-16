// Pure workspace-path safety helpers. No I/O, no config reads — the IPC
// handler resolves sandbox/root and passes them in. This module is the hard
// backstop (P2): defense-in-depth against a bypassed renderer writing
// outside the workspace. Mirrors the read defense (P1 fix): the caller must
// canonicalize BOTH the candidate path AND the workspace root (realpath)
// before calling enforceWorkspacePath, so symlinks in either side can't
// escape the boundary.

export type Sandbox = 'read-only' | 'workspace-write' | 'full-access'

export interface PathCheck {
  allowed: boolean
  reason?: string
}

/** Resolve `.` and `..` segments in a slash-normalized path. Defense in depth
 *  for the inside check: even if a caller forgets to realpath, string-level
 *  `..` cannot escape the workspace. Empty / `.` segments are dropped; `..`
 *  pops the previous segment (rooted at the first non-empty segment so a
 *  leading `..` cannot walk off the front of an absolute path). */
function resolveDots(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') {
      if (out.length) out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}

/** String-only inside check. Both inputs are absolute; we normalize slashes
 *  AND resolve `..`/`.` so traversal cannot prefix-spoof. The caller is
 *  still expected to canonicalize both sides via realpath first (to defeat
 *  symlink-based escapes); this is the string-level safety net. */
export function isInsideWorkspacePath(parent: string, child: string): boolean {
  const p = resolveDots(parent), c = resolveDots(child)
  if (p === c) return true
  return c.startsWith(p + '/')
}

/** Enforce the workspace boundary. `full-access` opts out. Otherwise the
 *  candidate must be inside `root` (the canonicalized workspace root). */
export function enforceWorkspacePath(
  resolved: string,
  sandbox: Sandbox,
  root: string
): PathCheck {
  if (sandbox === 'full-access') return { allowed: true }
  if (!isInsideWorkspacePath(root, resolved)) {
    return {
      allowed: false,
      reason: `拒绝写入工作区之外的文件:${resolved}(工作区根 ${root})`
    }
  }
  return { allowed: true }
}
