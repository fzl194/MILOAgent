// Safety policy engine (pure functions, no side effects, no I/O).
//
// Two stages:
//   1. classify()  — intrinsic risk of a tool call (safe | write | network | dangerous)
//   2. decide()    — given the risk + active sandbox + approval policy + allowlist,
//                    decide the action: 'auto' (run without asking) | 'ask' | 'deny'
//
// Keeping this pure lets it be unit-tested and reused by the AgentLoop before
// every tool execution. Personal-build note: there is no kernel-level sandbox;
// the "sandbox" here is a path-scope rule for file writes plus approval gating
// for everything else.

import type {
  RiskLevel,
  RiskAssessment,
  SandboxMode,
  ApprovalPolicy,
  AllowlistEntry,
  PermissionRule
} from '../types'

export interface ClassifyContext {
  sandbox: SandboxMode
  workspaceRoot?: string
  cwd?: string // turn-scoped project dir; the loop resolves relative paths against it
  /** Merged permission rules (session first, then project). Unified replacement
   *  for the old allowlist + per-project commandRules. */
  rules?: PermissionRule[]
}

export type SafetyAction = 'auto' | 'ask' | 'deny'

// ---------------------------------------------------------------------------
// Path helpers (string-only; no Node `path` module so this runs in the renderer)
// ---------------------------------------------------------------------------

/** Normalize a path for case-insensitive, slash-agnostic comparison. */
export function normalizePath(p: string): string {
  let s = p.trim().replace(/\\/g, '/')
  // Lowercase Windows drive letter (C:/ vs c:/) but keep the rest case-sensitive
  // so Unix paths aren't incorrectly folded.
  s = s.replace(/^([A-Z]):/i, (_m, d) => d.toLowerCase() + ':')
  // Collapse trailing slashes (but keep the root '/')
  s = s.replace(/\/+$/, '')
  return s
}

/** Escape a literal string into a regex source that matches it exactly. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Remember-pattern for write_file. When `root` (the project dir, ctx.cwd)
 *  is known and the file lives inside it, anchor on the ROOT so a single
 *  approval covers the whole project tree — otherwise the user must re-approve
 *  every subdirectory. This matches the Claude Code Write(dir/**) model with
 *  dir = project root. Falls back to the file's own directory when there is no
 *  root or the file is outside it; bare filenames (no directory) match exactly
 *  — never broaden a lone filename to the filesystem root. */
function writeFilePattern(path: string, root?: string): string {
  const norm = normalizePath(path)
  if (root) {
    // normalizePath collapses a lone '/' to '' (trailing-slash strip), so a
    // truthy `r` doubles as the guard against broadening to the filesystem root.
    const r = normalizePath(root)
    if (r && isInsideWorkspace(norm, r)) {
      return '^' + escapeRegex(r) + '/'
    }
  }
  const slash = norm.lastIndexOf('/')
  if (slash > 0) return '^' + escapeRegex(norm.slice(0, slash)) + '/'
  return '^' + escapeRegex(norm) + '$'
}

/** Remember-pattern for run_shell: the BASE command (first token) as an anchored
 *  prefix, so approving `mkdir x` auto-runs any `mkdir ...` (Claude Code
 *  Bash(cmd:*) style). Dangerous subcommands stay gated: classify() flags them
 *  first and decide() never auto-runs dangerous regardless of the allowlist. */
function baseCommandPattern(cmd: string): string {
  const base = (cmd.trim().split(/\s+/)[0] ?? '').trim()
  return '^' + escapeRegex(base) + '(\\s|$)'
}

/** Resolve `.` and `..` segments so `D:\repo\..\outside` can't prefix-spoof the
 *  workspace check. Symlinks/short paths still can't be canonicalized in the
 *  renderer (no realpath); the main process is the right place for a hard check
 *  if that threat model matters later. */
function resolveDots(p: string): string {
  const parts = normalizePath(p).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length) out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

/** True if `target` is inside (or equal to) `root`. Both may be absent. */
export function isInsideWorkspace(target: string, root?: string): boolean {
  if (!root) return true // no root configured → treat as inside (unrestricted)
  const t = resolveDots(target)
  const r = resolveDots(root)
  if (t === r) return true
  return t.startsWith(r + '/')
}

// ---------------------------------------------------------------------------
// Pattern tables
// ---------------------------------------------------------------------------

// Intrinsically dangerous operations. Each carries a human reason.
const DANGEROUS: { re: RegExp; label: string }[] = [
  { re: /\brm\s+-[rRfF]+\b/, label: '递归/强制删除' },
  { re: /\brmdir\s+\/s\b/i, label: '递归删除目录' },
  { re: /\bdel\s+\/[a-z]*s[a-z]*f/i, label: '递归强制删除' },
  { re: /\bformat\b/i, label: '格式化磁盘' },
  { re: /\bmkfs\b/, label: '创建文件系统' },
  { re: /\bdd\b[^;]*\bof=/, label: 'dd 写入设备/镜像' },
  { re: />\s*\/dev\/(sd|nvme|hd|disk)/, label: '直接写块设备' },
  { re: /:\s*\(\)\s*\{\s*:.*:\s*&\s*\}\s*;/, label: 'fork 炸弹' },
  { re: /\|\s*(sh|bash|zsh|fish|python\d?)\b/, label: '管道执行脚本（可能远程）' },
  { re: /\b(curl|wget|irm|iex)\b[^|]*\|\s*/, label: '下载并管道执行' },
  { re: /\bgit\s+push\b[^|;&]*(-f|--force)\b/, label: '强制推送' },
  { re: /\breg(exec)?\s+(add|delete|import|copy|load)/i, label: '修改注册表' },
  { re: /\bschtasks\s+\/(create|delete|change)/i, label: '修改计划任务' },
  { re: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i, label: '关机/重启' },
  { re: /\b(chown|chgrp)\s+-R\b/, label: '递归改属主' },
  { re: /\bchmod\s+-R\b/, label: '递归改权限' },
  { re: /\bgit\s+reset\s+--hard\b/, label: 'git 强制重置（丢弃改动）' },
  { re: /\bgit\s+clean\s+-[a-z]*f/, label: 'git 清理未跟踪文件' },
  { re: /\bfind\b[^;|&]*\s-delete\b/, label: 'find 删除文件' },
  { re: /\bsed\s+(-[A-Za-z]+\s+)*-i\b/, label: 'sed 原地改文件' },
  { re: /\biex\b|\bInvoke-Expression\b/i, label: 'PowerShell 动态执行' },
  // Long-flag / PowerShell equivalents of the short-form dangerous patterns.
  { re: /\brm\b[^|;&]*(-{1,2}(recursive|force|rf|fr|r|f)\b|--recursive|--force)/, label: 'rm 递归/强制删除' },
  { re: /\bRemove-Item\b[^|;&]*(-Recurse|-Force)/i, label: 'PowerShell 递归/强制删除' },
  // Interpreters executing INLINE code — an arbitrary code-execution primitive.
  // (Running a script FILE like `node x.js` is covered by HIGH_RISK_BASE below:
  // it stays 'write' but is never auto-run/remembered.) Inline -e/-c/-r bypass
  // the base-command check, so they must be caught here as dangerous.
  { re: /\b(node|deno|bun)\s+(-\w+\s+)*-e\b/, label: '解释器内联执行(node -e 等)' },
  { re: /\b(python[23]?|py)\s+(-\w+\s+)*-c\b/, label: '解释器内联执行(python -c)' },
  { re: /\b(ruby|perl)\s+(-\w+\s+)*-e\b/, label: '解释器内联执行(ruby/perl -e)' },
  { re: /\bphp\s+(-\w+\s+)*-r\b/, label: 'PHP 内联执行(-r)' },
  { re: /\b(bash|sh|zsh|ksh|fish)\s+(-\w+\s+)*-c\b/, label: 'shell -c 内联执行' },
  { re: /\b(powershell|pwsh)\s+(-\w+\s+)*-(Command|c)\b/i, label: 'PowerShell -Command 内联' },
  { re: /\bcmd\s+(-\w+\s+)*\/c\b/i, label: 'cmd /c 内联执行' },
  // Destructive copy/move/archive that bypass the rm-style detection.
  { re: /\bcp\b[^|;&]*\/dev\/null/, label: 'cp 清空文件(/dev/null)' },
  { re: /\btar\b[^|;&]*--remove-files/, label: 'tar 归档后删除源文件' },
  { re: /\bzip\b[^|;&]*\s-m\b/, label: 'zip -m 移动(删源)' },
  { re: /\btee\b[^|;&]*\/dev\/(sd|nvme|hd|disk)/, label: 'tee 写块设备' },
  // Disk / ownership / permission utilities (no safe auto-run form).
  { re: /\b(diskpart|cipher|takeown|icacls)\b/i, label: '磁盘/权限危险操作' },
  { re: /\bClear-Content\b/i, label: 'PowerShell 清空文件' },
  { re: /\bStart-Process\b/i, label: 'PowerShell 启动进程' },
  // Code-exec via awk/sed that have legit READ uses too — keep them out of
  // HIGH_RISK_BASE (would break `sed -n "1,200p"` / `awk '{print}'`) and use
  // precise DANGEROUS instead. Complex sed scripts may still slip; AST-level
  // detection is the future hardening.
  { re: /\bawk\b[^|;&]*\bsystem\s*\(/, label: 'awk system() 执行' },
  // GNU sed `e` flag executes the pattern space as a shell command: `sed 's/x/y/e'`.
  // Best-effort regex matching the `s/.../e'|"` form.
  { re: /\bsed\b[^|;&]*\bs\/[^\n|;&'"]*\/[^\n|;&'"]*e['"]/, label: 'sed e 命令执行 shell' }
]

// High-risk base commands: even if a specific dangerous pattern doesn't fire
// (e.g. an unusual flag spelling), an allow rule must NOT auto-run these — they
// always require asking. Defense-in-depth against classifier gaps.
// High-risk base commands: an allow rule must NOT auto-run these and (via the
// force-ask in decide) they always ask even under the 'auto' policy. Expanded
// beyond rm/format/… to include INTERPRETERS (node/python/ruby/perl/bash/…):
// a remembered interpreter rule would be a universal code-exec primitive
// (`node x.js` remembered → `node -e "evil"` would otherwise match and run).
// Defense-in-depth against prompt injection + classifier gaps.
const HIGH_RISK_BASE = /^(sudo\s+)?(rm|del|rmdir|format|mkfs|dd|shutdown|reboot|halt|poweroff|Remove-Item|Invoke-Expression|iex|node|deno|bun|python[23]?|py|ruby|perl|php|bash|sh|zsh|ksh|fish|powershell|pwsh|cmd|Start-Process|nu|xonsh|osascript|expect|tclsh|lua|jshell|ghci|pry|irb|tcc)\b/i

// Commands that reach the network (downloads, installs, remote git).
const NETWORK: RegExp[] = [
  /\b(curl|wget|nc|netcat|ssh|scp|sftp|ftp|telnet)\b/,
  /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i,
  /\b(pip|pip3|npm|yarn|pnpm|cargo|go|gem|uv|poetry)\s+(install|add|i|upgrade|up)\b/,
  /\bgit\s+(clone|fetch|pull|push)\b/,
  /\bapt(-get)?\s+(install|update|upgrade|remove)\b/,
  /\bdnf|yum|pacman|brew\s+(install|upgrade|uninstall)\b/
]

// Narrow read-only whitelist for auto-run. Deliberately EXCLUDES commands with
// destructive forms (git/sed/awk/find/cp/mv/chmod/rm/…) — those are handled by
// the dangerous/network/write checks and never auto-run. A command only counts
// as safe if it ALSO has no side-effect shell metacharacters (see hasSideEffects).
const SAFE_READ: RegExp[] = [
  /^\s*(ls|ll|la|pwd|cat|head|tail|wc|file|stat|du|df|env|whoami|date|uptime|uname|echo|printf|which|whereis|type|grep|egrep|fgrep|rg|ag|tree|bat|jq)\b/,
  /^\s*(dir|type|where|findstr|more|ver|vol)\b/i
]

// Shell constructs that can mutate state or chain destructive commands. Their
// presence disqualifies a command from the "safe read" path.
const SIDE_EFFECT_META = />>?|\||;|&&|\|\||`|\$\(/

// ---------------------------------------------------------------------------
// classify()
// ---------------------------------------------------------------------------

export function classify(
  name: string,
  args: Record<string, unknown>,
  ctx: ClassifyContext
): RiskAssessment {
  if (name === 'read_file') {
    // full-access: user opted in to no confinement — read anywhere, keep safe.
    if (ctx.sandbox === 'full-access') {
      return { level: 'safe', reason: '读取文件', patterns: [] }
    }
    // No workspace root at the classifier → main-process IPC guard is the hard
    // backstop (refuses reads outside the default workspace). Keep safe here to
    // avoid regressing pre-P1 UX; main is the boundary.
    if (!ctx.workspaceRoot) {
      return { level: 'safe', reason: '读取文件(主进程护栏)', patterns: [] }
    }
    const path = String(args.path ?? '')
    if (!isInsideWorkspace(path, ctx.workspaceRoot)) {
      // Outside-workspace read: ALWAYS ask, NO remember-pattern. A remembered
      // rule that auto-reads a path (e.g. ~/.ssh/id_rsa, ~/.desktop-agent/
      // models.json) is the exact hole the main-process backstop exists to
      // prevent. User must switch to full-access sandbox for truly unrestricted
      // reads.
      return { level: 'dangerous', reason: `读取工作区根之外:${path}`, patterns: [] }
    }
    return { level: 'safe', reason: '读取文件', patterns: [] }
  }

  if (name === 'write_file') {
    const path = String(args.path ?? '')
    // No workspace root configured → no confinement boundary. Fail-closed:
    // treat as dangerous (always ask) rather than silently unbounded. The
    // default project (dirPath=null) lands here; setting a project dir yields a
    // real boundary and the 'write' classification with remember-patterns.
    // (isInsideWorkspace still returns true for an absent root — that is a pure
    // geometric helper; the boundary *policy* is decided here.)
    if (!ctx.workspaceRoot) {
      return { level: 'dangerous', reason: '未配置工作区根,写入一律需确认', patterns: [] }
    }
    const outside = !isInsideWorkspace(path, ctx.workspaceRoot)
    if (outside) {
      // Outside the workspace is dangerous — never offer a remember-pattern
      // (consistent with dangerous run_shell: these must always ask).
      return { level: 'dangerous', reason: `写入工作区根之外:${path}`, patterns: [] }
    }
    return { level: 'write', reason: `写入文件:${path}`, patterns: [writeFilePattern(path, ctx.cwd)] }
  }

  if (name === 'run_shell') {
    const cmd = String(args.command ?? '')

    for (const d of DANGEROUS) {
      if (d.re.test(cmd)) {
        // Dangerous calls are NOT given a "remember" pattern — we never want a
        // one-click approval to silently auto-run destructive commands forever.
        return { level: 'dangerous', reason: `危险操作：${d.label}`, patterns: [] }
      }
    }
    for (const re of NETWORK) {
      if (re.test(cmd)) {
        return { level: 'network', reason: '涉及网络操作', patterns: [baseCommandPattern(cmd)] }
      }
    }
    for (const re of SAFE_READ) {
      // Only auto-run a read command if it has NO side-effect metacharacters —
      // otherwise `cat a > b`, `ls | xargs rm`, `git …`-style chains slip through.
      if (!SIDE_EFFECT_META.test(cmd) && re.test(cmd)) {
        return { level: 'safe', reason: '只读命令', patterns: [] }
      }
    }
    // High-risk base commands (interpreters, rm, …) are never given a
    // remember-pattern — a remembered interpreter rule would be a universal
    // code-exec primitive. decide() also force-asks them; this just avoids
    // persisting a rule that could never fire (and must never fire) as auto.
    const patterns = HIGH_RISK_BASE.test(cmd) ? [] : [baseCommandPattern(cmd)]
    return {
      level: 'write',
      reason: '可能修改系统状态的命令',
      patterns
    }
  }

  return { level: 'write', reason: '未知工具', patterns: [] }
}

// ---------------------------------------------------------------------------
// Allowlist matching (test utility for the remember-pattern feature)
// ---------------------------------------------------------------------------

/** The subject string an allowlist pattern is matched against for a tool call. */
function subjectFor(name: string, args: Record<string, unknown>): string | null {
  if (name === 'write_file') {
    const p = String(args.path ?? '')
    return p ? normalizePath(p) : null
  }
  if (name === 'run_shell') {
    const c = String(args.command ?? '').trim()
    return c || null
  }
  return null
}

/** True if an allowlist entry pre-approves this call. Used by the
 *  remember-pattern tests; production uses PermissionRule via decide(). */
export function allowlistAllows(
  entries: AllowlistEntry[],
  name: string,
  args: Record<string, unknown>
): boolean {
  const subject = subjectFor(name, args)
  if (!subject) return false
  for (const e of entries) {
    if (e.name !== name && e.name !== '*') continue
    try {
      if (new RegExp(e.pattern).test(subject)) return true
    } catch {
      continue
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// decide() — combine intrinsic risk with sandbox + policy + permission rules
// ---------------------------------------------------------------------------

export interface Decision {
  action: SafetyAction
  assessment: RiskAssessment
  /** Why this action was chosen (shown on the approval card / denial). */
  reason: string
}

export function decide(
  assessment: RiskAssessment,
  name: string,
  ctx: ClassifyContext,
  policy: ApprovalPolicy,
  subject?: string
): Decision {
  const { level } = assessment

  // 1) Read-only sandbox: only `read_file` is permitted. Every shell command is
  //    blocked (even "ls"-style reads) because shell can't be guaranteed
  //    side-effect-free on a personal build with no kernel sandbox.
  if (ctx.sandbox === 'read-only' && name !== 'read_file') {
    return { action: 'deny', assessment, reason: '只读沙箱下禁止写入与命令执行' }
  }

  // 1.5) Unified permission rules (merged session > project). Evaluation is a
  //      true deny > allow: FIRST scan every rule for a deny match (deny always
  //      wins, regardless of scope/order), THEN scan for an allow match. An empty
  //      shell command or write path is denied outright. allow auto-runs ONLY for
  //      non-dangerous, non-high-risk-base shell commands without shell
  //      metacharacters/newlines (chaining bypass). Malformed regex is skipped.
  if (name === 'run_shell' && subject !== undefined && !subject.trim()) {
    return { action: 'deny', assessment, reason: '命令为空' }
  }
  if (name === 'write_file' && subject !== undefined && !subject.trim()) {
    return { action: 'deny', assessment, reason: '路径为空' }
  }
  // Hoisted shell-risk flags: reused by the allow-rule pass below AND by the
  // force-ask in step 4.5. Computed from the trimmed command (run_shell only).
  const subjCmd = name === 'run_shell' ? (subject?.trim() ?? '') : ''
  const hasShellMeta = /[|;&`$>\r\n]/.test(subjCmd)
  const highRisk = HIGH_RISK_BASE.test(subjCmd)
  if (ctx.rules && subject) {
    // Normalize file paths the same way the stored rule patterns were built
    // (classify() runs the path through normalizePath: lowercase drive,
    // backslash→slash). Without this, a rule remembered for `D:\proj\a.txt`
    // wouldn't match the raw subject `D:\proj\a.txt` in a later session/write.
    const subj =
      name === 'write_file' || name === 'read_file' ? normalizePath(subject.trim()) : subject.trim()
    const matches = (pat: string): boolean => {
      try { return new RegExp(pat).test(subj) } catch { return false }
    }
    const applies = (rule: { tool?: string }): boolean => !rule.tool || rule.tool === name || rule.tool === '*'
    // Pass 1: deny (highest priority).
    for (const rule of ctx.rules) {
      if (rule.action === 'deny' && applies(rule) && matches(rule.pattern)) {
        return { action: 'deny', assessment, reason: `规则拒绝（匹配 ${rule.pattern}）` }
      }
    }
    // Pass 2: allow. Blocked for dangerous, high-risk-base, or shell-metachar
    // commands (hasShellMeta / highRisk hoisted above the rules block).
    if (level !== 'dangerous' && !hasShellMeta && !highRisk) {
      for (const rule of ctx.rules) {
        if (rule.action === 'allow' && applies(rule) && matches(rule.pattern)) {
          return { action: 'auto', assessment, reason: `规则允许（匹配 ${rule.pattern}）` }
        }
      }
    }
  }

  // 2) Safe reads always run automatically.
  if (level === 'safe') {
    return { action: 'auto', assessment, reason: assessment.reason }
  }

  // 3) Dangerous always asks, in every policy (never auto, even via rules).
  if (level === 'dangerous') {
    return { action: 'ask', assessment, reason: assessment.reason }
  }

  // 4) Network always asks (sensitive + prompt-injection vector).
  if (level === 'network') {
    return { action: 'ask', assessment, reason: assessment.reason }
  }

  // 4.5) Shell commands that can execute arbitrary code or chain ALWAYS ask —
  //      never auto-run (even under the permissive 'auto' policy) and never
  //      remembered (the allow-rule pass above already skips them). This is the
  //      prompt-injection defense: a model-emitted interpreter call
  //      (`node x.js`, `python bot.py`) or a chained command
  //      (`echo a && rm …`, `curl … | sh`) must surface to the user.
  if (name === 'run_shell' && (hasShellMeta || highRisk)) {
    return {
      action: 'ask',
      assessment,
      reason: highRisk ? '高危/解释器命令,需确认' : '含 shell 元字符,需确认'
    }
  }

  // 5) Plain writes: depend on policy.
  //    auto → run; on-request → ask; untrusted → ask.
  if (level === 'write') {
    if (policy === 'auto') return { action: 'auto', assessment, reason: assessment.reason }
    return { action: 'ask', assessment, reason: assessment.reason }
  }

  return { action: 'ask', assessment, reason: assessment.reason }
}
