import { useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { useModelStore } from '../../stores/model-store'
import { SessionItem } from './SessionItem'
import { NewSessionDialog } from './NewSessionDialog'
import { AdminPanel } from '../admin/AdminPanel'
import { useThemeStore } from '../../stores/theme-store'

export function Sidebar(): React.ReactElement {
  const { sessions, activeSessionId, switchSession, createSession, deleteSession, renameSession } = useSessionStore()
  const models = useModelStore((s) => s.models)
  const [showNewSession, setShowNewSession] = useState(false)
  const [adminTab, setAdminTab] = useState<string | null>(null)
  const theme = useThemeStore((s) => s.theme)
  const toggleTheme = useThemeStore((s) => s.toggle)

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = today - 86400000

  const groups: { label: string; sessions: typeof sessions }[] = [
    { label: '今天', sessions: sessions.filter((s) => s.updatedAt >= today) },
    { label: '昨天', sessions: sessions.filter((s) => s.updatedAt >= yesterday && s.updatedAt < today) },
    { label: '更早', sessions: sessions.filter((s) => s.updatedAt < yesterday) }
  ]

  const handleNewSession = async (modelConfigId: string): Promise<void> => {
    setShowNewSession(false)
    await createSession('新会话', modelConfigId)
  }

  // NOTE: NewSessionDialog and AdminPanel are rendered as SIBLINGS of the glass
  // sidebar (not children). A `backdrop-filter` ancestor becomes the containing
  // block for `position: fixed`, which would otherwise trap these full-screen
  // modals inside the 256px sidebar.
  return (
    <>
      <div className="glass flex h-full w-64 flex-col border-r border-line/60">
        <div className="flex items-center gap-2 px-4 py-3.5">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-lg text-sm font-bold text-on-accent"
            style={{ backgroundImage: 'linear-gradient(135deg, var(--color-accent), var(--color-accent2))', boxShadow: '0 0 16px -4px var(--color-accent)' }}
          >
            ◆
          </div>
          <div className="leading-none">
            <div className="brand text-sm font-bold tracking-[0.14em] text-fg">MILO</div>
            <div className="font-mono text-[9px] tracking-[0.3em] text-faint">CONSOLE</div>
          </div>
          <button
            onClick={toggleTheme}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg border border-line bg-card/50 text-muted transition hover:text-fg"
            title={theme === 'dark' ? '切换到亮色' : '切换到暗色'}
          >
            {theme === 'dark' ? '☾' : '☼'}
          </button>
        </div>

        <div className="px-3 pb-2">
          <button
            onClick={() => {
              if (models.length === 1) handleNewSession(models[0].id)
              else setShowNewSession(true)
            }}
            className="btn w-full justify-start gap-2 rounded-xl border border-line bg-card/50 px-3 py-2 text-sm text-muted transition hover:border-accent/40 hover:text-fg"
          >
            <span className="text-base leading-none text-accent">+</span> 新建会话
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-1">
          {groups.map((g) =>
            g.sessions.length > 0 ? (
              <div key={g.label} className="mb-2">
                <div className="px-2 py-1 font-mono text-[10px] tracking-[0.2em] text-faint">{g.label.toUpperCase()}</div>
                {g.sessions.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    isActive={s.id === activeSessionId}
                    onSelect={() => switchSession(s.id)}
                    onDelete={() => deleteSession(s.id)}
                    onRename={(t) => renameSession(s.id, t)}
                  />
                ))}
              </div>
            ) : null
          )}
          {sessions.length === 0 && <div className="px-3 py-10 text-center text-xs text-faint">暂无会话</div>}
        </div>

        <div className="border-t border-line/60 p-2">
          <button
            onClick={() => setAdminTab('models')}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-card/40 py-2 text-xs font-medium text-muted transition hover:border-accent/40 hover:bg-card/60 hover:text-fg"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-accent"
            >
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            设置
          </button>
        </div>
      </div>

      {showNewSession && <NewSessionDialog onSelect={handleNewSession} onClose={() => setShowNewSession(false)} />}
      {adminTab && <AdminPanel tab={adminTab} onClose={() => setAdminTab(null)} />}
    </>
  )
}
