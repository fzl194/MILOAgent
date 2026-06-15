/**
 * Dimension registry — the source of truth for "what can be monitored".
 *
 * Three-step contract (see docs/2026-06-15-desktop-agent-运行态监控面板设计.md):
 *   1) Add the key to `DimKey` in monitor/types.ts
 *   2) Add the metadata row here
 *   3) Publish at the right code site + render a card in MonitorPanel
 *
 * The panel reads DIMENSIONS at runtime to populate the dimension toggles, so
 * new dimensions appear in the UI without touching any other code.
 */
import type { DimKey } from './types'

/** Where a dimension's payload ends up on disk. */
export type PersistStrategy =
  | 'snapshot' // request_view + context_metrics → projects/<pid>/snapshots/<sid>/<callId>.json
  | 'trace-only' // tool_call / token_usage / turn_lifecycle → existing trace events
  | 'none' // in-memory only (e.g. ephemeral UI state)

export interface DimensionMeta {
  key: DimKey
  /** Chinese label shown in the panel toggle. */
  label: string
  /** Group header for the toggles row. */
  group: 'context' | 'tool' | 'token' | 'lifecycle'
  persistStrategy: PersistStrategy
  /**
   * Hint used by the bus to decide whether a payloadFactory invocation is
   * worthwhile. 'heavy' = request_view, the biggest payload in the system.
   * 'light' = everything else.
   */
  payloadCost: 'heavy' | 'light'
}

export const DIMENSIONS: Record<DimKey, DimensionMeta> = {
  request_view: {
    key: 'request_view',
    label: '请求视图',
    group: 'context',
    persistStrategy: 'snapshot',
    payloadCost: 'heavy'
  },
  context_metrics: {
    key: 'context_metrics',
    label: '上下文度量',
    group: 'context',
    persistStrategy: 'snapshot',
    payloadCost: 'light'
  },
  tool_call: {
    key: 'tool_call',
    label: '工具调用',
    group: 'tool',
    persistStrategy: 'trace-only',
    payloadCost: 'light'
  },
  token_usage: {
    key: 'token_usage',
    label: 'Token 用量',
    group: 'token',
    persistStrategy: 'trace-only',
    payloadCost: 'light'
  },
  turn_lifecycle: {
    key: 'turn_lifecycle',
    label: 'Turn 生命周期',
    group: 'lifecycle',
    persistStrategy: 'trace-only',
    payloadCost: 'light'
  }
}

/**
 * Default-on state per dimension. request_view + context_metrics default ON
 * because that's the core value prop; the rest default ON too — the panel is
 * a dev tool, off-by-default per-dimension would be friction without benefit
 * (the bus's lazy-payload contract already keeps heavy work off when nothing
 * is subscribed).
 */
export const DEFAULT_ENABLED: Record<DimKey, boolean> = {
  request_view: true,
  context_metrics: true,
  tool_call: true,
  token_usage: true,
  turn_lifecycle: true
}

export const ALL_DIMENSIONS: DimKey[] = Object.keys(DIMENSIONS) as DimKey[]
