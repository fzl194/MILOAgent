import { create } from 'zustand'
import type {
  Message,
  AgentConfig,
  UsageStats,
  ToolExecutedEventData,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalSource
} from '../agent-core/types'
import { AgentLoop, type LoopDoneEvent, type AgentSafety, type AgentLoopHooks } from '../agent-core/agent/loop'
import { DefaultContextStrategy, DEFAULT_CONTEXT_WINDOW } from '../agent-core/agent/context-strategy'
import { LLMProvider } from '../agent-core/llm/provider'
import { ElectronToolExecutor } from '../adapters/electron-tool-executor'
import { useSessionStore } from './session-store'
import { useModelStore } from './model-store'
import { useStatsStore } from './stats-store'
import { useProjectStore, loadProjectClaudeMd } from './project-store'
import { usePermissionStore } from './permission-store'
import { useConfigStore } from './config-store'
import { ALL_TOOLS } from '../agent-core/tools/definitions'
import { buildToolRegistry } from '../agent-core/tools/harness'
import { getEffectiveConfig, type EffectiveConfig } from '../lib/effective-config'
import { getMonitorBus } from '../monitor/bus'
import { startDefaultPersistence } from '../monitor/persistence'
import type {
  DimKey,
  MonitorEnvelope,
  RequestSnapshot,
  TokenUsageEvent,
  TurnLifecycleEvent
} from '../monitor/types'

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
async function safeAppendTrace(pid: string, sid: string, event: object): Promise<void> {
  const res = await window.electronAPI.appendTrace(pid, sid, event)
  if (!res.success) {
    console.warn('[trace] failed to append event', res.error, event)
  }
}

// ---------------------------------------------------------------------------
// Monitor bus wiring. All publish() calls go through getMonitorBus(); the bus
// is lazy — when nothing is subscribed AND no persistent consumer is attached,
// the payload factory is never invoked (zero cost when monitoring is off).
// Snapshots are stamped with sessionId/projectId here (the loop emits with an
// empty sessionId because it doesn't own that identity — chat-store does).
// ---------------------------------------------------------------------------

/** Build the stable envelope shared by every event for one (callId, dimension). */
function envelope(
  dim: DimKey,
  ctx: { turnId: string; callId: string; round: number; sessionId: string },
  extra?: Record<string, unknown>
): MonitorEnvelope {
  return { dimension: dim, turnId: ctx.turnId, callId: ctx.callId, round: ctx.round, sessionId: ctx.sessionId, ts: Date.now(), details: extra }
}

/** Publish the full request snapshot to BOTH request_view and context_metrics.
 *  The two dimensions share a payload (context_metrics is the metrics slice),
 *  so we publish the same snapshot object; the persistent subscriber writes it
 *  once (it no-ops on context_metrics to avoid double-writing). */
function publishRequestSnapshot(sid: string, snapshot: RequestSnapshot): void {
  const ctx = { turnId: snapshot.turnId, callId: snapshot.callId, round: snapshot.round, sessionId: sid }
  const bus = getMonitorBus()
  // Heavy payload: the factory only runs when a subscriber exists.
  bus.publish('request_view', envelope('request_view', ctx), () => ({ ...snapshot, sessionId: sid }))
  bus.publish('context_metrics', envelope('context_metrics', ctx), () => ({
    callId: snapshot.callId,
    turnId: snapshot.turnId,
    round: snapshot.round,
    metrics: snapshot.metrics,
    decisions: snapshot.decisions
  }))
}

function publishToolCall(sid: string, turnId: string, data: ToolExecutedEventData, callId: string, round: number): void {
  // The envelope's callId is the PARENT LLM call (so clicking a tool_call row in
  // the panel selects the request that triggered it). The tool's own id rides in
  // details.toolCallId — using it as the envelope callId would make the row
  // un-selectable (no request_view shares a toolCallId).
  getMonitorBus().publish(
    'tool_call',
    envelope('tool_call', { turnId, callId, round, sessionId: sid }, { toolCallId: data.toolCallId }),
    () => ({
      ...data,
      parentCallId: callId,
      sessionId: sid
    })
  )
}

function publishTokenUsage(sid: string, e: TokenUsageEvent): void {
  getMonitorBus().publish('token_usage', envelope('token_usage', { turnId: e.turnId, callId: e.callId, round: e.round, sessionId: sid }), () => e)
}

function publishLifecycle(sid: string, e: TurnLifecycleEvent): void {
  getMonitorBus().publish('turn_lifecycle', envelope('turn_lifecycle', { turnId: e.turnId, callId: e.callId, round: e.round, sessionId: sid }, { stage: e.stage, reason: e.reason }), () => e)
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
function buildSafety(turnId: string, effective: EffectiveConfig): AgentSafety {
  return {
    ctx: {
      sandbox: effective.sandbox,
      workspaceRoot: effective.workspaceRoot,
      cwd: effective.cwd,
      // Unified rules: session scope first, then project scope. Defer merging
      // to call-time via a getter so a "remember" approval added DURING this
      // turn is visible to the next tool call's classifier — a static snapshot
      // taken at turn-build time would miss same-turn session rules.
      get rules() {
        return usePermissionStore.getState().merged(effective.projectRules)
      }
    },
    policy: effective.approvalPolicy,
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
                // Remember to the project THIS TURN belongs to (effective.projectId),
                // not just the active project — keeps the whole turn bound to
                // session.projectId, consistent with how effective config is resolved.
                const proj = useProjectStore.getState().projects.find((p) => p.id === effective.projectId)
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
  /** The session the in-flight turn belongs to. Null when no turn is running.
   *  Decouples streaming from the viewed session so switching mid-turn doesn't
   *  tear the turn's messages into the wrong session. */
  streamingSessionId: string | null
  currentText: string
  currentReasoning: string
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
  streamingSessionId: null,
  currentText: '', currentReasoning: '',
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
    const stopSid = get().streamingSessionId
    const stopMsgs = stopSid ? (ss.messagesBySession[stopSid] ?? []) : ss.currentMessages
    for (const m of stopMsgs) {
      if (m.role === 'tool' && m.status === 'running' && m.toolCallId) {
        ss.updateToolMessage(m.toolCallId, { status: 'failed', isError: true, content: m.content || '已停止' }, stopSid ?? undefined)
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
    sessionStore.addMessage(userMsg, sessionId)

    const controller = new AbortController()
    set({ isStreaming: true, streamingSessionId: sessionId, currentText: '', currentReasoning: '', lastToolCallCount: 0, abortController: controller })

    const session = sessionStore.sessions.find((s) => s.id === sessionId)
    const projectId = session?.projectId ?? useProjectStore.getState().activeProjectId ?? ''
    // Model resolution: session's model → project default → global default.
    const projDefaultId = useProjectStore.getState().getActive()?.config?.defaultModelId
    let modelConfig = session ? modelStore.getModel(session.modelConfigId) : undefined
    if (!modelConfig && projDefaultId) modelConfig = modelStore.getModel(projDefaultId)
    if (!modelConfig) modelConfig = modelStore.getDefaultModel()

    if (!modelConfig || !modelConfig.apiKey) {
      sessionStore.addMessage({ id: crypto.randomUUID(), role: 'assistant', content: '请先在管理面板中配置模型 API Key。', timestamp: Date.now() }, sessionId)
      set({ isStreaming: false, streamingSessionId: null, currentText: '', currentReasoning: '', abortController: null })
      await sessionStore.saveCurrentMessages(sessionId)
      return
    }

    // P1: load project-root memory (CLAUDE.md / AGENTS.md) for the system prompt.
    // Best-effort — loadProjectClaudeMd swallows all IPC errors → ''. Read fresh
    // every turn so edits take effect without a restart.
    const memProj = useProjectStore.getState().projects.find((p) => p.id === projectId)
    const memory = memProj?.dirPath ? await loadProjectClaudeMd(memProj.dirPath) : ''

    // Effective config (global ← project ← cwd), centralized in
    // lib/effective-config so turnConfig and buildSafety share one merge.
    const effective = getEffectiveConfig(projectId, { workspaceOverride: session?.workspaceRoot, memory })
    const turnConfig: AgentConfig = {
      systemPrompt: effective.systemPrompt,
      sandbox: effective.sandbox,
      approvalPolicy: effective.approvalPolicy
    }
    const turnId = crypto.randomUUID()
    // Wrap initialization (trace-meta read/append + loop construction) AND the
    // loop in one try — a throw here used to bypass the catch and leave
    // isStreaming/streamingSessionId stuck on. The catch finalizes any path.
    // Declared outside the try so the finally can tear it down on every exit path.
    // Async: teardown awaits bus.drain() so in-flight snapshot/trace writes finish
    // before the turn is reported done (prevents orphan snapshots on session delete).
    let stopPersistence: () => Promise<void> = async () => {}
    try {

    // Ensure a session_meta row exists (written once per session)
    if (!sessionMetaWritten.has(sessionId)) {
      const existing = await window.electronAPI.readTrace(projectId, sessionId)
      const hasMeta = (existing.data || []).some((e) => (e as { type?: string }).type === 'session_meta')
      if (!hasMeta) {
        await safeAppendTrace(projectId, sessionId,{
          type: 'session_meta',
          sessionId,
          modelConfigId: modelConfig.id,
          model: modelConfig.model,
          systemPrompt: turnConfig.systemPrompt,
          tools: ALL_TOOLS.map((t) => t.name),
          startedAt: Date.now()
        })
      }
      sessionMetaWritten.add(sessionId)
    }

    // Exclude the user message just added above — the loop adds it itself.
    // Filter by id (not positional slice) so an abnormal prior state can't drop
    // a trailing tool message and leave an orphan assistant(toolCalls) → API 400.
    const history = (useSessionStore.getState().messagesBySession[sessionId] ?? []).filter((m) => m.id !== userMsg.id)
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
    executor.setCwd(effective.cwd)

    // Start the monitor bus's persistent subscriber for THIS turn. It routes
    // request_view/context_metrics → snapshot files and the other dimensions →
    // trace. Teardown happens in the finally/catch paths below so a torn-down
    // turn stops writing. (No-op cost when nothing publishes — but we always
    // start it so monitoring is on by default for dev.)
    stopPersistence = startDefaultPersistence({ projectId, sessionId })

    // Monitor hooks handed to the loop. onRequestReady fires once per round
    // with the exact view + compaction decisions; onLifecycle fires on
    // started/aborted/finished. Both publish to the bus; the bus swallows any
    // subscriber error, so monitoring can never break the turn.
    let currentRound = 0
    const hooks: AgentLoopHooks = {
      onRequestReady: (snapshot) => {
        currentRound = snapshot.round
        publishRequestSnapshot(sessionId, snapshot)
      },
      onLifecycle: (stage, lc) => {
        currentRound = lc.round
        publishLifecycle(sessionId, {
          callId: lc.callId,
          turnId,
          round: lc.round,
          sessionId,
          ts: Date.now(),
          stage,
          reason: lc.reason,
          modelConfigId: modelConfig.id
        })
      }
    }

    // P1 harness rollout: when the flag is on, read_file runs through the
    // harness (tools/harness/); everything else stays on the legacy executor.
    const toolHarnessEnabled = useConfigStore.getState().config.toolHarness?.enabled === true
    const loop = new AgentLoop(
      { apiKey: modelConfig.apiKey, baseUrl: modelConfig.baseUrl, model: modelConfig.model },
      executor,
      turnConfig,
      history,
      buildSafety(turnId, effective),
      controller.signal,
      contextStrategy,
      hooks,
      modelConfig.id,
      toolHarnessEnabled ? buildToolRegistry() : undefined
    )

      for await (const event of loop.run(text, turnId)) {
        switch (event.type) {
          case 'text_delta':
            set((s) => ({ currentText: s.currentText + (event.data as string) }))
            break
          case 'reasoning_delta':
            set((s) => ({ currentReasoning: s.currentReasoning + (event.data as string) }))
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
            // Read the TURN's session cache FRESH — not the viewed session's
            // pointer — so placeholders added this turn are found even if the
            // user switched sessions mid-turn.
            const existing = (useSessionStore.getState().messagesBySession[sessionId] ?? [])
              .find((m) => m.role === 'tool' && m.toolCallId === d.toolCallId)
            if (existing) {
              sessionStore.updateToolMessage(d.toolCallId, {
                content: d.result,
                isError: d.isError,
                toolName: d.name,
                toolArgs: d.arguments,
                durationMs: d.durationMs,
                riskLevel: d.riskLevel,
                status
              }, sessionId)
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
              }, sessionId)
            }
            // Persist the atomic tool_call event
            await safeAppendTrace(projectId, sessionId,{
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
            // Mirror to the monitor bus (tool_call dimension). The persistent
            // subscriber will append this to the trace as a monitor-tagged row.
            publishToolCall(sessionId, turnId, d, lastCallId, currentRound)
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

            // Mirror per-round usage to the monitor bus (token_usage dimension).
            publishTokenUsage(sessionId, {
              callId: d.callId,
              turnId,
              round: d.round,
              sessionId,
              ts: Date.now(),
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
              cachedTokens: usage.cachedTokens,
              usageSource,
              modelConfigId: modelConfig.id
            })

            // Mirror assistant messages (tagged with modelConfigId + reasoning snapshot)
            // into currentMessages. Capture reasoning BEFORE it's cleared below.
            const reasoningSnapshot = get().currentReasoning
            for (const m of d.appendedMessages) {
              if (m.role === 'assistant') {
                sessionStore.addMessage({ ...m, modelConfigId: modelConfig.id, reasoning: reasoningSnapshot || undefined }, sessionId)
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
                }, sessionId)
              }
            }

            // Persist the atomic llm_call event (incremental: appendedMessages only)
            await safeAppendTrace(projectId, sessionId,{
              type: 'llm_call',
              callId: d.callId,
              sessionId,
              turnId: d.turnId,
              round: d.round,
              modelConfigId: modelConfig.id,
              model: modelConfig.model,
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
            set({ currentText: '', currentReasoning: '' })

            // Only the final (non-tool_calls) round finishes the turn
            if (d.finishReason !== 'tool_calls') {
              set({ isStreaming: false, streamingSessionId: null, lastToolCallCount: toolCallCount })

              // Title generation: append a title request to the SAME message prefix
              // the main turn used → API prefix cache hit (identical prefix, only the
              // last user message is new). Near-zero cost vs a separate call with a
              // different system prompt (which would always miss the cache).
              if (session && session.title === '新会话') {
                void (async () => {
                  try {
                    const provider = new LLMProvider({
                      apiKey: modelConfig.apiKey,
                      baseUrl: modelConfig.baseUrl,
                      model: modelConfig.model
                    })
                    // Rebuild the exact prefix the main turn sent, then append the title request.
                    const msgs = [
                      { role: 'system' as const, content: turnConfig.systemPrompt },
                      ...(useSessionStore.getState().messagesBySession[sessionId] ?? [])
                        .filter((m) => m.role !== 'system')
                        .map((m) => ({ role: m.role as 'user' | 'assistant' | 'tool', content: m.content })),
                      { role: 'user' as const, content: '请用一句话概括本次对话主题作为会话标题（不超过15字，纯文本，不要标点、引号、换行）。直接输出标题。' }
                    ]
                    let title = ''
                    // Pass ALL_TOOLS so the chat template expands identically to the
                    // main turn → same token sequence → prefix cache hit. Tool calls in
                    // the title response (unlikely) are simply ignored.
                    for await (const ev of provider.chat(msgs, ALL_TOOLS)) {
                      if (ev.type === 'text_delta') title += ev.data as string
                    }
                    title = title.trim().replace(/["'""''「」【】\n]/g, '').slice(0, 20)
                    if (title) await useSessionStore.getState().renameSession(session.id, title)
                  } catch {
                    // Fallback: truncation (no extra cost).
                    const fallback = text.slice(0, 20).replace(/\n/g, ' ').trim()
                    await useSessionStore.getState().renameSession(session.id, fallback)
                  }
                })()
              }

              await sessionStore.saveCurrentMessages(sessionId)
              await useStatsStore.getState().recordEvent(projectId, {
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
            sessionStore.addMessage({ id: crypto.randomUUID(), role: 'assistant', content: `错误: ${event.data}`, isError: true, timestamp: Date.now() }, sessionId)
            set({ isStreaming: false, streamingSessionId: null })
            await sessionStore.saveCurrentMessages(sessionId)
            break
          }
        }
      }

      // User pressed stop mid-turn: preserve whatever was streamed so far, then
      // finalize. (Normal completion is handled inside the `done` branch above.)
      if (controller.signal.aborted) {
        const partial = get().currentText
        const reasoning = get().currentReasoning
        if (partial.trim() || reasoning.trim()) {
          sessionStore.addMessage({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: partial,
            reasoning: reasoning || undefined,
            timestamp: Date.now()
          }, sessionId)
        }
        set({ isStreaming: false, streamingSessionId: null, currentText: '', currentReasoning: '', abortController: null })
        await sessionStore.saveCurrentMessages(sessionId)
      }
    } catch (err: any) {
      if (!controller.signal.aborted) {
        sessionStore.addMessage({ id: crypto.randomUUID(), role: 'assistant', content: `意外错误: ${err.message}`, isError: true, timestamp: Date.now() }, sessionId)
      }
      set({ isStreaming: false, streamingSessionId: null, currentText: '', currentReasoning: '', abortController: null })
      await sessionStore.saveCurrentMessages(sessionId)
    } finally {
      // Always tear down this turn's monitor persistence subscription so a
      // finished/stopped/errored turn stops writing snapshots + trace rows.
      // Awaited so in-flight writes complete (prevents orphan snapshots).
      await stopPersistence()
    }
  },

  clearCurrent: () => set({ currentText: '', currentReasoning: '', isStreaming: false, streamingSessionId: null, abortController: null })
}))
