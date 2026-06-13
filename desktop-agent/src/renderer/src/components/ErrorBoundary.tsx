import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Shown in the fallback heading; defaults to a generic message. */
  label?: string
}

interface State {
  error: Error | null
  resetKey: number
}

/**
 * Catches render-time errors in its subtree so a single throwing component
 * cannot blank out the whole window. Without this, any render exception
 * anywhere leaves the user staring at a white screen with no way to recover.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the real cause in DevTools instead of a silent white screen.
    console.error('[ErrorBoundary]', error, info)
  }

  handleReset = (): void => {
    // Bump resetKey so React remounts the children subtree on retry. Clearing
    // the error state alone would reconcile the identical (still-throwing) tree.
    this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }))
  }

  render(): ReactNode {
    const { error, resetKey } = this.state
    if (!error) return <Fragment key={resetKey}>{this.props.children}</Fragment>

    const title = this.props.label ?? '页面渲染出错'
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center p-4">
        <div className="w-full max-w-md rounded-lg border border-red-200 bg-red-50 p-4 text-sm">
          <div className="mb-1 font-medium text-red-700">{title}</div>
          <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white/60 p-2 text-xs text-red-600">
            {String(error?.message ?? error)}
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={this.handleReset}
              className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
            >
              重试
            </button>
          </div>
        </div>
      </div>
    )
  }
}
