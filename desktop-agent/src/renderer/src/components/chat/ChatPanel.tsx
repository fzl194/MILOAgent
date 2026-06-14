import { useState, useMemo } from 'react'
import { useChatStore } from '../../stores/chat-store'
import { useSessionStore } from '../../stores/session-store'
import { useModelStore } from '../../stores/model-store'
import { useStatsStore } from '../../stores/stats-store'
import { useConfigStore } from '../../stores/config-store'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'

export function ChatPanel(): React.ReactElement {
  const { currentText, currentReasoning, isStreaming, streamingSessionId, sendMessage, stop } = useChatStore()
  const { sessions, activeSessionId, currentMessages, updateSessionModel } = useSessionStore()
  // Only show this turn's streaming preview when viewing the session it belongs
  // to — switching away must not leak another session's live text/reasoning,
  // and switching back resumes the preview (the turn kept appending to its own
  // session cache the whole time).
  const viewingStreaming = isStreaming && streamingSessionId === activeSessionId
  const models = useModelStore((s) => s.models)
  const [showModelMenu, setShowModelMenu] = useState(false)

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const activeModel = activeSession ? models.find((m) => m.id === activeSession.modelConfigId) : null

  // Running token total for the active session (shown in the top bar).
  const statsEvents = useStatsStore((s) => s.events)
  const totalTokens = useMemo(
    () =>
      statsEvents
        .filter((e) => e.sessionId === activeSessionId)
        .reduce((sum, e) => sum + (e.inputTokens || 0) + (e.outputTokens || 0), 0),
    [statsEvents, activeSessionId]
  )

  const handleSwitchModel = async (modelId: string): Promise<void> => {
    if (activeSession) {
      await updateSessionModel(activeSession.id, modelId)
      setShowModelMenu(false)
    }
  }

  // Safety-mode badge in the top bar (sandbox · approval policy), so the current
  // trust level is visible at a glance — mirroring how Codex surfaces permissions.
  const config = useConfigStore((s) => s.config)
  const sbLabel = config.sandbox === 'read-only' ? 'RO' : config.sandbox === 'full-access' ? 'FULL' : 'WS'
  const polLabel = config.approvalPolicy === 'auto' ? 'AUTO' : config.approvalPolicy === 'untrusted' ? 'CONFIRM' : 'ASK'
  const badgeTone =
    config.sandbox === 'read-only' || config.approvalPolicy === 'untrusted'
      ? 'var(--color-ok)'
      : config.sandbox === 'full-access' || config.approvalPolicy === 'auto'
        ? 'var(--color-warn)'
        : 'var(--color-accent)'

  if (!activeSessionId) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div
            className="floaty mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-xl font-bold text-on-accent"
            style={{ backgroundImage: 'linear-gradient(135deg, var(--color-accent), var(--color-accent2))', boxShadow: '0 0 40px -10px var(--color-accent)' }}
          >
            ◆
          </div>
          <p className="brand text-lg tracking-widest text-fg">DESKTOP AGENT</p>
          <p className="mt-1 text-sm text-faint">点击左侧「+ 新建会话」开始</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="glass relative z-20 flex items-center justify-between px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="pulse-glow h-2 w-2 rounded-full bg-ok" />
          <h1 className="truncate text-sm font-medium text-fg">{activeSession?.title || '会话'}</h1>
          {totalTokens > 0 && (
            <span className="shrink-0 font-mono text-[10px] text-faint">
              {totalTokens > 999 ? (totalTokens / 1000).toFixed(1) + 'k' : totalTokens} tokens
            </span>
          )}
          <span
            className="shrink-0 rounded-md border border-line/70 bg-card/50 px-1.5 py-0.5 font-mono text-[9px] tracking-wider"
            style={{ color: badgeTone }}
            title={`沙箱：${config.sandbox} · 审批：${config.approvalPolicy}`}
          >
            {sbLabel}·{polLabel}
          </span>
        </div>
        <div className="relative">
          <button
            onClick={() => setShowModelMenu(!showModelMenu)}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-card/60 px-2.5 py-1 text-xs text-muted transition hover:border-accent/40 hover:text-fg"
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--color-accent)' }} />
            <span className="font-mono">{activeModel?.name || '未选择'}</span>
            <span className="text-[9px] text-faint">▼</span>
          </button>
          {showModelMenu && (
            <div className="glass-strong absolute right-0 top-9 z-30 w-52 rounded-xl p-1">
              {models.map((m) => (
                <button
                  key={m.id}
                  onClick={() => handleSwitchModel(m.id)}
                  className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition hover:bg-elevated ${
                    m.id === activeSession?.modelConfigId ? 'text-accent' : 'text-muted'
                  }`}
                >
                  <span>{m.name}</span>
                  <span className="font-mono text-[10px] text-faint">{m.model}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <MessageList messages={currentMessages} currentText={viewingStreaming ? currentText : ''} currentReasoning={viewingStreaming ? currentReasoning : ''} isStreaming={viewingStreaming} />
      <ChatInput onSend={sendMessage} onStop={stop} disabled={isStreaming} />
    </div>
  )
}
