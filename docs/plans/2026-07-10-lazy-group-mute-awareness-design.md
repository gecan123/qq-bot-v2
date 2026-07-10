# 群聊禁言 Lazy 感知设计

## 目标

Luna 不主动订阅群成员禁言通知。只有在向群聊发送消息失败时，发送链路才按需确认机器人账号是否正被禁言，并把确认后的事实作为 `send_message` 的结构化 tool result 披露给 Luna。

本设计只回答“Luna 当前能否在目标群发言”，不感知其他成员的禁言变化，也不还原离线期间的禁言历史。

## 决策

采用“发送失败后查询确认”的 lazy 方案：

1. `send_message` 正常调用现有 NapCat 群发送接口。
2. 发送成功时不增加任何查询或状态维护。
3. 群发送最终失败时，调用 `get_group_shut_list` 查询该群当前禁言列表。
4. 如果列表包含 `config.selfNumber`，把失败归因为 `group_muted`，并返回可用的解禁时间。
5. 如果查询未确认机器人被禁言，保留普通发送失败，不猜测原因。
6. 不在发送工具中缓存或持久化“当前禁言”状态；后续发送仍走真实尝试，由最新结果更新 Luna 的认知。

示例结果：

```json
{
  "ok": false,
  "status": "failed",
  "reason": "group_muted",
  "target": { "type": "group", "groupId": 123 },
  "mode": "reply",
  "attempts": 2,
  "providerMessageId": null,
  "mutedUntil": "2026-07-10T12:30:00.000Z"
}
```

`mutedUntil` 来自 NapCat 的 `shut_up_time`。上游没有提供有效时间时可以省略该字段，但 `reason` 仍可基于成员列表确认。

## 备选方案

### 订阅 `notice.group_ban`

可以即时感知禁言和解禁，但需要新增 ingress 事件、Agent 事件类型、渲染和 replay/持久化决策。它还会接收本需求不关心的其他成员变化，复杂度高于“发言失败才发现”的产品语义。

### 仅解析发送异常

成本最低，但依赖 NapCat 错误文本或 retcode 的稳定性，容易把网络错误、风控或权限问题误判为禁言。因此不作为事实判断依据。

### 发送失败后查询确认

只有失败路径增加一次查询，且使用当前群禁言列表确认事实。它不能提前感知禁言或主动感知解禁，但这正符合 lazy 语义，因此作为选定方案。

## 组件边界

### NapCat 发送层

`src/messaging/napcat-sender.ts` 继续负责重试和发送日志，并在最终失败时保留足够的失败信息供上层诊断。发送层不直接写 AgentContext。

禁言是确定性业务失败。若第一次发送异常已能可靠标识为禁言，可以跳过第二次发送并直接进入查询确认；否则保持现有重试行为，最终失败后再确认。

### MessageSender

`MessageSender` 的失败结果扩展为可携带有界、可序列化的诊断结果。查询异常只能使诊断退化为普通发送失败，不能覆盖原始发送结果，也不能抛出新的工具级异常。

### `send_message` 工具

工具继续返回稳定 JSON。确认禁言后增加：

- `reason: "group_muted"`
- 可选 `mutedUntil`

未确认禁言时使用通用 `send_failed` 原因，不把原始异常、长错误文本或日志内容写入 AgentContext。私聊发送失败不触发群禁言查询。

## 数据与上下文

诊断结果只通过当前 `send_message` 的 `ToolExecutionResult.content` 进入 AgentContext，符合现有 ledger 契约。不新增数据库表、BotEvent、mailbox cursor、side table 或 system prompt 动态状态。

已经进入 ledger 的结果表达的是“某次发送时确认被禁言”，不是永久的运行时真值。后续成功发送会自然提供更新后的事实，因此工具层不做发送拦截。

## 错误处理

- 群消息发送失败、查询成功且命中自身：`reason=group_muted`。
- 群消息发送失败、查询成功但未命中自身：`reason=send_failed`。
- 群消息发送失败、查询也失败：`reason=send_failed`，诊断失败只记录运维日志。
- 私聊发送失败：`reason=send_failed`，不查询群状态。
- 查询返回非法时间：保留 `group_muted`，省略 `mutedUntil`。

日志应区分发送失败和禁言确认查询失败，但不得把 access token 或未经约束的响应体放入 tool result。

## 验证

至少覆盖以下 focused tests：

1. 群发送成功时不查询禁言列表，receipt 保持成功。
2. 群发送失败且自身出现在禁言列表时返回 `group_muted` 和 `mutedUntil`。
3. 群发送失败但自身不在列表时返回普通 `send_failed`。
4. 禁言列表查询失败时仍返回普通发送失败，不抛异常。
5. 私聊发送失败时不查询禁言列表。
6. 一次禁言失败不会阻止下一次真实发送；下一次成功时正常返回 `sent`。
7. tool result 始终是可解析、字段有界的稳定 JSON。

实现后运行发送工具 focused tests、相关 messaging tests、`pnpm typecheck` 和 `pnpm repo-check`。
