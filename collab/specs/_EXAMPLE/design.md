# Design — context-org-p2(示例)

> **架构师契约**。开发按此实现,测试按此验证。**文件归属表是防 file overlap 的核心**。
> 本文档为形态演示:内容取自本项目刚做完的真实工作,用来展示 design.md 该写什么。

---

## 问题(为什么要做)

文档《2026-06-15-上下文组织管理演进.md》声称 P1/P2 已落地,但审查发现文档与代码之间有 5 处漂移:
身份注释过时、cached_tokens 采而不用、ModelConfig 缺 supportsPromptCache 缝、git 状态文档撒谎(代码无实现)、
折叠占位符模型不知情。本工作项把这 5 处收口。

## 方案(怎么做)

5 个原子步骤,每步独立提交。详见下方任务拆分。整体不动"裁剪/压缩"轴,只动"组织/装配"轴。

## 模块边界

- 仅 `desktop-agent/src/` 下 renderer + main + preload
- 不动 `docs/` 归档(仅修订被审查的那份演进文档)
- 不动裁剪轴(context-strategy 的折叠阈值/占位策略不动)

## 文件归属表(核心:开发只能动这里列的文件)

| 任务 | 文件 | Owner | 依赖 | 验收 |
|---|---|---|---|---|
| T1 注释漂移 | `lib/identity-prompt.ts`、`agent-core/types.ts` | dev | — | typecheck 净 |
| T2 supportsPromptCache 缝 | `agent-core/types.ts`、`stores/model-store.ts`、`stores/model-store.test.ts` | dev | — | +8 用例 |
| T3 cachedTokens 监控 | `monitor/types.ts`、`stores/monitor-store.ts`、`stores/chat-store.ts`、`MonitorPanel/*.tsx` | dev | T2 | +9 用例 |
| T4 git:status 尾部注入 | `main/index.ts`(仅 git:status 段)、`preload/index.ts`、`adapters/electron-api.ts`、`lib/git-status.ts` | dev | — | +15 用例 |
| T5 FRC 通知段 | `lib/effective-config.ts`、`agent-core/agent/fold-notice.ts`、`agent-core/agent/context-strategy.ts` | dev | — | +1 用例 |

> **注意 `agent-core/types.ts` 被 T1 和 T2 都用**:架构师在设计时就发现 → 拆成两个原子提交、顺序执行,
> T1 只改注释、T2 才加字段,提交时互不干扰。**这就是 file overlap 在设计时被化解的例子。**
>
> **注意 `main/index.ts` 有另一条线(fs-guard 安全加固)在并行**:本表的 T4 只占 `git:status` 那一段函数 + 1 个 import,
> 与 fs-guard 的 `getSandboxAndRoot` / `fs:writeFile` 段不交错。开发 T4 时若看到 fs-guard 改动,那是别人的工作,**不要带进自己提交**。

## 验收标准(测试照此验)

- [ ] `npm run typecheck`(node + web)全绿
- [ ] `npm run test` 全绿,新增用例 ≥ 33(8+9+15+1)
- [ ] 文档《2026-06-15-上下文组织管理演进.md》自评段与代码一致(不再撒谎)
- [ ] 5 个原子提交,各自 conventional-commits 格式
