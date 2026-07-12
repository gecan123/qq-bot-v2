# 永续 Agent Context

项目产品契约是稳定、可 replay、低成本扩展的 LLM 历史。Prompt cache 稳定性是一等产品能力。

## 不变量

- `AgentContext` 是 LLM ledger。运行时形态和持久化 snapshot 形态必须一致。新的 LLM 可见事实只能通过 append 或受控 compaction 进入，不能从 side table 重建历史。
- `BotAgentSnapshot.mailboxCursors` 是每个 QQ 来源已披露 message row 的高水位。它必须和 `contextSnapshot` 同行保存，不能先推进游标再单独保存上下文。
- `BotAgentSnapshot.mailboxContinuity` 是条件性同来源上下文补偿的运行控制状态，和 cursor/context 同行保存。它只记录时间、累计 round、最近 input tokens、compaction epoch 与 per-mailbox 锚点，不进入 LLM ledger，也不按消息文本做语义 hardcode。
- `BotAgentSnapshot.goalRevision` 是当前 Goal 控制状态已披露到 ledger 的 revision。它必须和 `contextSnapshot` 同行保存；`bot_agent_goal` 只保存单例控制状态和 self Goal 保险丝计数，不能用来重建历史 transcript。发现更高 revision 时，Runtime Host 先 append 稳定的 `goal_state_changed`，再推进 cursor 并保存。
- `BotAgentSnapshot.contextSnapshot` 是持久化运行时形态。schema 由 `src/agent/agent-context.types.ts` 定义。`messages` 是 LLM 可见 ledger；`activeToolCapabilities` 是 deferred tools 的运行控制状态，必须随 snapshot 持久化/恢复，但不作为 LLM 可见事实注入 messages。
- `messages` 是入站事实账本。它服务于搜索、媒体解析、审计和 replay recovery，但不能替代 snapshot。
- Message scene 不变量：`sceneKind='qq_group'` 时 `groupId` 非空且 `sceneExternalId=''`；`sceneKind='qq_private'` 时 `groupId=null` 且 `sceneExternalId=String(peerId)`。
- late media 和 side table 更新不得改写已经 append 的 message。
- compaction 是正常情况下会破坏性改写 prefix 的路径。它必须保持 assistant tool call 和对应 tool result 的原子性。
- safe cut 之前除已有摘要外的完整 prefix 都必须进入 summarizer，不能按比例静默丢弃头部消息；图片和过期 native thinking 只能按既定有界规则降级。
- compaction 只改写 `messages`，不得隐式丢弃或重建 `activeToolCapabilities`。
- compaction 改写以及随后可能发生的 sticker-pool 注入完成后必须立即保存 snapshot，不能依赖下一轮顺带持久化。
- active Goal 在正常 compaction 和 context-overflow recovery compaction 后都必须重新 append `goal_continuation`，再保存或重试；摘要不是 Goal 当前状态的唯一载体。
- provider 在任何 tool call append 前明确拒绝超长 prompt 时，Runtime Host 可以强制执行一次 recovery compaction，立即保存 snapshot 后重试同一 round；每轮最多一次，普通 provider retry 不得修改 ledger 或重放工具。
- provider 以 `max_tokens` 正常结束时，第一次恢复只提高输出预算并重发同一份 snapshot，不修改 ledger。若仍截断，只能持久化不含 tool call 的 assistant 普通文本和固定 continuation 消息；截断 tool call 永远不能 append 或执行，continuation 次数必须有上限。
- LLM 请求使用从 durable ledger 确定性重建的 working-context projection。投影不得删 message、改 role、拆 assistant tool call/result 原子组；当前只把较旧 tool result 的图片字节替换为稳定 marker，并保留最近三个图片结果。原始图片仍在 snapshot 中，compaction/replay 的事实源不变。
- 同一 assistant message 的连续显式只读 tool call 可以并行执行，但完成时序不能进入 ledger：对应 tool result 必须严格按 assistant tool-call 原顺序 append。副作用或未知调用是 barrier，不能与前后调用跨越并行。
- system prompt 字节和 tool description 会影响 cache identity。修改时要有意、集中处理。
- replay 必须确定性。同样输入下，snapshot message 字节应当跨运行稳定。
- LLM、工具结果、运行日志、运维输出和 bot 自管 Markdown 中的时间统一使用北京时间。机器可读字段采用 `YYYY-MM-DDTHH:mm:ss.SSS+08:00`；数据库仍使用 `timestamptz` 保存绝对时刻，不把展示时区写进数据库语义。
- 大块外部内容必须通过有边界的 tool result、摘要或受控文件路径进入。raw pages、feeds、长文件和可变日志不能直接注入主 context。
- `ToolExecutionResult.content` 是唯一进入 `AgentContext` 的工具结果。`outcome` 和 `effects` 只服务当前运行时的日志、分支和 EffectInterpreter，不得 append、持久化或用于 replay 重建。
- 可供下一轮机器判断的 tool result 使用稳定 JSON；截断必须发生在字段或数组条目层，并用显式标记披露，不能直接切断序列化后的 JSON。
- generated image bytes 可以放在 `OutboundCache` 或 artifact 路径里，压缩 preview 可以进入 context。preview 压缩失败时，降级为稳定文本结果。
- 图片 handle 遵循共享 schema：吃图工具接受 `{mediaId}` 或 `{ephemeralRef}`；发送链路使用 `media:N` 或 `ephemeral:<64-hex>` 这类字符串 ref。
- `logs/*.ndjson` 是运维日志，不是 Prisma 事实，也不是 prompt replay 来源。

## 运行模型

- bot 在允许来源之间共享一个 owned `AgentContext`。
- 新事件源必须通过 event queue 和 dedup 路径进入披露规划，不要插入历史中段。所有 QQ 消息按 `groupId` 或 `peerId` 聚合为不含正文的稳定 inbox 通知；私聊和包含结构化 `@bot` 的群批次使用 `priority=high`，其余群批次使用 `priority=normal`。
- NapCat `group_upload` notice 也进入对应群 mailbox：用 notice 稳定字段生成负数 synthetic messageId 以便落库去重，`inbox.replyable=false` 明确禁止把它当 QQ 消息号引用回复；文件二进制仍走 Media handle。
- 启动 replay 必须等待首次 NapCat backfill 的所有允许来源尝试完成，并显式接收本次运行允许的 group IDs。单来源失败可以记录后继续；live/backfill/replay 的重叠只通过 message row ID 去重，不能靠时序猜测。
- 无持久 snapshot 且启动事件队列为空时，runtime 必须注入一次字节稳定的 `bootstrap` 事件来建立首个 `AgentContext` 和 snapshot；启动期间已有实时事件时不得额外注入。单纯存在一条空 snapshot 记录不能替代该启动事实。
- mailbox 是 `messages` 按 scene 划分的逻辑视图，不复制消息正文。Agent 用有界 `inbox` tool result 按需读取。
- 普通 mailbox 通知会按持久化新鲜度元数据条件性增加 `readArgs.contextBefore`：距同来源上一条消息至少 2 小时时轻量补 1 条；跨过 compaction、累计相隔至少 30 个 LLM round、或 input context 增长至少 128000 tokens 时补 8 条。补偿只读同一 mailbox 且在 `inbox` 结果中单列为 `previousMessages`，不扫描或猜测消息文本。
- 跨源知识共享是预期行为。跨源发言仍然依赖显式 `send_message` target，以及 ingress/tool 安全规则。
- curiosity tick、background task 完成等运行时事件如果进入 LLM，必须走稳定的结构化事件渲染或 tool-result 路径。事件载荷只包含受控字段，不拼接面向人的临时提示语。
- 表情包池在 compaction 后以有界 JSON user message 注入，图片引用统一使用 `media:N`。该消息一旦 append 就属于 snapshot ledger；replay 不得重新查询表情池生成它。

## 代码地图

- `src/agent/agent-context.ts`：内存中的 context 操作。
- `src/agent/snapshot-repo.ts`：`bot_agent_snapshot` 持久化。
- `src/agent/runtime.ts`：Agent runtime 装配边界，把已恢复的 context 接到 deferred tools、system prompt 和 `BotLoopAgent`。
- `src/agent/working-context.ts`：从 durable ledger 构造单次 LLM 可见投影并输出 hygiene 统计；这是可重建视图，不是新的持久状态。
- `src/agent/bot-loop-agent.ts`：Runtime Host，负责事件披露、mailbox cursors、snapshot 原子保存、life journal hook、compaction 和循环控制。
- `src/agent/react-kernel.ts`：一轮 ReAct transcript append 边界；只把 `ToolExecutionResult.content` 写入 `AgentContext`，`outcome` / `effects` 返回 Runtime Host。
- `src/agent/effect-interpreter.ts`：解释工具声明的 runtime effects，并集中执行合法性判断。
- `src/agent/compaction.ts`：基于摘要的历史 compaction。
- `src/agent/render-event.ts`：确定性的 event-to-user-message 渲染。
- `src/agent/mailbox.ts`：来源 key、direct/ambient 分类、通知渲染和 cursor 推进。
- `src/agent/replay-missed.ts`：启动恢复关机期间漏掉的入站事实。
- `prisma/schema.prisma`：持久数据库契约。

## 检查清单

- 这个改动会改变已经 append 的 message 字节吗？
- 它会把动态状态加进 system prompt 吗？
- 它会从可变表或日志重建 prompt history 吗？
- 它会在 compaction 时切开 tool-call 和 tool-result 对吗？
- 它会把大块外部内容塞进主 context，而不是有边界的 tool result 或摘要吗？
