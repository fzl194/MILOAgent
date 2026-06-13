import { create } from 'zustand'
import type { ModelConfig } from '../agent-core/types'

interface ModelState {
  models: ModelConfig[]
  isLoaded: boolean
  loadModels: () => Promise<void>
  addModel: (m: ModelConfig) => Promise<void>
  updateModel: (id: string, m: Partial<ModelConfig>) => Promise<void>
  deleteModel: (id: string) => Promise<void>
  getModel: (id: string) => ModelConfig | undefined
  getDefaultModel: () => ModelConfig | undefined
  persist: () => Promise<void>
}

export const useModelStore = create<ModelState>((set, get) => ({
  models: [],
  isLoaded: false,

  loadModels: async () => {
    const res = await window.electronAPI.listModels()
    const models = (res.data as ModelConfig[]) || []
    if (models.length === 0) {
      models.push({ id: crypto.randomUUID(), name: 'Default', apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', isDefault: true })
      await window.electronAPI.saveModels(models)
    }
    set({ models, isLoaded: true })
  },

  addModel: async (m) => { set((s) => ({ models: [...s.models, m] })); await get().persist() },
  updateModel: async (id, m) => { set((s) => ({ models: s.models.map((x) => x.id === id ? { ...x, ...m } : x) })); await get().persist() },
  deleteModel: async (id) => { set((s) => ({ models: s.models.filter((x) => x.id !== id) })); await get().persist() },
  getModel: (id) => get().models.find((x) => x.id === id),
  getDefaultModel: () => get().models.find((x) => x.isDefault) || get().models[0],
  persist: async () => { await window.electronAPI.saveModels(get().models) },
}))
