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
  AllowlistEntry
} from '../types'

export interface ClassifyContext {
  sandbox: SandboxMode
  workspaceRoot?: string
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
  { re: /\biex\b|\bInvoke-Expression\b/i, label: 'PowerShell 动态执行' }
]

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
  // Reads are intrinsically safe.
  if (name === 'read_file') {
    return { level: 'safe', reason: '读取文件', patterns: [] }
  }

  if (name === 'write_file') {
    const path = String(args.path ?? '')
    const outside = !isInsideWorkspace(path, ctx.workspaceRoot)
    const pat = '^' + escapeRegex(normalizePath(path)) + '$'
    if (outside) {
      return {
        level: 'dangerous',
        reason: `写入工作区根之外：${path}`,
        patterns: [pat]
      }
    }
    return { level: 'write', reason: `写入文件：${path}`, patterns: [pat] }
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
        return { level: 'network', reason: '涉及网络操作', patterns: ['^' + escapeRegex(cmd.trim()) + '$'] }
      }
    }
    for (const re of SAFE_READ) {
      // Only auto-run a read command if it has NO side-effect metacharacters —
      // otherwise `cat a > b`, `ls | xargs rm`, `git …`-style chains slip through.
      if (!SIDE_EFFECT_META.test(cmd) && re.test(cmd)) {
        return { level: 'safe', reason: '只读命令', patterns: [] }
      }
    }
    return {
      level: 'write',
      reason: '可能修改系统状态的命令',
      patterns: ['^' + escapeRegex(cmd.trim()) + '$']
    }
  }

  return { level: 'write', reason: '未知工具', patterns: [] }
}

// ---------------------------------------------------------------------------
// Allowlist matching
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

/** True if an allowlist entry pre-approves this call (global or session scope). */
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
      // A malformed remembered pattern shouldn't crash classification.
      continue
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// decide() — combine intrinsic risk with sandbox + policy + allowlist
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
  allowlisted: boolean
): Decision {
  const { level } = assessment

  // 1) Read-only sandbox: only `read_file` is permitted. Every shell command is
  //    blocked (even "ls"-style reads) because shell can't be guaranteed
  //    side-effect-free on a personal build with no kernel sandbox.
  if (ctx.sandbox === 'read-only' && name !== 'read_file') {
    return { action: 'deny', assessment, reason: '只读沙箱下禁止写入与命令执行' }
  }

  // 2) Safe reads always run automatically.
  if (level === 'safe') {
    return { action: 'auto', assessment, reason: assessment.reason }
  }

  // 3) An explicit allowlist hit auto-runs (except dangerous — never allowlisted).
  if (allowlisted && level !== 'dangerous') {
    return { action: 'auto', assessment, reason: `${assessment.reason}（已记住并自动批准）` }
  }

  // 4) Dangerous always asks, in every policy.
  if (level === 'dangerous') {
    return { action: 'ask', assessment, reason: assessment.reason }
  }

  // 5) Network always asks (sensitive + prompt-injection vector).
  if (level === 'network') {
    return { action: 'ask', assessment, reason: assessment.reason }
  }

  // 6) Plain writes: depend on policy.
  //    auto → run; on-request → ask; untrusted → ask.
  if (level === 'write') {
    if (policy === 'auto') return { action: 'auto', assessment, reason: assessment.reason }
    return { action: 'ask', assessment, reason: assessment.reason }
  }

  return { action: 'ask', assessment, reason: assessment.reason }
}
