# 永续 Agent Context

项目产品契约是稳定、可 replay、低成本扩展的 LLM 历史。Prompt cache 稳定性是一等产品能力。

## 不变量

- `AgentContext` 是 LLM ledger。运行时形态和持久化 snapshot 形态必须一致。新的 LLM 可见事实只能通过 append 或受控 compaction 进入，不能从 side table 重建历史。
- `BotAgentSnapshot.contextSnapshot` 是持久化运行时形态。schema 由 `src/agent/agent-context.types.ts` 定义。
- `messages` 是入站事实账本。它服务于搜索、媒体解析、审计和 replay recovery，但不能替代 snapshot。
- Message scene 不变量：`sceneKind='qq_group'` 时 `groupId` 非空且 `sceneExternalId=''`；`sceneKind='qq_private'` 时 `groupId=null` 且 `sceneExternalId=String(peerId)`。
- late media 和 side table 更新不得改写已经 append 的 message。
- compaction 是正常情况下会破坏性改写 prefix 的路径。它必须保持 assistant tool call 和对应 tool result 的原子性。
- system prompt 字节和 tool description 会影响 cache identity。修改时要有意、集中处理。
- replay 必须确定性。同样输入下，snapshot message 字节应当跨运行稳定。
- 大块外部内容必须通过有边界的 tool result、摘要或受控文件路径进入。raw pages、feeds、长文件和可变日志不能直接注入主 context。
- generated image bytes 可以放在 `OutboundCache` 或 artifact 路径里，压缩 preview 可以进入 context。preview 压缩失败时，降级为稳定文本结果。
- 图片 handle 遵循共享 schema：吃图工具接受 `{mediaId}` 或 `{ephemeralRef}`；发送链路使用 `media:N` 或 `ephemeral:<64-hex>` 这类字符串 ref。
- `logs/*.ndjson` 是运维日志，不是 Prisma 事实，也不是 prompt replay 来源。

## 运行模型

- bot 在允许来源之间共享一个 owned `AgentContext`。
- 新事件源必须通过 event queue 和 dedup 路径渲染为确定性的 `user` message，不要插入历史中段。
- 跨源知识共享是预期行为。跨源发言仍然依赖显式 `send_message` target，以及 ingress/tool 安全规则。
- idle hint、curiosity tick、background task 完成等运行时事件如果进入 LLM，必须走稳定事件渲染或 tool-result 路径。

## 代码地图

- `src/agent/agent-context.ts`：内存中的 context 操作。
- `src/agent/snapshot-repo.ts`：`bot_agent_snapshot` 持久化。
- `src/agent/bot-loop-agent.ts`：append、LLM call、tool result、persist cycle。
- `src/agent/compaction.ts`：基于摘要的历史 compaction。
- `src/agent/render-event.ts`：确定性的 event-to-user-message 渲染。
- `src/agent/replay-missed.ts`：启动恢复关机期间漏掉的入站事实。
- `prisma/schema.prisma`：持久数据库契约。

## 检查清单

- 这个改动会改变已经 append 的 message 字节吗？
- 它会把动态状态加进 system prompt 吗？
- 它会从可变表或日志重建 prompt history 吗？
- 它会在 compaction 时切开 tool-call 和 tool-result 对吗？
- 它会把大块外部内容塞进主 context，而不是有边界的 tool result 或摘要吗？
