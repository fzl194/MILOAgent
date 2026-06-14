# desktop-agent · Anthropic 格式兼容调研

> 日期:2026-06-14
> 目的:在现有「仅 OpenAI 格式」的 agent 上增加 Anthropic Messages API 支持,调研需要改什么(配置/前端/代码)。
> 主源:claude-api 参考(Messages API、streaming、tool-use)+ 知识库 `开发工具/Claude-Code/part04-queryengine/05-api-streaming.md` + 当前实现。

---

## 一、功能要点(要做什么)

当前 agent 只懂 OpenAI 格式(`{baseUrl}/chat/completions`)。目标:每个模型配置可选「OpenAI / Anthropic」两种协议,按选择走对应格式 —— 这样 GLM/DeepSeek 继续走 OpenAI 兼容,Claude 走原生 Anthropic Messages API。**agent 内核(循环、工具、上下文、审批)尽量不动**,只在「发送层」分流。

---

## 二、实现逻辑(机制)

### 现状(仅 OpenAI)
发送层直接 `fetch`,拼 OpenAI 请求体,按 OpenAI 的 SSE(`choices[].delta`)解析;消息转 OpenAI 形状(system 在 messages 里、`tool_calls`、`tool` 角色结果)。

### 目标架构:Provider 抽象
- 定义一个「LLM Provider」接口:**输入** = 内部统一消息 + 工具定义;**输出** = 统一的流式事件(文本增量、工具调用增量、工具调用结束、`done`+用量+结束原因)。
- agent 循环只消费这些统一事件 —— **不变**。
- 两个实现:`OpenAIProvider`(把现状拆出来)、`AnthropicProvider`(新增)。各自负责:消息→自己的 wire 格式、请求(endpoint/头/body)、解析自己的 SSE→统一事件。
- 一个工厂:按模型配置里的 `provider` 字段选实现。

### OpenAI vs Anthropic 逐点对照(核心)
| 维度 | OpenAI | Anthropic Messages |
|---|---|---|
| endpoint | `{baseUrl}/chat/completions` | `{baseUrl}/v1/messages` |
| 鉴权头 | `Authorization: Bearer <key>` | `x-api-key` + `anthropic-version: 2023-06-01`;浏览器直连再加 `anthropic-dangerous-direct-browser-access: true` |
| 系统消息 | messages 里 `role:system` | **顶层 `system` 字段**(messages 里没有 system) |
| messages 角色 | system/user/assistant/tool | **仅 user/assistant**(无 system、无 tool 角色) |
| max_tokens | 可选 | **必填** |
| 工具定义 | `{type:function,function:{name,description,parameters}}` | `{name,description,input_schema}` |
| 工具调用(出) | `assistant.tool_calls[].function.arguments`(字符串) | assistant 的 `content` 里的 `{type:tool_use,id,name,input}` 块;参数经 `input_json_delta` 增量拼接 |
| 工具结果(回) | `role:tool` + `tool_call_id` | **user 消息**里的 `{type:tool_result,tool_use_id,content,is_error?}` 块 |
| 流式增量 | `choices[0].delta.content` / `delta.tool_calls` | `content_block_delta`:`text_delta`(文本)/ `input_json_delta`(工具参数 `partial_json`) |
| 流式事件族 | 单一 `choices` 增量 | `message_start`/`content_block_start`/`content_block_delta`/`content_block_stop`/`message_delta`/`message_stop` |
| 结束原因 | `finish_reason`:stop/tool_calls/length | `stop_reason`:end_turn/tool_use/max_tokens/refusal/...(需映射:`tool_use→tool_calls`、`end_turn→stop`、`max_tokens→length`) |
| 用量 | prompt_tokens/completion_tokens/total_tokens | input_tokens/output_tokens(+ cache_*;**无 total**) |

### Anthropic 侧关键转换点
- **消息**:把内部历史里的 system 抽到顶层 `system`;user/assistant 直接转;内部「tool 结果消息」合并进紧随其后的 **user 消息**的 `tool_result` 块(按 `tool_use_id` 配对,连续多条可合并)。
- **工具调用出**:`content` 里的 `tool_use` 块(id/name/累加后的 input)→ 内部 ToolCallItem;逐块 yield 工具调用增量;`stop_reason=tool_use` 即「要执行工具」。
- **用量**:`input_tokens/output_tokens` → 内部 inputTokens/outputTokens(total 留空)。
- **请求体**只放 Anthropic 认的字段(注:部分 Claude 模型拒 `temperature/top_p/top_k`;`max_tokens` 必填;新模型用 `thinking:{type:"adaptive"}` + `output_config:{effort}` 而非采样参数)。

---

## 三、当前弊端

- 发送 / 解析 / 消息转换全绑死 OpenAI 形状;新增格式要改多处,且和现有逻辑纠缠、易回归。
- 直接浏览器 `fetch` + key(OpenAI 已如此);Anthropic 还需额外 CORS 头(或改主进程代理)。
- 无 provider 维度的配置,模型能力差异(上下文窗口、是否支持工具、参数限制)目前不感知(对应《功能盘点》那条)。

---

## 四、改进方向(分阶段)

> **2026-06-15 复核·实现状态**：**全部未实现**。仅 `ModelConfig.protocol` 字段已预留（`'openai' | 'anthropic'`，缺省 openai）；Provider 接口抽象、`AnthropicProvider`、独立 SSE 解析、前端协议选择、实测验证均**未落地**（`llm/` 目录下无任何 Anthropic 代码，发送层仍是纯 OpenAI 格式）。本文保留为未来实现依据。

1. **配置**:`ModelConfig` 加 `provider: 'openai' | 'anthropic'`(缺省 openai);`models.json` 透传。
2. **抽象**:把现有「发送+解析+消息转换」拆成 `OpenAIProvider`;定义 Provider 接口 + 工厂;agent 循环改用工厂产出的 provider(行为不变,纯重构)。
3. **新增 `AnthropicProvider`**:消息转换 + 请求(endpoint/鉴权/CORS 头)+ 独立 SSE 解析 + 结束原因/用量映射。
4. **前端**:模型编辑面板加 provider 选择;按选择给 baseUrl 默认值与提示(如 Anthropic 默认 `https://api.anthropic.com`)。
5. **验证**:接一个 Claude key 实测一轮(含一次工具调用往返);走「规划→改→测→ecc/codex 审查→迭代」固定 pipeline。

---

## 五、风险 / 注意

- **CORS**:Anthropic 默认拒浏览器;需 `anthropic-dangerous-direct-browser-access: true` 头(简单),或改走主进程代理(更安全、key 不进 renderer)。现状 OpenAI 也是 renderer 直连 key,直连 Anthropic 暴露面一致;主进程代理留作后续加固。
- **参数差异**:不能复用 OpenAI body;`temperature` 等在某些 Claude 模型会 400;`max_tokens` 必填。
- **系统消息位置 + 工具结果角色**不同,转换要仔细(id 配对、合并、连续 tool_result)。
- **SSE 结构完全不同**,需独立解析器,不能在 OpenAI 解析器上打补丁。
- **标题生成**也走 provider(现在直接用 OpenAI 形状发一个 2 消息请求),要兼容 Anthropic。
- **是否引入 `@anthropic-ai/sdk`**:SDK 更省心但加重 renderer bundle;现状是裸 `fetch`,**保持裸 fetch 双 provider 更一致**(推荐);SDK 作为备选。

---

## 六、参考

- claude-api 参考:`streaming.md`(SSE 事件族、finalMessage)、`tool-use.md`(tool_use/tool_result 往返)、`README.md`(system/鉴权)
- 知识库:`开发工具/Claude-Code/part04-queryengine/05-api-streaming.md`(流式→yield 映射)
