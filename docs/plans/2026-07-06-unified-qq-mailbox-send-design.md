# QQ mailbox 与发送流程统一设计

## 目标

统一群聊和私聊的入站披露、优先级和出站授权模型：所有 QQ 消息正文先进入事实账本，AgentContext 只接收 mailbox 通知；群内 `@bot` 和私聊通过通知上的批次级优先级触发优先处理。发送链路删除 dry-run，以明确授权、真实发送和结构化结果替代模拟成功。

## 入站与 mailbox

- 群聊和私聊继续先写入 `messages`，媒体解析完成后进入事件队列。
- 所有 `napcat_message` 和 `napcat_private_message` 都按来源聚合为 mailbox 通知，不再存在群 `@bot` 直接 append 正文的分支。
- mailbox key 保持不变：群为 `qq_group:<groupId>`，私聊为 `qq_private:<peerId>`。
- 通知增加稳定的批次级 `priority=high|normal`：
  - 私聊固定为 `high`。
  - 群批次中只要包含结构化 `@bot`，整个批次为 `high`。
  - 其余群批次为 `normal`。
- 通知不披露正文或优先消息 ID。调用 `inbox` 后，逐条消息已有的 `mentionedSelf` 仍是精确判断依据。
- 通知携带完整批次读取窗口：`afterRowId` 是本批首条消息之前的 row id，`throughRowId` 是本批最后一条消息的 row id。读取 high 批次时必须从 `afterRowId` 连续分页到覆盖 `throughRowId`，不能为了直接定位 `@bot` 而跳过前面的群聊消息。
- system prompt 指导 Agent 优先读取并通常回应 `high` 通知；`normal` 通知按兴趣和当前任务决定是否读取。
- mailbox cursor、按来源聚合、snapshot 原子持久化和 replay 规则不变。

## 发送授权

建立单一 `TargetPolicy`，在解析图片或调用 NapCat 前完成授权：

- 群 reply：目标必须属于监听群。
- 群 ambient：目标必须同时属于监听群和 ambient 发送白名单。
- 私聊 ambient/reply：目标必须存在于 NapCat 当前好友列表。
- owner 不绕过好友判断，私聊历史和 mailbox cursor 不参与授权。
- 每次私聊发送前读取当前好友列表，避免维护额外缓存状态或使用过期授权。
- 好友列表查询失败时 fail closed。
- 未授权统一返回 rejected，不调用 NapCat、不重试。

## 发送参数与执行

`send_message` 使用严格判别联合：

- `mode=ambient` 要求 `replyToMessageId=null`。
- `mode=reply` 要求 `replyToMessageId` 为整数。
- target 明确区分 `{type:'group', groupId, mentionUserId?}` 和 `{type:'private', userId}`。
- 不再根据 `replyToMessageId` 静默推断 mode，也不静默丢弃冲突参数。

文本和图片统一构造 NapCat segments。群聊和私聊只在发送叶节点选择 `send_group_msg` 或 `send_private_msg`；reply、at、text、image 的 segment 构造共享同一条路径。

删除 group ambient dry-run。发送结果统一为：

```ts
{
  ok: boolean
  status: 'sent' | 'rejected' | 'failed'
  target: SendTarget
  mode: 'ambient' | 'reply'
  attempts: number
  providerMessageId: number | null
  error?: string
}
```

- `sent`：NapCat 确认送达，主循环等待新外部事件。
- `rejected`：参数合法但目标未授权，主循环继续让 LLM 修正。
- `failed`：真实发送重试耗尽，主循环继续让 LLM 决定后续动作。

日志统一记录 target type/id、mode、status、attempts 和 provider message ID。

## 验证

- mailbox 单元测试覆盖所有 QQ 消息均走 mailbox、三种 priority 情况、聚合和 cursor 不变量。
- BotLoop 测试覆盖群 `@bot` 不再直接披露正文，以及 high/normal 通知进入 Context。
- TargetPolicy 测试覆盖监听群、ambient 白名单、好友缓存刷新和查询失败。
- `send_message` 测试覆盖严格 mode schema、未授权拒绝、真实发送结果和图片降级。
- BotLoop 测试覆盖只有 `status=sent` 才进入等待。
- 最终运行 focused tests、`pnpm typecheck` 和 `pnpm repo-check`。
