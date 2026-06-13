// ===== LLM Configuration =====
export interface LLMConfig {
  apiKey: string
  baseUrl: string
  model: string
  temperature?: number
  maxTokens?: number
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
  remember?: boolean // add `patterns` to the allowlist
  scope?: 'global' | 'session' // where to persist a remembered approval
  reason?: string // free text when denied
}

export type ApprovalSource = 'user' | 'auto' | 'allowlist' | 'denied'

// A remembered approval rule. `pattern` is a regex source; `name` is the tool
// it applies to ('*' = any). Session-scoped entries are cleared on restart.
export interface AllowlistEntry {
  pattern: string
  name: string
  scope: 'global' | 'session'
  createdAt: number
}

// ===== Streaming Events =====
export type StreamEventType =
  | 'text_delta'
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
export interface AgentConfig {
  maxToolRounds: number
  systemPrompt: string
  sandbox: SandboxMode
  approvalPolicy: ApprovalPolicy
  workspaceRoot?: string // global default workspace root
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
  temperature?: number
  maxTokens?: number
  isDefault?: boolean
  /** The model's context window in tokens, for context-budget enforcement.
   *  Optional: when absent, a conservative default is used. Editing models.json
   *  lets users set this per model (e.g. GLM-5.1 vs DeepSeek differ). */
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
export interface ProjectConfig {
  systemPrompt?: string // project-level system prompt (stacked atop global) — = project memory
  sandbox?: SandboxMode
  approvalPolicy?: ApprovalPolicy
  defaultModelId?: string
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
  maxToolRounds: number
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
