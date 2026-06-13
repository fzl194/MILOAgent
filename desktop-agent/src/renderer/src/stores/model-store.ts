import { create } from 'zustand'
import type { ModelConfig, ResolvedModel } from '../agent-core/types'

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
 *  `models[]`, `defaultModel`, and `protocol: 'openai'`. Pure — unit-tested
 *  without the store/IPC. */
export function migrateModelConfig(raw: unknown): ModelConfig {
  const r = (raw ?? {}) as Record<string, any>
  const model = typeof r.model === 'string' ? r.model : ''
  const contextWindow = typeof r.contextWindow === 'number' ? r.contextWindow : undefined
  // Spread (don't whitelist) so future ProviderModel fields survive a
  // load+persist round-trip; normalize only the two known fields.
  const models = Array.isArray(r.models) && r.models.length
    ? r.models.map((x: any) => ({
        ...x,
        id: String(x?.id ?? ''),
        contextWindow: typeof x?.contextWindow === 'number' ? x.contextWindow : undefined
      }))
    : model
      ? [{ id: model, contextWindow }]
      : []
  return {
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
