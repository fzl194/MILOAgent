# Agent 项目指南 · CLAUDE.md

> 本文件是 Claude 在本仓库工作的**默认指令**,每次会话自动加载。先读它,再动手。

---

## 1. 项目定位

仓库根是当前 **git 仓库根目录**(`.`),包含:

- **`desktop-agent/`** —— 一个**本地优先**的桌面 AI Agent(Electron 桌面应用)。代码主体。
- **`docs/`** —— 项目文档(演进记录、调研选型、盘点),见 §7。
- **`.claude/`** —— Claude Code 配置(settings / 权限 / hooks)。

这是一个**正在迭代的个人项目**,同时参考 Claude Code / Codex 的机制来构建自己的 agent 内核。

> 外部参考(Claude Code 源码解读知识库、Claude Code 源码本身)在仓库**同级别目录**下,具体目录名因机器而异,详见 §11。

---

## 2. 仓库布局

```
.
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
| **codex 审查** | 第二路:独立第二意见 | `codex-review`(codex 插件 review 斜杠命令;可能需先开 PR) |
| **迭代** | 汇总两路发现,修改后**重新验证**,循环到干净 | 同上 |

**规则:**
- **多用 Skill**(ecc 系列、codex),这是默认工作方式。
- **🚫 禁止调用 `deep-research` skill。** 需要"调研/查资料"时,改用同级别目录下的知识库(本机具体目录名按本地约定;§8)+ `WebSearch`/网页抓取,自己整合。
- 改动跨多个文件时,用 `TaskCreate` 跟踪进度。
- 类型检查或测试不绿,不得宣告"完成";如实报告失败。
- **codex 审查必须前台、显式等待**——不得后台派发后无人值守。`codex-review` 走 codex 运行时,同样的 wrapper 不轮询约束,后台派发会失去可见性(教训:曾用 `codex:codex-rescue` 后台跑,静默 48 分钟才察觉,期间无任何进度可查)。派发后用 `/codex:status` 主动监控进度;需取消用 `/codex:cancel`。**禁止**用子 agent 的「返回即视为完成」来隐藏进度,codex 任务必须同步等最终结论。

---

## 5. Git 机制

仓库已 `git init`。遵循:

- **只在用户明确要求时** `commit` / `push`,不要擅自提交。
- **默认直接在 `main` 上提交,不要随便开分支**;仅当用户明确要求、或确有并行/隔离需要时才开分支(`feat/<scope>`、`fix/<scope>`、`docs/<topic>`、`refactor/<scope>`)。
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

机制设计的**权威参考**在知识库:同级别目录下的 Claude Code 源码解读(基于 v2.1.88;`part06-tool-system` 工具系统/治理流水线、`part07-permissions` 权限、`part08-context-management` 上下文、`part09-memory-system` 记忆)。具体目录名因机器而异,见 §8。本项目的 agent 内核已按这些理念落地,改动时**保持一致、不要写死、预留演进接缝**。

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

### 6.4 工具层 harness(本项目遵循,2026-06-15 起;详见 docs/2026-06-15-工具层harness演进与安全.md)
- 工具走固定生命周期(校验→归一化→授权→执行→整形,可观测贯穿),共用 harness 拥有;每工具只声明定制(inputSchema/checkPermissions/call/maxResultSizeChars + isReadOnly/isConcurrencySafe 元数据),关注点 co-locate 到该工具模块。契约对齐 Claude Code 源码 `src/Tool.ts`(同级别目录 `claude-code-main/`),提示词描述与参数约束与之保持一致。
- **安全双层(本项目特有,因无内核沙箱,不可让步)**:① renderer 审批闸门(classify→decide,deny>ask>allow 首次匹配,危险一律问、永不自动/记忆;**解释器内联代码(`-e`/`-c`)、shell 元字符链、高危 base 命令一律强制问,永不自动/记忆**)——直面 prompt injection 的主防线;② **主进程 defense-in-depth 兜底(逐工具落地,非一刀切)**——`read_file` 的 IPC handler **已就位**(设备文件拒绝含 `\\.\`/`\\?\`/CONIN$、canonicalize 解符号链接、大小上限,即使 renderer 被绕过也不越界);**`write_file` / `run_shell` 的主进程兜底列为 P2 待办**,当前仅依赖 renderer 闸门。改安全层时以 renderer 闸门为主防线、主进程兜底按工具逐步补。
- 改工具时:安全以本双层为准,**不照搬** Claude Code 的 bypass/无条件 allow;暂不引入 tree-sitter AST、hook 系统、并行调度(留缝,不写死)。

---

## 7. 文档规范(docs/)

用户对项目文档的**硬性要求**(详见记忆 `doc-writing-style`):

1. **统一放 `docs/`**(仓库根下的 `docs/`),不散落到子项目。命名 **`YYYY-MM-DD-<主题>.md`**(按时间排序、可迭代)。
2. **四段式**:① 功能要点 ② 实现逻辑 ③ 当前弊端 ④ 改进方向。
3. **不堆代码级细节**:不要 `file:line`、函数签名、IPC 通道名。读完应知道「是什么 / 怎么做的 / 有啥问题 / 怎么改」。
4. 调研/选型类文档**带参考链接**。
5. 新增/改文档后,按 §5 提交(`docs:` 类型)。

现有 docs:`功能盘点`、`前端演进意见`、`上下文管理调研与选型`、`项目级设计`(均 2026-06-13)。

---

## 8. 知识库联动

同级别目录下的**机制参考源**(Claude Code v2.1.88 源码解读的 VitePress 站点;不在本仓库内)——**具体目录名因机器而异**(本机按本地约定,详见本机的 CLAUDE 同步说明),CLAUDE.md 里不写死绝对路径。

- 遇到「Claude Code / agent 机制怎么做」的问题,**先查知识库**:入口 `docs/index.md`,按 part 分章(`part06-tool-system`、`part07-permissions`、`part08-context-management`…),每 part 内有 `index.md` + 编号小节。
- 该知识库是**源码解读**(非带时效标注的笔记),引用以源码事实为准;涉及版本敏感处用 WebSearch 核实。
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

- **工具**:`read_file` / `write_file` / `run_shell`(harness 固定生命周期 + 双层安全:renderer 审批闸门 + 主进程兜底)。
- **多模型**:每个模型可独立配置 `apiKey/baseUrl/model/contextWindow`,在 `models.json`。
- **项目级(Project)**:按工作目录隔离;会话归属项目。
- **安全**:沙箱模式(只读/工作区可写/完全访问)+ 审批策略(自动/需要时问/全部确认)+ allowlist。
- **会话/统计/trace**:全量持久化,可清空(危险区)。

---

## 11. 外部参考(本项目依赖的、仓库外资源)

> 这两个资源都在仓库**同级别目录**下,**具体目录名因机器而异**(CLAUDE.md 不写死绝对路径)。本机实际名称请按本机约定(查询本机 `~/.claude/projects/.../memory/` 里与本机环境相关的 memory,或询问用户)。

| 资源 | 作用 | 用到的小节 |
|---|---|---|
| **Claude Code 源码解读知识库**(VitePress 站点,基于 v2.1.88 源码) | agent 机制权威参考:`part06-tool-system`、`part07-permissions`、`part08-context-management`、`part09-memory-system` 等 | §6、§8 |
| **Claude Code 源码**(`src/Tool.ts` 等) | 工具层契约对齐(输入 schema、权限检查、生命周期元数据) | §6.4 |

**怎么查:**
- 知识库:入口 `docs/index.md`,按 part 编号小节定位;先查知识库、再 WebSearch 核实版本敏感信息(§8)。
- 源码:用 `Grep` / `Read` 直接读 `src/Tool.ts` 等关键文件,与本项目 `desktop-agent/src/renderer/src/agent-core/tools/` 对照看。

**前置检查:** 首次在本机工作时,先确认本机是否已建好对应的知识库章节(`part06-tool-system` 等)和源码目录;若缺失,这是个独立任务,不在 CLAUDE.md 路径替换范围内。

---

*本文件随项目演进迭代;有新的稳定约定就更新它(走 §5 git 流程)。*
