import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjectStore } from '../../stores/project-store'
import { useModelStore } from '../../stores/model-store'
import type { Project, SandboxMode, ApprovalPolicy } from '../../agent-core/types'

const SANDBOX_OPTS: SandboxMode[] = ['workspace-write', 'read-only', 'full-access']
const POLICY_OPTS: ApprovalPolicy[] = ['on-request', 'auto', 'untrusted']

// Parse a newline-separated textarea into a cleaned string[]; blank lines dropped.
function toList(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

// Compile every pattern so we can reject malformed regex before saving, and
// cap length/count to bound the cost of matching on the authorization path
// (a crude ReDoS guard — full catastrophic-backtracking detection is out of
// scope for a personal tool, but bounded input keeps the worst cases contained).
const RX_MAX_LEN = 200
const RX_MAX_TOTAL = 30
function validateRegexes(list: string[]): string | null {
  if (list.length > RX_MAX_TOTAL) return `规则过多（上限 ${RX_MAX_TOTAL} 条）`
  for (const p of list) {
    if (p.length > RX_MAX_LEN) return `正则过长（上限 ${RX_MAX_LEN} 字符）：${p.slice(0, 40)}…`
    try {
      new RegExp(p)
    } catch {
      return `非法正则：${p}`
    }
  }
  return null
}

// Edit a single project's identity + effective-config overrides (systemPrompt,
// sandbox, approval policy, default model, per-project command allow/deny rules).
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

  const cfg = project.config ?? {}
  const [name, setName] = useState(project.name)
  const [dirPath, setDirPath] = useState(project.dirPath ?? '')
  const [systemPrompt, setSystemPrompt] = useState(cfg.systemPrompt ?? '')
  // '__inherit__' = no project override; falls through to the global setting.
  const [sandbox, setSandbox] = useState<SandboxMode | '__inherit__'>(cfg.sandbox ?? '__inherit__')
  const [policy, setPolicy] = useState<ApprovalPolicy | '__inherit__'>(cfg.approvalPolicy ?? '__inherit__')
  const [defaultModelId, setDefaultModelId] = useState(cfg.defaultModelId ?? '')
  const [allow, setAllow] = useState((cfg.commandRules?.allow ?? []).join('\n'))
  const [deny, setDeny] = useState((cfg.commandRules?.deny ?? []).join('\n'))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const pick = async (): Promise<void> => {
    const r = await window.electronAPI.pickFolder()
    if (r.success && r.data) setDirPath(r.data)
    else setErr('选择文件夹失败')
  }

  const save = async (): Promise<void> => {
    if (busy) return
    setErr('')
    const allowList = toList(allow)
    const denyList = toList(deny)
    const rxErr = validateRegexes([...allowList, ...denyList])
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
      await updateConfig(project.id, {
        systemPrompt: systemPrompt.trim() || undefined,
        sandbox: sandbox === '__inherit__' ? undefined : sandbox,
        approvalPolicy: policy === '__inherit__' ? undefined : policy,
        defaultModelId: defaultModelId || undefined,
        commandRules:
          allowList.length || denyList.length ? { allow: allowList, deny: denyList } : undefined
      })
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
        className="glass-strong rise max-h-[88vh] w-[28rem] max-w-[94vw] overflow-y-auto rounded-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 font-mono text-[10px] tracking-[0.2em] text-faint">PROJECT SETTINGS</div>
        <h3 className="brand mb-4 text-base font-semibold text-fg">项目设置</h3>

        <div className="space-y-3">
          {field(
            '名称',
            <input value={name} onChange={(e) => setName(e.target.value)} className="field" />
          )}

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
                onChange={(e) => setSandbox(e.target.value as SandboxMode | '__inherit__')}
                className="field font-mono text-xs"
              >
                <option value="__inherit__">继承全局</option>
                {SANDBOX_OPTS.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            )}
            {field(
              '审批策略',
              <select
                value={policy}
                onChange={(e) => setPolicy(e.target.value as ApprovalPolicy | '__inherit__')}
                className="field font-mono text-xs"
              >
                <option value="__inherit__">继承全局</option>
                {POLICY_OPTS.map((o) => (
                  <option key={o} value={o}>{o}</option>
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

          <div className="rounded-lg border border-line bg-card/30 p-2.5">
            <div className="label-tag mb-2 text-accent">命令规则（仅 shell，正则）</div>
            {field(
              '允许（命中自动放行，危险命令除外）',
              <textarea
                value={allow}
                onChange={(e) => setAllow(e.target.value)}
                rows={2}
                placeholder={'^git status$\n^pnpm test'}
                className="field resize-none font-mono text-[11px]"
              />
            )}
            <div className="mt-2">
              {field(
                '拒绝（命中硬拒）',
                <textarea
                  value={deny}
                  onChange={(e) => setDeny(e.target.value)}
                  rows={2}
                  placeholder={'\\brm\\s+-rf\n^sudo\\b'}
                  className="field resize-none font-mono text-[11px]"
                />
              )}
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
