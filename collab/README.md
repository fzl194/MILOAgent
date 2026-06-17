# 多 Agent 并行协作协议

> 这是本项目多 Agent(架构师 / 开发 / 测试)并行开发协作的**权威约定**。
> 每个 Agent 窗口启动后,**第一动作永远是读 `collab/PROJECT.md`**。

---

## 为什么有这套东西

多 Agent 同时改代码会反复踩"file overlap commit"——A 的提交偷偷带进 B 的改动,或互相抹掉对方的工作。
根治办法不是 git 技巧,而是**把冲突从"提交时"上移到"设计时"**:

1. 架构师在设计契约里写明**文件归属表**(每个任务只能动哪些文件)
2. 开发只动分给自己的文件 → 提交时天然不重叠
3. 每个工作项有个**状态机字段当分布式锁**,防止两个 Agent 抢同一件事

Agent 之间**不直接对话**,全部通过这个文件夹下的结构化 md 异步交接——和真实分布式团队靠 issue tracker + PR 通讯一个道理。

---

## 三个角色

| 角色 | 做什么 | 主要产出 | 写权限边界 |
|---|---|---|---|
| **架构师 Architect** | 读代码/docs → 定方向 → 设计契约 + 拆任务 + 文件归属 | `specs/<id>/design.md`、`backlog/`、`PROJECT.md` 方向段 | 仅 `collab/` 文档 |
| **开发 Developer** | 从 `READY` 领需求 → 按 design 文件归属表改代码 → 写 handoff | 代码 commit + `log.md` 实现段 | **仅 design 归属表里分给他的文件** + `log.md` |
| **测试 Tester** | 从 `DEV_DONE` 领 → 跑 typecheck/test + 按验收标准验证 → 报告 | `log.md` 测试段 + 测试代码 | `**/*.test.ts` + `log.md` |

**默认 1 窗口 = 1 角色**(3 窗口正好映射三角色)。模型是"角色按工作项分配",以后加窗口可灵活(两个开发就 `owner` 写 `dev-a` / `dev-b`)。

`review` 不单设角色:开发自测 + 测试验证为主,架构师可做设计评审,codex 独立第二意见仍按 `CLAUDE.md` §4 走(与本协议正交)。

---

## 文件夹结构

```
collab/
├── README.md              ← 本文件(协议本身)
├── PROJECT.md             ← 看板总览:目标 + 角色 + 工作项状态索引(先读这个)
├── backlog/               ← 尚未设计的需求池(谁都可投)
│   └── <NN>-<slug>.md
└── specs/                 ← 已设计的工作项 = 看板卡(一个工作项一个目录)
    └── <slug>/
        ├── STATUS.md      ← 状态机锁(frontmatter: status / owner / files)
        ├── design.md      ← 架构师契约:问题 / 方案 / 模块边界 / 文件归属表 / 验收标准
        └── log.md         ← 追加式交接日志(实现笔记 / 测试结果 / 坑,按时间累积)
```

**为什么 STATUS / design / log 拆三个文件**:
- `STATUS.md` = 协调令牌,`grep` 一下就知道哪些可领、谁在干啥
- `design.md` = 契约(架构师唯一产出,开发唯一输入)
- `log.md` = 跨会话记忆(Agent 本身无记忆,但笔记落盘了,下一棒必读)

---

## 状态机(`STATUS.md` 的 `status` 字段 = 分布式锁)

```
DRAFT      架构师写设计中                  (owner: architect)
  ↓
READY      设计完成,开发可领               (owner: 空)
  ↓ 开发翻 status + 写 owner 声明领取
DEV        开发实现中(独占,他人不碰)      (owner: dev)
  ↓
DEV_DONE   开发完成,测试可领               (owner: 空)
  ↓
TESTING    测试验证中                      (owner: test)
  ↓
DONE       验证通过 + 已合并               (owner: -)

BLOCKED    任何阶段卡住都可翻,带说明        (owner: 当前角色,等架构师/人介入)
```

**领取 = 乐观锁**:
1. Agent 把 `status: READY → DEV` + `owner: dev`
2. `git add collab/specs/<id>/STATUS.md && git commit -m "..."`
3. 若已被别人先 commit,git 报冲突 → 后来者 `git pull` 重读后**退避**,不硬抢

**一个工作项同一阶段只有一个 owner**——从机制上杜绝"抢同一需求"。

`STATUS.md` frontmatter 形态:
```yaml
---
id: <slug>
title: <一句话标题>
status: DEV            # DRAFT|READY|DEV|DEV_DONE|TESTING|DONE|BLOCKED
owner: dev             # architect|dev|test|dev-a...|(空)
files:                 # 从 design.md 抄过来,领取时锁定写权限边界
  - path/to/file-a.ts
  - path/to/file-b.ts
updated: 2026-06-17T10:00
---
```

---

## 交接协议(通讯,全部走 md)

Agent 启动**固定第一动作**:`读 collab/PROJECT.md` → 看自己是哪个角色、有哪些工作项处于"可领"状态。

| 通道 | 谁写 → 谁读 | 形态 |
|---|---|---|
| 契约 | 架构师 → 全员 | `design.md`(含**文件归属表**——防 file overlap 的核心) |
| 状态 | 任一角色(翻状态声明领权) | `STATUS.md` frontmatter |
| 交接日志 | 完成方 → 下一棒 | `log.md` 追加段(我做了啥 / 注意啥 / 测试在哪 / 疑问) |
| 反馈 | 测试 → 开发 | `log.md` 追加段(哪条验收没过 / 复现步骤)→ 翻回 `DEV` |

### 三条铁纪律

1. **只动 `STATUS.md` `files:` 列表里的文件**。要动表外的文件 → 先找架构师改 design(扩归属或拆新任务),**绝不擅自越界**。
2. **阶段交接必写 `log.md` 一段**(实现笔记 / 测试结果),让下一棒无需问人。
3. **翻状态后立即 commit**,别把多个工作项的改动堆在一起(原子提交,`CLAUDE.md` §5)。

### file overlap 怎么被根治的

架构师在设计阶段就看见某文件被两条线争用(例:本次 `main/index.ts` 的 git:status 段 vs fs-guard 段),
就在 design 的归属表里把它们分到**不同工作项、顺序执行**,或明确"各占独立函数段不交错"。
开发照表做,提交时天然不重叠——冲突在设计时已化解,不是提交时才爆发。

---

## 并行怎么真正发生(两层)

- **多工作项并行**:架构师按文件归属拆出 N 个不相关的工作项,分给 N 个开发,文件不重叠 = 真并行。
- **流水线并行**:同一时刻不同工作项处于不同阶段——架构师设计 story-4、开发实现 story-1、测试验证 story-2,三人都忙(Kanban 拉式,不是批处理)。

---

## worktree 在本协议下是"可选",不是必需

因为文件归属在设计阶段已隔离、状态机保证同一工作项只有一个 owner,共用主仓库即可。
仅当某工作项高风险(大重构)时,该 Agent 才单独开 worktree 隔离。

---

## 最小起步

1. 架构师窗口:在 `specs/` 建一个真实工作项目录,写 `design.md`(含文件归属表)+ `STATUS.md`(`status: READY`)→ commit
2. 开发窗口:读 `PROJECT.md` → 发现 `READY` → 翻 `DEV` + `owner: dev` → 只动归属文件 → 写 `log.md` → 翻 `DEV_DONE` → commit
3. 测试窗口:发现 `DEV_DONE` → 翻 `TESTING` → `npm run typecheck && npm run test` → 写 `log.md` → 翻 `DONE`(或 `BLOCKED` 回开发)

照着 `specs/_EXAMPLE/` 抄即可。
