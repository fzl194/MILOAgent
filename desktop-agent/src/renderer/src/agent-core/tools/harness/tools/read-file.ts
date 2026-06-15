// read_file — the first harness tool (P1). Demonstrates the defineTool contract
// end to end: Zod input schema, read-only + concurrency-safe metadata, an
// allow checkPermissions, and a call() that leans on the main-process defense
// layer (device/special-file refusal, size cap, canonicalize) while adding
// renderer-side shaping: line numbering, binary guard, and model-facing hints
// on failure. Error-message construction is split into pure helpers so the
// behavior is unit-testable without mocking window.electronAPI.

import { z } from 'zod/v4'

import { RecoverableToolError } from '../errors'
import { defineTool } from '../tool'

// Single source: runtime validation (safeParse via runTool), wire JSON schema
// (via toolToDefinition), and the TS input type.
const readFileSchema = z.object({
  path: z.string().describe('Absolute or relative file path to read')
})

export type ReadFileInput = z.infer<typeof readFileSchema>

// Matches the main-process READ_MAX_BYTES; surfaced in the oversized-file hint.
const MAX_SIZE_HINT = 2 * 1024 * 1024

/** Number each line cat -n style (6-wide, tab-separated) for model readability. */
export function withLineNumbers(content: string): string {
  const lines = content.split('\n')
  return lines.map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n')
}

/** True if the content looks binary (contains a NUL byte). Text files never do. */
export function isBinaryText(content: string): boolean {
  return content.includes('\0')
}

/** Shape a failed readFile result into a model-facing {message, hint}. Pure —
 *  no I/O — so it can be unit tested against a synthetic failure object. */
export function formatReadFailure(res: {
  error?: string
  truncated?: boolean
  bytes?: number
}): { message: string; hint?: string } {
  const err = res.error ?? '读取失败'
  if (res.truncated) {
    return {
      message: `文件过大(${res.bytes ?? '?'} 字节,上限 ${MAX_SIZE_HINT} 字节),未读取`,
      hint: '用 run_shell 的 sed -n "1,200p" / head -n / tail -n 按行范围分段读取'
    }
  }
  const notFound = /ENOENT|no such file/i.test(err)
  return {
    message: `读取失败:${err}`,
    hint: notFound ? '文件不存在,确认路径正确(可用 run_shell 的 ls/dir 列出目录)' : undefined
  }
}

export const ReadFileTool = defineTool({
  name: 'read_file',
  description: 'Read the contents of a file at the given path.',
  inputSchema: readFileSchema,
  // Self-bounds via the main-process size cap; setting Infinity avoids the
  // Read→persist→Read loop (Claude Code Read does the same).
  maxResultSizeChars: Infinity,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: async () => ({ behavior: 'allow' }), // read is intrinsically safe
  call: async (input, ctx) => {
    const res = await window.electronAPI.readFile(input.path, ctx.cwd)
    if (!res.success) {
      const { message, hint } = formatReadFailure(res)
      throw new RecoverableToolError(message, hint)
    }
    const data = (res.data as string) ?? ''
    if (isBinaryText(data)) {
      throw new RecoverableToolError(
        '文件疑似二进制(含 NUL 字节),read_file 仅支持文本',
        '若是图片/数据文件,说明用途或改用专用读取方式'
      )
    }
    return { content: withLineNumbers(data), isError: false, bytes: data.length }
  }
})
