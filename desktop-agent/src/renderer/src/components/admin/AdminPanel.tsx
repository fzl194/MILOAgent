import { useState } from 'react'
import { ModelManager } from './ModelManager'
import { StatsPanel } from './StatsPanel'
import { GeneralSettings } from './GeneralSettings'
import { MonitorPanel } from './MonitorPanel/MonitorPanel'
import { ErrorBoundary } from '../ErrorBoundary'

interface Props {
  tab: string
  onClose: () => void
}

const TABS = [
  { key: 'models', label: '模型管理' },
  { key: 'stats', label: '统计信息' },
  { key: 'monitor', label: '监控' },
  { key: 'settings', label: '通用设置' }
]

export function AdminPanel({ tab, onClose }: Props): React.ReactElement {
  const [activeTab, setActiveTab] = useState(tab)
  // The monitor panel needs a wider, taller surface (two-column request view +
  // decisions + token dashboard) than the other admin tabs; widen the shell
  // only when it's active so the rest keep their compact layout.
  const wide = activeTab === 'monitor'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`glass-strong rise flex flex-col rounded-2xl ${wide ? 'h-[90vh] w-[1100px] max-w-[96vw]' : 'h-[78vh] w-[680px] max-w-[92vw]'}`}
        onClick={(e) => e.stopPropagation()}
      >
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
        <div className={`flex-1 p-5 ${wide ? 'overflow-hidden' : 'overflow-y-auto'}`}>
          {activeTab === 'models' && <ModelManager />}
          {activeTab === 'stats' && (
            <ErrorBoundary label="统计页面加载出错">
              <StatsPanel />
            </ErrorBoundary>
          )}
          {activeTab === 'monitor' && (
            <ErrorBoundary label="监控面板加载出错">
              <MonitorPanel />
            </ErrorBoundary>
          )}
          {activeTab === 'settings' && <GeneralSettings />}
        </div>
      </div>
    </div>
  )
}
