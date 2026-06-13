import { useState, useRef } from 'react'

interface ChatInputProps {
  onSend: (text: string) => void
  onStop?: () => void
  disabled: boolean
}

export function ChatInput({ onSend, onStop, disabled }: ChatInputProps): React.ReactElement {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = (): void => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleInput = (): void => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 200) + 'px'
    }
  }

  return (
    <div className="relative z-10 px-4 pb-4 pt-1">
      <div className="glass-strong mx-auto flex max-w-3xl items-end gap-2 rounded-2xl p-2 transition focus-within:border-accent/40">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder="问 MILO 任何问题…  (Enter 发送 · Shift+Enter 换行)"
          rows={1}
          disabled={disabled}
          className="max-h-[200px] flex-1 resize-none bg-transparent px-3 py-2 text-sm leading-relaxed text-fg outline-none placeholder:text-faint disabled:opacity-50"
        />
        {disabled ? (
          <button
            onClick={() => onStop?.()}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-danger/50 bg-danger/10 px-4 text-sm text-danger transition hover:bg-danger/20"
            title="停止生成"
          >
            <span className="h-2.5 w-2.5 rounded-[2px] bg-danger" /> 停止
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!text.trim()}
            className="btn btn-primary h-9 shrink-0 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送 <span className="opacity-70">↵</span>
          </button>
        )}
      </div>
    </div>
  )
}
