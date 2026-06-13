# Desktop Agent 前端演进意见（对照 Codex 桌面版）· 剩余路线图

> **本文已裁剪**：原 Phase 1（安全审批层 + 工具富渲染 + 全局停止）**已全部落地**，相关条目删除。本文只保留**尚未实现**的演进方向。实现细节见同目录《功能盘点》。
> **日期**：2026-06-13（更新）
> **前提**：个人开发。Codex 中企业版 / 云端专属能力，本文照常纳入并给出「个人本地版如何近似」。

---

## 0. 当前进度与剩余结论

**已完成（不再列）**：安全审批层（沙箱×审批策略×风险分级×allowlist）、工具富渲染（按类型分流 + 默认收起 + 多工具合并）、全局停止（AbortSignal + spawn kill）。

**剩余要补的两件大事**：**① 规划与审查**（从黑盒执行到 diff 可审）+ **② 项目化上下文**（让 Agent 知道在哪、改什么）。再加输入区增强、消息操作、扩展生态。这些是 Codex 桌面版区别于「聊天框」的核心。

---

## 1. 调研基线：Codex 桌面版做对了什么（仍待借鉴的部分）

> Codex 桌面版也是 Electron 应用，技术栈同源，交互范式可直接借鉴。

| 能力类 | Codex 做法 | 个人版如何近似 |
|---|---|---|
| **规划与审查** | **Plan 模式**（Shift+Tab，先出计划再执行，计划可下载）；**代码审查面板**（Cmd+Opt+B，行级 diff、选择性暂存、一键回退、点行评论让 Agent 迭代） | Plan 模式 + Diff 审查面板可直接复刻（纯前端 + 少量协议） |
| **项目化** | **项目 → 线程**两级；线程持久化；**工作树（worktree）**并行不冲突；可见每个线程是本地/云端/工作树 | 引入「项目 = 工作目录」；线程持久化已有基础；并行用 worktree 或多窗口 |
| **富交互** | 内建终端、图片预览、行内 diff、**斜杠命令**（/plan /compact /fork /models /permissions /status）、**@文件引用**、**推理等级**、**/fast** | 斜杠命令、@引用、diff 渲染、终端块可复刻 |
| **扩展生态** | **Skills**、**MCP**、**Hooks**、**Sub-agent**、**Automations**、内建 Git | 逐项作为远期目标；Sub-agent / Hooks 性价比尤其高 |

**Codex 两个底层哲学**：① 可控自治（受限内自动跑、越界才问）；② 上下文是核心资产（持久会话、/compact、/fork、Sub-agent 隔离）。

---

## 2. 剩余前端缺口（对照 Codex）

- **工作流模式**：纯执行循环，看不到计划，改文件无 diff 可审。缺口：无 Plan、无 Diff 审查、无「先看后做」。
- **输入区**：纯 textarea。缺口：无 @引用、无斜杠命令、无附件、无推理等级切换。
- **会话与项目**：扁平会话按日期分组，无工作目录概念。缺口：无项目层、无 cwd、无搜索、无 /fork /compact。
- **消息与列表体验**：缺口：消息不可编辑/重生成/分支；长列表无虚拟化（会卡）。
- **全局体验**：缺口：无快捷键体系、无命令面板（Cmd+K）、无无障碍。（主题已支持。）

---

## 3. 演进意见（按优先级，仅含未实现项）

> 每条：**是什么 / 为什么 / 落地形态 / Codex 参照**。

### 🟠 Phase 1 — 从「聊天框」升级到「协作工作台」

**① Plan 模式 + Diff 审查面板**
- 是什么：**Plan 模式**让 Agent 先输出结构化步骤清单，确认后再执行（Shift+Tab 切换）；**审查面板**把文件改动渲染成行级 diff，可整体/逐块接受、点行评论让 Agent 迭代。
- 为什么：从「帮我跑命令」到「和我协作改代码」的分水岭，Codex 区别于聊天框的核心。
- 落地形态：模式切换器（Ask / Plan / Act）；抽屉式审查面板；diff 增删改着色 + 行内评论锚点。
- Codex 参照：Plan Mode + Code Review Panel（Cmd+Opt+B）。

**② @引用 + /斜杠命令 + 附件上传**
- 是什么：`@文件/目录`（带补全）投喂上下文；`/` 触发命令菜单（/plan /clear /compact /fork /models /permissions /status /ask）；文件/图片拖拽粘贴。
- 为什么：降低投喂上下文成本；斜杠命令是 Codex/Claude Code 事实标准。
- Codex 参照：@ file refs + slash commands + image previews。

**③ 推理等级 / /fast 模式**
- 是什么：模型可配推理强度（低/中/高），简单任务省、复杂任务强；紧急 /fast 加速。
- 为什么：成本与质量的杠杆。
- Codex 参照：reasoning levels + /fast。

**④ 消息操作 + 列表虚拟化**
- 是什么：每条消息支持 复制/编辑/重新生成/删除/分支（fork）；长会话虚拟滚动防卡。
- 为什么：消息不可编辑/重试、长会话卡顿——基础体验补全。
- Codex 参照：/fork 分支会话、虚拟列表。

### 🟡 Phase 2 — 让它「认识你的项目」

**⑤ 项目 > 线程结构 + 工作目录（cwd）**
- 是什么：「项目 = 工作目录 + 多线程」；Agent 在明确项目根下工作；侧栏从扁平会话升级为项目树。（注：会话级 workspaceRoot 字段已存在，缺 UI 入口。）
- 为什么：Agent 不知道在哪个目录、改谁的项目——「不能干真实活」的根因。
- Codex 参照：Project > Thread 持久化结构。

**⑥ 项目上下文文件（AGENTS.md 等价物）**
- 是什么：项目根放配置（构建命令、约定、PR 规范、忽略规则），Agent 自动读；配 `.gitignore` 感知与文件树侧栏。
- 为什么：把「反复告诉 AI 的规则」固化，省 token、稳行为。
- Codex 参照：AGENTS.md + version-control 检测后推荐模式。

**⑦ 并行 / 后台任务（worktree）**
- 是什么：git worktree 让多线程改同项目不同分支不冲突；任务挂后台（关窗口继续跑）。
- 为什么：Codex 云端「关笔记本回来继续」的个人版近似（本地守护进程 + worktree）。
- Codex 参照：worktree 并行 + cloud 异步任务。

**⑧ 内建 Git**
- 是什么：自动提交信息、stage、diff 查看、（可选）创建 PR，应用内完成。
- 为什么：减少终端/编辑器/浏览器间切换。
- Codex 参照：built-in Git first-class。

### 🟢 Phase 3 — 扩展生态（远期）

| 意见 | Codex 参照 | 个人版价值 |
|---|---|---|
| **Skills**（可复用工作流 + 本地市场） | Skills + marketplace | 常用多步操作封装成一键技能 |
| **MCP 接入**（外部工具/服务） | MCP（Figma/DB/Slack/Playwright） | 让 Agent 动浏览器、数据库等 |
| **Hooks**（生命周期钩子） | Hooks | 自动质量门禁（改完自动 lint/test） |
| **Sub-agent**（并行 + 上下文隔离） | Sub-agent 防「上下文腐烂」 | 主线程干净，子 agent 干脏活回报 |
| **Automations**（定时任务） | Automations（本地 cron） | 定期代码审查、依赖更新 |
| **多平台打包 + 无障碍** | 跨平台、可访问性 | 普适性（主题已支持） |

---

## 4. 优先级矩阵（仅未实现项）

| | 影响面 | 成本 | 建议 |
|---|---|---|---|
| Plan + Diff 审查 | 🔴 高（差异化） | 中-高 | **Phase 1 核心** |
| @引用 + 斜杠命令 | 🟠 高 | 中 | **Phase 1** |
| 消息操作 + 虚拟化 | 🟠 中 | 中 | **Phase 1** |
| 推理等级 / /fast | 🟡 中 | 低 | Phase 1 顺手 |
| 项目/线程 + 工作目录 | 🔴 高（解锁真实用途） | 中 | **Phase 2** |
| AGENTS.md + 文件树 | 🟠 中 | 低-中 | **Phase 2** |
| 并行/后台 + worktree | 🟡 中 | 高 | Phase 2 后段 |
| 内建 Git | 🟡 中 | 中 | Phase 2 |
| Skills/MCP/Hooks/Sub-agent | 🟡 扩展性 | 高 | Phase 3 |

---

## 5. 路线图

```
Phase 1  协作（差异化核心）
  Plan 模式 + Diff 审查 → @引用 + 斜杠命令 → 消息操作 + 虚拟化 → 推理等级
        ↓ 从聊天框变工作台
Phase 2  项目化
  项目>线程 + 工作目录 → AGENTS.md + 文件树 → 并行/后台 + Git
        ↓ 解锁真实项目用途
Phase 3  生态
  Skills → MCP → Hooks → Sub-agent → Automations
        ↓ 从工具变平台
```

---

## 6. 一页速记（TL;DR）

| 问题 | 答案 |
|---|---|
| **已完成** | 安全审批层 + 工具富渲染 + 全局停止（原 Phase 1） |
| **下一个差异化关键** | Plan 模式 + Diff 审查面板（Codex 同款核心） |
| **解锁真实用途** | 项目/工作目录 + AGENTS.md + 并行/后台 |
| **基础体验补全** | @引用 + 斜杠命令 + 消息操作 + 虚拟化 |
| **Codex 两个底层哲学** | ① 可控自治 ② 上下文是核心资产 |
| **个人版可拿来的「不开放功能」** | 云端异步→本地守护进程；并行→worktree |

---

## 7. 参考资料（Codex 实证来源）

- [Introducing the Codex app – OpenAI](https://openai.com/index/introducing-the-codex-app/)
- [Agent approvals & security – Codex / OpenAI Developers](https://developers.openai.com/codex/agent-approvals-security)
- [Codex IDE extension – OpenAI Developers](https://developers.openai.com/codex/ide)
- [Complete Beginner's Guide to OpenAI's Codex App – Push To Prod](https://getpushtoprod.substack.com/p/complete-beginners-guide-to-openais)
- [Codex App First Impressions 2026 – Verdent AI](https://www.verdent.ai/guides/codex-app-first-impressions-2026)
- [OpenAI Codex Review 2026 – zackproser](https://zackproser.com/blog/openai-codex-review-2026)

---
*文档结束。已删除原 Phase 1（审批/停止/富渲染，均已实现）。后续迭代沿用 `YYYY-MM-DD-<主题>.md`。*
