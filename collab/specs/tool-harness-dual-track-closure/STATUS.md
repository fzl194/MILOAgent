---
id: tool-harness-dual-track-closure
title: 收口工具层双轨 — write_file/run_shell 迁上 harness,删 legacy 执行路径与 feature flag
status: READY
owner: ''
files:
  - desktop-agent/src/renderer/src/agent-core/tools/harness/tools/write-file.ts
  - desktop-agent/src/renderer/src/agent-core/tools/harness/tools/run-shell.ts
  - desktop-agent/src/renderer/src/agent-core/tools/harness/build-registry.ts
  - desktop-agent/src/renderer/src/agent-core/tools/definitions.ts
  - desktop-agent/src/renderer/src/agent-core/tools/index.ts
  - desktop-agent/src/renderer/src/agent-core/tools/executor.ts
  - desktop-agent/src/renderer/src/agent-core/types.ts
  - desktop-agent/src/renderer/src/agent-core/index.ts
  - desktop-agent/src/renderer/src/agent-core/agent/loop.ts
  - desktop-agent/src/renderer/src/stores/chat-store.ts
  - desktop-agent/src/renderer/src/stores/config-store.ts
updated: 2026-06-17T15:00
note: 行为保持迁移。仅收双轨,不含退出码语义分离 / 编码归一化(后续卡)。checkPermissions 对 write/shell 暂 allow。
---

# STATUS — tool-harness-dual-track-closure

> 状态机锁。真相源就是上面 frontmatter 的 `status` / `owner` / `files`。
> 流转记录见下方。

## 流转记录

- `DRAFT` → `READY`(2026-06-17,架构师完成 design,含文件归属表 + 字节等价验收硬标准)
- _(后续由 dev/test 续写)_

## 架构师交付提示(给领取者)

1. **先读 `design.md` 文件归属表**——只能动表内文件,越界先找架构师。
2. **本卡最隐蔽的验收点**:线缆 schema 必须**字节级不变**(见 design 验收 #3)。`ALL_TOOLS` 参与 prefix cache 对齐,description / 字段名逐字照搬,迁移前后 `JSON.stringify` diff 必须为空。
3. **行为保持**:`checkPermissions` 对 write/shell 暂 `allow`;危险分类仍走 renderer `authorize()→classifier`,**本卡不动 `classifier.test.ts`**。退出码语义 / 编码归一化是后续卡,别顺手做。
