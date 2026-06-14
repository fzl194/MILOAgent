# desktop-agent 上下文管理:机制调研与选型

> 日期:2026-06-13
> 目的:调研 Codex / Claude Code / OpenCode / Amp 的上下文管理机制,为 desktop-agent 选定一个**务实、不过度设计、且预留向 Claude Code 完整机制演进**的方案。
> 主源:本地知识库 `开发工具/Claude-Code/part08-context-management`(权威教学+逆向);Codex/OpenCode 来自开源源码与工程对比文章。

---

## 0. 背景:我们现在的上下文管理(现状与问题)

> ⚠️ **2026-06-15 复核**：本节描述的是 **2026-06-13 的旧现状**（按消息条数裁剪、Gap C 配对 bug、无 token 感知）。**此后已全部升级**为 token 化 + 可插拔 Compactor 流水线：`maxContextMessages` 与 `splice(1,1)` 已从代码中移除；三接口已落地（见 §3、§4 实现状态，及《功能盘点 2026-06-14》§3.2）。本节保留为历史诊断。

| 维度 | 现状 | 问题 |
|---|---|---|
| 裁剪依据 | **固定消息条数** `maxContextMessages=20`(`config-store.ts`,传入 `ContextManager`) | 不看 token:一条 23KB 的 read_file 结果算 1 条,20 条可能远超模型窗口 → `context length exceeded` |
| 裁剪动作 | 从头部 `shift`,system 在前时 `splice(1,1)`(`context.ts:14-28`) | **bug(Gap C)**:`splice(1,1)` 不连带删 tool 结果,产生开头孤儿 tool → GLM `1214 messages 参数非法` |
| token 感知 | **无**(`estimateTokens` 仅用于 stats 兜底,不参与裁剪) | 既拦不住爆 token,又误删配对 |
| 模型感知 | **无**(GLM/DeepSeek 窗口不同,却用统一 20 条) | 切模型不调整(对应《功能盘点》「不感知模型能力差异」) |
| 工具结果 | 原文常驻,无截断/摘要 | 读几个大文件就把上下文塞满 |
| 持久化 vs 运行时 | session 文件存全量;`ContextManager` 每 turn 新建、按条数裁 | 运行时裁剪**会破坏配对**;且裁掉的就丢了(不可逆) |

核心结论:**现在的「上下文管理」只是「按条数砍头」,既不防溢出、又伤配对、还不感知模型。** 需要从机制层面重新设计。

---

## 1. 业界机制梳理

### 1.1 Claude Code —— 三层「精准遗忘」(本地 KB part08)

一条**梯度逃生通道**:先扫地,再收纳,最后搬家式打包。能用规则就不用模型,尽可能保前缀缓存。

| 层 | 名称 | 触发 | 是否调模型 | 动作 |
|---|---|---|---|---|
| **Tier1** | 微压缩 / 工具结果修剪 | 每轮请求前例行 | **否** | 把**旧工具结果**替换为占位符 `[Old tool result content cleared]`,**保留最近 N 个**(教学值 5)。**只 elide 结果,保留 tool_call** → 模型仍知道「我读过这个文件」,需要时可重读。叫「选择性失忆」 |
| **Tier2** | 缓存感知压缩 | 接近阈值 | 否(规则) | **从尾部修剪**,保持**前缀字节稳定** → 命中 Prompt Cache(`cache_edits` 手术刀式局部编辑,而非整段重写) |
| **Tier3** | 完全压缩(九节摘要) | 最后手段 | 是(LLM) | 先试 **Session Memory Compact**(用已有结构化记忆替代,免 LLM 调用);不够再 LLM 生成**九节结构化摘要**(意图/概念/文件/错误/逻辑链/用户原话/TODO/当前工作/下一步)。后处理:注入「续自上次对话」前导、**重读最近编辑的文件**、重声明工具、`CLAUDE.md` 常驻 |

**阈值(两套口径,均记录):**
- 教学口诀(KB):**60%** 主动介入 / **87%** 触发自动压缩 / **连续 3 次失败熔断**。
- 逆向实测(社区):自动压缩阈值 ≈ `有效上下文窗口 − 13,000 token`(有效窗口 = 模型窗口 − min(最大输出, 20k));另有 ~95% 容量触发一说;`prompt_too_long` 错误时**被动压缩并重试**。

**精髓**:大多数时候只跑 Tier1 规则(零 LLM 成本);Tier2 的「保前缀」是它独有优势(长任务省大钱);Tier3 是兜底。

### 1.2 OpenAI Codex CLI —— 单层「交接备忘录」(`codex-rs/core/src/compact.rs`)

一句话:**把整段对话交给 LLM 写一份「交接摘要」,然后替换掉历史**。

- **触发**:token 超过 `model_auto_compact_token_limit`(按模型,如 180k / 244k),约 `effective_context_window_percent = 95%`。**自动触发,无需手动 `/compact`**。
- **双路径**:`compact.rs`(本地调 LLM,任意模型可用)/ `compact_remote.rs`(调 OpenAI 内部 `responses/compact`,仅 OpenAI 模型)。**两者都要 LLM 参与**,区别只在「生成摘要这一步跑在哪」。
- **保留什么**:**保留最近的 user 消息原文**(硬上限 ~20k token),**物理删除所有 assistant + tool 消息**,插入**一条合成的 assistant 消息** = 交接摘要。
- **交接 prompt**:进度与关键决策 / 约束与偏好 / 剩余 TODO / 续作所需关键数据。
- **鲁棒**:失败用指数退避重试;压缩后警告「多次压缩会降低准确度」。
- **弊端**:**全有或全无** —— 摘要漏掉的细节就永久没了。空间换不回 tool 原文。

### 1.3 OpenCode(sst/opencode)—— 两步「阶梯治理」(`session/compaction.ts`)

**先标记、再摘要**,且**非破坏性**。

- **Step1 修剪(Prune)**:**不物理删除**,给旧消息打 `compacted = Date.now()` 时间戳 → 后续请求中「不可见」,但**数据仍在库**。规则:仅当可释放 >20k token 才动;保护最近 40k token;`skill` 型工具输出永不修剪;保护最近 2 轮 user 全文。
- **Step2 LLM 五段摘要**:用一个**隐藏专用 agent**(不打扰当前交互)调 LLM 出摘要。摘要后**自动重放最后一条 user 消息**(保证记忆点停在用户最新指令);**跟随用户语言**(中文会话出中文摘要)。
- **亮点**:非破坏性为未来的「历史回溯/审计/回滚」留门;TypeScript 实现,最易定制。

### 1.4 Amp(Sourcegraph)—— 纯手动

无自动压缩。提供 Handoff(指定下一目标,抽相关信息进新线程)/ Fork(在某点复制上下文)/ Edit/Restore / Thread References。哲学:**保持对话短而聚焦**,一切靠人。

### 1.5 横向对比

| 维度 | Codex | Claude Code | OpenCode | Amp |
|---|---|---|---|---|
| 层级数 | 1(摘要) | 3(修剪/缓存/摘要) | 2(隐藏/摘要) | 0(手动) |
| LLM 调用 | 必需 | 仅 Tier3 | 仅 Step2 | Handoff 时 |
| user 消息 | **原文保留** | 摘要(Tier3) | 摘要 + 重放末条 | 手动抽取 |
| 工具结果 | **物理删除** | **占位替换**(保 tool_call) | **时间戳隐藏**(可恢复) | 不自动处理 |
| 缓存优化 | 无 | **深度集成 Prompt Cache** | 减少冗余读 | — |
| 压缩后行为 | 被动等待 | **主动重读相关文件** | **自动重放最后指令** | — |
| 可逆性 | 否 | 否 | **是(隐藏非删除)** | Fork 可回退 |
| 实现复杂度 | 低 | 高 | 中 | — |

---

## 2. 选型分析(针对本项目)

**约束**:小型 Electron + React + Zustand;多 OpenAI 兼容后端(GLM / DeepSeek);无 prompt-cache 的 `cache_control` 强依赖(非 Anthropic 原生);单人/小团队,需控制复杂度。

| 方案 | 适配度 | 理由 |
|---|---|---|
| 直接上 Claude Code 三层 | ❌ 过度 | 需 token 精确计数、Prompt Cache 深度集成、Session Memory、九节 LLM 管线;GLM/DeepSeek 的缓存语义不同,收益打折 |
| Codex 单层 handoff | ✅ 可作近中期 | 实现最简(一次 LLM 调用 + 替换);但「全有或全无」,丢 tool 原文 |
| OpenCode 两步非破坏 | ✅ 极契合 | 非破坏性 + 阶梯,正好解决我们「裁剪不可逆、伤配对」的痛点;TS 易实现 |
| Amp 纯手动 | ❌ 不够 | 单人桌面 Agent 仍需自动兜底 |

**推荐:走「阶梯式 + 非破坏」的混合路线,而非照搬单一产品。** 取各家之长:
- **Claude Code Tier1** 的「工具结果占位替换,保 tool_call」—— 零成本减大头(我们 9f284bed 的 23KB 文件就是这种膨胀)。
- **OpenCode** 的「**压缩是视图、不是破坏**」—— 永不在持久层删数据。
- **Codex** 的「阈值触发、一次 LLM 交接摘要」—— 作为自动兜底,实现轻。
- **预留 Claude Code Tier2/Tier3** 的口子 —— 接口先行,未来按需点亮。

---

## 3. 可演进接口设计(关键:不写死)

> ✅ **2026-06-15 复核**：下列三个接口（`TokenEstimator` / `Compactor` / `ContextStrategy`）**已全部落地**于 `context-strategy.ts`（各阶段实现状态见 §4）。

> 核心原则:**持久层(session 文件)是全量真相源;「发送给 API 的上下文」只是它的一份视图。** 所有裁剪/压缩只改视图,永不破坏全量。这样今天能简单实现,明天能升级到 Claude Code 完整机制而无需重写。

### 3.1 抽象三个可插拔接口

```ts
// (a) token 估算 —— 今天用粗估,未来换 tiktoken / 按模型
interface TokenEstimator {
  estimate(msgs: Message[]): number
  windowOf(modelId: string): number            // 该模型上下文窗口(token)
}
// 今天:复用现有 estimateTokens 粗估 + 在 ModelConfig 加 contextWindow 字段
// 未来:接 gpt-tokenizer / 模型精确计数

// (b) 压缩器 —— 每个 tier 一个实现,可叠加
interface Compactor {
  readonly tier: 'trim' | 'summarize'
  shouldRun(m: ContextMetrics): boolean         // 是否该我出手
  run(msgs: Message[], m: ContextMetrics): Promise<CompactionResult>
}
interface ContextMetrics {
  tokenEstimate: number
  window: number
  fillRatio: number                              // = tokenEstimate / window
  messageCount: number
  modelId: string
}
// 今天:TrimCompactor(工具结果占位 + 条数兜底)
// 近期:HandoffCompactor(Codex 式一次 LLM 摘要)
// 未来:ClaudeTier2Compactor(cache-aware) / NineSectionCompactor / SessionMemoryCompactor

// (c) 上下文策略 —— 编排:决定本轮发什么、要不要触发压缩
interface ContextStrategy {
  toRequestMessages(full: Message[], m: ContextMetrics): Message[]   // 视图(只读全量)
  maybeCompact(full: Message[], m: ContextMetrics): Promise<CompactionResult | null>
}
```

### 3.2 数据模型的小改动(预留,不锁死)

- `ModelConfig` 增加 `contextWindow?: number` 与 `supportsPromptCache?: boolean` —— 选型第 2 条「感知模型能力」直接落地,`TokenEstimator.windowOf()` 读它。
- session 文件**保持全量**;新增可选的 **compaction 事件记录**(摘要文本 + 被压缩范围 + 时间戳),未来可做 OpenCode 式「隐藏/回溯」与审计。

### 3.3 阈值策略(沿用业界经验)

- **软预警 ~60%**:UI 提示「建议整理 / 拆任务」。
- **工具结果修剪**:持续/轻量(无 LLM),保护最近 N 条 tool 结果。
- **自动摘要 ~80–85%**(不照搬 95%,社区反馈 95% 太晚):触发 Handoff 摘要。
- **熔断**:连续 3 次摘要失败 → 暂停自动、提示用户。

### 3.4 为什么这样不写死

- `ContextStrategy` + `Compactor` 是**策略模式**:今天的实现 = `MessageCountTrimStrategy`(修好 Gap C)+ `ToolResultTrimCompactor`;明天加 `HandoffCompactor` 只需新增一个类,编排顺序不变。
- 「视图 vs 真相源」让任何压缩都**可逆、可审计**,未来加 Claude Code 的「压缩后重读文件」「九节摘要」都不会动到持久层。
- `TokenEstimator` 与 `ModelConfig.contextWindow` 把「token 感知」「模型感知」两个缺口一次性预留好。

---

## 4. 分阶段落地建议

> **2026-06-15 复核·实现状态**：**P0、P1 均已落地**——修 Gap C 改为整块删除（不产生孤儿 tool）、`RoughTokenEstimator` + 模型 `contextWindow` + token 预算兜底、`ToolResultTrimCompactor`（填充率 >0.5 折叠旧工具结果、保最近 10 条）、三接口 + `DefaultContextStrategy`/`CountTrimCompactor`。**P2 `HandoffCompactor`（LLM 交接摘要）未实现**（`maybeCompact` 仅留接缝、返回 null）；**P3 全部未实现**。下表保留为原始计划。

| 阶段 | 内容 | 解决 |
|---|---|---|
| **P0(立即)** | 修 Gap C 裁剪 bug(整块删,不产生孤儿) | 1214 + 丢配对 |
| **P0(立即)** | 引入 `TokenEstimator`(粗估)+ `ModelConfig.contextWindow`;`toOpenAIMessages` 发送前用 token 预算兜底 | 爆 token / 不感知模型 |
| **P1(近期)** | `ToolResultTrimCompactor`(Claude Tier1):旧 tool 结果占位,保 tool_call;保护最近 N | 工具结果膨胀(最大体积源) |
| **P1(近期)** | `ContextStrategy`/`Compactor` 接口落地,把现有条数裁剪重构为其中一个 Compactor | 架构口子 |
| **P2(中期)** | `HandoffCompactor`(Codex 式):阈值触发,一次 LLM 交接摘要,视图替换 | 长对话自动续命 |
| **P3(远期,按需)** | cache-aware 修剪(Tier2,若接 Anthropic 原生)/ 九节摘要(Tier3)/ 压缩后重读文件 / 非破坏隐藏+回溯 | 向 Claude Code 完整机制演进 |

---

## 5. 结论

- **机制选型**:不走单一产品路线,取**「阶梯式 + 非破坏」混合** —— Tier1 工具结果占位(零成本)+ Codex 式 handoff 摘要(自动兜底),持久层全量不变。
- **不写死的关键**:三个可插拔接口(`TokenEstimator` / `Compactor` / `ContextStrategy`)+ 「视图 vs 真相源」原则 + `ModelConfig.contextWindow`。今天落地简单版,明天按 P2/P3 点亮 Claude Code 完整机制无需重写。

---

## 6. 参考

**本地知识库(主源,Claude Code 权威教学+机制):**
- `开发工具/Claude-Code/part08-context-management/`(02 三层 / 03 微压缩 / 04 自动压缩 / 05 完全压缩 / 06 缓存感知 / 09 成本 / 10 最佳实践)
- `开发工具/Claude-Code/part05-prompt-engineering/05-token-economics.md`(缓存经济学)

**Codex / OpenCode(开源源码 + 工程对比):**
- [Shedding Heavy Memories: Context Compaction in Codex, Claude Code, and OpenCode — Justin3go](https://justin3go.com/en/posts/2026/04/09-context-compaction-in-codex-claude-code-and-opencode)
- [Context Compaction Research (Claude Code / Codex / OpenCode / Amp) — badlogic gist](https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f)
- [openai/codex · codex-rs/core/src/compact.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs)
- [sst/opencode · session/compaction.ts](https://github.com/sst/opencode/blob/main/packages/opencode/src/session/compaction.ts)
