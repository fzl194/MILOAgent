import { useEffect } from 'react'
import { Sidebar } from './components/sidebar/Sidebar'
import { ChatPanel } from './components/chat/ChatPanel'
import { useModelStore } from './stores/model-store'
import { useSessionStore } from './stores/session-store'
import { useStatsStore } from './stores/stats-store'
import { useConfigStore } from './stores/config-store'
import { useAllowlistStore } from './stores/allowlist-store'

// One-time cleanup of legacy config.json that may still hold dead LLM fields
// (apiKey/baseUrl/model) left over from the removed GlobalConfig. Those values
// now live in models.json; config.json should only hold AgentConfig.
async function migrateConfig(): Promise<void> {
  const res = await window.electronAPI.readConfig()
  const c = res.data || {}
  // Legacy config.json may still hold dead LLM fields (apiKey/baseUrl/model) from
  // the removed GlobalConfig — those now live in models.json. Strip them while
  // preserving any valid AgentConfig fields the user already set.
  if (c.apiKey || c.baseUrl || c.model) {
    await window.electronAPI.writeConfig({
      systemPrompt: typeof c.systemPrompt === 'string' ? c.systemPrompt : '',
      maxToolRounds: typeof c.maxToolRounds === 'number' ? c.maxToolRounds : 5,
      maxContextMessages: typeof c.maxContextMessages === 'number' ? c.maxContextMessages : 20,
      sandbox: c.sandbox ?? 'workspace-write',
      approvalPolicy: c.approvalPolicy ?? 'on-request',
      workspaceRoot: typeof c.workspaceRoot === 'string' ? c.workspaceRoot : undefined
    })
  }
}

function App(): React.ReactElement {
  const loadModels = useModelStore((s) => s.loadModels)
  const loadSessions = useSessionStore((s) => s.loadSessions)
  const loadStats = useStatsStore((s) => s.loadStats)
  const loadConfig = useConfigStore((s) => s.load)
  const loadAllowlist = useAllowlistStore((s) => s.load)

  useEffect(() => {
    ;(async () => {
      await loadConfig()
      await loadAllowlist()
      await loadModels()
      await loadSessions()
      await loadStats()
      await migrateConfig()
    })()
  }, [])

  return (
    <div className="relative flex h-screen overflow-hidden text-fg">
      {/* atmosphere */}
      <div className="app-aura" aria-hidden />
      <div className="grain" aria-hidden />
      {/* content above atmosphere */}
      <div className="relative z-10 flex h-full w-full">
        <Sidebar />
        <ChatPanel />
      </div>
    </div>
  )
}

export default App
