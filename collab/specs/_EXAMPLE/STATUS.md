---
id: context-org-p2
title: 示例 — 上下文组织 P2 收口(形态演示,非真实待办)
status: DONE
owner: ''
files:
  - desktop-agent/src/renderer/src/agent-core/types.ts
  - desktop-agent/src/renderer/src/stores/model-store.ts
  - desktop-agent/src/renderer/src/stores/model-store.test.ts
  - desktop-agent/src/renderer/src/monitor/types.ts
  - desktop-agent/src/renderer/src/stores/monitor-store.ts
  - desktop-agent/src/renderer/src/stores/chat-store.ts
  - desktop-agent/src/main/index.ts
  - desktop-agent/src/preload/index.ts
  - desktop-agent/src/renderer/src/lib/git-status.ts
  - desktop-agent/src/renderer/src/lib/effective-config.ts
  - desktop-agent/src/renderer/src/agent-core/agent/fold-notice.ts
updated: 2026-06-17T10:00
note: 这是形态演示样例,真实工作项由架构师窗口照此创建。
---

# STATUS — context-org-p2

> 状态机锁。**真相源**就是上面 frontmatter 的 `status` / `owner` / `files`。
> 流转记录见下方。

## 流转记录

- `DRAFT` → `READY`(架构师完成 design,含文件归属表)
- `READY` → `DEV`(`owner: dev` 领取)
- `DEV` → `DEV_DONE`(开发实现完,写 log 实现段)
- `DEV_DONE` → `TESTING`(`owner: test` 领取)
- `TESTING` → `DONE`(typecheck + 210 单测全绿)

> 注:本工作项在本协议建立前已实际完成(5 个原子提交),这里仅作**形态演示**——
> 展示 `STATUS.md` / `design.md` / `log.md` 三件套长什么样、流转怎么记。
