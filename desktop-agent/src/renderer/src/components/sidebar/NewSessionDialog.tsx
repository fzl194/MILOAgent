import { useState } from 'react'
import { useModelStore } from '../../stores/model-store'

interface Props {
  onSelect: (modelConfigId: string) => void
  onClose: () => void
}

export function NewSessionDialog({ onSelect, onClose }: Props): React.ReactElement | null {
  const models = useModelStore((s) => s.models)
  const [selected, setSelected] = useState(models.find((m) => m.isDefault)?.id || models[0]?.id || '')
  if (models.length === 0) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="glass-strong rise w-80 rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 font-mono text-[10px] tracking-[0.2em] text-faint">NEW SESSION</div>
        <h3 className="brand mb-3 text-base font-semibold text-fg">选择模型</h3>
        <div className="mb-4 space-y-2">
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => setSelected(m.id)}
              className={`flex w-full items-center gap-2.5 rounded-xl border p-2.5 text-left text-sm transition ${
                selected === m.id ? 'border-accent/60 bg-accent/10 text-fg' : 'border-line text-muted hover:bg-card/60 hover:text-fg'
              }`}
            >
              <span className={`flex h-4 w-4 items-center justify-center rounded-full border ${selected === m.id ? 'border-accent' : 'border-faint'}`}>
                {selected === m.id && <span className="h-2 w-2 rounded-full" style={{ background: 'var(--color-accent)' }} />}
              </span>
              <span className="flex-1">{m.name}</span>
              <span className="font-mono text-[10px] text-faint">{m.model}</span>
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-ghost px-3 py-1.5 text-sm">
            取消
          </button>
          <button onClick={() => onSelect(selected)} className="btn btn-primary px-4 py-1.5 text-sm">
            创建
          </button>
        </div>
      </div>
    </div>
  )
}
