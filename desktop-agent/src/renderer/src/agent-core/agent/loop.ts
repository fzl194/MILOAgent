import type {
  LLMConfig,
  AgentConfig,
  StreamEvent,
  Message,
  ToolResult,
  DoneEventData,
  ToolExecutedEventData,
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalSource,
  RiskLevel
} from '../types'
import type { ToolExecutor } from '../tools/executor'
import { LLMProvider } from '../llm/provider'
import { ALL_TOOLS } from '../tools/definitions'
import { ContextManager } from './context'
import {
  ContextStrategy,
  DefaultContextStrategy,
  DEFAULT_CONTEXT_WINDOW
} from './context-strategy'
import { classify, decide, type ClassifyContext } from '../safety/classifier'
import { runTool, type ToolRegistry } from '../tools/harness'
import type { RequestSnapshot, TurnLifecycleStage } from '../../monitor/types'

/**
 * Internal runaway guard: caps how many tool rounds a single turn may run. Not
 * user-facing — the model ends a turn naturally when it stops calling tools;
 * this only bounds a stuck/infinite tool-calling loop. (Mainstream agents rely
 * on model self-termination + context budget; this is the equivalent backstop.)
 */
const MAX_TOOL_ROUNDS = 50

/** Shape of the `done` event data emitted by AgentLoop (extends the raw provider payload). */
export interface LoopDoneEvent extends DoneEventData {
  turnId: string
  round: number
  callId: string
  appendedMessages: Message[] // messages appended to context since the previous llm_call
  contextMsgCount: number // context length at request time (post-trim)
  startedAt: number
  durationMs: number
}

/** Prompts the user for an approval decision on a tool call that needs one. */
export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<{ decision: ApprovalDecision; source: ApprovalSource }>
}

/**
 * Safety configuration injected by the chat store. If omitted, every tool call
 * runs automatically with no approval (legacy behaviour, e.g. tests).
 */
export interface AgentSafety {
  ctx: ClassifyContext // sandbox + workspace root + permission rules
  policy: ApprovalPolicy
  gate: ApprovalGate // drives the UI approval card
}

/**
 * Monitoring hooks injected by the chat store. BOTH are optional and default to
 * no-ops, so tests and any other AgentLoop consumer are unaffected. When wired
 * (by chat-store → getMonitorBus), they let the runtime monitor observe:
 *   - onRequestReady: the exact view + compaction decisions about to be sent
 *     (one call per LLM round). This is the "主动暴露的语义方法" hook — it
 *     fires right after the bounded view is built, before provider.chat().
 *   - onLifecycle: turn lifecycle markers (started / aborted / finished). The
 *     'aborted' marker prevents the monitor panel from showing a "request sent
 *     but never completed" hanging turn when the user stops mid-stream.
 * See docs/2026-06-15-desktop-agent-运行态监控面板设计.md §② 采集点.
 */
export interface AgentLoopHooks {
  onRequestReady?: (snapshot: RequestSnapshot) => void
  onLifecycle?: (stage: TurnLifecycleStage, ctx: { round: number; callId: string; reason?: string }) => void
}

export class AgentLoop {
  private context: ContextManager
  private provider: LLMProvider

  constructor(
    llmConfig: LLMConfig,
    private toolExecutor: ToolExecutor,
    private agentConfig: AgentConfig,
    existingMessages?: Message[],
    private safety?: AgentSafety,
    private signal?: AbortSignal,
    contextStrategy?: ContextStrategy,
    /** Optional monitoring hooks. Default no-op → tests/other consumers unaffected. */
    private hooks: AgentLoopHooks = {},
    /** Model config id for snapshot attribution. Passed through to the snapshot. */
    private modelConfigId: string = '',
    /** P1 harness rollout: when provided, tools registered here run through the
     *  harness instead of the legacy executor. Authorization still flows through
     *  authorize()/classify/decide — this only swaps execution. */
    private toolRegistry?: ToolRegistry
  ) {
    // ContextManager is the truth source; the strategy produces the bounded
    // view sent to the LLM. If none is supplied (e.g. tests), use a default.
    this.context = new ContextManager(
      contextStrategy ?? new DefaultContextStrategy({ contextWindow: DEFAULT_CONTEXT_WINDOW })
    )
    this.provider = new LLMProvider(llmConfig)

    // Load existing conversation history
    if (existingMessages) {
      for (const msg of existingMessages) {
        this.context.add(msg)
      }
    }
  }

  async *run(userMessage: string, turnId: string): AsyncGenerator<StreamEvent> {
    // Incremental buffer: every message added to context since the previous llm_call.
    // Handed off (and cleared) on each done event so each llm_call records only its delta.
    const appendedSinceLastCall: Message[] = []

    // Add system prompt only if not already present in history
    if (
      !this.context.getMessages().some((m) => m.role === 'system') &&
      this.agentConfig.systemPrompt
    ) {
      const systemMsg: Message = {
        id: crypto.randomUUID(),
        role: 'system',
        content: this.agentConfig.systemPrompt,
        timestamp: Date.now()
      }
      this.context.add(systemMsg)
      appendedSinceLastCall.push(systemMsg)
    }

    // Add user message (history from store already has old messages, this is the new one)
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userMessage,
      timestamp: Date.now()
    }
    this.context.add(userMsg)
    appendedSinceLastCall.push(userMsg)

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Round-scoped call id, generated up front so the monitor snapshot, the
      // `done` event, and any aborted marker all share one stable identifier.
      const callId = crypto.randomUUID()

      // A user "stop" between rounds ends the turn gracefully (no error shown).
      if (this.signal?.aborted) {
        // Emit an aborted marker so the monitor panel doesn't show a "request
        // sent but never completed" hanging turn when the user stops before a
        // round even fires. (Hook is a no-op when not wired.)
        this.emitLifecycle('aborted', { round, callId, reason: '用户停止' })
        return
      }

      // Between-round compaction hook. P2 (Codex-style handoff summary) plugs in
      // here via the strategy's maybeCompact; it is a no-op by default, so this
      // only acts once a compaction strategy is supplied. Applied before building
      // the request so the next round sees the compacted context.
      // Strategy contract: maybeCompact MUST protect the latest assistant +
      // tool-results block (don't summarise results the model hasn't consumed).
      try {
        const compacted = await this.context.maybeCompact()
        if (compacted) this.context.replaceMessages(compacted)
      } catch (e) {
        // maybeCompact() can await (P2 LLM handoff summary) and thus throw
        // (network/timeout/abort). Don't let it escape the generator and leave a
        // turn with no terminal signal. Abort → end gracefully; any other
        // failure → fall back to the un-compacted context and continue.
        if (this.signal?.aborted) {
          this.emitLifecycle('aborted', { round, callId, reason: '用户停止' })
          return
        }
        console.error('[loop] maybeCompact failed; continuing with un-compacted context', e)
      }

      // Second abort check AFTER the async compaction: maybeCompact() can await
      // (P2 LLM handoff summary), and the user may have stopped during that
      // window. Without this we'd build a request, fire the monitor snapshot,
      // and start a provider fetch only to abort immediately — leaving a phantom
      // "request prepared then aborted" row on the monitor panel.
      if (this.signal?.aborted) {
        this.emitLifecycle('aborted', { round, callId, reason: '用户停止' })
        return
      }

      const startedAt = Date.now()
      // Build the bounded request view ONCE — produceRequest yields the internal
      // view, the compaction decisions, the self-healed wire-format messages,
      // and the view metrics in a single pass (no double toView). The monitor
      // hook consumes the same bundle so it can't drift from what's sent.
      const request = this.context.produceRequest()
      const requestMessages = request.openaiMessages
      const contextMsgCount = requestMessages.length

      // Monitoring hook: hand the monitor the EXACT view + compaction decisions
      // about to be sent. This is the "主动暴露的语义方法" collection point — it
      // fires once per round, right after the view is built and before the
      // provider call. The hook is a no-op by default (tests/other consumers),
      // and emitRequestReady swallows any error so monitoring can never corrupt
      // the agent loop.
      this.emitRequestReady(turnId, round, callId, startedAt, request)

      try {
        const stream = this.provider.chat(requestMessages, ALL_TOOLS, this.signal)

        for await (const event of stream) {
          if (event.type === 'text_delta' || event.type === 'reasoning_delta') {
            yield event // passthrough to UI
          } else if (event.type === 'tool_call_end') {
            // Surface to UI as an active tool call (keeps existing UI behaviour)
            yield { type: 'tool_call_start', data: event.data }
          } else if (event.type === 'done') {
            const d = event.data as DoneEventData

            const assistantMsg: Message = {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: d.textContent,
              toolCalls: d.toolCalls.length > 0 ? d.toolCalls : undefined,
              timestamp: Date.now()
            }
            this.context.add(assistantMsg)
            appendedSinceLastCall.push(assistantMsg)

            const appended = appendedSinceLastCall.splice(0, appendedSinceLastCall.length)
            const durationMs = Date.now() - startedAt

            yield {
              type: 'done',
              data: {
                ...d,
                turnId,
                round,
                callId,
                appendedMessages: appended,
                contextMsgCount,
                startedAt,
                durationMs
              } as LoopDoneEvent
            }

            // No tool calls → this turn is finished
            if (d.finishReason !== 'tool_calls' || d.toolCalls.length === 0) {
              return
            }

            // Execute tools, append results to context (so the next round sees them).
            // INVARIANT: every tool call below receives exactly one matching tool
            // result — even if authorize()/execute() throws. Letting a throw
            // escape here would leave the assistant(tool_calls) message (added on
            // the `done` event above) with no following tool message, corrupting
            // history and causing API 400 "insufficient tool messages following
            // tool_calls message" on every subsequent turn.
            for (const tc of d.toolCalls) {
              const toolStartedAt = Date.now()
              let parsedArgs: Record<string, unknown>
              try {
                parsedArgs = JSON.parse(tc.arguments)
              } catch {
                parsedArgs = {}
              }

              // Resolve a relative write_file path against the turn cwd BEFORE
              // classification/execution, so the workspace-boundary check and the
              // executor see the same absolute path. Without this, "foo.txt" would
              // be compared against an absolute project root and wrongly flagged
              // as outside the workspace.
              const cwd = this.safety?.ctx.cwd
              // Home-dir / env-var prefixes (~/foo, $HOME/foo, %USERPROFILE%/foo)
              // are neither workspace-relative nor a form we expand. Detecting
              // them here (rather than prepending cwd) prevents a silent garbage
              // path like "/workspace/~/foo": the path flows through unchanged,
              // classify() then flags it outside the workspace → dangerous → the
              // user is asked instead of getting a wrong silent write.
              const hasEnvPrefix =
                (tc.name === 'read_file' || tc.name === 'write_file') &&
                typeof parsedArgs.path === 'string' &&
                /^[~$%]/.test(parsedArgs.path)
              if (
                // Resolve relative paths for ALL file tools (read + write) against
                // the turn cwd BEFORE classify. The classifier compares the path
                // string against the absolute workspaceRoot; a relative path like
                // `docs/x.md` would never startsWith an absolute root and get
                // misclassified as "outside workspace" → dangerous → ask. Prepending
                // cwd makes the comparison correct for files actually inside the
                // working area (the common case).
                (tc.name === 'read_file' || tc.name === 'write_file') &&
                cwd &&
                typeof parsedArgs.path === 'string' &&
                !/^[A-Za-z]:[\\/]/.test(parsedArgs.path) && // Windows drive-absolute
                !/^[\\/]/.test(parsedArgs.path) && // leading slash/backslash
                !parsedArgs.path.startsWith('\\\\') && // UNC
                !hasEnvPrefix // ~/$/% : don't prepend cwd (see note above)
              ) {
                parsedArgs = { ...parsedArgs, path: cwd.replace(/\/+$/, '') + '/' + parsedArgs.path }
              }

              let result: ToolResult
              let resultTruncated = false
              let riskLevel: RiskLevel | undefined
              let approvedBy: ApprovalSource | undefined

              try {
                // --- Authorization (safety gate) ---
                const auth = await this.authorize(turnId, tc.id, tc.name, parsedArgs)
                riskLevel = auth.riskLevel
                approvedBy = auth.approvedBy

                if (auth.action === 'deny') {
                  // Denied (by policy sandbox or by the user): surface as an error
                  // tool result so the model can adapt; the turn continues.
                  result = {
                    toolCallId: tc.id,
                    name: tc.name,
                    content: auth.deniedMessage ?? '被安全策略拒绝',
                    isError: true
                  }
                } else {
                  // Approved (auto / allowlist / user). A single tool failing should
                  // not abort the whole turn — surface the error as the tool result.
                  const harnessTool = this.toolRegistry?.get(tc.name)
                  if (harnessTool) {
                    // Harness path (P1): runTool owns validate → checkPermissions →
                    // call → shape. Authorization already happened in authorize().
                    try {
                      const raw = await runTool(harnessTool, parsedArgs, {
                        cwd: this.safety?.ctx.cwd,
                        signal: this.signal
                      })
                      result = {
                        toolCallId: tc.id,
                        name: tc.name,
                        content: raw.content,
                        isError: raw.isError
                      }
                      resultTruncated = raw.truncated ?? false
                    } catch (err: any) {
                      result = {
                        toolCallId: tc.id,
                        name: tc.name,
                        content: `Tool execution failed: ${err?.message ?? String(err)}`,
                        isError: true
                      }
                    }
                  } else {
                    // Legacy executor (all tools when the flag is off; write_file
                    // and run_shell always, until migrated in later phases).
                    try {
                      result = await this.toolExecutor.execute(tc.name, parsedArgs, this.signal)
                    } catch (err: any) {
                      result = {
                        toolCallId: tc.id,
                        name: tc.name,
                        content: `Tool execution failed: ${err?.message ?? String(err)}`,
                        isError: true
                      }
                    }
                  }
                }
              } catch (err: any) {
                // authorize() (or anything else in this block) threw unexpectedly.
                // Synthesize an error result so this tool_call is never left
                // without a matching tool message; the turn continues so the model
                // can react to the failure.
                result = {
                  toolCallId: tc.id,
                  name: tc.name,
                  content: `Tool call aborted: ${err?.message ?? String(err)}`,
                  isError: true
                }
              }

              const toolMsg: Message = {
                id: crypto.randomUUID(),
                role: 'tool',
                content: result.content,
                toolCallId: tc.id,
                isError: result.isError,
                // Rich-rendering metadata
                toolName: tc.name,
                toolArgs: parsedArgs,
                durationMs: Date.now() - toolStartedAt,
                riskLevel,
                timestamp: Date.now()
              }
              this.context.add(toolMsg)
              appendedSinceLastCall.push(toolMsg)

              yield {
                type: 'tool_executed',
                data: {
                  toolCallId: tc.id,
                  name: tc.name,
                  arguments: parsedArgs,
                  result: result.content,
                  resultTruncated: resultTruncated,
                  isError: result.isError,
                  startedAt: toolStartedAt,
                  durationMs: Date.now() - toolStartedAt,
                  riskLevel,
                  approvedBy
                } as ToolExecutedEventData
              }
              // Keep the existing UI tool-result rendering path working
              yield { type: 'tool_result', data: { name: tc.name, result } }
            }
            // provider stream has ended after `done`; the for-loop continues to next round
          }
        }
      } catch (err: any) {
        // An abort (user stop) mid-stream ends the turn silently.
        if (this.signal?.aborted) {
          // Emit an aborted marker so the monitor panel can close out this round
          // instead of showing it as a request that never completed.
          this.emitLifecycle('aborted', { round, callId, reason: '用户停止' })
          return
        }
        yield { type: 'error', data: err.message }
        return
      }
    }

    yield {
      type: 'error',
      data: `Reached maximum tool rounds (${MAX_TOOL_ROUNDS})`
    }
  }

  /**
   * Fire the onRequestReady monitor hook with the request bundle just produced.
   * Fully guarded — a missing hook, a throwing hook, or a throwing payload
   * builder can NEVER propagate into the agent loop. The config block mirrors
   * the model metadata relevant for replay (window + sampling); richer fields
   * can be added later without changing the snapshot envelope.
   */
  private emitRequestReady(
    turnId: string,
    round: number,
    callId: string,
    startedAt: number,
    request: { view: Message[]; decisions: RequestSnapshot['decisions']; openaiMessages: unknown[]; metrics: RequestSnapshot['metrics']; selfHeal: RequestSnapshot['selfHeal'] }
  ): void {
    const hook = this.hooks?.onRequestReady
    if (!hook) return
    try {
      hook({
        callId,
        turnId,
        round,
        sessionId: '',
        ts: startedAt,
        modelConfigId: this.modelConfigId,
        view: request.view,
        openaiMessages: request.openaiMessages,
        metrics: request.metrics,
        decisions: request.decisions,
        selfHeal: request.selfHeal,
        config: {
          // contextWindow is part of metrics.window; reuse it rather than
          // threading a separate value through.
          contextWindow: request.metrics.window
        }
      })
    } catch (err) {
      console.warn('[agent-loop] onRequestReady hook threw — ignored', err)
    }
  }

  /**
   * Fire the onLifecycle monitor hook (started / aborted / finished). Same
   * guard discipline as emitRequestReady — monitoring must never break the loop.
   */
  private emitLifecycle(
    stage: TurnLifecycleStage,
    ctx: { round: number; callId: string; reason?: string }
  ): void {
    const hook = this.hooks?.onLifecycle
    if (!hook) return
    try {
      hook(stage, ctx)
    } catch (err) {
      console.warn('[agent-loop] onLifecycle hook threw — ignored', err)
    }
  }

  /**
   * Classify a tool call and decide whether it runs automatically, must ask, or
   * is denied. Emits approval_request/approval_resolved events when it asks.
   */
  private async authorize(
    turnId: string,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<{
    action: 'auto' | 'deny'
    riskLevel?: RiskLevel
    approvedBy?: ApprovalSource
    deniedMessage?: string
  }> {
    // No safety config → legacy auto-run-everything behaviour.
    if (!this.safety) return { action: 'auto' }

    // If the user stopped the run, deny without prompting so the loop exits fast.
    if (this.signal?.aborted) return { action: 'deny', deniedMessage: '用户已停止' }

    const assessment = classify(name, args, this.safety.ctx)
    // Subject for permission-rule matching: the shell command, or the (already
    // resolved-to-absolute) write_file path. read_file has no rule subject.
    const subject =
      name === 'run_shell'
        ? String(args.command ?? '')
        : name === 'write_file'
          ? String(args.path ?? '')
          : undefined
    const decision = decide(assessment, name, this.safety.ctx, this.safety.policy, subject)

    if (decision.action === 'deny') {
      return { action: 'deny', riskLevel: assessment.level, deniedMessage: decision.reason }
    }
    if (decision.action === 'auto') {
      return {
        action: 'auto',
        riskLevel: assessment.level,
        // 'rule' when an allow rule drove the auto-run (reason mentions 规则), else 'auto'.
        approvedBy: decision.reason.includes('规则') ? 'allowlist' : 'auto'
      }
    }

    // action === 'ask': prompt the user via the gate.
    const req: ApprovalRequest = {
      reqId: crypto.randomUUID(),
      turnId,
      toolCallId,
      name,
      args,
      level: assessment.level,
      reason: decision.reason,
      patterns: assessment.patterns
    }
    const { decision: userDecision, source } = await this.safety.gate.request(req)
    if (!userDecision.approved) {
      const why = userDecision.reason ? `：${userDecision.reason}` : ''
      return { action: 'deny', riskLevel: assessment.level, approvedBy: 'denied', deniedMessage: `用户拒绝${why}` }
    }
    return { action: 'auto', riskLevel: assessment.level, approvedBy: source }
  }
}
