# Mailbox 已处理标记设计

## 问题

自主生活循环允许 `send_message` 成功后继续运行。旧的 `inbox_update` 与 `inbox` 结果仍保留在 durable `AgentContext` 中，后续自主轮次可能再次把已经回复过的消息识别为待处理请求。

实时消息与启动 replay 已经按 `messageRowId` 和 mailbox cursor 去重；本问题不是同一入站行重复入队，而是同一 durable 入站事实被模型重复回应。

## 目标

- 保留发送后的自主连续运行。
- 成功发言后，明确关闭同一目标 mailbox 当前已经披露的消息范围。
- 标记属于 durable LLM ledger，重启 replay 时保持确定性。
- 不新增数据库表，不从 side table 或运维日志重建处理状态。
- 不把失败或被拒绝的发送误判为已处理。

## 设计

`send_message` 只有在 provider 确认发送成功后才返回受信任的 `message_sent` effect。effect 携带规范化发送目标，只供当前 Runtime Host 使用，不直接进入 `AgentContext`。

Runtime Host 从 durable ledger 中按顺序归并两类稳定 JSON user event：

- `inbox_update` 推进对应 mailbox 的已披露 `throughRowId`。
- `mailbox_handled` 推进对应 mailbox 的已处理 `throughRowId`。

当本轮存在成功发送时，Runtime Host 把发送目标映射到 `qq_group:<id>` 或 `qq_private:<id>`。如果该 mailbox 存在 `disclosed > handled` 的范围，则在所有 tool result 闭合后追加一个稳定 user event：

```json
{"event":"mailbox_handled","mailbox":"qq_private:123","throughRowId":456}
```

同一轮向同一目标发送多段内容时只追加一个标记。不同目标分别处理。没有待处理通知、发送失败或发送被拒绝时不追加。

标记随正常 post-round snapshot 一起保存。后续轮次仍可继续研究、调用工具或主动聊天，但 system prompt 明确禁止把 `throughRowId` 不大于 handled cursor 的消息再次当成新请求回应。

## 组件变化

- `src/agent/tool.ts`：增加受控的 `message_sent` effect 类型。
- `src/agent/tools/send-message.ts`：仅成功发送时产生 effect。
- `src/agent/effect-interpreter.ts`：只接受来自 `send_message` 的 `message_sent` effect，并返回去重后的目标。
- 新增纯函数模块：从 durable ledger 解析待处理 mailbox 范围并渲染稳定 `mailbox_handled` 事件。
- `src/agent/bot-loop-agent.ts`：在成功发送轮次末尾追加标记，并由已有 post-round save 原子持久化。
- `prompts/bot-system.md`：解释标记语义，不改变消息正文来源或 replay 规则。

## 边界与错误处理

- effect 来源工具不是 `send_message` 时拒绝并记录日志。
- 非法目标或非法 ledger JSON 被忽略，不阻断主循环。
- 标记只引用当前 durable ledger 已披露的范围，不读取 `messages` 表或可变 side data。
- compaction 仍按现有规则总结 durable ledger；本改动不增加新的 replay 输入。

## 验证

- 纯函数测试：通知、已有 handled、不同 mailbox、无效 JSON、同轮多目标。
- `send_message` 测试：sent 才产生 effect；rejected/failed 不产生。
- EffectInterpreter 测试：可信来源、伪造来源、目标去重。
- BotLoop 回归测试：成功回复后追加并保存标记；下一自主轮可继续但 ledger 明确关闭旧批次；失败发送不关闭。
- 运行 focused tests、`pnpm typecheck`、`pnpm repo-check`。
