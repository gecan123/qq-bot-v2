---
name: replay_safety
description: 修改 AgentContext、mailbox、snapshot、compaction、render-event、system prompt、tool result 或图片 handle 契约前使用
---

# Replay 安全

replay 必须确定性。同样输入下，snapshot message 字节应跨运行稳定。

核心不变量:

- `AgentContext` 是 LLM ledger，运行时形态和持久化 snapshot 形态必须一致。
- `messages` 是入站事实账本，不是 LLM ledger。
- `mailboxCursors` 必须和 `contextSnapshot` 同行保存。
- `activeToolCapabilities` 随 snapshot 持久化/恢复，但不作为 LLM 可见事实注入 messages。
- `logs/*.ndjson` 不能作为 replay 输入。

禁止做:

- 从可变 side table、数据库派生表或运维日志重建 prompt history。
- 在已经 append 的 message 中补写 late media 或动态状态。
- 在 compaction 时切开 assistant tool call 和对应 tool result。
- 把动态时间、计数器、运行时统计拼进 system prompt。
- 用自然语言拼接代替稳定 JSON，让后续程序反解析。

修改前检查:

1. 是否会改变已经 append 的 message 字节？
2. 是否会改变 system prompt 或 tool description，从而影响 cache identity？
3. 是否会把大块或可变外部内容放进主 context？
4. 是否会让 tool `outcome` / `effects` 进入 ledger？
5. 是否会改变图片 handle、media ref 或 tool result schema？

验证:

- 优先跑 context、render-event、mailbox、compaction、tool schema 相关 focused tests。
- 修改 schema 后运行 `pnpm db:generate`。
- 影响面大时再跑 `pnpm typecheck` 和 `pnpm repo-check`。
