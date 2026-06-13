import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useModelStore, fetchModelList, mergeModelIds } from '../../stores/model-store'
import type { ModelConfig } from '../../agent-core/types'

interface Props {
  model: ModelConfig | null
  onClose: () => void
}

export function ModelEditDialog({ model, onClose }: Props): React.ReactElement {
  const { addModel, updateModel } = useModelStore()
  const isEdit = !!model
  const [form, setForm] = useState<ModelConfig>(
    model ?? {
      id: crypto.randomUUID(),
      name: '',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      isDefault: false,
      protocol: 'openai'
    }
  )
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const handleSave = async (): Promise<void> => {
    if (!form.name || !form.baseUrl) return
    // Default the active model: explicit defaultModel, else first listed, else
    // the legacy flat `model` (back-compat / manual entry).
    const resolved: ModelConfig = {
      ...form,
      defaultModel: form.defaultModel ?? form.models?.[0]?.id ?? form.model
    }
    if (isEdit) await updateModel(resolved.id, resolved)
    else await addModel(resolved)
    onClose()
  }

  // Fetch the provider's model list (/models) and merge into the form. Works in
  // both create and edit modes — only needs baseUrl + apiKey filled in.
  const handleFetch = async (): Promise<void> => {
    if (!form.baseUrl || !form.apiKey) return
    setFetching(true)
    setFetchError(null)
    try {
      const ids = await fetchModelList(form.baseUrl, form.apiKey)
      setForm((f) => ({ ...f, models: mergeModelIds(f.models ?? [], ids) }))
    } catch (e: any) {
      setFetchError(e?.message ?? String(e))
    } finally {
      setFetching(false)
    }
  }

  const field = (label: string, key: keyof ModelConfig, type = 'text', ph = ''): React.ReactElement => (
    <div>
      <label className="label-tag mb-1 block">{label}</label>
      <input
        type={type}
        value={form[key] as string}
        placeholder={ph}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="field"
      />
    </div>
  )

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="glass-strong rise max-h-[88vh] w-96 max-w-[92vw] overflow-auto rounded-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 font-mono text-[10px] tracking-[0.2em] text-faint">
          {isEdit ? 'EDIT PROVIDER' : 'NEW PROVIDER'}
        </div>
        <h3 className="brand mb-4 text-base font-semibold text-fg">{isEdit ? '编辑提供商' : '添加提供商'}</h3>
        <div className="space-y-3">
          {field('名称', 'name', 'text', 'DeepSeek / GLM …')}
          {field('API Key', 'apiKey', 'password', 'sk-...')}
          {field('Base URL', 'baseUrl', 'text', 'https://api.openai.com/v1')}
          <div>
            <label className="label-tag mb-1 block">协议</label>
            <select
              value={form.protocol ?? 'openai'}
              onChange={(e) => setForm({ ...form, protocol: e.target.value as ModelConfig['protocol'] })}
              className="field font-mono"
            >
              <option value="openai">openai（兼容 /chat/completions）</option>
              <option value="anthropic">anthropic（Messages · 预留）</option>
            </select>
          </div>

          {/* Model discovery: fetch /models, then pick the default model. */}
          <div className="rounded-xl border border-line bg-base/30 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="label-tag">模型列表</span>
              <button
                type="button"
                onClick={handleFetch}
                disabled={fetching || !form.baseUrl || !form.apiKey || form.protocol === 'anthropic'}
                className="rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] text-accent transition hover:bg-accent/20 disabled:opacity-40"
              >
                {fetching ? '拉取中…' : '拉取模型列表'}
              </button>
            </div>
            {fetchError && <div className="mb-2 font-mono text-[10px] text-danger">{fetchError}</div>}
            {(form.models?.length ?? 0) > 0 ? (
              <div className="space-y-1">
                {form.models!.map((m) => {
                  const isDefault = (form.defaultModel ?? form.model) === m.id
                  return (
                    <label key={m.id} className="flex items-center gap-2 font-mono text-[11px] text-muted">
                      <input
                        type="radio"
                        name="default-model"
                        checked={isDefault}
                        onChange={() => setForm({ ...form, defaultModel: m.id, model: m.id })}
                        className="accent-[var(--color-accent)]"
                      />
                      <span className={isDefault ? 'text-fg' : ''}>{m.id}</span>
                    </label>
                  )
                })}
              </div>
            ) : (
              <div className="font-mono text-[10px] text-faint">
                {form.protocol === 'anthropic'
                  ? 'Anthropic 协议的列表拉取尚未实现(预留);请手填下方默认模型。'
                  : '点「拉取」自动获取;或手填下方默认模型。'}
              </div>
            )}
          </div>

          {field('默认模型（手填/回退）', 'model', 'text', 'deepseek-v4-pro')}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-ghost px-3 py-1.5 text-sm">
            取消
          </button>
          <button onClick={handleSave} className="btn btn-primary px-4 py-1.5 text-sm">
            保存
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
