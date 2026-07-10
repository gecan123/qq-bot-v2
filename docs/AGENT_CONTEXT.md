# 永续 Agent Context

项目产品契约是稳定、可 replay、低成本扩展的 LLM 历史。Prompt cache 稳定性是一等产品能力。

## 不变量

- `AgentContext` 是 LLM ledger。运行时形态和持久化 snapshot 形态必须一致。新的 LLM 可见事实只能通过 append 或受控 compaction 进入，不能从 side table 重建历史。
- `BotAgentSnapshot.mailboxCursors` 是每个 QQ 来源已披露 message row 的高水位。它必须和 `contextSnapshot` 同行保存，不能先推进游标再单独保存上下文。
- `BotAgentSnapshot.contextSnapshot` 是持久化运行时形态。schema 由 `src/agent/agent-context.types.ts` 定义。`messages` 是 LLM 可见 ledger；`activeToolCapabilities` 是 deferred tools 的运行控制状态，必须随 snapshot 持久化/恢复，但不作为 LLM 可见事实注入 messages。
- `messages` 是入站事实账本。它服务于搜索、媒体解析、审计和 replay recovery，但不能替代 snapshot。
- Message scene 不变量：`sceneKind='qq_group'` 时 `groupId` 非空且 `sceneExternalId=''`；`sceneKind='qq_private'` 时 `groupId=null` 且 `sceneExternalId=String(peerId)`。
- late media 和 side table 更新不得改写已经 append 的 message。
- compaction 是正常情况下会破坏性改写 prefix 的路径。它必须保持 assistant tool call 和对应 tool result 的原子性。
- safe cut 之前除已有摘要外的完整 prefix 都必须进入 summarizer，不能按比例静默丢弃头部消息；图片和过期 native thinking 只能按既定有界规则降级。
- compaction 只改写 `messages`，不得隐式丢弃或重建 `activeToolCapabilities`。
- compaction 改写以及随后可能发生的 sticker-pool 注入完成后必须立即保存 snapshot，不能依赖下一轮顺带持久化。
- system prompt 字节和 tool description 会影响 cache identity。修改时要有意、集中处理。
- replay 必须确定性。同样输入下，snapshot message 字节应当跨运行稳定。
- 大块外部内容必须通过有边界的 tool result、摘要或受控文件路径进入。raw pages、feeds、长文件和可变日志不能直接注入主 context。
- `ToolExecutionResult.content` 是唯一进入 `AgentContext` 的工具结果。`outcome` 和 `effects` 只服务当前运行时的日志、分支和 EffectInterpreter，不得 append、持久化或用于 replay 重建。
- 可供下一轮机器判断的 tool result 使用稳定 JSON；截断必须发生在字段或数组条目层，并用显式标记披露，不能直接切断序列化后的 JSON。
- generated image bytes 可以放在 `OutboundCache` 或 artifact 路径里，压缩 preview 可以进入 context。preview 压缩失败时，降级为稳定文本结果。
- 图片 handle 遵循共享 schema：吃图工具接受 `{mediaId}` 或 `{ephemeralRef}`；发送链路使用 `media:N` 或 `ephemeral:<64-hex>` 这类字符串 ref。
- `logs/*.ndjson` 是运维日志，不是 Prisma 事实，也不是 prompt replay 来源。

## 运行模型

- bot 在允许来源之间共享一个 owned `AgentContext`。
- 新事件源必须通过 event queue 和 dedup 路径进入披露规划，不要插入历史中段。所有 QQ 消息按 `groupId` 或 `peerId` 聚合为不含正文的稳定 inbox 通知；私聊和包含结构化 `@bot` 的群批次使用 `priority=high`，其余群批次使用 `priority=normal`。
- 启动 replay 必须等待首次 NapCat backfill 的所有允许来源尝试完成，并显式接收本次运行允许的 group IDs。单来源失败可以记录后继续；live/backfill/replay 的重叠只通过 message row ID 去重，不能靠时序猜测。
- mailbox 是 `messages` 按 scene 划分的逻辑视图，不复制消息正文。Agent 用有界 `inbox` tool result 按需读取。
- 跨源知识共享是预期行为。跨源发言仍然依赖显式 `send_message` target，以及 ingress/tool 安全规则。
- curiosity tick、background task 完成等运行时事件如果进入 LLM，必须走稳定的结构化事件渲染或 tool-result 路径。事件载荷只包含受控字段，不拼接面向人的临时提示语。
- 表情包池在 compaction 后以有界 JSON user message 注入，图片引用统一使用 `media:N`。该消息一旦 append 就属于 snapshot ledger；replay 不得重新查询表情池生成它。

## 代码地图

- `src/agent/agent-context.ts`：内存中的 context 操作。
- `src/agent/snapshot-repo.ts`：`bot_agent_snapshot` 持久化。
- `src/agent/runtime.ts`：Agent runtime 装配边界，把已恢复的 context 接到 deferred tools、system prompt 和 `BotLoopAgent`。
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
