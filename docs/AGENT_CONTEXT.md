# 永续 Agent Context

项目产品契约是稳定、可 replay、可审计并能长期增长的 LLM 历史。Prompt cache 稳定性是一等产品能力。

## 事实模型

- Postgres `bot_agent_ledger_entries` 是唯一持久 LLM history source。普通事实写成 `message` entry；压缩写成 `compaction` entry。运行时没有更新或删除旧 entry 的接口。
- `AgentContext` 是当前 canonical ledger 的内存 projection，不是另一份事实源。`messages` / `media` 是 QQ 与飞书共享的入站事实账本，只用于 missed replay、搜索、审计和按需读取，不能重建 prompt transcript。
- `bot_agent_runtime_state` 只保存通知披露 cursors、inbox 已读 cursors、continuity、平台中立 conversation focus、last wake 和 ledger head。它不保存 LLM history；focus 只能由 `conversation open/close` 改变，不能从消息、memory、日志或其他 side state 推断。
- `bot_agent_checkpoint` 是可丢弃的 projection cache。启动始终先验证 canonical ledger；checkpoint 只有 schema、head、fingerprint 和 projection 都匹配时才命中。missing、stale、corrupt 都从 canonical ledger 重建，checkpoint 写失败不影响已提交历史。
- 普通 message/runtime commit 必须携带当前 expected head。事务返回 appended entries 与新 runtime state 后，`LedgerCommitCoordinator` 只基于当前已验证 active projection 增量安装；不得在日常 commit 热路径重新 SELECT/fingerprint 永久 prefix。完整 chain 校验保留在启动、compaction 后刷新、`agent:ledger-check` 和显式 Deep Integrity。
- workspace Markdown、调度文件和 `logs/*` 都是 side state，永远不能作为 transcript replay 来源。`logs/agent-activity.json` 仅供 WebAdmin 观察进程 phase、等待和并发工具，缺失或损坏不得影响 replay 或 Agent 行为。

## Append 与原子性

- 新的 LLM 可见事实只能通过 Runtime Host 的受控 append 或 compaction projection 进入。
- assistant tool call 和对应 tool result 是不可拆的原子组。结果按 assistant 中的 tool-call 顺序持久化；并行完成时序不进入 ledger。
- `ToolExecutionResult.content` 是唯一持久化工具结果。`outcome` 和 `effects` 只服务当前轮控制流；`progress`、`continuation` 和普通 `noveltyKey` 都不进入 replay，重复新颖性只作为有界进程内防空转状态。只有 Runtime Host 验证后的稳定 marker（例如 `mailbox_handled`、`runtime_correction`、`runtime_autonomy_tick`）可以另外 append。content-only 且无 tool call 的 assistant 输出不是有效行动或公开发言；Runtime Host 最多追加一次稳定行动纠错并重试，再次无行动则进入定时事件等待，方向选择仍由主 Agent 完成。
- 可见消息与通知披露 cursor、inbox 已读 cursor、continuity 或 conversation focus 变化必须在同一事务提交。`inbox` 只把实际呈现在有界 tool result 中的最新 row 标为已读，输出截断时不能跳过未展示行。持久化成功前不得推进内存 projection；提交失败时 runtime-local control state 必须回滚到 canonical projection。
- late media、side table 或日志变化不得回写已 append entry。

## 确定性 replay

启动恢复固定执行：

1. 只读加载所有 ledger entries 和 runtime singleton。
2. 校验 entry schema、严格递增 ID、runtime head、compaction chain、boundary，以及所有 tool call/result 组。
3. 找到最新 compaction；把其 summary 和受控机器状态放在最前，保留 `firstKeptEntryId` 起的旧 message entries，再追加 compaction 之后的新 message entries。
4. 把 runtime singleton 中的 capabilities 和跨平台 conversation focus 放入完整 projection，校验后原子安装到 `AgentContext`。
5. checkpoint 仅作为完全匹配时可复用的 validation cache；否则在完整 load 路径 best-effort 刷新。普通 commit 不同步刷新 checkpoint。

同一 canonical state 必须得到字节一致的 projection。不得从可变 side table、运维日志、当前媒体描述或重新执行工具来补历史。

## Append-only compaction

- compaction 不改写旧 prefix。它只追加一个带 summary、`firstKeptEntryId`、previous compaction link、token metrics、reason 和受控机器状态的 entry；projection 只解释最新 compaction boundary。
- cut point 以 entry token 预算选择，并保持 tool pair 原子性。若单个 tool turn 跨过目标预算，允许 split-turn：summary 同时包含历史部分和该 turn 已压缩的前缀，tail 从合法 assistant boundary 开始。
- 被压缩的完整 prefix 都进入 summarizer，不能按比例静默丢弃头部。Claude 的普通 history compaction 复用主 Agent 的 system、tools 和原始 working-context prefix，只在末尾追加可信 control message；受控机器 marker 只能作为线索，不能由摘要改写为权威状态。OpenAI 与 Claude split-turn fallback 继续使用隔离的 `[UNTRUSTED_DATA]` 序列化请求。summary 必须通过固定 heading、token 上限和完整 candidate projection 校验。
- Claude 主请求会在同一原子 cut 规则算出的 future compaction boundary 增加 provider-only 1h cache breakpoint；真正压缩时在相同 prefix 末尾再次声明该 breakpoint。cache marker 不进入 ledger/projection，cache miss 也不改变摘要语义。压缩调用可携带相同 tool declarations，但其 tool call 永不执行；tool call、空输出或截断都按 summarizer failure 处理。
- trigger 只有动态 threshold 和 provider context overflow。threshold 使用 provider input prefix 加本轮新 entry 的本地估算；overflow 每轮最多强制 compact-and-retry 一次。
- `beforeCompact` 和 summarizer 在事务外运行，支持 abort；CAS `appendCompaction(expectedHeadEntryId)` 成功后才安装 candidate。head race 丢弃 candidate 并基于新 head 重算一次。
- threshold 失败退避十分钟；overflow 不读该退避。summarizer 或 commit 失败不改变 canonical history；checkpoint 和 `afterCompact` 失败只记录，不回滚已提交 compaction；shutdown 会中止未提交 summarizer。
- mailbox continuity 的 compaction epoch 与 compaction entry 同事务提交；mailbox attention 状态进入 compaction payload 的受控字段，不交给 summarizer 改写。
- compaction 只改变 LLM messages projection，不得清空或从 transcript 重建 active capabilities、conversation focus 等 runtime control state。

## 图片与 working context

- canonical tool image 使用稳定 `image_ref`（Media id、类型、可选尺寸/描述），严禁把 base64 写入 ledger。每个持久 handle 创建独立 Media 行，物理字节按内容哈希 upsert `MediaBlob` 并通过 `blobId` 共享；不能把 blobId 或 hash 当成消息侧 handle。
- working context 按显式主 Agent 图片策略投影全部图片引用：默认 `LLM_AGENT_IMAGE_MODE=description`，主模型只读取独立 `describeImage` 路由已经持久化的描述/确定性 marker；`native` 才把图片解析为真实 image block。策略表达“谁负责识图”，不根据主模型名称或其理论能力猜测。
- 视觉模型解析媒体时若资源已失效，使用确定性 unavailable marker。失效不能改变已持久化文字、阻止 replay 或让旧 compaction 失效。working-context projection 不能查询后来变化的媒体描述、删事实、改 role、拆 tool pair 或成为第二份持久历史。

## Mailbox 与外部副作用

- bot 在 QQ 与飞书所有允许来源间共享一个串行 `AgentContext`。异步来源统一追加不含正文的 `notification` envelope；`priority` 表示重要性，`delivery=interrupt|next_round|passive` 独立决定披露节奏，`open.tool/open.args` 指向来源自己的按需读取入口。两个平台的正文先写 `messages` / `media`：私聊、结构化 @bot、编辑和撤回可以形成 attention；普通群消息只由 `inbox list/read` 被动、有界读取，QQ 的 selective/active 群还可以聚合为 normal+passive。
- 新通知统一写成 `event=notification`；历史 ledger 中的 `event=inbox_update` 继续由 mailbox attention parser 兼容，不能迁移或改写旧 entry。后台任务通知只披露状态和 `background_task get` 打开动作；调度到期 notification 不含 intention，正文先写独立 occurrence store，再由 `schedule get_occurrence` 读取。来源 side state 不参与 transcript replay；通知本身一旦进入 ledger 就保持字节稳定。
- 新 mailbox 不会自动切换当前会话。发送前必须通过 `conversation open` 显式选择允许的群或好友；`send_message` 只读取当前 focus，focus 变化和对应可见 tool result 同事务进入 runtime state。
- 私聊发送是否属于“回应新入站”由同 target 的 durable pending mailbox 判断，不依赖 `reply_to`。`reply_to` 只控制对应平台的引用/回复展示；进程内主动私聊冷却不得拦截 pending mailbox 的回复。
- 未追加 `mailbox_handled` 的私聊 mailbox 仍保留“尚未外发回应”的 durable 状态，用于回复冷却豁免和防重复边界；但强制 attention 只针对 `disclosedThroughRowId` 同时大于 handled cursor 与持久 `inboxReadCursors` 的未读范围。正文已经由有界 inbox result 展示后，不会因无需回复的旧私聊跨重启永久追加 attention 纠错；模型仍可根据内容决定是否外发。普通工具无进展只允许一次紧密重试；连续两轮无进展、方向完成或显式等待会进入最长 30 分钟的事件等待。外部事件立即唤醒且保留队列事实；超时则由 Runtime Host append canonical `runtime_autonomy_tick`，轮换检查未完成承诺、已有产物和有界好奇方向。tick 不是外部事实，但与其他受控 runtime message 一样进入唯一 ledger，保证 replay 看见同一牵引；轮换索引和探索门控是可丢弃进程内状态。
- provider-confirmed `send_message` 仍与本地数据库不存在分布式事务。只有同 target 有 pending disclosure 时才 append `mailbox_handled`；这防止重复回应，但不承诺任一平台外发 exactly-once。稳定 action UUID 与 `sent|failed|delivery_unknown` 只表达本次 adapter 结果，不引入 outbox 或自动重试。
- `mailbox_handled` 只表示这批入站已经回应，不表示回应中承诺的工作已完成。`send_message.work=continue` 只在进程内为下一轮保留短期行动锚点，不跨重启；跨天过程用 Notebook，未来时点重新评估用 Schedule。
- 主动休息只由主 Agent 显式调用 `rest`，默认请求 30 分钟、范围 10..120；等待发生在该工具执行内部，不读取或改写 canonical projection。工具只在当前进程保存最近三小时的实际休息区间：按 Asia/Singapore，白天 06:00..24:00 最多累计 60 分钟，夜间 00:00..06:00 最多 120 分钟；本次批准时长取请求、剩余额度和下一昼夜边界的最小值，注意事件打断只记录实际经过时间。自然结束后 Runtime append 一次 `runtime_autonomy_tick` 并在该探索阶段拒绝再次 `rest`，直到一次工具行动获得真实进展；被注意事件打断则优先处理该事件。休息额度和探索门控均不进入 runtime singleton、不跨重启持久化，也不根据工具次数、工作量或所谓精力判断资格。
- 不实现 pi 风格 session tree。跨平台外发、mailbox cursor 和工具副作用需要一条可审计的线性时间线；分叉历史会让“哪条分支已发送/已处理”失去唯一答案。并行工作只通过有明确类型和边界的 background task 完成，结果回到主 ledger。

## 代码地图

- `src/agent/agent-ledger-repo.ts`：append、CAS compaction、runtime 原子更新和 checkpoint I/O。
- `src/agent/agent-ledger-projection.ts`：canonical 校验与确定性 projection。
- `src/agent/agent-ledger-loader.ts`：checkpoint 分类、rebuild 和安装输入。
- `src/agent/ledger-commit-coordinator.ts`：expected-head commit 与 active projection 增量安装。
- `src/agent/compaction-coordinator.ts`：threshold/overflow、candidate、CAS 重算、失败退避和 post-compact refresh。
- `src/agent/agent-context.ts`：当前内存 projection。
- `src/agent/bot-loop-agent.ts`：Runtime Host、事务边界、trigger 与失败恢复。
- `src/agent/loop-policy.ts`：持续行动、技术退避和空上下文等待的结构化决策。
- `src/agent/compaction*.ts`：token cut、serialization、hooks、candidate 和 summary 校验。
- `src/agent/working-context.ts`、`src/media/agent-image-ref.ts`：单次请求 projection 与稳定图片引用解析。
- `src/ops/agent-ledger-check.ts`：完全只读的 canonical/checkpoint 检查。

## 修改前检查

- 会不会更新或删除已有 ledger entry？
- 会不会在事务提交前改变 `AgentContext`？
- 会不会切开 tool call/result，或从 side state 重建历史？
- checkpoint 删除后能否从 canonical ledger 得到相同 projection？
- 图片或其他可变资源失效后 replay 是否仍确定？
- 对外副作用是否仍只有一条主时间线和明确 target？
- conversation focus 是否只来自受控 runtime state，并和产生它的 tool result 原子提交？
