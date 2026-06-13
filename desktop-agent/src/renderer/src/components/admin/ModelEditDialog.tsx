import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useModelStore } from '../../stores/model-store'
import type { ModelConfig } from '../../agent-core/types'

interface Props {
  model: ModelConfig | null
  onClose: () => void
}

export function ModelEditDialog({ model, onClose }: Props): React.ReactElement {
  const { addModel, updateModel } = useModelStore()
  const isEdit = !!model
  const [form, setForm] = useState<ModelConfig>(
    model || {
      id: crypto.randomUUID(),
      name: '',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      isDefault: false
    }
  )

  const handleSave = async (): Promise<void> => {
    if (!form.name || !form.baseUrl || !form.model) return
    if (isEdit) await updateModel(form.id, form)
    else await addModel(form)
    onClose()
  }

  const upd = (k: keyof ModelConfig, v: string): void => setForm({ ...form, [k]: v })

  const field = (label: string, key: keyof ModelConfig, type = 'text', ph = ''): React.ReactElement => (
    <div>
      <label className="label-tag mb-1 block">{label}</label>
      <input
        type={type}
        value={form[key] as string}
        placeholder={ph}
        onChange={(e) => upd(key, e.target.value)}
        className="field"
      />
    </div>
  )

  // Portal to document.body so the overlay escapes the AdminPanel's
  // backdrop-filter ancestor (which would otherwise become its containing block).
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="glass-strong rise w-96 max-w-[92vw] rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 font-mono text-[10px] tracking-[0.2em] text-faint">{isEdit ? 'EDIT MODEL' : 'NEW MODEL'}</div>
        <h3 className="brand mb-4 text-base font-semibold text-fg">{isEdit ? '编辑模型' : '添加模型'}</h3>
        <div className="space-y-3">
          {field('名称', 'name', 'text', 'GPT-4o')}
          {field('API Key', 'apiKey', 'password', 'sk-...')}
          {field('Base URL', 'baseUrl', 'text', 'https://api.openai.com/v1')}
          {field('模型', 'model', 'text', 'gpt-4o-mini')}
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
