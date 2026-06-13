import { useState } from 'react'
import { useModelStore } from '../../stores/model-store'
import { ModelEditDialog } from './ModelEditDialog'
import type { ModelConfig } from '../../agent-core/types'

export function ModelManager(): React.ReactElement {
  const { models, deleteModel, updateModel } = useModelStore()
  const [editing, setEditing] = useState<ModelConfig | null>(null)
  const [creating, setCreating] = useState(false)

  const handleSetDefault = async (id: string): Promise<void> => {
    for (const m of models) await updateModel(m.id, { isDefault: m.id === id })
  }

  return (
    <div>
      <div className="space-y-2.5">
        {models.map((m) => (
          <div key={m.id} className="rounded-xl border border-line bg-card/50 p-3 transition hover:border-accent/30">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-fg">{m.name}</span>
                {m.isDefault && (
                  <span className="rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-accent">
                    DEFAULT
                  </span>
                )}
              </div>
              <div className="flex gap-1">
                {!m.isDefault && (
                  <button onClick={() => handleSetDefault(m.id)} className="rounded px-2 py-0.5 text-xs text-faint transition hover:text-accent">
                    设为默认
                  </button>
                )}
                <button onClick={() => setEditing(m)} className="rounded px-2 py-0.5 text-xs text-faint transition hover:text-fg">
                  编辑
                </button>
                {models.length > 1 && (
                  <button onClick={() => deleteModel(m.id)} className="rounded px-2 py-0.5 text-xs text-faint transition hover:text-danger">
                    删除
                  </button>
                )}
              </div>
            </div>
            <div className="mt-1.5 font-mono text-[11px] text-faint">
              {m.model} · {m.baseUrl}
            </div>
          </div>
        ))}
      </div>
      <button onClick={() => setCreating(true)} className="btn btn-ghost mt-3 w-full rounded-xl border border-dashed border-line py-2 text-sm">
        + 添加模型
      </button>
      {(editing || creating) && (
        <ModelEditDialog
          model={editing}
          onClose={() => {
            setEditing(null)
            setCreating(false)
          }}
        />
      )}
    </div>
  )
}
