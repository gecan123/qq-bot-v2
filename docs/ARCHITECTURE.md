# 架构

`qq-bot-v2` 是一个接入 NapCat 的 QQ Agent。群聊和私聊入站消息先写入 Postgres，再由 `BotLoopAgent` 披露给单一持久化 `AgentContext`：所有 QQ 消息按群或联系人进入 mailbox 通知，正文由 Agent 按需读取；私聊和包含 `@bot` 的群批次标记为高优先级。

这是实验性新项目。除非任务明确要求历史兼容或迁移保留，否则优先选择干净的目标模型，不要为了旧 adapter、dual-write bridge 或长期兼容层牺牲架构。

## 核心流程

1. `src/index.ts` 加载 config，连接 Prisma，注册媒体 provider，创建 agent LLM client，恢复 `BotAgentSnapshot`，并启动 event queue。
2. `src/bot/**` 接收 NapCat 事件，并通过 `src/database/messages.ts` 写入入站事实。
3. ready 后的消息被投递为 `BotEvent`。
4. `src/agent/mailbox.ts` 把所有 QQ 消息按来源聚合为不含正文的确定性通知，并计算批次级 `priority=high|normal`；非 QQ 运行时事件仍走稳定 direct 渲染。
5. `src/agent/bot-loop-agent.ts` append 披露结果、调用 LLM、执行 tool calls、append tool results，并把 context snapshot 与 mailbox cursors 同行持久化后运行 compaction。

## 持久边界

- `messages` 是入站事实账本，不是 LLM ledger。
- `bot_agent_snapshot.context_snapshot` 是持久化的 LLM 可见上下文；`mailbox_cursors` 是与它原子保存的 per-source 披露进度。
- `logs/*.ndjson` 是运维日志，不能成为 replay 输入。
- `data/agent-workspace/` 是 bot 生产的 workspace 数据，不是项目源码。
- 当前范围主要是 bot/backend。不要假设一定存在 admin WebUI。
- 如果以后重新出现 `apps/admin-web/**`，且任务明确涉及它，先读它自己的局部指令，并把修改限制在对应范围。
- 做 bot/backend 任务时，不要读或改无关的 UI/admin 面。

## 主要模块

- `src/agent/**`：永续上下文、主循环、LLM client routing、工具、replay、compaction 和 token stats。
- `src/bot/**`：NapCat 解析和 message readiness。
- `src/media/**`：媒体缓存、描述、image handles、outbound promotion。
- `src/messaging/**`：发送路径和 NapCat segment 构造。
- `src/database/**`：Prisma 访问、入站消息存储、agent SQL helper。
- `src/browser/**`：browser sidecar protocol 和 action logging。
- `src/ops/**`：运维日志和仓库检查。
