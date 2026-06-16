/**
 * Shared risk / approval color tokens.
 *
 * **Scope of this module: the color token ONLY.** Surface-specific labels
 * (e.g. "SAFE" vs "安全") and icons stay with each consumer (`ToolInvocationCard`,
 * `ApprovalCard`, `LiveEventStream`). Mixing those into this record would
 * force unrelated UI decisions to live together; keep them separate.
 *
 * `RISK_TONE.color` and `APPROVAL_TONE.color` are CSS expressions pointing
 * at theme variables, so badges follow the active light/dark theme without
 * any extra wiring. Consumers that need a border should use `badgeStyle()`,
 * which layers `color-mix` 40% on top of the same token.
 *
 * Extending `RiskLevel` or `ApprovalSource` is a closed-enum change — these
 * `Record<...>` types force every case to be covered, so a new value becomes
 * a TS error here rather than a silent UI regression.
 */
import type { ApprovalSource, RiskLevel } from './types'

export interface ToneMeta {
  /** A CSS color expression — typically a `var(--color-…)` token. */
  color: string
}

export const RISK_TONE: Record<RiskLevel, ToneMeta> = {
  safe: { color: 'var(--color-ok)' },
  write: { color: 'var(--color-accent)' },
  network: { color: 'var(--color-warn)' },
  dangerous: { color: 'var(--color-danger)' }
}

export const APPROVAL_TONE: Record<ApprovalSource, ToneMeta> = {
  user: { color: 'var(--color-accent)' },
  auto: { color: 'var(--color-faint)' },
  allowlist: { color: 'var(--color-ok)' },
  denied: { color: 'var(--color-danger)' }
}

/** Render a tone as the inline style used by chat + monitor badges:
 *  foreground color + 40%-transparent border via `color-mix`. Centralizing
 *  this keeps the two surfaces visually identical without coupling the rest
 *  of their shape. */
export function badgeStyle(tone: ToneMeta): { color: string; borderColor: string } {
  return { color: tone.color, borderColor: `color-mix(in srgb, ${tone.color} 40%, transparent)` }
}
