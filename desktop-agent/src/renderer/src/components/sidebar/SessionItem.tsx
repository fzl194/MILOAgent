import { useState } from 'react'
import type { Session } from '../../agent-core/types'

interface Props {
  session: Session
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
  onRename: (t: string) => void
}

export function SessionItem({ session, isActive, onSelect, onDelete, onRename }: Props): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(session.title)
  const [showMenu, setShowMenu] = useState(false)

  const handleRename = (): void => {
    setEditing(false)
    if (title.trim() && title !== session.title) onRename(title.trim())
  }

  return (
    <div
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        setShowMenu(!showMenu)
      }}
      className={`group relative mb-0.5 flex cursor-pointer items-center rounded-lg px-2.5 py-2 text-sm transition ${
        isActive ? 'bg-elevated text-fg' : 'text-muted hover:bg-card/60 hover:text-fg'
      }`}
    >
      {isActive && (
        <span
          className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full"
          style={{ background: 'linear-gradient(var(--color-accent), var(--color-accent2))' }}
        />
      )}
      {editing ? (
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => e.key === 'Enter' && handleRename()}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          className="w-full rounded border-b border-accent bg-transparent py-0.5 text-sm text-fg outline-none"
        />
      ) : (
        <span className="truncate">{session.title}</span>
      )}
      <div
        className={`ml-auto flex items-center gap-0.5 transition-opacity ${showMenu || isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => {
            setEditing(true)
            setTitle(session.title)
            setShowMenu(false)
          }}
          className="rounded p-1 text-faint transition hover:text-accent"
          title="重命名"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
        <button
          onClick={() => {
            onDelete()
            setShowMenu(false)
          }}
          className="rounded p-1 text-faint transition hover:text-danger"
          title="删除"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          </svg>
        </button>
      </div>
    </div>
  )
}
