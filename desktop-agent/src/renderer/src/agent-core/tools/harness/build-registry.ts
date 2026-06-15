// Assemble the harness tool registry. P1 registers only read_file; later
// phases add write_file / run_shell here. chat-store calls this (gated by the
// toolHarness.enabled flag) to inject the registry into the agent loop.

import { ToolRegistry } from './registry'
import { ReadFileTool } from './tools/read-file'

export function buildToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(ReadFileTool)
  return registry
}
