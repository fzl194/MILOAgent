# Agent 项目指南 · CLAUDE.md

> 本文件是 Claude 在本仓库工作的**默认指令**,每次会话自动加载。先读它,再动手。

---

## 1. 项目定位

`D:\study\Agent` 是一个 **git 仓库**,包含:

- **`desktop-agent/`** —— 一个**本地优先**的桌面 AI Agent(Electron 桌面应用)。代码主体。
- **`docs/`** —— 项目文档(演进记录、调研选型、盘点),见 §7。
- **`.claude/`** —— Claude Code 配置(settings / 权限 / hooks)。

这是一个**正在迭代的个人项目**,同时参考 Claude Code / Codex 的机制来构建自己的 agent 内核。

---

## 2. 仓库布局

```
Agent/
├── desktop-agent/              # Electron 应用(代码主体)
│   ├── src/
│   │   ├── main/index.ts       # 主进程:IPC、文件系统、Shell 执行、数据持久化
│   │   ├── preload/index.ts    # 上下文桥(electronAPI)
│   │   └── renderer/src/
│   │       ├── agent-core/     # agent 内核(loop / 上下文 / LLM / 工具 / 安全)
│   │       ├── stores/         # Zustand 状态(config / model / session / chat / allowlist / project / stats)
│   │       ├── components/     # UI(chat / sidebar / admin)
│   │       └── App.tsx
│   └── package.json
├── docs/                       # 项目文档(见 §7)
└── .claude/                    # Claude Code 配置
```

运行时数据落在 `~/.desktop-agent/`(`config.json` / `models.json` / `projects.json` / `allowlist.json` / `sessions/` / `traces/` / `stats/`)。

---

## 3. 技术栈 & 常用命令

Electron 35 + React 18 + Zustand 5 + TypeScript 5.7 + vitest 4 + Tailwind 4 + electron-vite 3。

```bash
cd desktop-agent
npm run dev          # 启动开发(electron-vite dev)
npm run build        # 构建
npm run typecheck    # 类型检查(node + web 两份 tsconfig)— 改动后必跑
npm run test         # vitest run(单测)
npm run test:watch   # 监听模式
```

平台为 **Windows + bash**:用 Unix 语法(`/dev/null`、正斜杠路径),不要用 Windows cmd 写法。

---

## 4. ⚠️ 工作流:固定 Pipeline(强制)

**任何非平凡改动都必须走这条流水线,不要跳步:**

```
规划 → 修改 → 测试 → 审查(ecc) → codex 独立审查 → 据反馈迭代 → 再验证
```

| 阶段 | 做什么 | 工具/Skill |
|---|---|---|
| **规划** | 先给结构化方案,获批再动手 | `ecc:plan` / `EnterPlanMode` |
| **修改** | 按方案实现 | 直接编辑;小步聚焦 |
| **测试** | 类型检查 + 单测必须全绿 | `npm run typecheck && npm run test` |
| **审查** | 第一路:正确性/边界/回归 | `ecc:code-review`(ecc code-reviewer agent) |
| **codex 审查** | 第二路:独立第二意见 | `codex:codex-rescue` agent |
| **迭代** | 汇总两路发现,修改后**重新验证**,循环到干净 | 同上 |

**规则:**
- **多用 Skill**(ecc 系列、codex),这是默认工作方式。
- **🚫 禁止调用 `deep-research` skill。** 需要"调研/查资料"时,改用 `D:\study\KnowledgeBase`(知识库)+ `WebSearch`/网页抓取,自己整合。
- 改动跨多个文件时,用 `TaskCreate` 跟踪进度。
- 类型检查或测试不绿,不得宣告"完成";如实报告失败。

---

## 5. Git 机制

仓库已 `git init`。遵循:

- **只在用户明确要求时** `commit` / `push`,不要擅自提交。
- **不直接提交到默认分支**(main/master);先开分支:`feat/<scope>`、`fix/<scope>`、`docs/<topic>`、`refactor/<scope>`。
- **提交粒度**:一个逻辑变更一个提交;docs/ 文档变更与对应代码变更可合并或独立,保持原子。
- **提交信息**(Conventional Commits):
  ```
  <类型>: <简述>

  <可选详细说明>

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
  类型:`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf` / `build`。
- **禁止**:`git reset --hard`、`git push --force`(除非用户明确要求);交互式 rebase 不可用。
- 用 `gh` CLI 处理 GitHub PR/issue。
- 回退优先 `git revert <hash>`(保留历史),不用 hard reset。

---

## 6. Claude Code 式机制(本项目遵循)

机制设计的**权威参考**在知识库:`D:\study\KnowledgeBase\开发工具\Claude-Code\`(`part07-permissions` 权限、`part08-context-management` 上下文、`part09-memory-system` 记忆)。本项目的 agent 内核已按这些理念落地,改动时**保持一致、不要写死、预留演进接缝**。

### 6.1 上下文管理(已在 desktop-agent 落地 v2)
- **持久层 = 全量真相源**;发给模型的只是一份「视图」。裁剪只改视图,不破坏全量历史。
- **token 预算是主边界**(按模型 `contextWindow`),不再用「消息条数」硬限制。
- **工具结果折叠**(Claude Tier1):旧工具结果→占位,保留 tool_call 痕迹。
- **预留 compaction 接缝**(`ContextStrategy` / `Compactor` / `maybeCompact`):未来 P2(handoff 摘要)、P3(九节摘要/cache-aware)只加策略、不重写。**改动时不要把接口写死。**

### 6.2 权限 / 审批(allowlist)
- **deny > ask > allow,首次匹配**;**危险操作一律问**,且 allowlist 对危险无效。
- allowlist 是**前缀匹配**(Claude Code `Bash(cmd:*)` / `Write(dir/**)` 式):write_file 按目录记、run_shell 按基础命令记。
- 永久决策 → `~/.desktop-agent/allowlist.json`(global,重启保留);本次会话 → 内存(session,重启清空)。
- 沙箱模式 + 审批策略 + 工作区根 共同决定是否自动放行。

### 6.3 记忆
- 持久记忆在 `~/.claude/projects/.../memory/`(每条一个事实 + frontmatter,`MEMORY.md` 为索引)。
- **项目级长期约束**写进 `docs/` 或本 CLAUDE.md;不要把代码结构/历史修复等可从代码推导的东西存进记忆。

---

## 7. 文档规范(docs/)

用户对项目文档的**硬性要求**(详见记忆 `doc-writing-style`):

1. **统一放 `D:\study\Agent\docs\`**,不散落到子项目。命名 **`YYYY-MM-DD-<主题>.md`**(按时间排序、可迭代)。
2. **四段式**:① 功能要点 ② 实现逻辑 ③ 当前弊端 ④ 改进方向。
3. **不堆代码级细节**:不要 `file:line`、函数签名、IPC 通道名。读完应知道「是什么 / 怎么做的 / 有啥问题 / 怎么改」。
4. 调研/选型类文档**带参考链接**。
5. 新增/改文档后,按 §5 提交(`docs:` 类型)。

现有 docs:`功能盘点`、`前端演进意见`、`上下文管理调研与选型`、`项目级设计`(均 2026-06-13)。

---

## 8. 知识库联动

`D:\study\KnowledgeBase` 是**机制参考源**(不是本仓库的一部分):

- 遇到「Claude Code / Codex / agent 机制怎么做」的问题,**先查知识库**(根 `_index.md` → 分类 → 文件)。
- 知识库有**新鲜度模型**(`tier:fast-moving|evolving|stable` + `next-review`),引用时注意时效;过时则提示并用 WebSearch 核实。
- **禁止 deep-research**(§4);用知识库 + WebSearch 代替。

---

## 9. 环境与陷阱

- **多 OpenAI 兼容后端**(GLM、DeepSeek……):不同模型上下文窗口/缓存语义不同;token 仅粗估,勿当精确值。
- **运行时数据**在 `~/.desktop-agent/`(见 §2);改数据文件前先确认 app 未占用,避免被覆盖。
- **共享文件**(`types.ts`、`main/index.ts` 等)可能有**协作者并行改动**(如「项目」特性);编辑前先读最新状态,Edit 失败就重读重试。
- Electron dev 模式改了主进程/内核代码要**重启 dev server**才生效;renderer 改动走 HMR。
- 排查 agent 行为:看 `~/.desktop-agent/traces/<sid>.jsonl`(每轮请求/工具的原子记录)。

---

## 10. agent 能力速览(功能层)

- **工具**:`read_file` / `write_file` / `run_shell`(经安全分类 + 审批)。
- **多模型**:每个模型可独立配置 `apiKey/baseUrl/model/contextWindow`,在 `models.json`。
- **项目级(Project)**:按工作目录隔离;会话归属项目。
- **安全**:沙箱模式(只读/工作区可写/完全访问)+ 审批策略(自动/需要时问/全部确认)+ allowlist。
- **会话/统计/trace**:全量持久化,可清空(危险区)。

---

*本文件随项目演进迭代;有新的稳定约定就更新它(走 §5 git 流程)。*
