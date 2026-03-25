# Agent Loop 设计方案（P0 原子工具版）

> 状态：v2.0（已实现）
> 更新时间：2026-03-25

## 1. 目标

将 @回复能力改为“模型自主规划 + 原子工具调用”，避免把业务流程提前固化为高层工具。

关键目标：

- 工具面收敛到原子能力：`db_schema` / `db_read` / `web_search` / `final_answer`
- 数据访问可自由组合，但必须有硬约束（只读、群隔离、超时、截断）
- agent loop 可多步运行并保留兜底链路

## 2. 当前架构

```text
@消息
  -> at-mention handler
  -> buildContext + triggerText
  -> runAgentLoop
       -> adapter.chat(..., tools)
       -> 执行工具 / 回灌 tool_results
       -> 直到 final_answer 或中止
  -> 若非 final，降级 singleTurnReply
  -> sendGroupReply
```

主文件：

- `src/responder/handlers/at-mention.ts`
- `src/agent/loop.ts`
- `src/agent/tools.ts`
- `src/database/agent-sql.ts`
- `src/agent/openai-agent-adapter.ts`

## 3. Loop 协议

### 3.1 输入

`runAgentLoop` 参数：

- `systemPrompt`
- `userMessage`
- `adapter`
- `tools`
- `executors`
- `maxSteps?`（默认 12）
- `warningTimeMs?`（慢请求告警阈值，默认 60000ms，仅告警）
- `maxAnswerChars?`（默认 500）

兼容字段：`maxTimeMs`（仅映射到 `warningTimeMs`，不再用于硬超时终止）。

### 3.2 回合结果

adapter 每回合返回三种之一：

- `tool_calls`
- `text`
- `empty`

处理规则：

1. `tool_calls`
2. 遇到 `final_answer` 立即终止并返回 `final`
3. 其他工具执行后把结果写回历史，进入下一轮
4. `text` 视为 `implicit_text` 终止
5. `empty` 返回 `fallback`
6. 超出步数返回 `aborted`
7. loop 内异常返回 `fallback`

## 4. 工具面（P0）

## 4.1 `db_schema`

返回数据库可用表/字段和约束声明，供模型规划查询。

## 4.2 `db_read`

输入：

- `sql: string`
- `params?: Record<string, string | number | boolean | null>`

输出：JSON 字符串，包含：

- `columns`
- `rows`
- `rowCount`
- `truncated`
- `elapsedMs`

## 4.3 `web_search`（可选）

仅当 `TAVILY_API_KEY` 存在时注入工具声明。

## 4.4 `final_answer`

终止工具，参数 `text`。loop 统一做长度截断。

## 5. `db_read` 安全边界

由 `src/database/agent-sql.ts` 强制：

- 仅允许 `SELECT` / `WITH ... SELECT`
- 禁止多语句
- 禁止危险关键字（DML/DDL）
- 必须包含 `:group_id`
- 必须包含显式 group 过滤谓词：`group_id = :group_id`（含别名形式）
- 自动注入 `group_id`
- statement timeout
- 最大返回行数限制（超限保留 `truncated=true`）
- 最大输出字符限制（超限截短行并 `truncated=true`）

## 6. 配置默认值

来自 `src/config/agent-profiles.ts` 与 `src/agent/loop.ts`：

- `replyContextMessages = 20`
- `maxSteps = 12`
- `maxAnswerChars = 500`
- `warningTimeMs = 60000`

## 7. 与旧方案的差异

已移除旧高层业务工具：

- `search_messages`
- `get_recent_messages`
- `get_user_profile`
- `get_group_summary`
- `lookup_group_member`

保留降级链路：agent 非 `final` 时自动回退单轮回复，保证可用性。

## 8. 可观测性

loop 记录结构化日志：

- `state`
- `termination / reason`
- `steps`
- `toolsCalled`
- `totalDurationMs`
- `stepDetails`（每步工具与耗时）

慢请求会记录 `agent_loop_slow_warning`，但不提前中断。

## 9. 后续演进（P1/P2）

- 记忆层从“预计算表”升级为“按需检索 + 可选离线压缩”
- 引入更丰富的只读视图，减少模型对底层 schema 假设
- 对 `db_read` 增加更细粒度配额（窗口频率、总字符预算）
- 增加可复现 trace（问题、调用链、结果摘要）用于离线评估
