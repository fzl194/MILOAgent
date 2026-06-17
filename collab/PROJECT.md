# 协作看板 · PROJECT.md

> **Agent 启动第一动作:读本文件。** 确认自己是哪个角色,看哪些工作项"可领"。
> 协议细则见 `collab/README.md`。

---

## 当前迭代目标

<!-- 架构师维护这一段:本阶段要推进的方向。 -->

### 本阶段(2026-06-17 起):工具层 harness 收口

架构审查结论(`docs/2026-06-17-工具层harness架构审查.md`):harness 地基工业级、契约可演进,代码已领先文档;唯一实质架构债是**双轨中间态未收口**。

推进顺序:
1. **`tool-harness-dual-track-closure`(READY)**:write_file/run_shell 迁上 harness,删 legacy 执行路径与 feature flag。**关键路径,unlock 后续。**
2. `tool-exit-code-semantics`:退出码语义分离(依赖 #1)。
3. `shell-encoding-normalization`:shell 输出编码归一化(依赖 #1)。
4. docs 同步:`docs/2026-06-15-工具层harness演进与安全.md` 过时项修正(独立小卡,见 backlog)。

shell 命令级安全的架构张力已在审查报告 §③.5 诚实表述:无内核沙箱下,命令安全以 renderer 闸门为唯一可信防线,主进程只做执行卫生,不假装补到 read/write 强度。

---

## 角色与窗口

| 角色 | 职责一句话 | 领取条件(status) |
|---|---|---|
| **架构师 architect** | 定方向 + 设计契约 + 文件归属 + 验收标准 | 自己排期,无领取条件 |
| **开发 dev** | 按 design 归属表实现,只动表内文件 | `READY` |
| **测试 test** | typecheck/test + 按验收标准验证 | `DEV_DONE` |

**默认 1 窗口 = 1 角色**。多开发时 `owner` 用 `dev-a` / `dev-b`。

---

## 工作项状态索引

> 看板总览。新增/流转工作项时同步更新这一行。
> 详细状态以各 `specs/<id>/STATUS.md` 的 frontmatter 为准(那里是真相源)。

| ID | 标题 | 状态 | Owner | 说明 |
|---|---|---|---|---|
| `_EXAMPLE` | 示例:上下文组织 P2 收口 | `DONE` | — | 形态演示,照抄用,**非真实待办** |
<!-- 真实工作项示例:
| `tool-harness-p3` | 工具层 harness 下一阶段 | `READY` | (空) | 等开发领 |
| `monitor-p2` | 监控面板 P2 | `DEV` | dev-a | dev-a 实现中 |
-->

| `tool-harness-dual-track-closure` | 工具层双轨收口 — write/shell 迁上 harness,删 legacy + flag | `READY` | (空) | 等开发领。字节等价验收 + 行为保持迁移。design 见 `specs/tool-harness-dual-track-closure/` |

---

## 待设计需求池(backlog)

> 谁都可投。一条需求一个 md 放 `collab/backlog/<NN>-<slug>.md`,写清标题 + 动机 + 粗略范围,等架构师设计。
> 投了就在这里登记一行。

| 文件 | 标题 | 提出者 |
|---|---|---|
| _(空)_ | | |

---

## 协作速记(给三个窗口的)

- **动手前**:读本文件 → 看自己角色对应"可领"状态的工作项 → 读它的 `design.md`。
- **领取**:翻对应 `STATUS.md`(`status` + `owner` + 从 design 抄 `files`)→ 立即 commit。
- **写代码**:只动 `STATUS.md` 里 `files:` 列表的文件。越界先改 design。
- **交接**:完成阶段在 `log.md` 追加一段(做了啥/注意啥/疑问)→ 翻 `STATUS.md` 到下一状态 → commit。
- **卡住**:翻 `STATUS.md` 为 `BLOCKED` 并写说明,等架构师或人介入。
- 铁纪律、状态机、file overlap 根治逻辑 → 见 `README.md`。
