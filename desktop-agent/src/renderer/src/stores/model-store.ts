import { create } from 'zustand'
import type { ModelConfig, ProviderModel, ResolvedModel } from '../agent-core/types'

interface ModelState {
  models: ModelConfig[]
  isLoaded: boolean
  loadModels: () => Promise<void>
  addModel: (m: ModelConfig) => Promise<void>
  updateModel: (id: string, m: Partial<ModelConfig>) => Promise<void>
  deleteModel: (id: string) => Promise<void>
  getModel: (id: string) => ModelConfig | undefined
  getDefaultModel: () => ModelConfig | undefined
  /** Alias of getModel — a ModelConfig is a provider. */
  getProvider: (id: string) => ModelConfig | undefined
  /** Resolve the effective connection + chosen model from a provider. `modelId`
   *  is optional (defaults to the provider's defaultModel). Seam for the
   *  model-picker UI (provider · model dropdown). */
  resolveModel: (providerId: string, modelId?: string) => ResolvedModel | undefined
  persist: () => Promise<void>
}

/** Normalize a raw models.json entry into a provider-shaped ModelConfig. Legacy
 *  flat entries (just `model`/`apiKey`/...) are upgraded with a synthesized
 *  `models[]`, `defaultModel`, and `protocol: 'openai'`. Spreads the raw entry
 *  first, so fields not normalized here — including ones the concurrent
 *  refactor is relocating (e.g. sampling params) — survive a load+persist
 *  round-trip. Lossless + forward-compatible. Pure w.r.t. the store/IPC. */
export function migrateModelConfig(raw: unknown): ModelConfig {
  const r = (raw ?? {}) as Record<string, any>
  const model = typeof r.model === 'string' ? r.model : ''
  const contextWindow = typeof r.contextWindow === 'number' ? r.contextWindow : undefined
  // Spread (don't whitelist) so future ProviderModel fields survive a
  // load+persist round-trip; normalize only the two known fields.
  const models = Array.isArray(r.models)
    ? r.models.map((x: any) => ({
        ...x,
        id: String(x?.id ?? ''),
        contextWindow: typeof x?.contextWindow === 'number' ? x.contextWindow : undefined
      }))
    : model
      ? [{ id: model, contextWindow }]
      : []
  // Spread first so unhandled/legacy fields are preserved (lossless), then
  // normalize the known ModelConfig fields on top.
  return {
    ...r,
    id: typeof r.id === 'string' ? r.id : crypto.randomUUID(),
    name: typeof r.name === 'string' ? r.name : 'Default',
    apiKey: typeof r.apiKey === 'string' ? r.apiKey : '',
    baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : 'https://api.openai.com/v1',
    model,
    isDefault: !!r.isDefault,
    contextWindow,
    protocol: r.protocol === 'anthropic' ? 'anthropic' : 'openai',
    models,
    defaultModel: typeof r.defaultModel === 'string' ? r.defaultModel : model || undefined
  }
}

/** Fetch available model ids from an OpenAI-compatible `GET {baseUrl}/models`.
 *  Renderer-side fetch (same origin/path the chat path already uses); throws on
 *  non-OK so the caller can surface the error. */
export async function fetchModelList(baseUrl: string, apiKey: string): Promise<string[]> {
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Base URL 需以 http(s):// 开头')
  const url = baseUrl.replace(/\/+$/, '') + '/models'
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`模型列表请求失败 (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const j = await res.json()
  const arr = (j as any)?.data ?? (j as any)?.models ?? j
  return Array.isArray(arr)
    ? arr.map((x: any) => String(x?.id ?? x?.name ?? x?.model ?? '')).filter(Boolean)
    : []
}

/** Merge a fetched id list into a provider's existing models: keep
 *  contextWindow overrides on ids still present, add new fetched ids, and retain
 *  manual entries the endpoint didn't list. Pure — unit-tested. */
export function mergeModelIds(existing: ProviderModel[], fetched: string[]): ProviderModel[] {
  // Dedup fetched first — real endpoints return snapshot duplicates (same id
  // twice), which would collide React keys and confuse the default-model radio.
  const seen = new Set<string>()
  const unique = fetched.filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
  const existingById = new Map(existing.map((m) => [m.id, m]))
  const merged = unique.map((id) => existingById.get(id) ?? ({ id } as ProviderModel))
  const fetchedSet = new Set(unique)
  for (const m of existing) if (!fetchedSet.has(m.id)) merged.push(m)
  return merged
}

export const useModelStore = create<ModelState>((set, get) => ({
  models: [],
  isLoaded: false,

  loadModels: async () => {
    const res = await window.electronAPI.listModels()
    const raw = (res.data as unknown[]) || []
    // Migrate legacy flat entries into provider-shaped configs. "Legacy" = lacks
    // a `models[]` array — a single canonical signal so a fully-migrated entry is
    // a strict persistence no-op (idempotent), even if it intentionally omits
    // defaultModel/protocol (those default in-memory only).
    const needsPersist =
      raw.length === 0 || raw.some((r) => !Array.isArray((r as any)?.models))
    const models = raw.length
      ? raw.map((r) => migrateModelConfig(r))
      : [
          migrateModelConfig({
            id: crypto.randomUUID(),
            name: 'Default',
            apiKey: '',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini',
            isDefault: true
          })
        ]
    set({ models, isLoaded: true })
    if (needsPersist) await window.electronAPI.saveModels(models)
  },

  addModel: async (m) => { set((s) => ({ models: [...s.models, m] })); await get().persist() },
  updateModel: async (id, m) => { set((s) => ({ models: s.models.map((x) => x.id === id ? { ...x, ...m } : x) })); await get().persist() },
  deleteModel: async (id) => { set((s) => ({ models: s.models.filter((x) => x.id !== id) })); await get().persist() },
  getModel: (id) => get().models.find((x) => x.id === id),
  getDefaultModel: () => get().models.find((x) => x.isDefault) || get().models[0],
  getProvider: (id) => get().models.find((x) => x.id === id),
  resolveModel: (providerId, modelId?) => {
    const p = get().models.find((x) => x.id === providerId)
    if (!p) return undefined
    const list = p.models ?? []
    const want = modelId ?? p.defaultModel ?? p.model
    if (!want) return undefined // no resolvable model id → treat as unresolvable
    const entry = list.find((m) => m.id === want)
    return {
      apiKey: p.apiKey,
      baseUrl: p.baseUrl,
      model: entry?.id ?? want,
      protocol: p.protocol ?? 'openai',
      contextWindow: entry?.contextWindow ?? p.contextWindow
    }
  },
  persist: async () => { await window.electronAPI.saveModels(get().models) },
}))
