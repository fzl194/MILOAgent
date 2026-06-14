# Desktop Agent 项目级（Project-level）设计

> **目标**：把当前「扁平会话列表」的 Agent 升级为「项目级 Agent」——Project 指向一个工作目录，会话挂在 Project 下，配置/记忆/权限/上下文全部项目级化。
> **依据**：本地 Claude Code 知识库（`D:\study\KnowledgeBase`）+ Codex 联网调研。两者模型高度收敛。
> **日期**：2026-06-13 · 性质：实现设计（可据此落地）
> **v2 修订**：① 统计拆为项目级（不再全局单文件）；② 砍掉目录文件记忆（AGENTS.md/MILO.md），项目记忆改用「项目级 systemPrompt」。
> **v3 核对（2026-06-14）**：项目级功能已落地。其中 §0决策2（默认项目现绑定 `<workspace>/default` 真实目录，非 dirPath=null）与 §6（allowlist 实为「全局=模式／规则=会话+项目」，无全局 rules 档）已被实现调整，详见 `2026-06-14-desktop-agent-项目级实现核对.md`。

---

## 0. 已确认的决策

1. **Project 身份**：显式 Project 记录（名字 + 目录路径），**以目录 realpath 为唯一身份**（兼容 Codex/Claude「目录即项目」）。目录被移走/删除 → 标记「缺失」并提示。
2. **默认项目**：始终存在一个「默认项目」——**用户不新建项目也能直接聊天**，会话落在默认项目区。新建项目两类：① **新建项目**（在 workspace 根下创建新文件夹）；② **复用已有文件夹**（指向已存在目录）。**旧会话清掉**（不做迁移）。
3. **workspace 根**：默认 `~/.desktop-agent/workspace`，可在设置中修改。
4. **项目级配置（全部支持覆盖全局）**：项目级系统提示词（即项目记忆）、沙箱模式 + 审批策略、allowlist、默认模型。
5. **统计拆项目级**：每项目独立 `stats/events.jsonl`；全局总览按需汇总各项目，不单独存全局统计文件。
6. **不做目录文件记忆**：不读取项目目录里的 AGENTS.md/MILO.md；项目记忆 = 项目级 systemPrompt（存 `projects/<id>/config.json`）。

---

## 1. 跨工具调研共识（设计依据）

| 维度 | 共识 | 我们采纳 |
|---|---|---|
| 项目身份 | **项目 = 工作目录路径**（realpath 规范化作身份） | ✅ 显式 Project 记录 + 目录路径身份 |
| 记忆/指令 | Codex 从根走 cwd 逐层收集 `AGENTS.md`；Claude CLAUDE.md 四层栈 | ⚠️ 简化：用**项目级 systemPrompt**（不做目录文件遍历） |
| 配置作用域 | **global → project → local** 三层合并 | ✅ global→project 覆盖 |
| 会话归属 | 会话**按项目分桶**（transcript + meta） | ✅ `projects/<id>/sessions` |
| 统计归属 | （Claude）按项目分桶 | ✅ `projects/<id>/stats` |
| cwd | 一等状态，变更驱动权限/上下文重解析 | ✅ 项目目录即 cwd |

> 来源：[Codex AGENTS.md 指南](https://developers.openai.com/codex/guides/agents-md)、[Codex #25818](https://github.com/openai/codex/issues/25818)、[Codex config-advanced](https://developers.openai.com/codex/config-advanced)；本地 KB part09/part07/part13。

---

## 2. 数据模型

```
Project {
  id: string                 // uuid，分桶键
  name: string               // 显示名
  dirPath: string | null     // 规范化 realpath；默认项目为 null
  isDefault: boolean         // 默认项目标记（唯一）
  createdAt / updatedAt
  config?: ProjectConfig     // 项目级覆盖
}

ProjectConfig {              // 全 optional，未设则继承全局
  systemPrompt?: string      // 项目级系统提示词（= 项目记忆）
  sandbox?: SandboxMode
  approvalPolicy?: ApprovalPolicy
  defaultModelId?: string
  // allowlist 单独存 projects/<id>/allowlist.json
}

Session += { projectId: string }   // 现有 Session 增加 projectId
```

**身份规则**：`dirPath` 经 realpath 规范化；两个 Project 不能指向同一目录（去重）；默认项目 `dirPath=null`，不绑目录。

---

## 3. 目录布局（`~/.desktop-agent/`）

```
~/.desktop-agent/
├── config.json              # 全局 AgentConfig（systemPrompt/sandbox/policy/workspaceRoot/默认模型）
├── models.json              # 全局模型定义（不变）
├── workspace/               # 「新建项目」默认在此创建新文件夹（根可改）
│   └── <项目名>/
├── projects/
│   ├── index.json           # Project[] 记录
│   └── <projectId>/
│       ├── config.json      # 项目级覆盖（ProjectConfig）
│       ├── allowlist.json   # 项目级 allowlist（与全局取并集）
│       ├── sessions/<sid>.json
│       ├── traces/<sid>.jsonl
│       └── stats/events.jsonl   # 项目级统计（用量/成本/工具）
└── allowlist.json           # 全局 allowlist（默认项目/未覆盖时用）
```

> **统计**：不再有全局 `stats/events.jsonl`；每个项目独立统计文件。「全局总花费/总趋势」由 StatsPanel 按需遍历各项目汇总（多源聚合，已有先例）。
> **旧数据**：升级时清掉旧 `index.json` / `sessions/` / `traces/` / `stats/`（按决策不迁移），种子一个默认项目。

---

## 4. 配置解析（effective config，每次对话前算）

```
effective = {
  sandbox:         project.config.sandbox         ?? global.sandbox
  approvalPolicy:  project.config.approvalPolicy  ?? global.approvalPolicy
  workspaceRoot:   project.dirPath ?? global.workspaceRoot   // 项目目录即工作区
  defaultModel:    project.config.defaultModelId  ?? global.default
  allowlist:       global.allowlist ∪ project.allowlist       // 并集
  systemPrompt:    joinNonEmpty(global.systemPrompt, project.config.systemPrompt)
}
```

- **项目记忆** = 项目级 systemPrompt（叠加在全局之后）。不做目录文件遍历。
- **模型选择优先级**：会话级 modelConfigId > 项目 defaultModelId > 全局默认。
- allowlist 取并集（项目可放宽，但 dangerous 仍走分级器，不因 allowlist 放行）。

---

## 5. 侧栏 / 交互

```
┌─ MILO ────────────────────┐
│ + 新建会话                 │  ← 在当前激活项目下建会话
│ + 新建项目 ▾               │  ← ① 新建项目(新文件夹) ② 复用已有文件夹
│ ▾ 默认项目                 │  ← 始终在顶部；不绑目录
│     · 会话A  会话B          │
│ ▾ my-app  (/code/my-app)   │  ← 命名项目，显示目录
│     · 会话C                │
│ ▾ 实验  (⚠ 缺失: /x/y 已移走)│
└───────────────────────────┘
```

- **新建项目(新文件夹)**：输入名 → 在 `<workspaceRoot>/<名>` 建目录 → dirPath 指向它。
- **复用已有文件夹**：文件夹选择器 → realpath → dirPath（同目录去重）。
- 切换项目 → 显示该项目会话；新建会话归激活项目。
- 项目右键：重命名、改目录、删除（删项目默认只删记录+会话，保留磁盘目录）。

---

## 6. 与现有体系的衔接

| 现有模块 | 改动 |
|---|---|
| **session-store** | 增加 `activeProjectId`；会话按 projectId 过滤；新建会话带 projectId |
| **新增 project-store** | Project CRUD、激活项目、workspace 根、effective-config 解析 |
| **config-store** | 保留全局；新增 `getEffectiveConfig(projectId)` 合并全局+项目 |
| **safety/classifier + decide** | ctx.workspaceRoot 改用 effective.workspaceRoot（=项目目录）；policy/sandbox 用 effective |
| **allowlist-store** | 拆全局 + 项目级；`all()` 按当前项目返回并集 |
| **chat-store sendMessage** | 用 effective config 构造 AgentLoop；trace/stats 写到 `projects/<id>/` |
| **stats-store / StatsPanel** | 改为按项目读 `projects/<id>/stats/events.jsonl`；全局视图=遍历项目汇总；trace/成本按项目 |
| **main IPC** | 新增 `project:*`（list/save/delete）、项目级 config/allowlist/sessions/traces/stats 读写、新建项目=mkdir |
| **Sidebar** | 扁平会话 → 项目树 |
| **trace 时间线** | 读 `projects/<id>/traces/<sid>.jsonl` |

---

## 7. 分阶段实施计划

| 阶段 | 内容 | 产出 |
|---|---|---|
| **P1 地基** | Project 类型 + project-store + 默认项目 + Session.projectId + main IPC(project:*) + 迁移清理（旧数据清掉） | 能建/切项目，会话挂项目下（配置暂全继承全局） |
| **P2 新建流程 + UI** | 两类新建（新文件夹/复用目录）+ workspace 根设置 + 目录缺失检测 + 侧栏项目树 | 完整项目管理 UX |
| **P3 项目级配置** | ProjectConfig + effective-config 解析（systemPrompt/sandbox/policy/默认模型）+ 项目设置 UI + 各模块改用 effective | 配置项目级化 |
| **P4 收尾** | 项目级 allowlist 分桶、trace/stats 拆项目级 + StatsPanel 按项目汇总、删除选项、typecheck+测试 | 全量项目化 |

> 建议从 **P1** 起步（最小可用：项目+会话归属），每阶段 typecheck 保持构建绿。

---

## 8. 待定 / 开放项

- **删除项目时是否删除磁盘目录**：默认只删 Project 记录+会话（保留磁盘目录，安全）；可选「连同目录删除」。
- **会话能否跨项目移动**：后续可加。
- **MILO.md 文件记忆**（未来）：当前不做；若以后要"自动读项目目录里的指令文件"，用品牌名 `MILO.md`，根→cwd 逐层收集（Codex 同款）。

---

## 9. 一页速记

| 项 | 方案 |
|---|---|
| **项目身份** | 显式 Project 记录 + 目录 realpath 作底层身份 |
| **默认项目** | 始终存在，不绑目录，不新建也能聊 |
| **新建两类** | 新文件夹（workspace 下）/ 复用已有目录 |
| **配置层级** | global → project 覆盖；effective 合并；allowlist 并集 |
| **项目记忆** | 项目级 systemPrompt（不做目录文件遍历） |
| **统计** | 拆项目级；全局总览按需汇总 |
| **目录布局** | `projects/<id>/{config,allowlist,sessions,traces,stats}` + `workspace/` |
| **迁移** | 旧会话/trace/stats 清掉，种子默认项目 |
| **第一刀** | P1：Project 模型 + 默认项目 + 会话挂项目 |

---
*文档结束。确认后从 P1 开始实施。*
