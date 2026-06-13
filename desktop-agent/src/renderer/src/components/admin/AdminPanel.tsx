import { useState } from 'react'
import { ModelManager } from './ModelManager'
import { StatsPanel } from './StatsPanel'
import { GeneralSettings } from './GeneralSettings'
import { ErrorBoundary } from '../ErrorBoundary'

interface Props {
  tab: string
  onClose: () => void
}

const TABS = [
  { key: 'models', label: '模型管理' },
  { key: 'stats', label: '统计信息' },
  { key: 'settings', label: '通用设置' }
]

export function AdminPanel({ tab, onClose }: Props): React.ReactElement {
  const [activeTab, setActiveTab] = useState(tab)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="glass-strong rise flex h-[78vh] w-[680px] max-w-[92vw] flex-col rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line/60 px-4 py-3">
          <span className="font-mono text-[10px] tracking-[0.25em] text-faint">CONTROL · 控制台</span>
          <div className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`rounded-lg px-3 py-1.5 text-sm transition ${
                  activeTab === t.key ? 'bg-card/70 text-fg' : 'text-faint hover:bg-card/40 hover:text-muted'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-faint transition hover:text-fg">
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === 'models' && <ModelManager />}
          {activeTab === 'stats' && (
            <ErrorBoundary label="统计页面加载出错">
              <StatsPanel />
            </ErrorBoundary>
          )}
          {activeTab === 'settings' && <GeneralSettings />}
        </div>
      </div>
    </div>
  )
}
