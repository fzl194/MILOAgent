// Tool contract + harness lifecycle. Aligns with Claude Code's src/Tool.ts
// (name / inputSchema Zod / maxResultSizeChars / isReadOnly / isConcurrencySafe
// / validateInput / checkPermissions / call) — with one deliberate divergence
// documented below.
//
// Authorization (classify → decide → approval gate) is OWNED BY the agent loop
// and reused as-is; this harness does NOT re-implement it. `checkPermissions`
// here is a per-tool self-check that runs inside `runTool`, fail-closed by
// default. The two layers compose: the loop gates before calling runTool; the
// tool self-checks again defensively.

import type { z, ZodTypeAny } from 'zod/v4'

import type { ToolDefinition } from '../../types'
import { RecoverableToolError } from './errors'
import { zodToJsonSchema } from './schema'

// ---------------------------------------------------------------------------
// Result & context shapes
// ---------------------------------------------------------------------------

/** A tool's raw output before the harness decides how to surface it. `truncated`
 *  / `bytes` let the harness append a "read the rest via …" hint. */
export interface RawToolResult {
  content: string
  isError: boolean
  truncated?: boolean
  bytes?: number
}

/** Per-call execution context. `cwd` is the turn-scoped project dir (frozen by
 *  the chat store); `signal` propagates user stop requests. */
export interface ToolContext {
  cwd?: string
  signal?: AbortSignal
}

export type PermissionBehavior = 'allow' | 'deny'

/** Result of a tool's permission self-check. `updatedInput` lets a tool
 *  normalize its input (e.g. resolve a relative path) before execution. */
export interface ToolPermissionResult {
  behavior: PermissionBehavior
  updatedInput?: Record<string, unknown>
  reason?: string
}

// ---------------------------------------------------------------------------
// Tool contract
// ---------------------------------------------------------------------------

export interface Tool<Input extends ZodTypeAny = ZodTypeAny> {
  readonly name: string
  readonly description: string
  readonly inputSchema: Input
  /** Max content chars before the result is truncated (with a truncated=true
   *  flag). Set to Infinity for tools that self-bound (e.g. read_file, which
   *  already caps via the main-process size limit). */
  readonly maxResultSizeChars: number
  /** Whether the call has no side effects. Default false (assume writes). */
  isReadOnly(input: z.infer<Input>): boolean
  /** Whether the call is safe to run concurrently with others. Default false. */
  isConcurrencySafe(input: z.infer<Input>): boolean
  /** Per-tool permission self-check. DELIBERATE DIVERGENCE from Claude Code:
   *  Claude Code defaults this to {behavior:'allow'} (defers entirely to the
   *  general permission system). We default to DENY (fail-closed) because we
   *  have no kernel sandbox — a tool that forgets to declare itself safe is
   *  blocked, not auto-run. read_file overrides to allow. */
  checkPermissions(input: z.infer<Input>, ctx: ToolContext): Promise<ToolPermissionResult>
  /** Optional business-value validation, run after Zod schema parsing and before
   *  call(). Throw RecoverableToolError to reject with a model-facing message. */
  validateInput?(input: z.infer<Input>, ctx: ToolContext): Promise<void>
  /** The actual side-effect / read. Throw RecoverableToolError for model-facing
   *  failures (the harness surfaces the message + hint). */
  call(input: z.infer<Input>, ctx: ToolContext): Promise<RawToolResult>
}

// ---------------------------------------------------------------------------
// defineTool factory
// ---------------------------------------------------------------------------

/** Keys defineTool supplies a default for. A ToolDef may omit these; the
 *  resulting Tool always has them. */
type DefaultableKeys = 'isReadOnly' | 'isConcurrencySafe' | 'checkPermissions'

/** Definition accepted by defineTool: the defaultable methods are optional. */
export type ToolDef<Input extends ZodTypeAny = ZodTypeAny> = Omit<Tool<Input>, DefaultableKeys> &
  Partial<Pick<Tool<Input>, DefaultableKeys>>

const TOOL_DEFAULTS = {
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: (): Promise<ToolPermissionResult> =>
    Promise.resolve({ behavior: 'deny', reason: '未声明权限(fail-closed)' }),
}

/** Build a complete Tool from a definition, filling fail-closed defaults. */
export function defineTool<Input extends ZodTypeAny>(def: ToolDef<Input>): Tool<Input> {
  return { ...TOOL_DEFAULTS, ...def } as Tool<Input>
}

// ---------------------------------------------------------------------------
// runTool lifecycle: validate → validateInput → checkPermissions → call → shape
// ---------------------------------------------------------------------------

/** The output type of runTool: a RawToolResult plus an optional `denial` record
 *  (present when the tool's own checkPermissions refused) for trace. */
export type ToolRunResult = RawToolResult & { denial?: ToolPermissionResult }

function formatThrown(e: unknown): string {
  if (e instanceof RecoverableToolError) {
    return e.hint ? `${e.message}\n建议:${e.hint}` : e.message
  }
  if (e instanceof Error) return e.message
  return String(e)
}

/** Execute one tool call through the fixed lifecycle. Authorization is NOT done
 *  here — the loop already gated this call. Returns content + isError (+ truncated
 *  / bytes for the truncation hint). Every failure path returns a usable result;
 *  this never throws. */
export async function runTool(
  tool: Tool,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolRunResult> {
  // 1) Zod runtime validation (single source of truth, same schema as the wire).
  const parsed = tool.inputSchema.safeParse(args)
  if (!parsed.success) {
    const issues = parsed.error.issues
    const first = issues[0]
    const pathStr = first?.path?.length ? first.path.map(String).join('.') : '(root)'
    return { content: `参数校验失败:${pathStr} — ${first?.message ?? '未知错误'}`, isError: true }
  }
  const input = parsed.data

  // 2) validateInput — business-value checks (e.g. binary guard).
  try {
    await tool.validateInput?.(input, ctx)
  } catch (e) {
    return { content: formatThrown(e), isError: true }
  }

  // 3) checkPermissions — tool-level fail-closed self-check. Wrapped so the
  //  "never throws" contract holds even if a tool's checkPermissions rejects.
  let perm: ToolPermissionResult
  try {
    perm = await tool.checkPermissions(input, ctx)
  } catch (e) {
    return { content: formatThrown(e), isError: true }
  }
  if (perm.behavior === 'deny') {
    return { content: perm.reason ?? '工具拒绝执行', isError: true, denial: perm }
  }

  // 4) call.
  let raw: RawToolResult
  try {
    raw = await tool.call(input, ctx)
  } catch (e) {
    return { content: formatThrown(e), isError: true }
  }

  // 5) Shape: enforce maxResultSizeChars (Infinity bypasses — tool self-bounds).
  if (Number.isFinite(tool.maxResultSizeChars) && raw.content.length > tool.maxResultSizeChars) {
    return {
      ...raw,
      content: raw.content.slice(0, tool.maxResultSizeChars),
      truncated: true,
      bytes: raw.content.length,
    }
  }
  return raw
}

// ---------------------------------------------------------------------------
// Wire-schema bridge (P1 keeps ALL_TOOLS unchanged; this is the P2 seam)
// ---------------------------------------------------------------------------

/** Convert a Tool to the ToolDefinition shape the LLM provider consumes. The
 *  parameters come from zodToJsonSchema; cast is required because the native
 *  output carries extra JSON-Schema fields ($schema, additionalProperties) the
 *  strict ToolParameterSchema interface doesn't list — harmless on the wire. */
export function toolToDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.inputSchema) as unknown as ToolDefinition['parameters'],
  }
}
