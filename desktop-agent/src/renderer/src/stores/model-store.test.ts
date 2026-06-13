import { describe, it, expect } from 'vitest'
import { migrateModelConfig, useModelStore } from './model-store'
import type { ModelConfig } from '../agent-core/types'

describe('migrateModelConfig', () => {
  it('upgrades a legacy flat entry into a provider shape', () => {
    const m = migrateModelConfig({
      id: 'p1',
      name: 'DeepSeek',
      apiKey: 'k',
      baseUrl: 'b',
      model: 'deepseek-v4-pro',
      contextWindow: 64000
    })
    expect(m.protocol).toBe('openai')
    expect(m.defaultModel).toBe('deepseek-v4-pro')
    expect(m.models).toEqual([{ id: 'deepseek-v4-pro', contextWindow: 64000 }])
    // Back-compat flat fields are preserved (chat-store still reads `model`).
    expect(m.model).toBe('deepseek-v4-pro')
    expect(m.contextWindow).toBe(64000)
  })

  it('preserves an already-provider-shaped entry (no double migration)', () => {
    const m = migrateModelConfig({
      id: 'p2',
      name: 'GLM',
      apiKey: 'k',
      baseUrl: 'b',
      model: 'glm-5.1',
      protocol: 'openai',
      defaultModel: 'glm-5.1',
      models: [{ id: 'glm-5.1' }, { id: 'glm-5' }]
    })
    expect(m.protocol).toBe('openai')
    expect(m.defaultModel).toBe('glm-5.1')
    expect(m.models?.map((x) => x.id)).toEqual(['glm-5.1', 'glm-5'])
  })

  it('respects an explicit anthropic protocol (the reserved seam)', () => {
    expect(
      migrateModelConfig({ id: 'p3', name: 'Claude', apiKey: 'k', baseUrl: 'b', model: 'claude-opus-4-8', protocol: 'anthropic' }).protocol
    ).toBe('anthropic')
  })

  it('defaults unknown/missing fields safely', () => {
    const m = migrateModelConfig({ name: 'X' })
    expect(m.protocol).toBe('openai')
    expect(m.apiKey).toBe('')
    expect(m.models).toEqual([])
    expect(typeof m.id).toBe('string')
  })
})

describe('resolveModel', () => {
  const base = migrateModelConfig({
    id: 'p1',
    name: 'GLM',
    apiKey: 'k',
    baseUrl: 'https://glm',
    model: 'glm-5.1',
    contextWindow: 128000
  })

  it('resolves the provider default model', () => {
    useModelStore.setState({ models: [base] })
    const r = useModelStore.getState().resolveModel('p1')
    expect(r?.model).toBe('glm-5.1')
    expect(r?.apiKey).toBe('k')
    expect(r?.contextWindow).toBe(128000)
    expect(r?.protocol).toBe('openai')
  })

  it('resolves an explicit modelId and its per-model context window', () => {
    const p2: ModelConfig = {
      ...base,
      id: 'p2',
      defaultModel: 'glm-5.1',
      models: [
        { id: 'glm-5.1', contextWindow: 128000 },
        { id: 'glm-4.6', contextWindow: 64000 }
      ]
    }
    useModelStore.setState({ models: [p2] })
    const r = useModelStore.getState().resolveModel('p2', 'glm-4.6')
    expect(r?.model).toBe('glm-4.6')
    expect(r?.contextWindow).toBe(64000)
  })

  it('passes through an unknown modelId (manual model not in models[])', () => {
    useModelStore.setState({ models: [base] }) // base.models = [{ glm-5.1 }]
    const r = useModelStore.getState().resolveModel('p1', 'glm-5')
    expect(r?.model).toBe('glm-5') // accepted as-is; API will validate
    expect(r?.contextWindow).toBe(128000) // falls back to provider-level window
  })

  it('returns undefined when no model id can be resolved at all', () => {
    const empty = migrateModelConfig({ id: 'p3', name: 'Empty', apiKey: 'k', baseUrl: 'b', model: '' })
    useModelStore.setState({ models: [empty] })
    expect(useModelStore.getState().resolveModel('p3')).toBeUndefined()
  })

  it('returns undefined for an unknown provider', () => {
    expect(useModelStore.getState().resolveModel('does-not-exist')).toBeUndefined()
  })
})
