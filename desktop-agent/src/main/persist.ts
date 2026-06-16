import { join } from 'path'

// Pure output-persistence decision for large shell results. The caller (main
// process IPC handler) does the actual writeFile; this module only DECIDES
// inline-vs-persisted and SHAPES the preview. Keeping it pure = unit-testable
// and reusable from the harness shape() once run_shell migrates (P3).

export type PersistDecision =
  | { kind: 'inline'; content: string }
  | { kind: 'persisted'; preview: string; path: string; bytes: number; truncated: true }

export interface PersistOptions {
  /** Stable id used in the persisted file name (e.g. a tool-call id). */
  id: string
  /** Directory the persisted file should live in (caller creates + writes). */
  baseDir: string
  /** Content-length threshold. <= maxChars → inline; > maxChars → persist. */
  maxChars: number
  /** Size of the preview window (in chars) taken from the head of the content. */
  previewBytes: number
}

export function decideShellOutputPersist(content: string, opts: PersistOptions): PersistDecision {
  if (content.length <= opts.maxChars) {
    return { kind: 'inline', content }
  }
  // Persist: take a preview aligned to the last newline within the window so
  // we never cut mid-line. If no newline exists in the window, use the full
  // window as-is (avoids degenerate 1-char previews when the first char is
  // '\n' or when there are no newlines at all).
  const window = content.slice(0, opts.previewBytes)
  const lastNl = window.lastIndexOf('\n')
  const aligned = lastNl > 0 ? window.slice(0, lastNl + 1) : window
  const path = join(opts.baseDir, opts.id + '.txt')
  // Marker tells the model: output was truncated, full version is at <path>
  // (which the model can re-read via the read_file tool).
  const marker = `\n... (truncated, full at ${path})`
  return {
    kind: 'persisted',
    preview: aligned + marker,
    path,
    bytes: content.length,
    truncated: true,
  }
}
