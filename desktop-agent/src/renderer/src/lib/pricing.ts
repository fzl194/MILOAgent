// Pricing table for cost estimation. Stored in localStorage (per-user override)
// so we don't have to touch the main process / models.json — keeps this module
// fully isolated from the approval-layer work happening in parallel.

export interface ModelPricing {
  inputPer1M: number // USD per 1M input tokens
  outputPer1M: number // USD per 1M output tokens
}

const STORAGE_KEY = 'da-pricing-v1'

// Built-in defaults (USD per 1M tokens). Best-effort public list prices; users
// can override any of these and add their own models in the Stats panel.
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gpt-5': { inputPer1M: 1.25, outputPer1M: 10 },
  // Anthropic
  'claude-opus-4-8': { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5': { inputPer1M: 1, outputPer1M: 5 },
  // DeepSeek
  'deepseek-chat': { inputPer1M: 0.27, outputPer1M: 1.1 },
  'deepseek-reasoner': { inputPer1M: 0.55, outputPer1M: 2.19 },
  'deepseek-v4-pro': { inputPer1M: 0.27, outputPer1M: 1.1 },
  // GLM (Zhipu)
  'glm-5.1': { inputPer1M: 0.5, outputPer1M: 0.5 },
  'glm-4.7': { inputPer1M: 0.5, outputPer1M: 0.5 }
}

function isFiniteNonNeg(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

// Drop entries with empty keys or invalid (non-finite / negative) prices so a
// corrupted localStorage payload can never produce NaN/negative costs downstream.
function sanitizePricing(raw: unknown): Record<string, ModelPricing> {
  const out: Record<string, ModelPricing> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k) continue
    if (!v || typeof v !== 'object') continue
    const entry = v as { inputPer1M?: unknown; outputPer1M?: unknown }
    if (isFiniteNonNeg(entry.inputPer1M) && isFiniteNonNeg(entry.outputPer1M)) {
      out[k] = { inputPer1M: entry.inputPer1M, outputPer1M: entry.outputPer1M }
    }
  }
  return out
}

export function loadPricing(): Record<string, ModelPricing> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_PRICING }
    return { ...DEFAULT_PRICING, ...sanitizePricing(JSON.parse(raw)) }
  } catch {
    return { ...DEFAULT_PRICING }
  }
}

export function savePricing(table: Record<string, ModelPricing>): void {
  try {
    // Only persist overrides; defaults are re-merged on load.
    const overrides: Record<string, ModelPricing> = {}
    for (const [k, v] of Object.entries(table)) {
      const dflt = DEFAULT_PRICING[k]
      if (!dflt || dflt.inputPer1M !== v.inputPer1M || dflt.outputPer1M !== v.outputPer1M) {
        overrides[k] = v
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    /* ignore quota / privacy errors */
  }
}

/** Cost (USD) for a token pair given a pricing entry; 0 if unpriced. Defensive
 *  against NaN/negative tokens or prices. */
export function computeCost(inputTokens: number, outputTokens: number, pricing?: ModelPricing): number {
  if (!pricing) return 0
  const inT = isFiniteNonNeg(inputTokens) ? inputTokens : 0
  const outT = isFiniteNonNeg(outputTokens) ? outputTokens : 0
  const inP = isFiniteNonNeg(pricing.inputPer1M) ? pricing.inputPer1M : 0
  const outP = isFiniteNonNeg(pricing.outputPer1M) ? pricing.outputPer1M : 0
  return (inT / 1_000_000) * inP + (outT / 1_000_000) * outP
}

/** Look up pricing for a model name: exact match first, then a separator-bounded
 *  prefix match (e.g. user model "deepseek-v4-pro-abc" → key "deepseek-v4-pro").
 *  Empty keys never match. */
export function lookupPricing(model: string, table: Record<string, ModelPricing>): ModelPricing | undefined {
  if (!model) return undefined
  if (table[model]) return table[model]
  // Prefix match with a separator boundary; pick the LONGEST matching key so
  // e.g. "deepseek-v4-pro-x" prefers "deepseek-v4-pro" over a shorter "deepseek-v4".
  let bestKey = ''
  let bestVal: ModelPricing | undefined
  for (const k of Object.keys(table)) {
    if (!k || k.length >= model.length || k.length <= bestKey.length) continue
    const bounded =
      model.startsWith(k + '-') ||
      model.startsWith(k + '_') ||
      model.startsWith(k + '.') ||
      model.startsWith(k + ':') ||
      model.startsWith(k + '/')
    if (bounded) {
      bestKey = k
      bestVal = table[k]
    }
  }
  return bestVal
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 1) return '$' + usd.toFixed(3)
  return '$' + usd.toFixed(2)
}
