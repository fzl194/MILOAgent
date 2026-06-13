import { useState, useEffect } from 'react'
import { useConfigStore } from '../../stores/config-store'

interface FormState {
  systemPrompt: string
  workspaceRoot: string
}

export function GeneralSettings(): React.ReactElement {
  const config = useConfigStore((s) => s.config)
  const save = useConfigStore((s) => s.save)
  const load = useConfigStore((s) => s.load)
  const [form, setForm] = useState<FormState>({ systemPrompt: '', workspaceRoot: '' })
  const [saved, setSaved] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [picking, setPicking] = useState(false)

  // Pull from the config store (single source of truth) on mount.
  useEffect(() => {
    load()
  }, [load])

  // Sync form whenever the store config changes (e.g. after load/migration).
  useEffect(() => {
    setForm({ systemPrompt: config.systemPrompt, workspaceRoot: config.workspaceRoot ?? '' })
  }, [config])

  const handleSave = async (): Promise<void> => {
    await save({ systemPrompt: form.systemPrompt, workspaceRoot: form.workspaceRoot.trim() || undefined })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }

  const handlePickFolder = async (): Promise<void> => {
    setPicking(true)
    try {
      const res = await window.electronAPI.pickFolder()
      if (res.success && res.data) setForm((f) => ({ ...f, workspaceRoot: res.data as string }))
    } finally {
      setPicking(false)
    }
  }

  const handleClearAll = async (): Promise<void> => {
    if (!window.confirm('将清空所有会话、对话记录、trace 与统计数据(模型配置保留)。此操作不可恢复,确定?')) return
    setClearing(true)
    const res = await window.electronAPI.clearAllData()
    if (res.success) {
      window.location.reload()
    } else {
      alert('清空失败:' + (res.error || '未知错误'))
      setClearing(false)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <label className="label-tag mb-1.5 block">系统提示词 · SYSTEM PROMPT</label>
        <textarea
          value={form.systemPrompt}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
          rows={4}
          placeholder="全局系统提示词（每个项目可叠加自己的提示词）…"
          className="field resize-none font-sans leading-relaxed"
        />
      </div>

      <div>
        <label className="label-tag mb-1.5 block">工作区根 · WORKSPACE ROOT</label>
        <div className="flex gap-2">
          <input
            value={form.workspaceRoot}
            onChange={(e) => setForm({ ...form, workspaceRoot: e.target.value })}
            placeholder="决定可写范围；留空则不限（仅 workspace-write 生效）"
            className="field font-mono text-xs"
          />
          <button
            type="button"
            onClick={handlePickFolder}
            disabled={picking}
            className="btn btn-ghost shrink-0 px-3 text-xs disabled:opacity-50"
          >
            {picking ? '…' : '选择'}
          </button>
        </div>
        <div className="mt-1 font-mono text-[10px] text-faint">
          文件写入限制在此目录内；Shell 仍由审批控制（个人版无内核沙箱）。
          留空时「新建项目」与默认项目会在默认 <span className="text-muted">~/.desktop-agent/workspace</span> 下。
        </div>
      </div>

      {/* 风险配置（沙箱/审批/命令规则）已移至「项目设置」，按项目配置；全局不再开放。 */}

      <div className="flex items-center gap-3">
        <button onClick={handleSave} className="btn btn-primary px-4 py-2 text-sm">
          保存设置
        </button>
        {saved && <span className="font-mono text-xs text-ok">✓ 已保存</span>}
      </div>

      <div className="rounded-xl border border-danger/30 bg-danger/5 p-3.5">
        <div className="label-tag mb-1 text-danger">危险区 · DANGER ZONE</div>
        <p className="mb-2.5 text-xs text-muted">
          清空所有会话、对话记录、trace 与统计数据。<span className="text-fg">模型配置(models.json)保留</span>。
        </p>
        <button
          onClick={handleClearAll}
          disabled={clearing}
          className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs text-danger transition hover:bg-danger/20 disabled:opacity-50"
        >
          {clearing ? '清空中…' : '一键清空所有数据'}
        </button>
      </div>
    </div>
  )
}
