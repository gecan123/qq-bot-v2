# @-mention 回复逻辑（P0 原子工具架构）

## 入口

```text
收到群消息
  └─ 是否包含 @Bot
      ├─ 否 -> continue
      └─ 是 -> 进入 agentReply
               └─ 失败时降级到 singleTurnReply
```

主入口：`src/responder/handlers/at-mention.ts`

## 上下文构建

- 通过 `buildContext(msg, contextLimit)` 构造群聊背景。
- `contextLimit` 默认 `20`（来自 `src/config/agent-profiles.ts`，可按群覆盖）。
- 当前触发文本优先使用 `extractResolvedTriggerText`，确保媒体描述已就绪后再送入 agent。

传给 agent 的 `userMessage` 结构：

```text
{triggerText 或 (用户@了你)}

[群聊背景]
{context}
```

## Agent Loop 行为

调用：`runAgentLoop({...})`

- 默认最大步数：`maxSteps = 12`
- 默认最终回答最大长度：`maxAnswerChars = 500`
- 慢请求告警：`warningTimeMs`（默认 60s，仅告警，不中断）

终止条件：

1. 模型调用 `final_answer(text)` -> 返回最终答案
2. 模型直接输出文本（`implicit_text`）-> 作为最终答案
3. 模型返回 `empty` -> fallback
4. 超过 `maxSteps` -> `aborted`
5. adapter/执行器抛错 -> fallback

## 可用工具

| 工具 | 说明 |
|---|---|
| `db_schema` | 返回可查询表结构、约束和限制 |
| `db_read` | 执行只读 SQL（强约束） |
| `final_answer` | 提交最终回复 |
| `web_search` | Tavily 实时搜索（仅配置 API key 时可见） |

> 已移除旧工具：`search_messages` / `get_recent_messages` / `get_user_profile` / `get_group_summary` 等。

## `db_read` 关键约束

由 `src/database/agent-sql.ts` 强制执行：

- 仅允许 `SELECT` / `WITH ... SELECT`
- 禁止多语句
- 禁止 DDL/DML 危险关键字
- SQL 必须包含 `:group_id`
- SQL 必须包含显式 `group_id = :group_id` 过滤
- 自动注入 `group_id` 参数
- 结果行数和输出长度受限（并返回 `truncated`）
- 查询设置 statement timeout

## 降级策略

- Agent 返回非 `final`（`fallback`/`aborted`）时，自动走 `singleTurnReply`。
- 单轮也失败则记录错误并跳过发送。

## 配置

`agent-config.json`（不存在时使用内置默认）：

```json
{
  "default": {
    "personaFile": "./prompts/default-persona.md",
    "replyContextMessages": 20,
    "agentMaxSteps": 12,
    "agentWarningTimeMs": 60000,
    "agentMaxAnswerChars": 500
  },
  "groups": {
    "123456789": {
      "personaFile": "./prompts/group-123456789.md",
      "replyContextMessages": 20
    }
  }
}
```

兼容字段：`agentMaxTimeMs`（等价于 `agentWarningTimeMs`，仅保留兼容）。
