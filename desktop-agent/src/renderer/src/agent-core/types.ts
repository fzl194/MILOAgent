// ===== LLM Configuration =====
export interface LLMConfig {
  apiKey: string
  baseUrl: string
  model: string
  temperature?: number
  maxTokens?: number
  /** Wire protocol — reserved seam for the Anthropic provider (openai today).
   *  See docs/2026-06-14-desktop-agent-Anthropic格式兼容调研.md. */
  protocol?: 'openai' | 'anthropic'
}

// ===== Message Types =====
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCallItem {
  id: string
  name: string
  arguments: string
}

export interface Message {
  id: string
  role: MessageRole
  content: string
  toolCalls?: ToolCallItem[]
  toolCallId?: string
  isError?: boolean
  modelConfigId?: string // which model produced an assistant message
  // Tool-message rendering metadata (role: 'tool' only). Back-compat: older
  // tool messages lack these and render as plain text.
  toolName?: string
  toolArgs?: Record<string, unknown>
  durationMs?: number
  riskLevel?: RiskLevel
  // Tool-call lifecycle, surfaced in the UI: 'running' while the call is
  // executing (or waiting on approval), 'success'/'failed' once it resolves.
  // Older persisted tool messages have no status → treated as terminal.
  status?: 'running' | 'success' | 'failed'
  // Reasoning model's thinking process (delta.reasoning_content). Captured during
  // streaming, saved on the assistant message so it survives after the turn ends.
  reasoning?: string
  timestamp: number
}

// ===== Tool System =====
export interface ToolParameterSchema {
  type: 'object'
  properties: Record<string, {
    type: string
    description?: string
    enum?: string[]
  }>
  required?: string[]
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: ToolParameterSchema
}

export interface ToolResult {
  toolCallId: string
  name: string
  content: string
  isError: boolean
}

// ===== Tool Executor (platform abstraction) =====
export interface ToolExecutor {
  execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>
}

// ===== Safety / Approval =====
// A single tool call is classified into one risk level before execution. The
// level — together with the active sandbox + approval policy — decides whether
// the call runs automatically or must prompt the user for approval.
export type RiskLevel = 'safe' | 'write' | 'network' | 'dangerous'

// What the agent is technically allowed to touch. `workspace-write` is the
// personal-default: file writes are confined to the workspace root; shell is
// approval-gated (no kernel sandbox on personal builds — see classifier notes).
export type SandboxMode = 'read-only' | 'workspace-write' | 'full-access'

// When the agent must stop and ask before acting.
//   auto       — safe + in-workspace writes run automatically; dangerous still asks
//   on-request — writes and dangerous both ask (personal default)
//   untrusted  — everything except known-safe reads asks
export type ApprovalPolicy = 'auto' | 'on-request' | 'untrusted'

export interface RiskAssessment {
  level: RiskLevel
  reason: string
  // Regex source patterns describing this call; added to the allowlist when the
  // user approves with "remember", so future matching calls auto-run.
  patterns: string[]
}

export interface ApprovalRequest {
  reqId: string
  turnId: string
  toolCallId: string
  name: string
  args: Record<string, unknown>
  level: RiskLevel
  reason: string
  patterns: string[]
}

export interface ApprovalDecision {
  approved: boolean
  remember?: boolean // add an allow rule (session or project scope)
  scope?: 'session' | 'project' // where to persist a remembered approval
  reason?: string // free text when denied
}

export type ApprovalSource = 'user' | 'auto' | 'allowlist' | 'denied'

/** Legacy allowlist entry — kept as a test utility for the remember-pattern
 *  (directory/command prefix) tests. Production permission matching uses
 *  PermissionRule via decide(); this shape is not persisted anymore. */
export interface AllowlistEntry {
  pattern: string
  name: string
  scope: 'global' | 'session'
  createdAt: number
}

// ===== Streaming Events =====
export type StreamEventType =
  | 'text_delta'
  | 'reasoning_delta'
  | 'tool_call_start'
  | 'tool_call_delta'
  | 'tool_call_end'
  | 'tool_result'
  | 'tool_executed'
  | 'approval_request'
  | 'approval_resolved'
  | 'done'
  | 'error'

export interface StreamEvent {
  type: StreamEventType
  data: unknown
}

// Shape of the `approval_request` stream event data
export interface ApprovalRequestEventData extends ApprovalRequest {}

// Shape of the `approval_resolved` stream event data
export interface ApprovalResolvedEventData {
  reqId: string
  decision: ApprovalDecision
  source: ApprovalSource
}

// ===== Usage stats (real tokens, source-tagged) =====
export interface UsageStats {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  /** Prefix-cache hit tokens (OpenAI: prompt_tokens_details.cached_tokens). */
  cachedTokens?: number
}

// Shape of the `done` stream event data emitted by LLMProvider / AgentLoop
export interface DoneEventData {
  textContent: string
  toolCalls: ToolCallItem[]
  finishReason: string
  usage: UsageStats | null
}

// Shape of the `tool_executed` stream event data emitted by AgentLoop
export interface ToolExecutedEventData {
  toolCallId: string
  name: string
  arguments: Record<string, unknown>
  result: string
  resultTruncated: boolean
  isError: boolean
  startedAt: number
  durationMs: number
  riskLevel?: RiskLevel
  approvedBy?: ApprovalSource
}

// ===== Agent Config =====
// P1 rollout flag for the tool harness. Default off; when on, read_file runs
// through the new harness (tools/harness/), everything else stays on the
// legacy executor. See docs/2026-06-15-工具层harness演进与安全.md.
export interface ToolHarnessConfig {
  enabled: boolean
}

// P0 context-org: a default agent identity (role / tool norms / safety) prepended
// to the system prompt when enabled. Default OFF → the system prompt stays
// byte-identical to legacy until toggled; P1 will flip the default. See
// docs/2026-06-15-desktop-agent-上下文组织管理演进.md.
export interface IdentityConfig {
  enabled: boolean
}

export interface AgentConfig {
  systemPrompt: string
  sandbox: SandboxMode
  approvalPolicy: ApprovalPolicy
  toolHarness?: ToolHarnessConfig
  identity?: IdentityConfig
  /** P1: persisted schema version for one-time migrations (e.g. flipping the
   *  identity default). Absent on pre-P1 disks → treated as legacy. */
  configVersion?: number
}

// ===== OpenAI API Types =====
export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

// ===== Model Configuration (user can define multiple) =====
export interface ModelConfig {
  id: string
  name: string
  apiKey: string
  baseUrl: string
  model: string
  isDefault?: boolean
  /** The model's context window in tokens, for context-budget enforcement.
   *  Optional: when absent, a conservative default is used. Editing models.json
   *  lets users set this per model (e.g. GLM-5.1 vs DeepSeek differ). */
  contextWindow?: number
  /** Wire protocol. 'openai' = OpenAI-compatible (/chat/completions, /models).
   *  'anthropic' is reserved (Messages API). Defaults to 'openai'. */
  protocol?: 'openai' | 'anthropic'
  /** Models available under this provider. Absent/empty → falls back to `model`. */
  models?: ProviderModel[]
  /** The provider's default model id (used when a session picks the provider
   *  without choosing a specific model). Defaults to `model` when absent. */
  defaultModel?: string
}

/** A model entry within a provider's list. */
export interface ProviderModel {
  id: string
  contextWindow?: number
}

/** A ModelConfig IS a provider (additive evolution; the rename to `Provider` is
 *  deferred to avoid churn in the session/chat layer while it's being refactored
 *  concurrently). This alias lets new code speak "provider". */
export type Provider = ModelConfig

/** Effective connection + chosen model, resolved from a provider (+ optional
 *  model id). This is what the LLM send path consumes. */
export interface ResolvedModel {
  apiKey: string
  baseUrl: string
  model: string
  protocol: 'openai' | 'anthropic'
  contextWindow?: number
}

// ===== Session =====
export interface Session {
  id: string
  title: string
  modelConfigId: string
  projectId: string // which Project this session belongs to
  createdAt: number
  updatedAt: number
  messageCount: number
  workspaceRoot?: string // session-level override of the global workspace root
}

// ===== Project =====
// A Project is an explicit, named record that points at a working directory
// (dirPath). The directory path (realpath) is the project's logical identity
// (mirroring Codex/Claude "project = cwd"). The Default Project has dirPath =
// null — users can chat without creating a project.
/** One unified permission rule. Replaces the old split (allowlist +
 *  commandRules). `pattern` is a regex source matched against the call's subject
 *  (shell command, or resolved file path). Scopes (session > project) are
 *  merged and evaluated deny > ask > allow, first match wins. */
export interface PermissionRule {
  pattern: string
  action: 'allow' | 'deny'
  tool?: string // 'run_shell' | 'write_file' | '*' (omitted = any tool)
}

export interface ProjectConfig {
  systemPrompt?: string // project-level system prompt (stacked atop global) — = project memory
  sandbox?: SandboxMode
  approvalPolicy?: ApprovalPolicy
  defaultModelId?: string
  /** Project-scope permission rules (session rules are evaluated first). */
  rules?: PermissionRule[]
}

export interface Project {
  id: string
  name: string
  dirPath: string | null // normalized realpath; null for the default project
  isDefault: boolean // exactly one project has this true
  config?: ProjectConfig // project-level overrides (effective = global ← project)
  createdAt: number
  updatedAt: number
}

// ===== Usage Statistics =====
export interface UsageEvent {
  id: string
  sessionId: string
  modelConfigId: string
  timestamp: number
  inputTokens?: number
  outputTokens?: number
  toolCalls: number
  durationMs: number
  usageSource?: 'api' | 'partial' | 'estimated'
  turnId?: string
  round?: number
}

export interface StatsSummary {
  totalMessages: number
  totalInputTokens: number
  totalOutputTokens: number
  totalToolCalls: number
  avgDurationMs: number
  modelUsage: Record<string, number>
  toolUsage: Record<string, number>
  dailyCounts: Record<string, number>
}

// ===== Trace Events (atomic units, persisted to traces/<sid>.jsonl) =====
// `AgentConfig` (above) is the single source of truth for agent / global
// settings. The previous duplicate `GlobalConfig` interface was removed to
// avoid the two drifting apart.

export interface TraceMessage {
  msgId: string
  role: MessageRole
  content: string
  toolCalls?: ToolCallItem[]
  toolCallId?: string
  isError?: boolean
}

// (A) Written once when a session first sends a message — session-level constants snapshot
export interface SessionMetaTrace {
  type: 'session_meta'
  sessionId: string
  modelConfigId: string
  model: string
  systemPrompt: string
  temperature?: number
  maxTokens?: number
  tools: string[]
  startedAt: number
}

// (B) One LLM request = one line (incremental storage)
export interface LlmCallTrace {
  type: 'llm_call'
  callId: string
  sessionId: string
  turnId: string
  round: number
  modelConfigId: string
  model: string
  temperature?: number
  maxTokens?: number
  tools: string[]
  appendedMessages: TraceMessage[] // messages appended to context since the previous llm_call
  contextMsgCount: number // context length at request time (post-trim) — verifies reconstruction
  usage: UsageStats
  usageSource: 'api' | 'partial' | 'estimated'
  finishReason: string
  startedAt: number
  durationMs: number
}

// (C) One tool execution = one line
export interface ToolCallTrace {
  type: 'tool_call'
  toolCallId: string
  callId: string // links back to the llm_call that triggered it
  sessionId: string
  name: string
  arguments: Record<string, unknown> // parsed object, not raw string
  result: string
  resultTruncated?: boolean
  isError: boolean
  riskLevel?: RiskLevel // how risky the call was classified
  approvedBy?: ApprovalSource // how it was authorized (user / auto / allowlist / denied)
  startedAt: number
  durationMs: number
}

export type TraceEvent = SessionMetaTrace | LlmCallTrace | ToolCallTrace
