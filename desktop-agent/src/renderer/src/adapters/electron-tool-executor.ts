import type { ToolExecutor, ToolResult } from '../agent-core/types'

export class ElectronToolExecutor implements ToolExecutor {
  // Turn-scoped working directory (the active project's dirPath), frozen per
  // turn by chat-store via setCwd(). Reading the live active project at execute
  // time would race if the user switches project mid-turn (during an approval
  // wait) — the model/safety would see one cwd while tools run in another.
  private cwd: string | undefined

  setCwd(dir?: string): void {
    this.cwd = dir
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    try {
      const cwd = this.cwd
      let result: { success: boolean; data?: any; error?: string }

      switch (name) {
        case 'read_file':
          result = await window.electronAPI.readFile(args.path as string, cwd)
          break
        case 'write_file':
          result = await window.electronAPI.writeFile(args.path as string, args.content as string, cwd)
          break
        case 'run_shell': {
          const runP = window.electronAPI.runShell(args.command as string, cwd)
          // If a cancel signal fires mid-run, kill the tracked child process.
          // The runShell promise then resolves (via the close handler) and we
          // surface a clear "aborted" result rather than a half-finished one.
          if (signal) {
            let onAbort: (() => void) | undefined
            const abortP = new Promise<never>((_, reject) => {
              if (signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'))
                return
              }
              onAbort = () => {
                void window.electronAPI.cancelShell()
                reject(new DOMException('Aborted', 'AbortError'))
              }
              signal.addEventListener('abort', onAbort, { once: true })
            })
            try {
              result = await Promise.race([runP, abortP])
            } finally {
              // Always detach so a long tool round doesn't pile up listeners on
              // the same signal, and stop() doesn't fire cancelShell repeatedly.
              if (onAbort) signal.removeEventListener('abort', onAbort)
            }
          } else {
            result = await runP
          }
          break
        }
        default:
          return { toolCallId: '', name, content: `Unknown tool: ${name}`, isError: true }
      }

      if (!result.success) {
        return { toolCallId: '', name, content: result.error ?? 'Unknown error', isError: true }
      }

      let content: string
      if (result.data === undefined || result.data === null) content = 'Success'
      else if (typeof result.data === 'string') content = result.data
      else content = JSON.stringify(result.data, null, 2)

      return { toolCallId: '', name, content, isError: false }
    } catch (err: any) {
      // An AbortError means the user stopped the run — surface it cleanly.
      if (err?.name === 'AbortError') {
        return { toolCallId: '', name, content: '用户已停止', isError: true }
      }
      return { toolCallId: '', name, content: err?.message ?? String(err), isError: true }
    }
  }
}
