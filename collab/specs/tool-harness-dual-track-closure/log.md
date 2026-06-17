# Log — tool-harness-dual-track-closure

> 追加式交接日志。每个角色完成自己阶段时追加一段。
> 格式:`### <角色> → <下一棒> (<时间>)` + 做了啥/注意啥/测试在哪/疑问。

---

### architect → dev (2026-06-17,design 完成)

工作项已建,`STATUS` 翻 `READY`。design.md 含 6 个原子任务(T1–T6)+ 文件归属表 + 字节等价验收硬标准。

**给开发的最关键提醒**:
1. 本卡是**行为保持迁移**——只搬工具上 harness、删双轨,**不要顺手改退出码语义或编码**(那是后续卡)。`checkPermissions` 对 write/shell 写 `allow` 即可。
2. **最隐蔽的坑**:`ALL_TOOLS` 参与 OpenAI 兼容前缀缓存对齐(`effective-config.ts:39` / commit 2428b16)。迁移后线缆 schema 必须**字节级不变**——description 逐字照搬 `definitions.ts:16-41`,迁移前后 `JSON.stringify(ALL_TOOLS)` diff 必须为空。read-file 已验证 `toolToDefinition` 可复现,照做。
3. **不要动** `safety/classifier.ts` 和 `classifier.test.ts`——风险分类行为变更是硬约束红线。
4. **不要动 main 进程**——write/shell 的 IPC 兜底(canonicalize + `enforceWorkspacePath` + 落盘)已就位,本卡只在 renderer 侧收口。
5. feature flag `config.toolHarness` **保留字段、只标 deprecated**,别删 schema(动 config migrate 有回归风险,留 chore 卡)。

**并行注意**:本卡文件在 `tools/` + `loop.ts` + `chat-store`/`config-store`。若 `types.ts` 与别的并行卡同改,按 T6 顺序排队、git pull 后再改,不交叉。

领取动作:翻 `STATUS.md`(`status: READY → DEV` + `owner: dev` + 从 design 抄 `files`)→ 立即 commit。
