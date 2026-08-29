# 架构

`qq-bot-v2` 是一个同时接入 QQ 与飞书的单 Agent runtime。默认运行形态是一个平台 supervisor 管理多个边界清晰的本机进程：Agent Core、QQ Gateway、按配置启用的 Feishu Gateway、Media Worker，以及按配置启用的 Browser Controller；WebAdmin 保持业务独立，但本地开发可用 `pnpm dev:all` 交给同一 supervisor 管理生命周期。短期调度在 Agent Core 内部运行，Agent Core 与 Media Worker 直接调用配置的 LLM provider。两个平台的群聊和私聊入站事件都先写入同一套 Postgres 事实账本，再由同一个串行 `BotLoopAgent` 消费并写入唯一 canonical ledger。私聊、结构化 `@bot`、编辑和撤回可以形成 attention；普通群消息留在被动 inbox，正文默认由 Agent 通过 `inbox` 按需读取。

这是实验性新项目。除非任务明确要求历史兼容或迁移保留，否则优先选择干净的目标模型，不为旧 adapter、dual-write bridge 或旧 snapshot 增加长期兼容层。生产级高可用、长期稳定运行和自动故障恢复也不是默认目标；没有用户要求或可测量真实痛点时，不为假设性故障提前增加 HA、failover、跨重启自动续跑、复杂重试/对账或运维平台。正确性、确定性 replay、明确失败状态和外部副作用安全边界仍然必须保持。

## 核心流程

1. `src/platform.ts` 启动各服务、等待健康检查通过，再启动 `src/index.ts` 中的 Agent Core。每个进程写独立日志，supervisor 只负责本机生命周期，不承担业务路由。
2. Agent Core 先用专用 PostgreSQL session 获取 advisory lock，再连接 Prisma。启动恢复只从 `bot_agent_ledger_entries` 加载 canonical history，并校验 `bot_agent_runtime_state`。可丢弃的 `bot_agent_checkpoint` 只有完全匹配时才可复用；missing、stale 或 corrupt 都从 canonical ledger 重建。
3. QQ Gateway 独占 NapCat WebSocket、首次群历史 backfill、好友/群目录查询和 QQ 外发。按配置启用的 Feishu Gateway 独占官方 WebSocket client、飞书资源下载和飞书外发，并通过 loopback HTTP 向 Agent Core 暴露健康、已观察会话与发送边界；两个 Gateway 都不是 Agent。
4. `src/bot/**` 与 `src/services/feishu-ingress.ts` 把平台事件规范化为追加式 `messages` / `media` 事实；每次附件保留独立、稳定的 `mediaId`，物理字节通过 `media.blobId` 引用按 SHA-256 唯一的 `media_blobs`，单个飞书下载资源上限为 20MB。Agent Core 先做 missed-message replay，再由 database mailbox watcher 按递增 `rowId` 读取新事实，`src/agent/mailbox.ts` 按平台与会话聚合成不含正文的确定性通知。
5. `src/agent/runtime.ts` 装配 context projection、tools、system prompt 和 `BotLoopAgent`。QQ 与飞书始终共用一个主 Agent、一个 mailbox 调度器和一个持久 LLM ledger；轮次边界统一按 attention、scheduled wake 和普通环境事件披露。
6. `src/agent/bot-loop-agent.ts` 是唯一 Runtime Host；它把 expected-head append/增量 projection 委托给 `LedgerCommitCoordinator`，把 threshold/overflow/CAS 重算委托给 `CompactionCoordinator`，把 continue/wait/backoff/stop 决策委托给纯 `LoopPolicy`。事务成功后才推进内存 `AgentContext`。
7. `src/agent/react-kernel.ts` 只处理一轮通用 ReAct。连续且显式只读的 tool calls 可以并行，副作用和未知调用是 barrier；tool results 始终按 assistant tool-call 顺序成组 append。只有 `ToolExecutionResult.content` 进入 ledger，`outcome` / `effects` 由 Runtime Host 解释。

专用后台工作统一走有界边界。Agent Core 内部仍保留 `maintenance=1`、`network=3` 等 bounded task scheduler；全局未完成后台任务数默认最多 8 个，已登记但仍在 scheduler 中等待的任务也占额度，超限会在启动实际图片、网络或交易研究工作前明确拒绝。入站媒体描述由独立 Media Worker 处理，并把结果写回 Postgres `media` 事实行。媒体描述是可缺失的 best-effort 增强：消息渲染只读取当时已有描述，不等待、不触发生成；新图片/贴纸下载后最多自动请求一次，视频、语音和文件不自动生成描述。原始图片事实仍可保存，但预览和视觉模型路径只解码最多 4000 万像素、单边最多 8192px 的第一帧。Media Worker 不扫描历史空描述，也不自动重试失败调用。Browser Controller 继续作为独立进程。它们都不是新的主 Agent，也不能直接写 canonical ledger。项目当前接受进程重启中断在途后台任务，不建设通用 `jobKind + payload` 自动恢复层；只有重启丢失昂贵长任务形成可测量痛点，或外部服务原生提供可恢复 task/session ID 时再重新评估。

短期调度是 Agent Core 内部的持久深模块。`ScheduleRuntime` 把 active 状态原子写入 `schedules.json`，把已触发正文写入 occurrence store，并在删除 active job 前把待投递 wake 写入 delivery store；到期时直接向同进程 `EventQueue` 投递 `scheduled_wake`，由单一 `BotLoopAgent` 转成不含 intention 的 `notification`。该 notification 写入 canonical ledger 后，Runtime 才删除 pending delivery；进程重启会检查 active schedule、pending delivery 和 canonical ledger，重放尚未提交的 wake，并清理已经提交但尚未确认的 delivery。Agent 按需调用 `schedule get_occurrence` 打开正文。

Agent Core 和 Media Worker 直接使用 provider 注册表中的 URL/API Key；system prompt、tools、canonical/provider 请求构造、响应解析、token evidence 和 ledger commit 仍由各自现有 client 负责，不经过本机 LLM 转发进程。进程间只使用 PostgreSQL 事实边界和必要的薄 HTTP；当前不引入 Redis、Kafka、通用 broker 或第二套 workflow engine。

## 本机 WebAdmin

`apps/admin-web` 是独立的 TanStack Start Node 应用，不参与 ingress 或主 Agent 调度；`pnpm dev:all` 只提供一键本地生命周期管理。“现在”首页结合已完成工具审计和 `logs/agent-activity.json`，直接解释 Agent 的唤醒原因、实时 phase、当前工具、等待条件与最近进展；进程日志页只从固定的 `logs/processes/*.log` 白名单读取有界尾部，Context/Ledger、原始事件、计划、Memory、QQ、指标和健康页保留为只读技术下钻。

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

浏览器只消费经过 Zod 校验的 DTO；BigInt 转十进制字符串，Date 转 ISO 8601。Prisma、环境变量和数据库连接只存在于 server-only 模块，client bundle 有静态边界检查和构建产物秘密扫描。观察 feature 全部只读；唯一写入口是 `features/operations/operations.server.ts` 对固定 `reset_state` 服务的调用。浏览器不能提交命令、脚本参数、SQL、工作目录或文件路径。

每次 reset 先生成短期预览和 SHA-256 指纹，要求 operator 输入服务端确认短语；执行前重新检查 Bot 已停止、重建预览并核对指纹。同一时刻最多一个任务。run state 原子写入 `logs/admin-operation-state.json`，transition 审计追加到 `logs/admin-operations.ndjson`；WebAdmin 重启时旧 `running` 记录转为 `interrupted`，不会盲目续跑。reset 没有自动恢复路径，WebAdmin 也不会停止或重启 Bot。

WebAdmin 的查询结果、TanStack Query cache 和页面状态都不是 replay source，不能用来重建 `AgentContext`。它默认绑定 `127.0.0.1:20030`；当前没有管理员鉴权，不得直接暴露到非可信网络。

`logs/agent-activity.json` 是 Bot Runtime best-effort 原子更新的可丢弃实时观察面。它只保存进程 phase、结构化唤醒原因、等待条件、并发工具和最近完成工具，不进入 canonical ledger 或 runtime singleton；缺失、损坏、PID 不匹配或写入失败都不能改变 Agent 行为，WebAdmin 必须明确降级为“实时状态不可用”。首页的最近工具进展和 24 小时工具统计读取 `logs/tool-calls.ndjson`，按文件元数据缓存解析结果；它们只反映当前 `BOT_TOOL_AUDIT_MODE` 覆盖的调用，不能从 `agent_tool_calls` 旧表补齐或用于 replay。`agent_token_usage` 同时承担有保留期的逐调用 LLM 观察面：每次调用记录 callId、actor/operation、provider/model、成功/失败/取消、耗时、stop reason、token/cache，以及 canonical request、provider request、provider response、canonical response 四段结构摘要与 SHA-256 指纹。四段 evidence 不保存 prompt、response、工具参数或错误正文；WebAdmin Context 页面只读展示最近记录，它们同样不是 replay source。

## 永续上下文与压缩

- `bot_agent_ledger_entries` 是唯一持久 LLM history source；`AgentContext` 只是其当前内存 projection。
- 普通历史 append `message` entry。compaction 不更新或删除旧 prefix，只 append `compaction` entry，并由 projection 解释最新 boundary。
- compaction 保持 assistant tool call/result 原子组；cut point 允许在合法 assistant boundary 做 split-turn。summary、受控机器状态和 tail 组成的 candidate 必须整体通过校验。
- Claude 主请求会预热同一原子 cut 上的 provider-only cache breakpoint；普通 Claude compaction 复用主 system、tools 和原始 prefix 后追加可信 control message。OpenAI 与 Claude split-turn fallback 仍走隔离 summarizer 请求；缓存从不成为 replay 或事实来源。
- 自动压缩由动态 token threshold 触发；provider context overflow 每轮最多强制 compact-and-retry 一次。主 Agent 和聊天控制面不提供手动 compaction。
- summarizer 和 hook 在事务外执行，最终用 expected head 做 CAS。head race 会基于新 head 重算一次；失败不会改变 canonical history。
- 普通 commit 直接用事务返回的 appended entries/runtime state 增量安装 projection，不读取永久 prefix，也不刷新 checkpoint。checkpoint 只在启动或 compaction 后完整 canonical load 时 best-effort 刷新；runtime state 只保存控制元数据，两者都不能重建 transcript。
- canonical 图片只保存稳定 `image_ref`；请求前按 `LLM_AGENT_IMAGE_MODE` 投影：默认 `description` 复用独立媒体视觉路由已经持久化的描述，`native` 才解析真实 image block。该策略与主模型自身是否理论支持视觉解耦；媒体失效时投影确定性 unavailable marker，不改变旧 ledger。

完整 replay、compaction、图片和 mailbox 不变量见 `docs/AGENT_CONTEXT.md`。

## 自主循环

- `send_message` 成功只是完成一个动作，不强制等待。当前会话内马上续做用 `work=continue`，它只为下一轮提供进程内行动锚点；mailbox 在成功回复后仍可关闭防重。有真实进展或显式 `immediate` 牵引时继续；方向完成、后台任务已启动、显式等待或连续两轮无进展时进入事件等待。模型只输出不会执行的普通文本时，Runtime 最多追加一次受控行动纠错并重试，仍不执行那段文本；再次只输出文本则进入等待，避免纠错自循环。
- provider-confirmed 外发到有 pending 通知的同 target mailbox 后，Runtime 在 tool result 闭合后原子 append `mailbox_handled` 与 runtime cursor，避免把已经处理的旧行再次视为新请求。私聊强制 attention 只覆盖尚未由有界 inbox result 展示的 pending 行；持久已读 cursor 已追上 disclosure 时不再跨重启强迫回应，但未写 `mailbox_handled` 的范围仍可作为后来真实回复的冷却豁免。
- `rest` 是唯一的主动暂停工具。它在工具调用内部按明确的批准时长等待，记录真实理由和醒后检查点；私聊、@、后台任务完成、调度事件或停止信号会提前打断。工具用一个进程内三小时滚动窗口限制实际休息：Asia/Singapore 白天最多 60 分钟，夜间最多 120 分钟，并在 00:00 / 06:00 边界结束后重新评估；请求会被剩余额度缩短，额度不足 10 分钟时明确拒绝并技术退避。休息自然结束后进入有界自主探索，此时工具列表保持稳定，但 Runtime 会拒绝再次 `rest`；只有获得真实新证据或改变可观察状态后才解除限制。休息区间与该探索门控都不进入 runtime singleton，也不跨重启持久化。
- Runtime 不维护自动休息顾问或持久 Goal。全新空 ledger 会先 append 一条稳定的自主启动消息并立即开始第一轮；事件等待最长 30 分钟，外部事件可随时提前唤醒，超时则 append 一条 canonical `runtime_autonomy_tick`，轮换检查未完成承诺、已有产物和有界好奇探索。该轮换索引与当前探索门控只保存在进程内，不新增队列、进程或第二个 Agent。
- 连续有效自主行动不设总轮次上限，不会因为工作轮数达到固定值而强制冷却。工具用 `outcome.progress` 报告是否获得新事实或改变状态，只用 `continuation=immediate|wait_attention|wait_event|backoff|stop` 表达当前方向状态：真实进展和 `immediate` 继续，`wait_event`、`wait_attention` 与方向级 `stop` 进入上述定时事件等待，`backoff` 做有界技术退避。可丢弃的 `continuationDetail` 只用于实时活动说明，`noveltyKey` 默认抑制进程内重复披露。`continuation=immediate` 的失败最多保留三轮紧密纠错，之后改走下一行动或短暂技术退避。
- 兴趣、作品反馈和市场复盘不新增第二套持久 runtime 状态：当前上下文内直接继续，需要等待人类反馈或跨天保留过程时使用同 topic Notebook，未来时点重新评估用 Schedule，稳定乐趣与偏好才进入 self/topic Memory。换题但重复同一种生产形式也视为机械重复；分享一次只选择一个相关会话，不通过群发制造反馈。
- 本地 `crypto_paper` 的自主权限由工具 schema 和执行前限额共同约束：`decisionSource=self` 只允许 BTC/ETH/SOL，单次增仓成本最多权益 5%，单币最多权益 20%；普通证券 Moomoo 模拟订单保持用户逐次授权。所有路径仍禁止实盘、杠杆和做空。
- 循环控制使用稳定结构化载荷，不能依赖自由文本判断成功或状态。

## 持久边界

- `messages` / `media` 是入站事实账本，`media_blobs` 是可由 Media 引用和保留期 GC 管理的内容寻址物理存储；它们只用于 missed replay、搜索、审计和按需读取，不是 prompt history。
- `bot_agent_ledger_entries` 保存 append-only LLM history；`bot_agent_runtime_state` 保存通知披露 cursor、inbox 已读 cursor、continuity、平台中立 conversation focus、last wake 和 ledger head；`bot_agent_checkpoint` 只缓存已验证 projection。
- QQ 或飞书新消息都不会隐式切换 focus。Agent 必须先通过 `conversation open` 显式打开允许的群或私聊，`send_message` 才能向当前 focus 发送；focus 不从 transcript、memory 或日志重建。
- `prompts/groups.md` 是群监听范围、主动发送权限、参与档位和 operator 固定群提示的唯一配置源。启动时严格解析并冻结；`mentions` 只允许结构化 @ reply，其普通消息不生成 notification；`selective` / `active` 的普通消息可聚合为 `delivery=passive` 的 QQ notification，但不主动唤醒，正文仍必须用 inbox 按需读取。档位不扩大发送授权。active 群可用一行稳定 `resident-hint` 进入常驻 source list，作为成果分享候选；完整风格正文仍只由 `chat_style` 按需读取，会变化的群文化与历史写 group memory。
- Memory、Notebook、调度文件和 `logs/*` 都是 side state，不能作为 transcript replay 来源。
- 外部平台已确认发送和本地数据库之间没有分布式事务，因此 `mailbox_handled` 是 durable 防重复边界，不承诺外部发送 exactly-once。统一 `MessageDelivery` 使用稳定 UUID 标识一次动作，并把结果明确区分为 `sent`、`failed`、`delivery_unknown`；当前不增加 outbox、自动重试、独立 egress 进程或平台降级层。
- compaction、append 与 runtime 元数据使用数据库事务；checkpoint 刷新和 `afterCompact` 是 best-effort，不回滚已提交历史。
- `data/agent-workspace/` 是 bot 生产的 workspace 数据，不是项目源码。

不实现 pi 风格 session tree。跨平台外发、mailbox cursor 和工具副作用必须共享一条可审计的线性时间线，否则“哪条分支已发送、已处理”没有唯一答案。需要并行时使用有明确类型和边界的 background task，并把结果汇回主 ledger。

## 生命周期边界

- 平台启动顺序固定为 `sidecars -> health barrier -> Agent Core`。QQ Gateway 内部执行 `connect -> initial backfill barrier -> ready`；启用飞书时 Feishu Gateway 执行 `bot identity -> WebSocket -> ready`，当前不补拉停机期间的飞书历史。Agent Core 执行 `metadata -> replay -> database mailbox watcher -> runtime`。replay 的允许会话列表显式注入，不能从可变全局 config 隐式读取。
- clean cutover 不迁移旧 `BotAgentSnapshot`；部署 schema 后使用显式 reset 命令初始化空 ledger/runtime，再启动新版本。
- `SIGINT` / `SIGTERM` 先由 platform supervisor 向所有子进程转发。Agent Core 的幂等 shutdown coordinator 停止 mailbox watcher、中止未提交 compaction、停止并等待 Agent、停止每日 retention runner、进程内 ScheduleRuntime 和自身 jobs、同步最终 runtime 状态，最后断开自己的数据库连接；QQ Gateway、Feishu Gateway 和 Media Worker 分别清理自己拥有的资源。
- shutdown 各阶段 best-effort 且有超时；前一阶段失败不会阻止后续清理，Prisma disconnect 始终最后执行。

## 主要模块

- `src/agent/agent-ledger-repo.ts`：append、CAS compaction、runtime 原子更新和 checkpoint I/O。
- `src/agent/agent-ledger-projection.ts`：canonical 校验与确定性 projection。
- `src/agent/agent-ledger-loader.ts`：checkpoint 分类、rebuild 和安装输入。
- `src/agent/ledger-commit-coordinator.ts`、`src/agent/compaction-coordinator.ts`、`src/agent/loop-policy.ts`：提交热路径、压缩事务与纯循环策略。
- `src/agent/bot-loop-agent.ts`：唯一 Runtime Host、trigger、失败恢复和自主循环编排。
- `src/agent/react-kernel.ts`：单轮 ReAct、tool call/result 顺序和结果边界。
- `src/agent/compaction*.ts`：token cut、serialization、hooks、candidate 和 summary 校验。
- `src/agent/working-context.ts`、`src/media/agent-image-ref.ts`：请求投影与稳定图片引用。
- `src/agent/mailbox.ts`、`src/agent/mailbox-handled.ts`：入站通知和 durable handled boundary。
- `src/agent/tools/**`：受控工具；注册表以 `src/agent/tools/index.ts` 为准。
- `src/platform.ts`：本机多进程 supervisor、健康屏障和独立日志。
- `src/services/qq-gateway.ts`、`src/services/feishu-gateway.ts`、`src/services/database-mailbox-watcher.ts`：平台连接所有权与 PostgreSQL mailbox 边界。
- `src/agent/schedule-*.ts`：进程内短期调度、occurrence、pending delivery 和重启恢复。
- `src/services/media-worker.ts`：独立媒体描述 worker，直接调用媒体 provider。
- `src/bot/**`、`src/services/feishu-*.ts`、`src/messaging/**`、`src/media/**`：QQ/飞书 ingress、发送和媒体领域实现。
- `src/database/**`、`src/ops/**`：数据库 helper、Agent Core advisory lock、入站 transient retry、运维日志和只读检查。
- `apps/admin-web/**`：TanStack Start 本机管理面；观察 feature 只读，operations feature 通过固定 DTO、single-flight runner 和本地审计调用强类型 `src/ops` 服务；`*.functions.ts` 暴露 RPC wrapper，`*.server.ts` 保留 Prisma/env/文件 helper。
