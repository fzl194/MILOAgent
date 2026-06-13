import { useState, useEffect } from 'react'
import { useConfigStore } from '../../stores/config-store'
import type { SandboxMode, ApprovalPolicy } from '../../agent-core/types'

interface FormState {
  systemPrompt: string
  sandbox: SandboxMode
  approvalPolicy: ApprovalPolicy
  workspaceRoot: string
}

const SANDBOX_OPTIONS: { value: SandboxMode; label: string; hint: string }[] = [
  { value: 'read-only', label: '只读', hint: '禁止任何写入与命令' },
  { value: 'workspace-write', label: '工作区可写', hint: '仅工作区根内可写（默认）' },
  { value: 'full-access', label: '完全访问', hint: '不限制写入路径' }
]

const POLICY_OPTIONS: { value: ApprovalPolicy; label: string; hint: string }[] = [
  { value: 'auto', label: '自动', hint: '安全+写自动跑，危险才问' },
  { value: 'on-request', label: '需要时问', hint: '写与危险都问（默认）' },
  { value: 'untrusted', label: '全部确认', hint: '除已知安全读外都问' }
]

export function GeneralSettings(): React.ReactElement {
  const config = useConfigStore((s) => s.config)
  const save = useConfigStore((s) => s.save)
  const load = useConfigStore((s) => s.load)
  const [form, setForm] = useState<FormState>({
    systemPrompt: '',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    workspaceRoot: ''
  })
  const [saved, setSaved] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [picking, setPicking] = useState(false)

  // Pull from the config store (single source of truth) on mount.
  useEffect(() => {
    load()
  }, [load])

  // Sync form whenever the store config changes (e.g. after load/migration).
  useEffect(() => {
    setForm({
      systemPrompt: config.systemPrompt,
      sandbox: config.sandbox,
      approvalPolicy: config.approvalPolicy,
      workspaceRoot: config.workspaceRoot ?? ''
    })
  }, [config])

  const handleSave = async (): Promise<void> => {
    await save({
      systemPrompt: form.systemPrompt,
      sandbox: form.sandbox,
      approvalPolicy: form.approvalPolicy,
      workspaceRoot: form.workspaceRoot.trim() || undefined
    })
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
          placeholder="自定义 Agent 的行为与角色…"
          className="field resize-none font-sans leading-relaxed"
        />
      </div>

      {/* Safety controls */}
      <div className="rounded-xl border border-line bg-card/30 p-3.5">
        <div className="label-tag mb-3 text-accent">安全控制 · SAFETY</div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-tag mb-1.5 block">沙箱模式</label>
            <select
              value={form.sandbox}
              onChange={(e) => setForm({ ...form, sandbox: e.target.value as SandboxMode })}
              className="field font-mono"
            >
              {SANDBOX_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <div className="mt-1 font-mono text-[10px] text-faint">
              {SANDBOX_OPTIONS.find((o) => o.value === form.sandbox)?.hint}
            </div>
          </div>
          <div>
            <label className="label-tag mb-1.5 block">审批策略</label>
            <select
              value={form.approvalPolicy}
              onChange={(e) => setForm({ ...form, approvalPolicy: e.target.value as ApprovalPolicy })}
              className="field font-mono"
            >
              {POLICY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <div className="mt-1 font-mono text-[10px] text-faint">
              {POLICY_OPTIONS.find((o) => o.value === form.approvalPolicy)?.hint}
            </div>
          </div>
        </div>
        <div className="mt-3">
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
            留空时「新建项目」会在默认 <span className="text-muted">~/.desktop-agent/workspace</span> 下创建新文件夹。
          </div>
        </div>
      </div>

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
