import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjectStore } from '../../stores/project-store'
import { useModelStore } from '../../stores/model-store'
import { useConfigStore } from '../../stores/config-store'
import type { Project, ProjectConfig, PermissionRule, SandboxMode, ApprovalPolicy } from '../../agent-core/types'

const SANDBOX_OPTS: SandboxMode[] = ['workspace-write', 'read-only', 'full-access']
const POLICY_OPTS: ApprovalPolicy[] = ['on-request', 'auto', 'untrusted']
const TOOL_OPTS: { value: string; label: string }[] = [
  { value: 'run_shell', label: 'shell' },
  { value: 'write_file', label: '写文件' },
  { value: '*', label: '任意' }
]

const RX_MAX_LEN = 200
const RX_MAX_TOTAL = 30
function validateRegexes(rules: PermissionRule[]): string | null {
  const filled = rules.filter((r) => r.pattern.trim())
  if (filled.length > RX_MAX_TOTAL) return `规则过多（上限 ${RX_MAX_TOTAL} 条）`
  for (const r of filled) {
    if (r.pattern.length > RX_MAX_LEN) return `正则过长（上限 ${RX_MAX_LEN} 字符）：${r.pattern.slice(0, 40)}…`
    try {
      new RegExp(r.pattern)
    } catch {
      return `非法正则：${r.pattern}`
    }
  }
  return null
}

// Edit a single project's identity + effective-config overrides. Permission
// rules are edited as a STRUCTURED list (pattern + action + tool per row) so the
// editor matches the stored PermissionRule[] exactly — no field is dropped on
// round-trip (the old allow/deny textareas silently rewrote write_file rules to
// run_shell). sandbox/policy default to "继承全局" and show what global resolves to.
export function ProjectSettingsDialog({
  project,
  onClose
}: {
  project: Project
  onClose: () => void
}): React.ReactElement {
  const rename = useProjectStore((s) => s.rename)
  const updateDir = useProjectStore((s) => s.updateDir)
  const updateConfig = useProjectStore((s) => s.updateConfig)
  const models = useModelStore((s) => s.models)
  const gCfg = useConfigStore((s) => s.config) // for "继承全局" resolved display

  const cfg = project.config ?? {}
  const [name, setName] = useState(project.name)
  const [dirPath, setDirPath] = useState(project.dirPath ?? '')
  const [systemPrompt, setSystemPrompt] = useState(cfg.systemPrompt ?? '')
  const [sandbox, setSandbox] = useState<SandboxMode>(cfg.sandbox ?? gCfg.sandbox)
  const [policy, setPolicy] = useState<ApprovalPolicy>(cfg.approvalPolicy ?? gCfg.approvalPolicy)
  const [defaultModelId, setDefaultModelId] = useState(cfg.defaultModelId ?? '')
  const [rules, setRules] = useState<PermissionRule[]>(
    (cfg.rules ?? []).map((r) => ({ ...r }))
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const patchRule = (i: number, patch: Partial<PermissionRule>): void =>
    setRules((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const addRule = (): void =>
    setRules((rs) => [...rs, { pattern: '', action: 'allow', tool: 'run_shell' }])
  const removeRule = (i: number): void => setRules((rs) => rs.filter((_, idx) => idx !== i))

  const pick = async (): Promise<void> => {
    const r = await window.electronAPI.pickFolder()
    if (r.success && r.data) setDirPath(r.data)
    else setErr('选择文件夹失败')
  }

  const save = async (): Promise<void> => {
    if (busy) return
    setErr('')
    const cleaned = rules.map((r) => ({ ...r, pattern: r.pattern.trim() })).filter((r) => r.pattern)
    const rxErr = validateRegexes(cleaned)
    if (rxErr) {
      setErr(rxErr)
      return
    }
    setBusy(true)
    try {
      if (name.trim() && name.trim() !== project.name) await rename(project.id, name.trim())
      if (!project.isDefault && dirPath.trim() && dirPath.trim() !== project.dirPath) {
        await updateDir(project.id, dirPath.trim())
      }
      const patch: Partial<ProjectConfig> = {
        systemPrompt: systemPrompt.trim() || undefined,
        // Store no override when the project keeps the global default → truly
        // inherits (follows future global changes).
        sandbox: sandbox === gCfg.sandbox ? undefined : sandbox,
        approvalPolicy: policy === gCfg.approvalPolicy ? undefined : policy,
        defaultModelId: defaultModelId || undefined,
        rules: cleaned.length ? cleaned : undefined
      }
      await updateConfig(project.id, patch)
      onClose()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const field = (label: string, children: React.ReactElement): React.ReactElement => (
    <div>
      <label className="label-tag mb-1 block">{label}</label>
      {children}
    </div>
  )

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-strong rise max-h-[88vh] w-[30rem] max-w-[94vw] overflow-y-auto rounded-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 font-mono text-[10px] tracking-[0.2em] text-faint">PROJECT SETTINGS</div>
        <h3 className="brand mb-4 text-base font-semibold text-fg">项目设置</h3>

        <div className="space-y-3">
          {field('名称', <input value={name} onChange={(e) => setName(e.target.value)} className="field" />)}

          {!project.isDefault &&
            field(
              '目录',
              <div className="flex gap-2">
                <input
                  value={dirPath}
                  onChange={(e) => setDirPath(e.target.value)}
                  className="field font-mono text-xs"
                />
                <button type="button" onClick={pick} className="btn btn-ghost shrink-0 px-3 text-xs">
                  选择
                </button>
              </div>
            )}

          {field(
            '项目系统提示词（叠加在全局之上）',
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={3}
              placeholder="本项目专属指令，例如：这是一个 React+TS 项目，用 pnpm…"
              className="field resize-none text-xs leading-relaxed"
            />
          )}

          <div className="grid grid-cols-2 gap-3">
            {field(
              '沙箱',
              <select
                value={sandbox}
                onChange={(e) => setSandbox(e.target.value as SandboxMode)}
                className="field font-mono text-xs"
              >
                {SANDBOX_OPTS.map((o) => (
                  <option key={o} value={o}>
                    {o === gCfg.sandbox ? `${o}（继承全局）` : o}
                  </option>
                ))}
              </select>
            )}
            {field(
              '审批策略',
              <select
                value={policy}
                onChange={(e) => setPolicy(e.target.value as ApprovalPolicy)}
                className="field font-mono text-xs"
              >
                {POLICY_OPTS.map((o) => (
                  <option key={o} value={o}>
                    {o === gCfg.approvalPolicy ? `${o}（继承全局）` : o}
                  </option>
                ))}
              </select>
            )}
          </div>

          {field(
            '默认模型',
            <select
              value={defaultModelId}
              onChange={(e) => setDefaultModelId(e.target.value)}
              className="field font-mono text-xs"
            >
              <option value="">（用全局默认）</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          )}

          {/* Structured permission rules — one row per PermissionRule. */}
          <div className="rounded-lg border border-line bg-card/30 p-2.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="label-tag text-accent">权限规则（deny 永远优先于 allow）</span>
              <button type="button" onClick={addRule} className="rounded px-2 py-0.5 text-[11px] text-faint transition hover:text-accent">
                + 添加
              </button>
            </div>
            <div className="space-y-1.5">
              {rules.length === 0 && (
                <div className="py-1 font-mono text-[10px] text-faint">暂无规则（继承全局内建底线）</div>
              )}
              {rules.map((r, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    value={r.pattern}
                    onChange={(e) => patchRule(i, { pattern: e.target.value })}
                    placeholder="正则，如 ^git status$"
                    className="field flex-1 font-mono text-[11px]"
                  />
                  <select
                    value={r.action}
                    onChange={(e) => patchRule(i, { action: e.target.value as 'allow' | 'deny' })}
                    className="shrink-0 rounded border border-line bg-card/80 px-1.5 py-1 font-mono text-[11px] text-fg outline-none"
                    style={{ width: '4.5rem' }}
                  >
                    <option value="allow">允许</option>
                    <option value="deny">拒绝</option>
                  </select>
                  <select
                    value={r.tool ?? '*'}
                    onChange={(e) => patchRule(i, { tool: e.target.value })}
                    className="shrink-0 rounded border border-line bg-card/80 px-1.5 py-1 font-mono text-[11px] text-fg outline-none"
                    style={{ width: '5.5rem' }}
                  >
                    {TOOL_OPTS.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeRule(i)}
                    className="shrink-0 rounded px-1.5 py-1 text-xs text-faint transition hover:text-danger"
                    title="删除规则"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {err && <div className="mt-3 text-xs text-danger">{err}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost px-3 py-1.5 text-sm">
            取消
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="btn btn-primary px-4 py-1.5 text-sm disabled:opacity-50"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
