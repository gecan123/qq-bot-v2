# Agent P0 线上观测清单（中文）

适用版本：P0 原子工具架构（`db_schema` / `db_read` / `web_search` / `final_answer`）

## 1. 上线后先看 30 分钟（快速健康检查）

1. `agent_loop_complete` 是否持续出现。
2. `state=final` 是否明显高于 `fallback + aborted`。
3. 是否出现大量 `agent_loop_unknown_tool`。
4. 是否出现持续 `agent_loop_tool_error`。
5. `agent_loop_slow_warning` 是否异常密集。

## 2. 核心指标与建议阈值

1. 完成率：`final / 全部 loop`
建议：`>= 85%`

2. 降级率：`fallback_to_single_turn / 全部 @请求`
建议：`<= 15%`

3. 超步数率：`termination=max_steps_exceeded`
建议：`<= 5%`

4. 隐式文本率：`termination=implicit_text`
建议：`<= 30%`
说明：过高通常表示模型没有稳定走 `final_answer` 协议。

5. 慢请求率：`agent_loop_slow_warning / 全部 loop`
建议：`<= 10%`

6. `db_read` 截断率：`truncated=true`
建议：`<= 25%`
说明：过高表示查询太宽，容易浪费 token。

7. `web_search` 失败率
建议：`<= 10%`

## 3. 每日最小复盘项（建议固定时间看一次）

1. `state` 分布：`final / fallback / aborted`。
2. `termination` 分布：`final_answer / implicit_text / max_steps_exceeded / empty_response`。
3. `steps` 分布：均值、P95、最大值。
4. 工具使用频次：`db_read`、`web_search`、`db_schema`。
5. `db_read` 常见失败原因（SQL 校验不通过、缺 group 过滤、超时等）。
6. `totalDurationMs` 的 P50/P95。

## 4. 异常 -> 处置建议

1. `max_steps_exceeded` 偏高
先优化系统提示词里的“先收敛后回答”，再考虑从 12 调到更高。

2. `implicit_text` 偏高
加强 system prompt，明确“最终输出必须调用 `final_answer`”。

3. `db_read` 错误偏高
给模型补 SQL 模板示例（含 `:group_id` + 显式过滤）。

4. 慢请求偏高
先缩小上下文条数（当前默认 20），再限制 `db_read` 返回规模。

5. `web_search` 错误偏高
检查 Tavily key、网络和重试策略；必要时暂时关闭 `web_search` 注入。

## 5. 建议保留的日志字段

`groupId`, `state`, `termination/reason`, `steps`, `toolsCalled`, `totalDurationMs`, `stepDetails`

## 6. 最小采样建议

1. 第一轮观察至少覆盖 200 条 @请求。
2. 按群分桶统计（避免被单个大群掩盖）。
3. 先看 24 小时，再决定是否调整默认值（`maxSteps`、`replyContextMessages`）。
