# 多消息源 Mailbox 设计

## 目标

保留单一全局 `AgentContext` 和跨来源人格连续性，同时停止把所有群聊正文自动注入 LLM 历史。`messages` 继续作为不可变事实账本；每个来源用独立持久游标记录已经向 Agent 披露到哪里；Agent 通过有界工具按需读取具体 mailbox。

## 选择

采用“单一全局 Agent + 多 mailbox + 分级披露”。不为每个群创建独立 Agent，也不复制一份 mailbox 正文表。mailbox 是 `messages` 按 scene 划分后的逻辑视图。

## 数据边界

- `messages`：群聊和私聊的不可变入站事实。
- `BotAgentSnapshot.mailboxCursors`：与 `contextSnapshot` 同行持久化的来源高水位。key 是稳定的 `qq_group:<groupId>` 或 `qq_private:<peerId>`，value 是该来源最后已披露的 `messages.id`。
- `AgentContext`：direct 消息正文、ambient inbox 通知，以及 Agent 主动读取后形成的 tool result。

游标和 context snapshot 必须在同一次 snapshot upsert 中保存。崩溃发生在保存前时，两者都回退并从事实账本重放；保存后则两者都前进，避免“游标前进但上下文丢失”。

## 披露策略

- 私聊：direct，正文按现有稳定格式立即 append。
- 群聊中 `@bot`：direct，正文立即 append。
- 其他群聊：ambient。一次 drain 内按来源聚合成确定格式的有界通知，只包含来源、消息数量、row-id 范围、时间范围、发送者数量和读取指引，不包含正文。
- curiosity tick 和后台任务结果保持现有行为。

通知一旦 append 就成为 AgentContext 的稳定历史。聚合边界只影响尚未提交的本轮；已提交历史不从动态 side table 重建。

## Mailbox 工具

新增 `inbox` 工具：

- `action=list`：列出允许来源及其最新消息高水位，帮助 Agent 发现当前 mailbox。
- `action=read`：按明确的 `groupId` 或 `peerId` 读取消息，支持 `afterRowId` 和 `limit`，按 `messages.id` 升序返回。

工具输出有严格行数和字符上限。返回稳定 message row ID、QQ message ID、发送时间、发送者和冻结后的 `resolvedText`；不自动修改披露游标，因为“读过”与“已向主 Agent 通知”不是同一语义。

## Replay

启动恢复从 snapshot 中的 per-source cursor 出发，查询每个允许来源中 `messages.id` 更大的消息。冷启动且没有 snapshot 时仍不灌入历史。live 与 replay 继续按 `messageRowId` 去重。

旧 snapshot 没有 mailbox cursors 时，使用旧 `lastWakeAt` 完成一次兼容恢复；首次保存新 snapshot 后进入 cursor 模型。`lastWakeAt` 仅作为过渡字段保留，不再承担正常恢复语义。

## 安全与边界

- `inbox.read` 必须要求显式来源；群 ID 受监听白名单约束。
- 私聊读取要求显式 peer ID，沿用当前任意好友 DM 的入站模型。
- 所有读取结果都是不可信外部内容，只通过 tool result 进入 AgentContext。
- 出站仍必须使用显式 `send_message` target。本次不引入跨来源内容流防护；该问题单独设计，避免与摄取重构耦合。

## 验证

- 单元测试覆盖 direct/ambient 分类、按来源聚合、游标推进和稳定渲染。
- replay 测试覆盖多来源独立 cursor、旧 snapshot fallback、live/replay 去重。
- inbox 工具测试覆盖群白名单、私聊、边界分页和输出上限。
- 集成测试证明 ambient 正文不进入 AgentContext，而 direct 正文仍可触发回复。
- 最终运行 focused tests、`pnpm db:generate`、`pnpm typecheck`、`pnpm repo-check` 和完整测试。
