import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjectStore } from '../../stores/project-store'

// Two creation modes, per the project-level design:
//   ① 新建项目 — create a NEW folder under the workspace root (project:createDir)
//   ② 复用文件夹 — point at an EXISTING directory (dialog:pickFolder → realpath)
// Rendered via portal to document.body so the overlay escapes the sidebar's
// backdrop-filter containing block (same reason as ModelEditDialog).
export function NewProjectDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const createNew = useProjectStore((s) => s.createProjectNew)
  const createExisting = useProjectStore((s) => s.createProjectFromExisting)
  const [tab, setTab] = useState<'new' | 'reuse'>('new')
  const [name, setName] = useState('')
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const pick = async (): Promise<void> => {
    const r = await window.electronAPI.pickFolder()
    if (r.success && r.data) setPicked(r.data)
    else setErr('选择文件夹失败')
  }

  const submit = async (): Promise<void> => {
    if (busy) return // guard against double-click / double-Enter
    setErr('')
    const n = name.trim()
    if (tab === 'reuse' && !picked) {
      setErr('请先选择一个文件夹')
      return
    }
    setBusy(true)
    try {
      if (tab === 'new') await createNew(n || '新项目')
      else await createExisting(n || '新项目', picked)
      onClose()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-strong rise w-96 max-w-[92vw] rounded-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 font-mono text-[10px] tracking-[0.2em] text-faint">NEW PROJECT</div>
        <h3 className="brand mb-4 text-base font-semibold text-fg">新建项目</h3>

        {/* Mode tabs */}
        <div className="mb-4 flex gap-1 rounded-lg border border-line bg-card/40 p-1">
          <button
            type="button"
            onClick={() => setTab('new')}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs transition ${
              tab === 'new' ? 'bg-elevated text-fg' : 'text-muted hover:text-fg'
            }`}
          >
            新建文件夹
          </button>
          <button
            type="button"
            onClick={() => setTab('reuse')}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs transition ${
              tab === 'reuse' ? 'bg-elevated text-fg' : 'text-muted hover:text-fg'
            }`}
          >
            复用已有文件夹
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="label-tag mb-1 block">项目名称</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 my-app"
              className="field"
              autoFocus
            />
          </div>

          {tab === 'reuse' && (
            <div>
              <label className="label-tag mb-1 block">目录</label>
              <div className="flex gap-2">
                <input
                  value={picked}
                  readOnly
                  placeholder="点击右侧选择文件夹…"
                  className="field font-mono text-xs"
                />
                <button type="button" onClick={pick} className="btn btn-ghost shrink-0 px-3 text-xs">
                  选择
                </button>
              </div>
            </div>
          )}
          {tab === 'new' && (
            <div className="font-mono text-[10px] text-faint">
              将在「工作区根」下创建同名新文件夹（可在设置里改工作区根）。
            </div>
          )}
        </div>

        {err && <div className="mt-3 text-xs text-danger">{err}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost px-3 py-1.5 text-sm">
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="btn btn-primary px-4 py-1.5 text-sm disabled:opacity-50"
          >
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
