# QQ 会话焦点与 invoke 发送设计

## 目标

借鉴 Kagami 的 QQ App 模型：模型先打开一个 QQ 会话，后续发送只描述内容和可选引用消息，不在每次 `send_message` 调用中重复生成 target、mode 和空值占位。

本设计复用现有 `help` / `invoke` deferred capability，不新增第二套通用 App 框架。QQ 发送目标从显式逐次参数改为 snapshot 中的持久会话焦点。

## 目标模型

新增 deferred capability `qq`，内部提供：

- `qq_conversation`：`list | current | open | close`。`open` 接受一次显式 group/private target，并把它设为当前会话。
- `send_message`：向当前会话发送文本、图片或音乐；不再接受 target 或 mode。

调用流程：

1. Agent 用 `help action=activate capability=qq` 激活 QQ capability。
2. Agent 用 `invoke tool=qq_conversation` 查看或打开会话。
3. Agent 用 `invoke tool=send_message` 发送内容。
4. `reply_to` 有值时构造引用回复，无值时构造普通发送。

沿用仓库现有稳定 invoke 信封：

```json
{
  "tool": "send_message",
  "args": {
    "message": "确实有点离谱",
    "reply_to": 456
  }
}
```

不把 Kagami 的扁平 passthrough invoke 搬过来，因为当前嵌套 `args` 已经是持久 ledger 契约，改它会无谓影响所有 deferred capability。

## 状态与持久化

`AgentContext` snapshot 新增可空的 `qqConversationFocus`：

```ts
type QqConversationFocus =
  | { type: 'group'; groupId: number }
  | { type: 'private'; userId: number }
  | null
```

它与 `messages`、`activeToolCapabilities` 一起持久化和恢复，但不作为额外消息注入 LLM ledger。`qq_conversation open/close` 的 tool call 和 tool result 已经为模型保留可见事实；机器状态用于发送路由和重启恢复。

compaction 只改写 messages，不改变会话焦点。snapshot schema version 随之递增，完整性校验同步更新。

## 工具契约

### qq_conversation

```ts
z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('current') }),
  z.object({ action: z.literal('open'), target: groupOrPrivateTarget }),
  z.object({ action: z.literal('close') }),
])
```

`open` 必须经过现有 QQ 目录/监听范围校验：群只能是配置监听群，私聊只能是 NapCat 当前好友。成功结果明确返回规范化后的 current target。

### send_message

```ts
z.object({
  message: z.string().min(1).max(500).nullable().optional(),
  imageRef: imageRefSchema.nullable().optional(),
  music: musicSchema.nullable().optional(),
  reply_to: z.number().int().positive().optional(),
  mention_user_id: z.number().int().positive().optional(),
}).refine(hasAtLeastOneContent)
```

运行时从 `reply_to` 推导发送模式：有值为 `reply`，无值为 `ambient`。`mention_user_id` 仅允许群会话。发送授权、群 ambient 白名单、好友校验、禁言诊断、图片 handle、音乐卡片和 provider-confirmed receipt 语义保持不变。

## 数据流

```text
invoke qq_conversation.open
  -> 校验 target 可达
  -> 更新 AgentContext.qqConversationFocus
  -> tool result 披露 current conversation
  -> round 结束时随 snapshot 保存

invoke send_message
  -> 读取 qqConversationFocus
  -> 无焦点则返回 CHAT_CONTEXT_UNAVAILABLE
  -> 由 reply_to 推导 ambient/reply
  -> 复用 SendTargetPolicy 与 MessageSender
  -> provider 确认成功后返回 receipt + message_sent effect
```

`message_sent` effect 必须携带实际解析出的 target，现有 mailbox handled 逻辑继续以 provider-confirmed target 为准。

## 错误处理

- 未激活 `qq`：沿用 invoke 的 inactive capability 错误。
- 未打开会话：`CHAT_CONTEXT_UNAVAILABLE`，提示先调用 `qq_conversation open`。
- 当前焦点已不再可达：清除焦点并返回 `CHAT_CONTEXT_STALE`，不得尝试发送。
- `reply_to` 非正整数、空内容或私聊携带 mention：由 Zod/业务校验拒绝。
- provider 失败、禁言、图片解析失败：保留现有结构化 receipt 和诊断。

## 兼容与迁移

这是实验性项目，采用干净目标模型：删除 always-on 顶层 `send_message`，不保留旧 target/mode adapter。历史 ledger 中已经存在的旧 tool call 仍作为 provider 历史回放，不会重新执行；新请求只暴露 `help` / `invoke` 和新的 deferred QQ schema。

文档、system prompt 能力索引和 unknown-tool 提示同步改为 `help -> activate qq -> invoke` 路径。

## 测试

按 TDD 覆盖：

1. provider 顶层 tools 不再包含 `send_message`，`invoke` schema 保持稳定。
2. `qq_conversation open/current/close` 更新并恢复 snapshot 焦点。
3. 普通发送不带 `reply_to`，引用发送接受正整数并传给 target policy/sender。
4. 新 schema 不再产生 `replyToMessageId: { type: 'null' }` 的错误展开。
5. 无焦点、过期焦点、未授权 target、私聊 mention 和空内容均返回稳定错误且不调用 sender。
6. 文本、图片、音乐、禁言诊断、message_sent effect 和 mailbox handled 既有回归测试继续通过。
7. 运行 focused tests、`pnpm typecheck`、`pnpm repo-check`；影响面验证通过后再运行完整测试。
