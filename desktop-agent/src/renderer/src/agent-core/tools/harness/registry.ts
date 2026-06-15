// Tool registry: name → Tool lookup, used by the agent loop to route a tool call
// to its harness definition when the harness flag is on. P1 holds only
// read_file; later phases register write_file / run_shell here too.

import type { ToolDefinition } from '../../types'
import { toolToDefinition, type Tool } from './tool'

export class ToolRegistry {
  private readonly map = new Map<string, Tool>()

  register(tool: Tool): void {
    this.map.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.map.get(name)
  }

  /** All registered tools as wire ToolDefinitions (for the LLM provider). */
  definitions(): ToolDefinition[] {
    return [...this.map.values()].map(toolToDefinition)
  }
}
