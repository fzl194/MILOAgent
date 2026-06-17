# Log — context-org-p2(示例)

> **追加式交接日志**。每个角色完成自己阶段时追加一段。
> 格式:`### <角色> → <下一棒> (<时间>)` + 做了啥/注意啥/测试在哪/疑问。
> 本文档为形态演示,内容取自真实工作的交接记录。

---

### dev → test (2026-06-16,完成 5 步)

5 个原子提交全部完成(commit `77305b0`…`54dca91`):

- T1 注释漂移:`identity-prompt.ts` + `types.ts` 注释对齐代码真相。纯注释,零行为变化。
- T2 supportsPromptCache 缝:`ModelConfig`/`ResolvedModel` 加三态字段(`true|false|undefined`=运行时探测),`migrateModelConfig` 加严格类型守卫,+8 用例。
- T3 cachedTokens 监控:snapshot 在 `onRequestReady` 时拿不到 usage,走 post-done patch(`recordUsagePatch` 按 callId 关联),UI 在 `TokenDashboard` 露出。+9 用例。
- T4 git:status:新 IPC `git:status`(`execFile` 无 shell、3s 超时、4KB 上限),`lib/git-status.ts` 带 60s TTL 缓存,chat-store 在 `loop.run` 前拼到 user 消息尾部。+15 用例。
- T5 FRC 通知:`fold-notice.ts` 共享常量(防占位符改名漂移),`buildSystemPromptParts` 无条件追加通知块。+1 用例。

**注意 / 给测试的提醒**:
- `main/index.ts` 同时被另一条线(fs-guard 安全加固)改过。我的 T4 只占 `git:status` handler + 1 个 import。
  审查时若看到 `getSandboxAndRoot` / `fs:writeFile` 防御层,**那是别人的工作,不算本任务**,别误判为漂移。
- T3 的 `recordUsagePatch` 有个 selectCall 在途竞态,我已处理(re-join 时校验 callId),测试用例覆盖了。

**测试位置**:
- `stores/model-store.test.ts`(+8)
- `stores/monitor-store.test.ts`(+9)
- `lib/git-status.test.ts`(+15)
- `lib/effective-config.test.ts`(+1)

**疑问(留给测试)**:cached_tokens 命中率跨会话聚合还没做(本次只露出到单轮),要不要单开一个工作项?——我的建议:先不,等积累几轮真实数据再开。

---

### test → dev (形态演示:验证通过)

- `npm run typecheck`:node + web 两份全绿。
- `npm run test`:**16 文件 / 210 用例全绿**(新增 33,无回归)。
- 抽查 5 个 commit 的 `git diff --stat`,改动面与 design 文件归属表一致,无越界。
- 结论:翻 `DONE`。唯一遗留是上面 dev 提的"命中率聚合",已记为后续工作项候选,不阻塞本项。
