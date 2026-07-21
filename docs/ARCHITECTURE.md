# 架构

`qq-bot-v2` 是一个接入 NapCat 的 QQ Agent。群聊和私聊入站消息先写入 Postgres 事实账本；只有私聊和包含 `@bot` 的群消息会唤醒或打断单一串行 `BotLoopAgent`，普通群消息留在被动 inbox，等待 Agent 自主读取。正文默认由 Agent 通过 `inbox` 按需读取。

这是实验性新项目。除非任务明确要求历史兼容或迁移保留，否则优先选择干净的目标模型，不为旧 adapter、dual-write bridge 或旧 snapshot 增加长期兼容层。生产级高可用、长期稳定运行和自动故障恢复也不是默认目标；没有用户要求或可测量真实痛点时，不为假设性故障提前增加 HA、failover、跨重启自动续跑、复杂重试/对账或运维平台。正确性、确定性 replay、明确失败状态和外部副作用安全边界仍然必须保持。

## 核心流程

1. `src/index.ts` 加载 config、连接 Prisma、执行 message/media retention，并创建 ledger repository、loader、LLM client 和 event queue。
2. 启动恢复只从 `bot_agent_ledger_entries` 加载 canonical history，并校验 `bot_agent_runtime_state`。可丢弃的 `bot_agent_checkpoint` 只有完全匹配时才用于加速；missing、stale 或 corrupt 都从 canonical ledger 重建。
3. NapCat handlers 先连接 ingress。首次群历史 backfill 通过 barrier 等待所有来源尝试完成，再执行 missed-message replay；单群失败只记录 source-level error。实时和 replay 消息使用相同 message-row dedup gate。
4. `src/bot/**` 把 NapCat 事件写入 `messages` / `media`；`src/agent/mailbox.ts` 再按来源聚合成不含正文的确定性通知。
5. `src/agent/runtime.ts` 装配 context projection、tools、system prompt 和 `BotLoopAgent`。主 Agent 始终只有一个，轮次边界按高优先 QQ、scheduled wake、active Goal、普通环境事件的顺序披露。
6. `src/agent/bot-loop-agent.ts` 是 Runtime Host：负责受控 append、runtime cursor/continuity/Goal revision/capability/QQ focus 原子更新、compaction、life journal hook 和 pause/autonomy 控制。事务成功后才推进内存 `AgentContext`。
7. `src/agent/react-kernel.ts` 只处理一轮通用 ReAct。连续且显式只读的 tool calls 可以并行，副作用和未知调用是 barrier；tool results 始终按 assistant tool-call 顺序成组 append。只有 `ToolExecutionResult.content` 进入 ledger，`outcome` / `effects` 由 Runtime Host 解释。

专用后台工作统一走 bounded task scheduler：`maintenance=1`、`network=3`、`media-description=2`。同一 `resourceKey` 串行，相同 `dedupeKey` 共享任务。这些有明确类型和边界的 Node async worker 不是新的主 Agent；完成结果回到同一主 ledger。ingress 媒体描述使用独立 `jobQueue`，Browser sidecar 是独立进程。项目当前接受进程重启中断在途后台任务：遗留 `running` 明确转成 `interrupted`，不建设通用 `jobKind + payload` 自动恢复层；只有重启丢失昂贵长任务形成可测量痛点，或外部服务原生提供可恢复 task/session ID 时再重新评估。

短期调度由进程内 `ScheduleRuntime` 管理。它把 active 状态原子写入 `schedules.json`，把已触发正文写入独立 occurrence store；到期只向现有 event queue 注入内部 `scheduled_wake`，由单一 `BotLoopAgent` 转成不含 intention 的 `notification`，Agent 按需调用 `schedule get_occurrence` 打开。

Goal 也不创建第二个主 Agent。`bot_agent_goal` 只保存控制状态；状态变化通过 revision 事件进入 ledger。owner Goal 可以抢占 self Goal，旧 goalId 的迟到调用会被拒绝。

## 本机 WebAdmin

`apps/admin-web` 是独立的 TanStack Start Node 应用，不参与 bot 启动、ingress 或主 Agent 调度。“现在”首页结合当前 Goal/commitment、已完成工具审计和 `logs/agent-activity.json`，直接解释 Agent 的唤醒原因、实时 phase、当前工具、等待条件与最近进展；Context/Ledger、原始事件、生命状态、Memory、QQ、指标和健康页保留为只读技术下钻。

观察数据流固定为：

```text
Browser → TanStack Start Server Function → read service → PostgreSQL / bounded local observation files
```

管理操作使用独立边界：

```text
Browser → validated Server Function → operation service
        → Bot-stopped guard → typed src/ops mutation
        → local run state / audit log
```

浏览器只消费经过 Zod 校验的 DTO；BigInt 转十进制字符串，Date 转 ISO 8601。Prisma、环境变量和数据库连接只存在于 server-only 模块，client bundle 有静态边界检查和构建产物秘密扫描。观察 feature 全部只读；唯一写入口是 `features/operations/operations.server.ts` 对 reset、Memory v2、Memory canonicalization 和长期状态中文迁移四种强类型服务的调用。浏览器不能提交命令、脚本参数、SQL、工作目录或文件路径。

每次写操作先生成短期预览和 SHA-256 指纹，要求 operator 输入服务端确认短语；执行前重新检查 Bot 已停止、重建预览并核对指纹。同一时刻最多一个任务。run state 原子写入 `logs/admin-operation-state.json`，transition 审计追加到 `logs/admin-operations.ndjson`；WebAdmin 重启时旧 `running` 记录转为 `interrupted`，不会盲目续跑。三种迁移使用底层自动备份，reset 没有自动恢复路径；WebAdmin 不会停止或重启 Bot。

WebAdmin 的查询结果、TanStack Query cache 和页面状态都不是 replay source，不能用来重建 `AgentContext`。它默认绑定 `127.0.0.1:20030`；当前没有管理员鉴权，不得直接暴露到非可信网络。

`logs/agent-activity.json` 是 Bot Runtime best-effort 原子更新的可丢弃实时观察面。它只保存进程 phase、结构化唤醒原因、等待条件、并发工具和最近完成工具，不进入 canonical ledger 或 runtime singleton；缺失、损坏、PID 不匹配或写入失败都不能改变 Agent 行为，WebAdmin 必须明确降级为“实时状态不可用”。首页的最近工具进展和 24 小时工具统计读取 `logs/tool-calls.ndjson`，按文件元数据缓存解析结果；它们只反映当前 `BOT_TOOL_AUDIT_MODE` 覆盖的调用，不能从 `agent_tool_calls` 旧表补齐或用于 replay。

## 永续上下文与压缩

- `bot_agent_ledger_entries` 是唯一持久 LLM history source；`AgentContext` 只是其当前内存 projection。
- 普通历史 append `message` entry。compaction 不更新或删除旧 prefix，只 append `compaction` entry，并由 projection 解释最新 boundary。
- compaction 保持 assistant tool call/result 原子组；cut point 允许在合法 assistant boundary 做 split-turn。summary、受控机器状态和 tail 组成的 candidate 必须整体通过校验。
- Claude 主请求会预热同一原子 cut 上的 provider-only cache breakpoint；普通 Claude compaction 复用主 system、tools 和原始 prefix 后追加可信 control message。OpenAI 与 Claude split-turn fallback 仍走隔离 summarizer 请求；缓存从不成为 replay 或事实来源。
- 自动压缩由动态 token threshold 触发；provider context overflow 每轮最多强制 compact-and-retry 一次；owner friend-private `/compact [focus]` 可手动触发。
- summarizer 和 hook 在事务外执行，最终用 expected head 做 CAS。head race 会基于新 head 重算一次；失败不会改变 canonical history。
- checkpoint 只是可重建 projection cache，runtime state 只保存控制元数据，两者都不能重建 transcript。
- canonical 图片只保存稳定 `image_ref`，请求前才解析近期图片。媒体失效时投影确定性 unavailable marker，不改变旧 ledger。

完整 replay、compaction、图片和 mailbox 不变量见 `docs/AGENT_CONTEXT.md`。

## 自主循环

- `send_message` 成功只是完成一个动作，不强制立即等待。正文留下后续工作时，`work=goal_progress` 必须绑定当前 active Goal/currentCommitment；mailbox 在成功回复后仍可关闭防重，Goal 独立保留行动锚点。刚收到注意事件、存在 active Goal，或模型只输出了不会执行的普通文本时，无工具结束会立即纠错一次；连续第二次等待 60 秒。自由空闲或无进展工具轮从 15 分钟开始指数退避，最多 4 小时；新的注意事件或真实工具进展会复位退避。
- Notebook、topic Memory 或后台任务明确产出新成果后，Runtime 可追加一次 `share_checkpoint`，列出启动时冻结的 active 群短定位。它只要求 Agent 判断一次是否适合分享，不自动发送、不改变 QQ focus/发送授权或普通群消息的免唤醒规则；同一成果键永久去重，同主题两小时内不连续追加。
- provider-confirmed 外发到有 pending 通知的同 target mailbox 后，Runtime 在 tool result 闭合后原子 append `mailbox_handled` 与 runtime cursor，避免把已经处理的旧行再次视为新请求。
- `pause action=rest` 是 30–600 秒短休息安全阀。没有真实牵引力时应直接以无工具轮结束活动并进入 runtime 有界等待；只有此刻确实选择短暂休息才调用 `pause`，调用后立即计时，不再同步请求额外 LLM。计时可被注意事件、后台任务完成或停止信号打断。
- 连续自主行动不设轮次上限，不会因为工作轮数达到固定值而强制冷却。空闲、无进展和工具明确请求等待时仍使用进程内有界等待，它们不进入 ledger。工具用 `outcome.progress` 报告是否获得新事实或改变状态，用 `continuation=immediate|wait_attention|wait_event|backoff|stop` 独立表达下一轮调度：`wait_event` 表示已有真实后台工作，等待完成事件时不受 pending 请求的一分钟纠错节奏驱动，也会重置连续行动计数；可丢弃的 `continuationDetail` 只用于实时活动说明。`noveltyKey` 抑制进程内重复披露，`retryClass=immediate|after_event|backoff|terminal` 只描述失败重试。可立即纠正的失败仍只允许三轮紧密重试，之后回到普通无进展调度，但不终止自主活动。`curiosity_tick` 只保留为人工调试入口。
- 循环控制使用稳定结构化载荷，不能依赖自由文本判断成功或状态。

## 持久边界

- `messages` / `media` 是入站事实账本，只用于 missed replay、搜索、审计和按需读取，不是 prompt history。
- `bot_agent_ledger_entries` 保存 append-only LLM history；`bot_agent_runtime_state` 保存通知披露 cursor、inbox 已读 cursor、continuity、Goal revision、active capabilities、QQ 当前会话 focus、last wake 和 ledger head；`bot_agent_checkpoint` 只缓存已验证 projection。
- QQ 新消息不会隐式切换 focus。Agent 必须先通过 `qq_conversation open` 显式打开允许的群或好友，`send_message` 才能向当前 focus 发送；focus 不从 transcript、memory 或日志重建。
- `prompts/groups.md` 是群监听范围、主动发送权限、参与档位和 operator 固定群提示的唯一配置源。启动时严格解析并冻结；`mentions` 只允许结构化 @ reply，其普通消息不生成 notification；`selective` / `active` 的普通消息可聚合为 `delivery=passive` 的 QQ notification，但不唤醒、不打断休息，正文仍必须用 inbox 按需读取。档位不扩大发送授权。active 群可用一行稳定 `resident-hint` 进入常驻 source list，作为成果分享候选；完整风格正文仍只由 `chat_style` 按需读取，会变化的群文化与历史写 group memory。
- `bot_agent_goal`、Memory、Notebook、Life Journal、Agenda、调度文件和 `logs/*` 都是 side state，不能作为 transcript replay 来源。
- QQ provider 已确认发送和本地数据库之间没有分布式事务，因此 `mailbox_handled` 是 durable 防重复边界，不承诺外部发送 exactly-once。
- compaction、append 与 runtime 元数据使用数据库事务；checkpoint 刷新和 `afterCompact` 是 best-effort，不回滚已提交历史。
- `data/agent-workspace/` 是 bot 生产的 workspace 数据，不是项目源码。

不实现 pi 风格 session tree。QQ 外发、mailbox cursor、Goal revision 和工具副作用必须共享一条可审计的线性时间线，否则“哪条分支已发送、已处理”没有唯一答案。需要并行时使用有明确类型和边界的 background task，并把结果汇回主 ledger。

## 生命周期边界

- 启动顺序固定为 `connect -> initial backfill barrier -> metadata -> replay -> runtime`。replay 的允许群列表显式注入，不能从可变全局 config 隐式读取。
- clean cutover 不迁移旧 `BotAgentSnapshot`；部署 schema 后使用显式 reset 命令初始化空 ledger/runtime，再启动新版本。
- `SIGINT` / `SIGTERM` 触发同一个幂等 shutdown coordinator：断开 ingress、中止未提交 compaction、停止并等待 Agent、drain backfill、停止 jobs、同步最终 Goal/runtime 状态，最后断开数据库。
- shutdown 各阶段 best-effort 且有超时；前一阶段失败不会阻止后续清理，Prisma disconnect 始终最后执行。

## 主要模块

- `src/agent/agent-ledger-repo.ts`：append、CAS compaction、runtime 原子更新和 checkpoint I/O。
- `src/agent/agent-ledger-projection.ts`：canonical 校验与确定性 projection。
- `src/agent/agent-ledger-loader.ts`：checkpoint 分类、rebuild 和安装输入。
- `src/agent/bot-loop-agent.ts`：Runtime Host、事务边界、trigger、失败恢复和自主循环。
- `src/agent/react-kernel.ts`：单轮 ReAct、tool call/result 顺序和结果边界。
- `src/agent/compaction*.ts`：token cut、serialization、hooks、candidate 和 summary 校验。
- `src/agent/working-context.ts`、`src/media/agent-image-ref.ts`：请求投影与稳定图片引用。
- `src/agent/compaction-control.ts`：owner `/compact` 身份、startup/live gate 和去重。
- `src/agent/mailbox.ts`、`src/agent/mailbox-handled.ts`：入站通知和 durable handled boundary。
- `src/agent/tools/**`：受控工具；注册表以 `src/agent/tools/index.ts` 为准。
- `src/bot/**`、`src/messaging/**`、`src/media/**`：NapCat ingress、发送和媒体路径。
- `src/database/**`、`src/ops/**`：数据库 helper、运维日志和只读检查。
- `apps/admin-web/**`：TanStack Start 本机管理面；观察 feature 只读，operations feature 通过固定 DTO、single-flight runner 和本地审计调用强类型 `src/ops` 服务；`*.functions.ts` 暴露 RPC wrapper，`*.server.ts` 保留 Prisma/env/文件 helper。
