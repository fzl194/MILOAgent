# desktop-agent 上下文组织管理演进

> 2026-06-15。基于 Claude Code v2.1.88 真实源码(`claude-code-main/`)+ 知识库 `part08-context-management` / `part09-memory-system` 校准,非仅文档。
> 工作边界:**只讲「上下文怎么组织/装配」这一条轴**——系统提示分层、记忆/环境注入、缓存友好前缀。**不含裁剪/压缩**(那是另一篇《2026-06-13-上下文管理调研与选型》的轴,负责历史视图的折叠与兜底),也**不含运行态监控**(《2026-06-15-运行态监控面板设计》)。三条轴正交、互不踩。

> **演进 vs 现状核对(2026-06-16 更新):P0 接缝落地 / P1 已落地(身份默认开 + 记忆/日期注入)/ P2·P3 部分。**
> - **P0(接缝完成、已激活)**:默认 agent 身份基提示(角色/工具规范/安全口径)+「前缀(prefix)+ 后缀(suffix)」两段式装配抽象已落地;身份开关经 P1 翻为默认开。
> - **P1(已落地)**:身份开关**默认翻开**(P0 遗留盘经 `configVersion` 迁移一次性翻 true,版本盘尊重显式值);`currentDate` 总开注入 suffix;项目根 CLAUDE.md / AGENTS.md / .claude/CLAUDE.md **自动发现**(纯异步读取器,吞所有异常、>2MB 给提示、不改 store 每轮读)作「项目记忆」块注入 suffix。suffix 内顺序:记忆 → 日期 → base → project → cwd;identity 仍是唯一静态 prefix。**git 状态仍未注入**(属每轮变动,留 P2 挂 user 消息尾部)。
> - **P2(部分)**:静态/动态分段与「身份段字节稳定」的设计意图已落进代码;但 cached_tokens 虽已采集却未做命中率前后对比,ModelConfig 也**尚未加** supportsPromptCache 缝,git 状态尾部注入待做。
> - **P3(部分)**:工具结果折叠已有「已折叠」占位告知;完整 FRC 截断告知段、cache-aware 裁剪**均未实现**(仅留策略接缝)。
> - **一句话**:组织层已立「分层装配 + 默认身份 + 记忆/日期注入」;剩余主线是缓存命中率优化(P2:supportsPromptCache 缝、cached_tokens 前后对比、git 状态尾部注入)与截断告知(P3)。

---

## ① 功能要点

把上下文从「**单条扁平 system 字符串 + 原始历史**」演进为「**结构化分层装配**」:

- **拆出稳定前缀(静态段)与易变后缀(动态段),中间用边界隔开。** 静态段承载 agent 身份与工具使用规范(今天它是**空的**——这是组织层最大的洞);动态段承载项目记忆、工作目录、日期、git 状态。
- **记忆从项目根自动发现加载**,不再靠用户手填进配置字符串;同时补上**当前日期**(模型本不知道"今天")与可选的**工作区状态**。
- **给模型一个稳定、可缓存、有身份的前缀。** 收益有二:① 行为上,模型知道自己是谁、该怎么用工具、什么该先问;② 成本上,稳定前缀命中 OpenAI 兼容后端的自动前缀缓存(GLM/DeepSeek 已在 `usage` 里回传 `cached_tokens`,本项目**已在采集但没为之优化**)。
- **把「组织」与「裁剪」明确分成两条演进轴。** 裁剪管历史视图(已落地 Tier1 + token 预算),组织管前缀装配(本文)。两者在代码里各自有接缝,演进互不阻塞。

一句话:**今天我们的"上下文管理"只有"砍历史",没有"装前缀";这篇补上"装前缀"这条轴。**

---

## ② 实现逻辑

### 现状(desktop-agent)

- 上下文 = **一条 system 消息 + tools(API 独立字段)+ 历史**。system 消息由全局基提示(默认**空串**)← 项目级 prompt ← 工作目录提示,纯字符串拼接而成(装配发生在 effective-config 的构建函数里)。
- **无 agent 身份基提示**:配置里 `systemPrompt` 默认空,loop 只在基提示非空时才插 system 消息——也就是说默认情况下,**模型拿不到任何"你是谁、怎么用工具"的约束**。
- **无日期、无 git 状态、无文件级记忆自动加载**:项目指令只能手填进项目配置;CLAUDE.md / AGENTS.md 这类仓库内指令文件不会被自动读进上下文。
- **裁剪轴已就绪**(本文不重复):工具结果折叠(填充率 > 0.5 才动,保护短会话缓存)+ token 预算兜底 + 配对自愈,视图与全量真相源分离。
- **已采集 `cached_tokens`**(provider 解析 usage 时留存);**标题生成子请求已做过一次前缀缓存对齐**(把 system + 全量工具对齐主轮前缀以命中),但主对话路径仍未系统化地"为缓存而装配前缀"。

### 权威机制(Claude Code v2.1.88 源码核实)

- **系统提示是「字符串数组」而非单串,且按静态/动态分段。** `getSystemPrompt` 依次拼接:静态段(自我介绍 / 系统规范 / 做事方式 / 动作 / 工具使用 / 语气 / 输出效率)→ **边界标记** `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` → 动态段(会话引导 / 记忆 / 环境信息 / 语言 / MCP 说明 / 函数结果清理 FRC …)。源码注释明说:**"边界标记之后是用户/会话特定内容,不应缓存。"**
- **缓存分块由边界驱动。** `splitSysPromptPrefix` 找到边界标记,把静态段标为可缓存(global scope)、动态段标为不缓存;另有专门的缓存断点检测模块,盯住系统提示 / 工具 / 模型 / 模式等十多类变化,前缀一旦被打断就告警。这套是 Anthropic 原生 `cache_control` 语义。
- **记忆 / 日期作为「用户上下文块」注入,而非塞进 system 字符串。** `getUserContext`(会话级 memoize)返回一个上下文字典:**恒在的 `currentDate`**(`Today's date is …`)+ **可缺省的 `claudeMd`**。CLAUDE.md 走**四层优先级**(托管 → 用户全局 → 项目根 / 目录级 → 本地),自动发现加载。整块在会话内缓存、拼到对话历史之前。
- **微压缩有两条路径**:时间触发(清旧工具结果、保最近 N、占位符替换)与 cached 路径(**不改动消息本体**,改走 `cache_edits` 块——"手术刀式"局部编辑,只为保住前缀字节稳定)。
- **九节摘要**(完全压缩时):Primary Request / Key Concepts / Files / Errors / Problem Solving / All user messages / Pending Tasks / Current Work / Optional Next Step——固定结构。(属裁剪轴 P3,本文不展开。)

### 机制对照(组织轴)

| 维度 | desktop-agent 现状 | Claude Code 权威 | 差距性质 |
|---|---|---|---|
| 系统提示结构 | 单条扁平字符串,默认空 | 静态段 + 边界 + 动态段 | **无身份基提示、无分层** |
| 记忆注入 | 仅手填项目 prompt | CLAUDE.md 四层自动加载 + 独立块 | **无自动记忆、无日期** |
| 缓存感知 | 折叠推迟到阈值;采了 cached_tokens 却没优化 | 静态前缀标可缓存、手术刀式保前缀、断点检测 | **未识别/未保稳定前缀** |
| 截断告知 | 静默占位 | FRC 段告知模型旧结果已折叠 | 无(留缝) |

---

## ③ 当前弊端

1. **没有 agent 身份基提示(默认空串)——组织层最基础的洞。** 模型不知道自己是谁、工具该怎么用、危险操作该先问。这比"会不会爆 token"更靠前:一个没有身份的 agent,裁剪做得再好也是在"管理一段无人导航的历史"。
2. **system 是单条扁平字符串,无静态/动态之分。** 每次会话只要项目记忆或工作目录变,整段 system 就抖动;OpenAI 兼容后端靠自动前缀缓存,前缀不稳就命不中——而本项目已经能读到 `cached_tokens`,却没有任何动作去把命中率提上去(采了数据、没用数据)。
3. **无文件级记忆自动加载。** 仓库里的 CLAUDE.md / AGENTS.md 类指令只能靠用户手抄进项目配置,既容易漏,也无法按目录分层;模型还不知道"今天几号"(无 currentDate),对时间敏感的任务会出错。
4. **"组织"与"裁剪"耦合在同一层、无统一装配抽象。** 历史视图归 ContextManager/Strategy,system 装配散在 effective-config,两者各管一摊;未来想加"压缩后重读文件""前缀锚点"时会互相踩,缺乏一个"上下文整体怎么拼"的单一真相。

---

## ④ 改进方向

分阶段、行为保持迁移(每阶段 typecheck + 单测全绿,走 CLAUDE.md §4 pipeline:实现 → 测试 → ecc 审查 → codex 独立审查 → 迭代):

- **P0 · 身份基提示 + 装配接缝**:引入一份默认 agent 身份基提示(角色 / 工具使用规范 / 安全口径),`systemPrompt` 不再默认空;把 system 装配从"返回单串"演进为"返回前缀 + 后缀两段"(先逻辑分,边界标记留缝但不强依赖缓存语义)。**行为保持**:不启用基提示时等价于今天。
- **P1 · 记忆 / 上下文注入层**:从项目根自动发现 CLAUDE.md / AGENTS.md(四层简化为:全局 / 项目根 / 目录级可选),作为**独立块**注入(对齐 Claude Code——而非塞回 systemPrompt 字符串);补 `currentDate`。**注入位置按"变动频率"决定(见 P2 布局规则)**:`CLAUDE.md` / `currentDate` 属低频变动(编辑或跨天才变),可进前缀的动态段;**`git status` 属每轮变动,绝不能进前缀**——放进去会每轮改坏前缀字节、令整段缓存失效、模型每轮重算,只能挂在最新一轮的尾部。读文件走既有 IPC,主进程兜底已就位。
- **P2 · 缓存友好前缀**:核心规则——**按"变动频率"从低到高排布,绝不把每轮变动的内容写进前缀**。OpenAI 兼容后端(GLM/DeepSeek)的前缀缓存是从首 token 起逐字节比对,**前缀任一字节变动,从该处起整段作废、模型须重算**。因此布局应是:【最稳】身份基提示 + 工具定义 + 全局记忆 → 【低频变】项目记忆 + 当前日期 → 【每轮追加、仍缓存友好】对话历史(append-only,只在尾部增长,旧前缀原样保留)→ 【每轮变动】git 状态等挂最新轮尾部。**静态身份段必须字节稳定**(不掺时间戳 / 会话 id)。这一条也是 P1 git 状态只能放尾部的依据。在此布局上用已采集的 `cached_tokens` 做前后对比,验证命中率提升。**无需显式 `cache_control`**(那是 Anthropic 原生语义),靠自动前缀缓存,原理相通;为按模型区分缓存语义,可在 `ModelConfig` 增 `supportsPromptCache` 缝(2026-06-13 选型文档已提议、**尚未落地**),不写死。
- **P3 · 接缝(按需)**:FRC 式"截断告知"段(告诉模型旧工具结果已被折叠、可重读);真正的 cache-aware compaction(手术刀式局部编辑、保前缀)——与裁剪轴 P2/P3 衔接,不在本篇展开。

**硬门**:现有 context / context-strategy 单测全绿;装配重构行为保持(不启用基提示时与今天逐字节等价);`cached_tokens` 采集链路不回归。

**明确暂不引入**(留演进缝,不写死):显式 `cache_control` 锚点(Anthropic 原生,GLM/DeepSeek 不适用,靠 `supportsPromptCache` 缝);十多类缓存断点检测(过度工程,单机桌面无必要);托管级 `/etc` 记忆(单机场景无);九节摘要本体(属裁剪轴 P3);MCP / 多输出风格段(暂无 MCP,留动态段缝)。

---

## ⑤ 参考

**Claude Code v2.1.88 源码(`claude-code-main/`,仓库同级目录):**
- 系统提示分段与边界:`src/constants/prompts.ts`(`getSystemPrompt` / `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`)
- 记忆 + 日期注入:`src/context.ts`(`getUserContext`)、`src/utils/claudemd.ts`(CLAUDE.md 四层发现)
- 缓存分块:`src/utils/api.ts`(`splitSysPromptPrefix`)、`src/services/api/promptCacheBreakDetection.ts`
- 微压缩双路径:`src/services/compact/microCompact.ts`;九节摘要:`src/services/compact/prompt.ts`

**知识库(本机 `KnowledgeBase/`,`开发工具/Claude-Code/`):**
- `part08-context-management`(三层压缩 / 缓存感知 / 成本 / 最佳实践)、`part09-memory-system`(CLAUDE.md 四层 / 记忆注入 ≤5 条)、`part05-prompt-engineering/02-static-constitution`(静态宪法 vs 动态政策)

**本项目相关文档:**
- `docs/2026-06-13-desktop-agent-上下文管理调研与选型.md`(裁剪/压缩轴,P0/P1 已落地、P2/P3 接缝)
- `docs/2026-06-15-工具层harness演进与安全.md`(工具层契约对齐)
- `docs/2026-06-15-desktop-agent-运行态监控面板设计.md`(采集点含上下文视图与压缩决策)
