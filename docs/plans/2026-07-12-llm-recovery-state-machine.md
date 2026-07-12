# LLM Recovery State Machine 实施计划

## 目标

把当前“整轮失败后固定等待”的粗粒度恢复，拆成可观察、可测试、不会重放副作用的 LLM 请求恢复状态机。

恢复边界只包围 `LlmClient.chat()`。工具执行发生在成功响应被写入 `AgentContext` 之后，不属于 provider retry；任何 `send_message`、交易、发布或文件写入都不得由本状态机自动重放。

## 错误分类

| 类别 | 例子 | 默认动作 |
|---|---|---|
| `transport` | 连接重置、DNS、读取响应失败 | 有界重试 |
| `rate_limit` | HTTP 429 | 尊重 `retry-after`，否则指数退避 |
| `overloaded` | HTTP 529、SSE `overloaded_error` | 指数退避；后续阶段可 fallback |
| `server` | HTTP 500/502/503/504 | 有界重试 |
| `context_overflow` | provider 明确返回 prompt/context too long | 不做普通重试；交给 Runtime Host reactive compact |
| `output_truncated` | 成功响应的 stop reason 为 `max_tokens` | 不当成错误；后续阶段追加 continuation |
| `auth` / `permission` | 401/403 | 不重试 |
| `invalid_request` | 400/413 或 schema/provider 参数错误 | 不重试 |
| `invalid_response` | 非法 SSE/JSON、缺失终止事件 | 第一阶段不重试，保留完整诊断 |

## 阶段一：Claude transient retry 与结构化错误

- 在 `ClaudeCodeApiError` 上增加稳定的 `kind`、`retryable`、`retryAfterMs`、`requestId` 和 provider error type。
- HTTP 响应保留 `retry-after` 与 `request-id`。
- transport、429、500/502/503/504/529 最多重试两次，与 Anthropic SDK 默认次数对齐。
- 延迟使用指数退避；有合法 `retry-after` 时优先采用并设置上限。
- abort 立即停止，不重试。
- SSE 200 中的 `overloaded_error` 也进入同一重试路径。
- 每次重试记录 kind、status、attempt、delay 和 request ID，不记录密钥。

## 阶段二：Runtime Host reactive compact

- provider 适配器只负责识别 `context_overflow`，不直接修改 `AgentContext`。
- `BotLoopAgent` 捕获该分类后调用一次 emergency/reactive compact，立即保存 snapshot，再重试同一 LLM round。
- reactive compact 一轮最多一次；仍失败则回到现有 round backoff，避免压缩循环。
- compaction 不重新执行任何已经 append 的 tool call/result。

## 阶段三：stop reason 与 continuation（已实现）

- Claude `stop_reason` 与 OpenAI `finish_reason` 归一化为 provider-neutral stop reason。
- 首次 `max_tokens` 保持 messages 不变，只提高 call-level 输出预算再请求一次。
- 仍截断时，仅把不含 tool call 的普通 assistant 文本写成 checkpoint，再注入固定 continuation 请求；每个 round 最多两次。
- 截断响应里只要出现 tool call，就不 append、不执行并返回有界失败，避免把半截 JSON 当成副作用指令。

## 阶段四：fallback model（已实现）

- 增加显式 `LLM_FALLBACK_MODEL` 配置，不从模型名或 provider 列表猜测。
- 只在主 adapter 的内部 retry 已耗尽且错误仍为 `overloaded/server` 后切换一次；auth、rate limit、invalid request、context overflow 不切换。
- fallback 共享同一 wire provider 时保持 request body 契约；跨 provider fallback 另行设计，不在首版隐式转换。
- 日志和 token usage 必须记录实际模型与 fallback 原因。

## 验收

- 同一个 request body 在 transient retry 中字节不变。
- 429/5xx/529、transport、SSE overload、abort、401/403、400 各有 focused test。
- `retry-after` 秒数和 HTTP-date 均可解析且有上限。
- 所有重试次数固定有界，测试不真实 sleep。
- snapshot/context 测试证明 provider retry 不新增 ledger message。
- reactive compact 测试证明最多压缩并重试一次，且不切开 tool call/result。
- 全部路径有结构化日志，可回答“为什么重试、等了多久、最终是否恢复”。
