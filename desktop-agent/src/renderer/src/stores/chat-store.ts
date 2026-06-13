import { create } from 'zustand'
import type {
  Message,
  AgentConfig,
  UsageStats,
  ToolExecutedEventData,
  ModelConfig,
  OpenAIChatMessage,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalSource,
  ProjectConfig
} from '../agent-core/types'
import { AgentLoop, type LoopDoneEvent, type AgentSafety } from '../agent-core/agent/loop'
import { DefaultContextStrategy, DEFAULT_CONTEXT_WINDOW } from '../agent-core/agent/context-strategy'
import { LLMProvider } from '../agent-core/llm/provider'
import { ElectronToolExecutor } from '../adapters/electron-tool-executor'
import { useSessionStore } from './session-store'
import { useModelStore } from './model-store'
import { useStatsStore } from './stats-store'
import { useConfigStore } from './config-store'
import { useAllowlistStore } from './allowlist-store'
import { useProjectStore } from './project-store'
import { usePermissionStore } from './permission-store'
import { ALL_TOOLS } from '../agent-core/tools/definitions'

function estimateTokens(text: string): number {
  const chinese = (text.match(/[一-鿿]/g) || []).length
  const english = text.replace(/[一-鿿]/g, ' ').split(/\s+/).filter(Boolean).length
  return Math.round(chinese / 1.5 + english)
}

// Resolve real token usage with a graceful fallback chain when the provider
// omits usage (or only returns totals).
function resolveUsage(
  usage: UsageStats | null | undefined,
  inputText: string,
  outputText: string
): { usage: UsageStats; usageSource: 'api' | 'partial' | 'estimated' } {
  if (usage && usage.inputTokens != null && usage.outputTokens != null) {
    return { usage, usageSource: 'api' }
  }
  if (usage && usage.totalTokens != null) {
    return {
      usage: { inputTokens: 0, outputTokens: usage.totalTokens, totalTokens: usage.totalTokens },
      usageSource: 'partial'
    }
  }
  return {
    usage: { inputTokens: estimateTokens(inputText), outputTokens: estimateTokens(outputText) },
    usageSource: 'estimated'
  }
}

// Module-scope executor (stateless, reuse across messages)
const executor = new ElectronToolExecutor()

// Track which sessions already have a session_meta row in their trace file
const sessionMetaWritten = new Set<string>()

// Append a trace event and warn (rather than fail silently) if persistence fails.
// Trace rows are the core observability surface — a silent drop would hide data loss.
async function safeAppendTrace(sid: string, event: object): Promise<void> {
  const res = await window.electronAPI.appendTrace(sid, event)
  if (!res.success) {
    console.warn('[trace] failed to append event', res.error, event)
  }
}

// Ask the model for a concise session title from the first exchange; falls back
// to truncating the user input on any failure (network error, bad model, etc.).
async function generateTitle(modelConfig: ModelConfig, userText: string, assistantText: string): Promise<string> {
  try {
    console.log('[title] generating via', modelConfig.model)
    const provider = new LLMProvider({
      apiKey: modelConfig.apiKey,
      baseUrl: modelConfig.baseUrl,
      model: modelConfig.model,
      temperature: 0,
      maxTokens: 2048
    })
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: '你是一个标题生成器。根据下面的对话生成一个简短的中文会话标题(不超过12个字,纯文本,不要标点、不要引号、不要换行)。直接输出标题本身。' },
      { role: 'user', content: `用户:${userText}\n助手:${assistantText.slice(0, 500)}` }
    ]
    let title = ''
    for await (const ev of provider.chat(messages)) {
      if (ev.type === 'text_delta') title += ev.data as string
      else if (ev.type === 'done') console.log('[title] done:', JSON.stringify(ev.data))
    }
    const clean = title.trim().replace(/["'“”‘’「」【】]/g, '').replace(/\s+/g, ' ').slice(0, 20)
    console.log('[title] generated:', clean || '(empty → fallback)')
    return clean || userText.slice(0, 20).trim()
  } catch (e: any) {
    console.warn('[title] generation failed, fallback to truncation:', e?.message ?? e)
    return userText.slice(0, 20).trim()
  }
}

// Read fresh each turn from the config store (the single source of truth, kept
// up-to-date by the Settings panel). Avoids a per-message IPC round-trip and a
// stale module-level cache.
function loadConfig(): AgentConfig {
  return useConfigStore.getState().config
}

// The active project's directory, when bound and present. The agent's shell and
// relative file paths run inside it; the default project (no dir) returns undefined.
function activeProjectDir(): string | undefined {
  const ps = useProjectStore.getState()
  const active = ps.getActive()
  return active?.dirPath && !ps.dirMissing[active.id] ? active.dirPath : undefined
}

// The active project's config overrides (undefined for the default project).
function activeProjectConfig(): ProjectConfig | undefined {
  return useProjectStore.getState().getActive()?.config
}

// Compose the effective system prompt: global base ← project prompt ← cwd note.
function buildSystemPrompt(base: string, projectPrompt: string | undefined, dir?: string): string {
  let s = base.trim()
  if (projectPrompt && projectPrompt.trim()) {
    s = s ? `${s}\n\n${projectPrompt.trim()}` : projectPrompt.trim()
  }
  if (!dir) return s
  const note = `# 工作目录\n你的当前工作目录是 \`${dir}\`。相对路径基于此解析，shell 命令默认在此目录下执行；请优先在此目录内工作。`
  return s ? `${s}\n\n${note}` : note
}

// ---------------------------------------------------------------------------
// Approval gate: the AgentLoop calls gate.request(req) when a tool call needs
// human approval. The request is pushed into `pendingApprovals` (rendered as an
// inline ApprovalCard); the user's click resolves the stored promise.
// ---------------------------------------------------------------------------
const approvalResolvers = new Map<string, (d: ApprovalDecision) => void>()

// Pushed into `pendingApprovals` by the gate; `useChatStore` is initialized by
// the time the gate runs (turns only happen after app mount).
function pushPendingApproval(req: ApprovalRequest): void {
  useChatStore.setState((s) => ({ pendingApprovals: [...s.pendingApprovals, req] }))
}

// Build the safety config handed to the AgentLoop for one turn. Reads fresh
// sandbox/policy/workspace from the config store (with a session-level workspace
// override) and the combined allowlist. `cwd` is the turn-scoped project dir,
// used by the loop to resolve relative write_file paths before classification.
function buildSafety(turnId: string, workspaceOverride?: string, cwd?: string): AgentSafety {
  const cfg = useConfigStore.getState().config
  // Effective safety = global ← active project overrides.
  const pcfg = useProjectStore.getState().getActive()?.config
  return {
    ctx: {
      sandbox: pcfg?.sandbox ?? cfg.sandbox,
      workspaceRoot: workspaceOverride ?? cfg.workspaceRoot,
      cwd,
      // Unified rules: session scope first, then project scope.
      rules: usePermissionStore.getState().merged(pcfg?.rules)
    },
    policy: pcfg?.approvalPolicy ?? cfg.approvalPolicy,
    getAllowlist: () => useAllowlistStore.getState().all(),
    gate: {
      request: (req: ApprovalRequest) =>
        new Promise<{ decision: ApprovalDecision; source: ApprovalSource }>((resolve) => {
          approvalResolvers.set(req.reqId, (decision) => {
            // Persist a "remember" approval as a unified allow rule, to the chosen
            // scope (session or project). Dangerous calls have no patterns and are
            // skipped by the classifier, so they can never be remembered.
            if (decision.approved && decision.remember && req.patterns.length > 0) {
              const newRules = req.patterns.map((p) => ({ pattern: p, action: 'allow' as const, tool: req.name }))
              if (decision.scope === 'project') {
                const proj = useProjectStore.getState().getActive()
                if (proj) {
                  const existing = proj.config?.rules ?? []
                  const mergedRules = [
                    ...existing,
                    ...newRules.filter(
                      (r) =>
                        !existing.some(
                          (e) => e.pattern === r.pattern && e.action === r.action && e.tool === r.tool
                        )
                    )
                  ]
                  useProjectStore
                    .getState()
                    .updateConfig(proj.id, { rules: mergedRules })
                    .catch((e) => console.error('[approval] failed to persist project rule', e))
                }
              } else {
                usePermissionStore
                  .getState()
                  .addSessionRules(newRules)
                  .catch((e) => console.error('[approval] failed to persist session rule', e))
              }
            }
            resolve({ decision, source: decision.approved ? 'user' : 'denied' })
          })
          pushPendingApproval(req)
        })
    }
  }
}

interface ChatState {
  isStreaming: boolean
  currentText: string
  lastToolCallCount: number
  pendingApprovals: ApprovalRequest[]
  abortController: AbortController | null
  sendMessage: (text: string) => Promise<void>
  resolveApproval: (reqId: string, decision: ApprovalDecision) => void
  stop: () => void
  clearCurrent: () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  isStreaming: false,
  currentText: '',
  lastToolCallCount: 0,
  pendingApprovals: [],
  abortController: null,

  resolveApproval: (reqId, decision) => {
    const fn = approvalResolvers.get(reqId)
    if (fn) {
      approvalResolvers.delete(reqId)
      fn(decision)
    }
    set((s) => ({ pendingApprovals: s.pendingApprovals.filter((r) => r.reqId !== reqId) }))
  },

  // Abort the in-flight turn: cancels the LLM fetch, kills the running shell,
  // and resolves any pending approval as denied so the loop unblocks and exits.
  stop: () => {
    const ctrl = get().abortController
    if (ctrl && !ctrl.signal.aborted) ctrl.abort()
    for (const [, fn] of approvalResolvers) fn({ approved: false, reason: '用户停止' })
    approvalResolvers.clear()
    // Finalize any tool calls still mid-flight so their cards don't hang in the
    // "calling…" state after the user stops.
    const ss = useSessionStore.getState()
    for (const m of ss.currentMessages) {
      if (m.role === 'tool' && m.status === 'running' && m.toolCallId) {
        ss.updateToolMessage(m.toolCallId, { status: 'failed', isError: true, content: m.content || '已停止' })
      }
    }
    set({ pendingApprovals: [] })
  },

  sendMessage: async (text: string) => {
    const sessionStore = useSessionStore.getState()
    const modelStore = useModelStore.getState()

    if (!sessionStore.activeSessionId) return

    // Serialize turns: a double-click, rapid Enter, or direct store call must
    // not start a second concurrent turn — turn-scoped state (abortController,
    // currentText, approvalResolvers, currentShell) would race.
    if (get().isStreaming) return

    const sessionId = sessionStore.activeSessionId
    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: text, timestamp: Date.now() }
    sessionStore.addMessage(userMsg)

    const controller = new AbortController()
    set({ isStreaming: true, currentText: '', lastToolCallCount: 0, abortController: controller })

    const session = sessionStore.sessions.find((s) => s.id === sessionId)
    // Model resolution: session's model → project default → global default.
    const projDefaultId = useProjectStore.getState().getActive()?.config?.defaultModelId
    let modelConfig = session ? modelStore.getModel(session.modelConfigId) : undefined
    if (!modelConfig && projDefaultId) modelConfig = modelStore.getModel(projDefaultId)
    if (!modelConfig) modelConfig = modelStore.getDefaultModel()

    if (!modelConfig || !modelConfig.apiKey) {
      sessionStore.addMessage({ id: crypto.randomUUID(), role: 'assistant', content: '请先在管理面板中配置模型 API Key。', timestamp: Date.now() })
      set({ isStreaming: false, currentText: '', abortController: null })
      await sessionStore.saveCurrentMessages()
      return
    }

    const config = loadConfig()
    // Bind the turn to the active project: inject the working directory into the
    // system prompt and use it as the safety workspace boundary (unless the
    // session overrides workspaceRoot). Effective config = global ← project.
    const projDir = activeProjectDir()
    const pcfg = activeProjectConfig()
    const turnConfig: AgentConfig = {
      ...config,
      sandbox: pcfg?.sandbox ?? config.sandbox,
      approvalPolicy: pcfg?.approvalPolicy ?? config.approvalPolicy,
      systemPrompt: buildSystemPrompt(config.systemPrompt, pcfg?.systemPrompt, projDir)
    }
    const turnId = crypto.randomUUID()

    // Ensure a session_meta row exists (written once per session)
    if (!sessionMetaWritten.has(sessionId)) {
      const existing = await window.electronAPI.readTrace(sessionId)
      const hasMeta = (existing.data || []).some((e) => (e as { type?: string }).type === 'session_meta')
      if (!hasMeta) {
        await safeAppendTrace(sessionId,{
          type: 'session_meta',
          sessionId,
          modelConfigId: modelConfig.id,
          model: modelConfig.model,
          systemPrompt: turnConfig.systemPrompt,
          temperature: modelConfig.temperature,
          maxTokens: modelConfig.maxTokens,
          tools: ALL_TOOLS.map((t) => t.name),
          startedAt: Date.now()
        })
      }
      sessionMetaWritten.add(sessionId)
    }

    // Exclude the user message just added above — the loop adds it itself.
    // Filter by id (not positional slice) so an abnormal prior state can't drop
    // a trailing tool message and leave an orphan assistant(toolCalls) → API 400.
    const history = sessionStore.currentMessages.filter((m) => m.id !== userMsg.id)
    const turnStartedAt = Date.now()
    let toolCallCount = 0
    let lastCallId = ''
    // Accumulate tokens across ALL llm_calls in this turn (a tool-using turn may
    // span several rounds); recording only the final round would lose the rest.
    let turnInputTokens = 0
    let turnOutputTokens = 0
    let turnUsageSource: 'api' | 'partial' | 'estimated' = 'api'

    // Build the model-aware context strategy: token budget uses the active
    // model's declared context window (falls back to a conservative default),
    // and the message-count cap comes from the agent config.
    const contextStrategy = new DefaultContextStrategy({
      contextWindow: modelConfig.contextWindow ?? DEFAULT_CONTEXT_WINDOW
    })

    // Freeze the turn's cwd on the executor so tool execution can't drift if the
    // user switches project mid-turn (approval wait).
    executor.setCwd(projDir)

    const loop = new AgentLoop(
      { apiKey: modelConfig.apiKey, baseUrl: modelConfig.baseUrl, model: modelConfig.model, temperature: modelConfig.temperature, maxTokens: modelConfig.maxTokens },
      executor,
      turnConfig,
      history,
      buildSafety(turnId, session?.workspaceRoot ?? projDir, projDir),
      controller.signal,
      contextStrategy
    )

    try {
      for await (const event of loop.run(text, turnId)) {
        switch (event.type) {
          case 'text_delta':
            set((s) => ({ currentText: s.currentText + (event.data as string) }))
            break
          case 'tool_call_start':
            toolCallCount++
            break
          case 'tool_executed': {
            const d = event.data as ToolExecutedEventData
            // Transition this call's card from "calling…" to success/failed IN
            // PLACE. A 'running' placeholder was inserted on the `done` event
            // (matched by toolCallId); update it so the SAME card animates. Fall
            // back to append if no placeholder exists (defensive).
            const status: Message['status'] = d.isError ? 'failed' : 'success'
            // Read currentMessages FRESH from the store — the `sessionStore`
            // captured at turn start holds a stale snapshot that doesn't include
            // the placeholders added this turn, so a stale read would miss the
            // placeholder, fall back to addMessage, and create a duplicate
            // (running + failed) card for the same call.
            const existing = useSessionStore
              .getState()
              .currentMessages.find((m) => m.role === 'tool' && m.toolCallId === d.toolCallId)
            if (existing) {
              sessionStore.updateToolMessage(d.toolCallId, {
                content: d.result,
                isError: d.isError,
                toolName: d.name,
                toolArgs: d.arguments,
                durationMs: d.durationMs,
                riskLevel: d.riskLevel,
                status
              })
            } else {
              sessionStore.addMessage({
                id: crypto.randomUUID(),
                role: 'tool',
                content: d.result,
                toolCallId: d.toolCallId,
                isError: d.isError,
                toolName: d.name,
                toolArgs: d.arguments,
                durationMs: d.durationMs,
                riskLevel: d.riskLevel,
                status,
                timestamp: Date.now()
              })
            }
            // Persist the atomic tool_call event
            await safeAppendTrace(sessionId,{
              type: 'tool_call',
              toolCallId: d.toolCallId,
              callId: lastCallId,
              sessionId,
              name: d.name,
              arguments: d.arguments,
              result: d.result,
              resultTruncated: d.resultTruncated,
              isError: d.isError,
              riskLevel: d.riskLevel,
              approvedBy: d.approvedBy,
              startedAt: Date.now() - d.durationMs,
              durationMs: d.durationMs
            })
            break
          }
          case 'done': {
            const d = event.data as LoopDoneEvent
            lastCallId = d.callId
            // For the estimated fallback, approximate this call's input from the
            // messages it added (closer than reusing the user text each round).
            const inputEstimate = d.appendedMessages.map((m) => m.content).join('')
            const { usage, usageSource } = resolveUsage(d.usage, inputEstimate, d.textContent)
            turnInputTokens += usage.inputTokens
            turnOutputTokens += usage.outputTokens
            if (usageSource === 'estimated') turnUsageSource = 'estimated'
            else if (usageSource === 'partial' && turnUsageSource === 'api') turnUsageSource = 'partial'

            // Mirror assistant messages (tagged with modelConfigId) into currentMessages
            for (const m of d.appendedMessages) {
              if (m.role === 'assistant') {
                sessionStore.addMessage({ ...m, modelConfigId: modelConfig.id })
              }
            }

            // Tool-calling round: insert a 'running' placeholder per tool call so
            // its card can animate running → success/failed in place when
            // tool_executed lands. Placed AFTER the assistant message (correct
            // position); matched + updated by toolCallId on tool_executed.
            if (d.finishReason === 'tool_calls') {
              for (const tc of d.toolCalls) {
                let parsedArgs: Record<string, unknown>
                try {
                  parsedArgs = JSON.parse(tc.arguments)
                } catch {
                  parsedArgs = {}
                }
                sessionStore.addMessage({
                  id: crypto.randomUUID(),
                  role: 'tool',
                  content: '',
                  toolCallId: tc.id,
                  toolName: tc.name,
                  toolArgs: parsedArgs,
                  status: 'running',
                  timestamp: Date.now()
                })
              }
            }

            // Persist the atomic llm_call event (incremental: appendedMessages only)
            await safeAppendTrace(sessionId,{
              type: 'llm_call',
              callId: d.callId,
              sessionId,
              turnId: d.turnId,
              round: d.round,
              modelConfigId: modelConfig.id,
              model: modelConfig.model,
              temperature: modelConfig.temperature,
              maxTokens: modelConfig.maxTokens,
              tools: ALL_TOOLS.map((t) => t.name),
              appendedMessages: d.appendedMessages.map((m) => ({
                msgId: m.id,
                role: m.role,
                content: m.content,
                toolCalls: m.toolCalls,
                toolCallId: m.toolCallId,
                isError: m.isError
              })),
              contextMsgCount: d.contextMsgCount,
              usage,
              usageSource,
              finishReason: d.finishReason,
              startedAt: d.startedAt,
              durationMs: d.durationMs
            })

            // Streaming text is now mirrored into messages; clear the live buffer
            set({ currentText: '' })

            // Only the final (non-tool_calls) round finishes the turn
            if (d.finishReason !== 'tool_calls') {
              set({ isStreaming: false, lastToolCallCount: toolCallCount })

              // Generate a concise title in the background (first turn only) — fire-and-forget
              // so it doesn't block saving the conversation. Uses this session's model; not traced.
              if (session && session.title === '新会话') {
                void generateTitle(modelConfig, text, d.textContent).then((title) =>
                  sessionStore.renameSession(session.id, title)
                )
              }

              await sessionStore.saveCurrentMessages()
              await useStatsStore.getState().recordEvent({
                id: crypto.randomUUID(),
                sessionId,
                modelConfigId: modelConfig.id,
                timestamp: Date.now(),
                inputTokens: turnInputTokens,
                outputTokens: turnOutputTokens,
                toolCalls: toolCallCount,
                durationMs: Date.now() - turnStartedAt,
                usageSource: turnUsageSource,
                turnId,
                round: d.round
              })
            }
            break
          }
          case 'error': {
            sessionStore.addMessage({ id: crypto.randomUUID(), role: 'assistant', content: `错误: ${event.data}`, isError: true, timestamp: Date.now() })
            set({ isStreaming: false })
            await sessionStore.saveCurrentMessages()
            break
          }
        }
      }

      // User pressed stop mid-turn: preserve whatever was streamed so far, then
      // finalize. (Normal completion is handled inside the `done` branch above.)
      if (controller.signal.aborted) {
        const partial = get().currentText
        if (partial.trim()) {
          sessionStore.addMessage({ id: crypto.randomUUID(), role: 'assistant', content: partial, timestamp: Date.now() })
        }
        set({ isStreaming: false, currentText: '', abortController: null })
        await sessionStore.saveCurrentMessages()
      }
    } catch (err: any) {
      if (!controller.signal.aborted) {
        sessionStore.addMessage({ id: crypto.randomUUID(), role: 'assistant', content: `意外错误: ${err.message}`, isError: true, timestamp: Date.now() })
      }
      set({ isStreaming: false, currentText: '', abortController: null })
      await sessionStore.saveCurrentMessages()
    }
  },

  clearCurrent: () => set({ currentText: '', isStreaming: false })
}))
