# 架构

`qq-bot-v2` 是一个接入 NapCat 的 QQ Agent。群聊和私聊入站消息先写入 Postgres，再由 `BotLoopAgent` 披露给单一持久化 `AgentContext`：所有 QQ 消息按群或联系人进入 mailbox 通知，正文由 Agent 按需读取；私聊和包含 `@bot` 的群批次标记为高优先级。

这是实验性新项目。除非任务明确要求历史兼容或迁移保留，否则优先选择干净的目标模型，不要为了旧 adapter、dual-write bridge 或长期兼容层牺牲架构。

## 核心流程

1. `src/index.ts` 加载 config、连接 Prisma、执行 message/media retention、注册媒体 provider，创建 agent LLM client，恢复 `BotAgentSnapshot`，并启动 event queue。
2. NapCat handlers 注册后先连接 ingress。实时消息立即走 message-row dedup queue；首次群历史 backfill 通过 `initialBackfillDone` barrier 等待所有来源尝试完成后，才执行 missed-message replay。单群失败只记录 source-level error，其余来源继续；重连 backfill 继续串行执行，但不重新阻塞已经启动的 Agent。
3. `src/bot/**` 接收 NapCat 事件，并通过 `src/database/messages.ts` 写入入站事实；ready 后的消息被投递为 `BotEvent`。
4. `src/agent/mailbox.ts` 把所有 QQ 消息按来源聚合为不含正文的确定性通知，并计算批次级 `priority=high|normal`；非 QQ 运行时事件仍走稳定 direct 渲染。
5. `src/agent/runtime.ts` 把已恢复的 context、tools、system prompt 和 `BotLoopAgent` 装配成运行时。
6. `src/agent/bot-loop-agent.ts` 是 Runtime Host：负责事件披露、mailbox cursors、Goal revision、context snapshot 原子保存、有界 life journal hook、compaction，以及 pause/autonomy 循环控制。active Goal 是处理完高优先注意事件后的默认主线；compaction 后会重新注入 Goal continuation 并立即保存 snapshot。
7. `src/agent/react-kernel.ts` 只处理一轮通用 ReAct：把 system prompt、从 durable `messages` 确定性构造的 working-context projection 和可见 tools 发给 LLM，append assistant tool calls；仅连续且显式只读的 tool calls 可以并行，副作用和未知调用都是 barrier，tool results 严格按原 tool-call 顺序 append。只有 `ToolExecutionResult.content` 进入 ledger；工具的 `outcome` / `effects` 返回 Runtime Host，由 `src/agent/effect-interpreter.ts` 统一解释。

Agent runtime 的非关键后台工作统一走共享 bounded task scheduler：`maintenance=1`、`network=3`、`media-description=2`、`delegate=2`。同一 `resourceKey` 串行，相同 `dedupeKey` 共享任务。它们是 Node async worker，不是 OS 线程；ingress 媒体描述另走独立 `jobQueue`，Browser sidecar 也是独立进程并使用自己的单 worker housekeeping scheduler。

Goal 不创建第二个主 Agent。主前台仍只有一个串行 `BotLoopAgent` / `AgentContext`；私聊、`@bot` 和审批等高优先事件可以在轮次边界临时打断，处理后回到 Goal。只有现有 `background_task`、`delegate` 和 bounded scheduler lane 可以并发：用户可见的后台任务和 delegate 通过完成事件回到单一主 ledger，Memory maintenance、Life review 和 housekeeping 只更新 side-data 或日志，不进入 ledger。没有未完成 Goal 时，Agent 可以直接创建 `origin=self` 的持久目标；owner 私聊创建的 Goal 可以抢占它，旧 goalId 的迟到调用会被拒绝。

## 自主循环

- `send_message` 成功只是完成一个动作，不再强制 BotLoop 等待外部事件；下一轮由 Agent 自己决定继续做事或休息。
- `pause action=rest` 是短休息安全阀，时长 30–300 秒。首次请求使用 `confirmed=false`；Life Journal idle picker 优先从最近 durable context 找到具体锚点，再以 Agenda、近期 Journal 或愿望为后备。完整候选作为结构化 `idleThought` 随 `alternative_available` tool result 写入 ledger，不产生 pause effect，也不在 replay 时重算；它是可接受或放过的自主联想，不是任务。只有 picker 成功返回无念头时首次请求才直接休息；超时、provider 错误或不完整结果返回 `alternative_check_unavailable`，不产生 pause effect。模型看过候选后仍想休息，才以 `confirmed=true` 再次调用。醒后计划只保留一个 `primaryDirection` 和一个不同的 `alternativeDirection`；等待消息、机械盯行情和泛化维护不是方向，未来时点检查应使用 `schedule`。真正计时结束后自动继续；私聊、`@bot`、后台任务完成和停止信号可提前打断，Runtime 会在注意事件后用不复制具体方向的固定 reminder 提醒处理完再回看最近 `resumePlan`。
- runtime 对未主动休息的连续轮次和每日 token 使用设置保护性冷却。保护状态不进入 `AgentContext`，不参与 replay。
- `curiosity_tick` 只保留为人工调试入口，不是生产自主循环的驱动器。
- mailbox 和后台任务等运行时事件使用稳定 JSON 披露；外部内容、表情包和命令结果也使用有界结构化载荷。自然语言只存在于明确字段中，不能承担循环控制或成功状态判断。

## 持久边界

- `messages` 是入站事实账本，不是 LLM ledger。
- `bot_agent_snapshot.context_snapshot` 持久化 `AgentContext` 形态：`messages` 是 LLM 可见 ledger，`activeToolCapabilities` 是不进入 `messages` 的 deferred-tool 运行控制状态。
- `mailbox_cursors`、`mailbox_continuity`、`goal_revision` 和 legacy recovery boundary `last_wake_at` 是 row-level 运行控制状态，与 `context_snapshot` 原子保存。
- 长期 side-data 分为 `memory`、Notebook、Life Journal 和 Agenda，全部按需披露且不参与 replay；完整分层、写入路由和维护流程见 `docs/MEMORY_ARCHITECTURE.md`。
- `bot_agent_goal` 是单一持久 Goal 状态，不是第二份 LLM 历史。`origin=owner|self`、动机、完成标准、预算、token/time/round 使用量、blocker 和完成证据在这里持久化；状态变化通过 revision 事件进入 ledger。blocker 连续性使用 Goal 自己的持久 round，而不是进程重启会归零的 BotLoop round。self Goal 默认 1,000,000 tokens、单个上限 10,000,000；60 秒冷却和每滚动 24 小时 64 个仅作为失控保险丝。
- `logs/*.ndjson` 是运维日志，不能成为 replay 输入。
- `data/agent-workspace/` 是 bot 生产的 workspace 数据，不是项目源码。
- 当前范围主要是 bot/backend。不要假设一定存在 admin WebUI。
- 如果以后重新出现 `apps/admin-web/**`，且任务明确涉及它，先读它自己的局部指令，并把修改限制在对应范围。
- 做 bot/backend 任务时，不要读或改无关的 UI/admin 面。

## 生命周期边界

- 启动恢复顺序固定为 `connect -> initial backfill barrier -> metadata -> replay -> runtime`。replay 的允许群列表显式注入，不能从可变全局 config 隐式读取。
- `SIGINT` / `SIGTERM` 触发同一个幂等 shutdown coordinator：断开 ingress、停止并等待 Agent、drain backfill、停止 jobs、保存最终 snapshot，最后断开数据库。
- shutdown 各阶段 best-effort 且有超时；前一阶段失败不会阻止后续清理，Prisma disconnect 始终最后执行。

## 主要模块

- `src/agent/bot-loop-agent.ts`：Runtime Host，负责披露、持久化、compaction、life journal hook 和 pause/autonomy 控制。
- `src/agent/runtime.ts`：Agent runtime 装配边界，负责创建 target policy、task registry、deferred tool executor、system prompt 和 `BotLoopAgent`。
- `src/agent/react-kernel.ts`：单轮 ReAct transcript append 边界，负责 LLM call、assistant tool calls 和 tool result content。
- `src/agent/**`：永续上下文、LLM client routing、工具、replay、compaction 和 token stats。
- `src/bot/**`：NapCat 解析和 message readiness。
- `src/media/**`：媒体缓存、描述、image handles、outbound promotion。
- `src/messaging/**`：发送路径和 NapCat segment 构造。
- `src/database/**`：Prisma 访问、入站消息存储、agent SQL helper。
- `src/browser/**`：browser sidecar protocol 和 action logging。
- `src/ops/**`：运维日志和仓库检查。
