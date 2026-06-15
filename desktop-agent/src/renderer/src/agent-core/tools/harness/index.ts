// Tool harness barrel. See docs/2026-06-15-工具层harness演进与安全.md.

export { zodToJsonSchema } from './schema'
export type { JsonSchema7 } from './schema'

export { RecoverableToolError, FatalToolError, isRecoverable } from './errors'

export { defineTool, runTool, toolToDefinition } from './tool'
export type {
  Tool,
  ToolDef,
  ToolContext,
  ToolRunResult,
  RawToolResult,
  ToolPermissionResult,
  PermissionBehavior
} from './tool'

export { ToolRegistry } from './registry'

// read_file is the P1 reference tool; buildToolRegistry wires the registry the
// loop consumes when the harness flag is on.
export { ReadFileTool } from './tools/read-file'
export { withLineNumbers, isBinaryText, formatReadFailure } from './tools/read-file'
export { buildToolRegistry } from './build-registry'
