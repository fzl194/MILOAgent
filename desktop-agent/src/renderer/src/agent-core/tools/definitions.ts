import type { ToolDefinition } from '../types'

export const READ_FILE_TOOL: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file at the given path.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' }
    },
    required: ['path']
  }
}

export const WRITE_FILE_TOOL: ToolDefinition = {
  name: 'write_file',
  description: 'Write content to a file. Creates the file if it does not exist.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative file path. The field name MUST be "path" (do not use filePath, filename, file, or key).'
      },
      content: { type: 'string', description: 'The content to write' }
    },
    required: ['path', 'content']
  }
}

export const RUN_SHELL_TOOL: ToolDefinition = {
  name: 'run_shell',
  description: 'Execute a shell command and return stdout and stderr.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' }
    },
    required: ['command']
  }
}

export const ALL_TOOLS: ToolDefinition[] = [READ_FILE_TOOL, WRITE_FILE_TOOL, RUN_SHELL_TOOL]
