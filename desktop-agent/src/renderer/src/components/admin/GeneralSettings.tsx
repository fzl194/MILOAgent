import { useState, useEffect } from 'react'
import { useConfigStore } from '../../stores/config-store'
import type { SandboxMode, ApprovalPolicy } from '../../agent-core/types'

interface FormState {
  systemPrompt: string
  sandbox: SandboxMode
  approvalPolicy: ApprovalPolicy
}

const SANDBOX_OPTIONS: { value: SandboxMode; hint: string }[] = [
  { value: 'workspace-write', hint: '仅工作区根内可写（默认）' },
  { value: 'read-only', hint: '禁止任何写入与命令' },
  { value: 'full-access', hint: '不限制写入路径' }
]

const POLICY_OPTIONS: { value: ApprovalPolicy; hint: string }[] = [
  { value: 'on-request', hint: '写与危险都问（默认）' },
  { value: 'auto', hint: '安全+写自动跑，危险才问' },
  { value: 'untrusted', hint: '除已知安全读外都问' }
]

export function GeneralSettings(): React.ReactElement {
  const config = useConfigStore((s) => s.config)
  const save = useConfigStore((s) => s.save)
  const load = useConfigStore((s) => s.load)
  const [form, setForm] = useState<FormState>({
    systemPrompt: '',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request'
  })
  const [saved, setSaved] = useState(false)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    setForm({
      systemPrompt: config.systemPrompt,
      sandbox: config.sandbox,
      approvalPolicy: config.approvalPolicy
    })
  }, [config])

  const handleSave = async (): Promise<void> => {
    await save({
      systemPrompt: form.systemPrompt,
      sandbox: form.sandbox,
      approvalPolicy: form.approvalPolicy
    })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
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

      {/* 全局风险兜底（项目可覆盖；项目默认"继承全局"会用到这里的值） */}
      <div className="rounded-xl border border-line bg-card/30 p-3.5">
        <div className="label-tag mb-3 text-accent">全局风险兜底 · GLOBAL SAFETY DEFAULTS</div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-tag mb-1.5 block">沙箱模式</label>
            <select
              value={form.sandbox}
              onChange={(e) => setForm({ ...form, sandbox: e.target.value as SandboxMode })}
              className="field font-mono"
            >
              {SANDBOX_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.value}</option>
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
                <option key={o.value} value={o.value}>{o.value}</option>
              ))}
            </select>
            <div className="mt-1 font-mono text-[10px] text-faint">
              {POLICY_OPTIONS.find((o) => o.value === form.approvalPolicy)?.hint}
            </div>
          </div>
        </div>
        <div className="mt-2 font-mono text-[10px] text-faint">
          新建项目文件夹与默认项目目录固定在 <span className="text-muted">~/.desktop-agent/workspace</span>；想用别的目录请「复用已有文件夹」。
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
