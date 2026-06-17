# Design — tool-harness-dual-track-closure

> 架构师契约。开发按此实现,测试按此验证。**文件归属表是防 file overlap 的核心**。
> 上游审查依据见 `docs/2026-06-17-工具层harness架构审查.md`。

---

## 问题(为什么要做)

工具层 harness 迁移目前停在"双轨中间态":`read_file` 已上 harness(`tools/harness/tools/read-file.ts`),但 `write_file` / `run_shell` 仍走 legacy executor。副作用:

1. **schema 单一真相源被违反**——`read_file` 在 registry(Zod schema)与 `definitions.ts`(手写 JSON schema)两处定义并存。
2. **生命周期割裂**——harness 路径有「校验→validateInput→checkPermissions→call→整形」固定生命周期 + fail-closed 默认;legacy 路径全无。
3. **双轨的根是 feature flag**(`config.toolHarness.enabled`,默认 false)——flag 不处理,双轨永远清不掉。

这是审查报告里认定的**唯一实质架构债**。本卡收口。

## 方案(怎么做)

**行为保持迁移**:把 write_file / run_shell 搬上 harness、删 legacy 执行路径与 feature flag 对 loop 的作用,线缆 schema 与执行结果**字节级 / 行为级不变**。

**明确排除(后续卡,本卡不做)**:
- 退出码语义分离(非零仍 isError,保持现状)。
- shell 输出编码归一化(仍 `toString()` 现状)。
- 危险正则搬进 `checkPermissions`(仍走 renderer classifier)。

即:本卡只搬不动语义。这保证最小回归面,后续债各自独立卡推进。

## 模块边界

- 仅 `desktop-agent/src/renderer/src/`(agent-core + stores)。**不动 main 进程**(write/shell 的 IPC 兜底已就位,本卡不碰)。
- **不动 `safety/classifier.ts` / `classifier.test.ts`**(风险分类行为不变,是硬约束)。
- **不动 `docs/`**(文档同步是独立的 backlog 卡,见 PROJECT.md)。

## 文件归属表(核心:开发只能动这里列的文件)

| 任务 | 文件 | Owner | 依赖 | 验收 |
|---|---|---|---|---|
| T1 新建 harness 工具 | `tools/harness/tools/write-file.ts`、`tools/harness/tools/run-shell.ts`(新建) | dev | — | 各自带单测;description 与 `definitions.ts` 逐字等价 |
| T2 注册三工具 | `tools/harness/build-registry.ts` | dev | T1 | `registry.get('write_file'/'run_shell')` 非 undefined |
| T3 schema 单一真相源 | `tools/definitions.ts`、`tools/index.ts` | dev | T2 | `ALL_TOOLS` 改由 `registry.definitions()` 派生;**迁移前后 `JSON.stringify` diff 为空** |
| T4 删 loop 双轨 | `agent-core/agent/loop.ts` | dev | T3 | legacy 分支(tool.ts 注释的 `else` 段)删除;`toolExecutor` 构造参数移除 |
| T5 无条件走 harness | `stores/chat-store.ts`、`stores/config-store.ts` | dev | T4 | `buildToolRegistry()` 无条件调用;`toolHarness` 标 `@deprecated`(no-op,保留 schema 避免动 config migrate) |
| T6 清理 legacy 痕迹 | `tools/executor.ts`、`agent-core/types.ts`、`agent-core/index.ts` | dev | T4 | `ToolExecutor` 接口 / shim / re-export 删除 |

> **共享文件顺序执行(防 overlap)**:
> - `loop.ts` 只在 T4 动,且只动工具派发段(`toolRegistry?.get` 的 if/else → 无条件 harness)与构造函数签名。**不碰** context 折叠段 / authorize 段。
> - `chat-store.ts` 只在 T5 动,且只动构造 loop 的两行(registry 无条件传入、toolExecutor 移除)。**不碰** monitor / git-status / context 相关段。
> - `types.ts` 只在 T6 动(删 `ToolExecutor` 接口)。若与并行卡(如 context / monitor)同改 `types.ts`,**按本表 T6 顺序排队**,git pull 后再改,不交叉。
>
> **并行卡冲突回避**:本卡文件全在 `tools/` + `agent/loop.ts` + `chat-store`/`config-store`,与 `MonitorPanel/*` / `monitor-store` / `context-strategy` 线不重叠。

## 关键实现约束(开发必读)

1. **description 逐字照搬**:`write-file.ts` / `run-shell.ts` 的 Zod `.describe()` 必须与 `definitions.ts:16-41` 的 `description` / 字段 description **字符级一致**。read-file 已验证 `toolToDefinition` 输出可复现(见 `read-file.ts:59` = `definitions.ts:5`),write/shell 照做。
2. **checkPermissions 暂 allow**:`write_file` / `run_shell` 的 `checkPermissions: async () => ({ behavior: 'allow' })`。理由:命令安全由 renderer `authorize()→classifier` 负责(主进程无内核沙箱无法可靠审查命令,见审查报告 §③.5);路径安全由主进程 IPC 兜底(canonicalize + `enforceWorkspacePath`,已就位)。本卡不重复、不搬危险正则。
3. **maxResultSizeChars**:`write_file` 内容自定、无需落盘 → 设一个合理上限(如 30K,超出即 truncated 标记);`run_shell` 落盘已在主进程做(`SHELL_PERSIST_THRESHOLD`),harness 拿到的是 preview → 设 `Infinity`(主进程已 cap)。
4. **shell 结果整形**:`run-shell.ts` 的 `call` 调 `window.electronAPI.shellRun(...)`,把 `{success, error, data:{stdout, stderr, persisted}}` 整形为 `RawToolResult`。非零退出仍 `isError: true`(行为保持,退出码语义分离是后续卡)。`persisted` 信息可放 `bytes` 字段透出给 trace。
5. **feature flag 处理**:T5 让 loop 无条件走 harness;`config.toolHarness` 字段**保留读取兼容**(`config-store.ts:51-55` 不删,只加 `@deprecated` 注释),避免动 config.json migrate 逻辑(那是有回归风险的独立 chore)。flag 字段的物理删除放后续 chore 卡。

## 验收标准(测试照此验)

- [ ] `npm run typecheck`(node + web)全绿
- [ ] `npm run test` 全绿,新增 `write-file.test.ts` / `run-shell.test.ts` 覆盖 harness 生命周期(校验失败 / checkPermissions / call 成功 / 整形)
- [ ] **线缆 schema 字节等价**:迁移前后 `JSON.stringify(ALL_TOOLS)` diff 为空(prefix cache 不破)——本卡最关键不可见验收
- [ ] `grep -rn "toolExecutor" desktop-agent/src` 仅剩 `@deprecated` 注释或零命中
- [ ] `grep -n "legacy\|toolHarness" desktop-agent/src/renderer/src/agent-core/agent/loop.ts` 零命中(loop 无条件 harness)
- [ ] `classifier.test.ts` 未被修改(风险分类行为不变)
- [ ] 6 个原子提交,各自 conventional-commits 格式(`refactor(tools): ...` / `chore(tools): ...`)

## 不做(留演进缝)

- 退出码语义分离 → 后续卡 `tool-exit-code-semantics`
- shell 输出编码归一化 → 后续卡 `shell-encoding-normalization`
- `config.toolHarness` 字段物理删除 → 后续 chore 卡
- `outputSchema` 再校验、tree-sitter AST、hook 系统、并行调度器(始终留缝)
