# 永续 Agent Context

项目产品契约是稳定、可 replay、可审计并能长期增长的 LLM 历史。Prompt cache 稳定性是一等产品能力。

## 事实模型

- Postgres `bot_agent_ledger_entries` 是唯一持久 LLM history source。普通事实写成 `message` entry；压缩写成 `compaction` entry。运行时没有更新或删除旧 entry 的接口。
- `AgentContext` 是当前 canonical ledger 的内存 projection，不是另一份事实源。`messages` / `media` 是 QQ 入站事实账本，只用于 missed replay、搜索、审计和按需读取，不能重建 prompt transcript。
- `bot_agent_runtime_state` 只保存通知披露 cursors、inbox 已读 cursors、continuity、Goal revision、active tool capabilities、QQ 当前会话 focus、last wake 和 ledger head。它不保存 LLM history；focus 只能由 `qq_conversation open/close` 改变，不能从消息、memory、日志或其他 side state 推断。
- `bot_agent_checkpoint` 是可丢弃的 projection cache。启动始终先验证 canonical ledger；checkpoint 只有 schema、head、fingerprint 和 projection 都匹配时才命中。missing、stale、corrupt 都从 canonical ledger 重建，checkpoint 写失败不影响已提交历史。
- `bot_agent_goal`、workspace Markdown、调度文件和 `logs/*` 都是 side state，永远不能作为 transcript replay 来源。`logs/agent-activity.json` 仅供 WebAdmin 观察进程 phase、等待和并发工具，缺失或损坏不得影响 replay 或 Agent 行为。

## Append 与原子性

- 新的 LLM 可见事实只能通过 Runtime Host 的受控 append 或 compaction projection 进入。
- assistant tool call 和对应 tool result 是不可拆的原子组。结果按 assistant 中的 tool-call 顺序持久化；并行完成时序不进入 ledger。
- `ToolExecutionResult.content` 是唯一持久化工具结果。`outcome` 和 `effects` 只服务当前轮控制流；`progress`、`continuation` 和普通 `noveltyKey` 都不进入 replay，重复新颖性只作为有界进程内防空转状态。只有 Runtime Host 验证后的稳定 marker（例如 `mailbox_handled`、`runtime_correction`）可以另外 append。content-only 且无 tool call 的 assistant 输出不是有效行动或公开发言；Runtime Host 追加稳定纠错 marker 并只立即重试一次，再次命中则进入一分钟可打断等待。
- 可见消息与通知披露 cursor、inbox 已读 cursor、continuity、Goal revision 或 QQ focus 变化必须在同一事务提交。`inbox` 只把实际呈现在有界 tool result 中的最新 row 标为已读，输出截断时不能跳过未展示行。持久化成功前不得推进内存 projection；提交失败时 runtime-local control state 必须回滚到 canonical projection。
- late media、side table 或日志变化不得回写已 append entry。

## 确定性 replay

启动恢复固定执行：

1. 只读加载所有 ledger entries 和 runtime singleton。
2. 校验 entry schema、严格递增 ID、runtime head、compaction chain、boundary，以及所有 tool call/result 组。
3. 找到最新 compaction；把其 summary 和受控机器状态放在最前，保留 `firstKeptEntryId` 起的旧 message entries，再追加 compaction 之后的新 message entries。
4. 把 runtime singleton 中的 capabilities 和 QQ focus 放入完整 projection，校验后原子安装到 `AgentContext`。
5. checkpoint 仅作为完全匹配时的加速缓存；否则 best-effort 刷新。

同一 canonical state 必须得到字节一致的 projection。不得从可变 side table、运维日志、当前媒体描述或重新执行工具来补历史。

## Append-only compaction

- compaction 不改写旧 prefix。它只追加一个带 summary、`firstKeptEntryId`、previous compaction link、token metrics、reason 和受控机器状态的 entry；projection 只解释最新 compaction boundary。
- cut point 以 entry token 预算选择，并保持 tool pair 原子性。若单个 tool turn 跨过目标预算，允许 split-turn：summary 同时包含历史部分和该 turn 已压缩的前缀，tail 从合法 assistant boundary 开始。
- 被压缩的完整 prefix 都进入 summarizer，不能按比例静默丢弃头部。Claude 的普通 history compaction 复用主 Agent 的 system、tools 和原始 working-context prefix，只在末尾追加可信 control message；受控机器 marker 只能作为线索，不能由摘要改写为权威状态。OpenAI 与 Claude split-turn fallback 继续使用隔离的 `[UNTRUSTED_DATA]` 序列化请求。summary 必须通过固定 heading、token 上限和完整 candidate projection 校验。
- Claude 主请求会在同一原子 cut 规则算出的 future compaction boundary 增加 provider-only 1h cache breakpoint；真正压缩时在相同 prefix 末尾再次声明该 breakpoint。cache marker 不进入 ledger/projection，cache miss 也不改变摘要语义。压缩调用可携带相同 tool declarations，但其 tool call 永不执行；tool call、空输出或截断都按 summarizer failure 处理。
- trigger 有三种：动态 threshold、provider context overflow、owner friend-private `/compact [focus]`。threshold 使用 provider input prefix 加本轮新 entry 的本地估算；overflow 每轮最多强制 compact-and-retry 一次；manual 绕过 threshold/backoff。
- `beforeCompact` 和 summarizer 在事务外运行，支持 abort；CAS `appendCompaction(expectedHeadEntryId)` 成功后才安装 candidate。head race 丢弃 candidate 并基于新 head 重算一次。
- threshold 失败退避十分钟；manual/overflow 不读该退避。summarizer 或 commit 失败不改变 canonical history；checkpoint 和 `afterCompact` 失败只记录，不回滚已提交 compaction；shutdown 会中止未提交 summarizer。
- active Goal 在 compaction 后追加稳定 continuation。mailbox continuity 的 compaction epoch 与 compaction entry 同事务提交；rest reminder 状态和 mailbox attention 状态进入 compaction payload 的受控字段，不交给 summarizer 改写。
- compaction 只改变 LLM messages projection，不得清空或从 transcript 重建 active capabilities、QQ focus 等 runtime control state。

## 图片与 working context

- canonical tool image 使用稳定 `image_ref`（Media id、类型、可选尺寸/描述），严禁把 base64 写入 ledger。持久化前按内容哈希 upsert Media。
- working context 在调用 provider 前按需解析近期图片引用；媒体已失效时使用确定性 unavailable marker。失效不能改变已持久化文字、阻止 replay 或让旧 compaction 失效。
- working-context projection 可以做确定性、有界的 provider 适配，但不能删事实、改 role、拆 tool pair 或成为第二份持久历史。

## Mailbox、Goal 与外部副作用

- bot 在所有允许来源间共享一个串行 `AgentContext`。异步来源统一追加不含正文的 `notification` envelope；`priority` 表示重要性，`delivery=interrupt|next_round|passive` 独立决定披露节奏，`open.tool/open.args` 指向来源自己的按需读取入口。QQ 消息正文先写 `messages` / `media`：私聊和结构化 @bot 以 high+interrupt 唤醒；selective/active 群的普通消息可以入 EventQueue 聚合为 normal+passive，只在自然轮次或其他 attention 到来时披露；mentions 群普通消息仍只由 `inbox list/read` 被动、有界读取。
- 新通知统一写成 `event=notification`；历史 ledger 中的 `event=inbox_update` 继续由 mailbox attention parser 兼容，不能迁移或改写旧 entry。后台任务通知只披露状态和 `background_task get` 打开动作；调度到期 notification 不含 intention，正文先写独立 occurrence store，再由 `schedule get_occurrence` 读取。来源 side state 不参与 transcript replay；通知本身一旦进入 ledger 就保持字节稳定。
- 新 mailbox 不会自动切换当前会话。发送前必须通过 `qq_conversation open` 显式选择允许的群或好友；`send_message` 只读取当前 focus，focus 变化和对应可见 tool result 同事务进入 runtime state。
- 私聊发送是否属于“回应新入站”由同 target 的 durable pending mailbox 判断，不依赖 `reply_to`。`reply_to` 只控制 QQ 引用展示；进程内主动私聊冷却不得拦截 pending mailbox 的回复。
- 未追加 `mailbox_handled` 的私聊 mailbox 跨 round 保持行动锚点。锚点下的无进展 round 只允许一次立即纠错；连续第二次仍无进展时进入一分钟、可被注意事件打断的等待，不能降级为普通十五分钟 idle wait，也不能无限即时自循环。
- provider-confirmed `send_message` 仍与本地数据库不存在分布式事务。只有同 target 有 pending disclosure 时才 append `mailbox_handled`；这防止重复回应，但不承诺 QQ 外发 exactly-once。
- `mailbox_handled` 只表示这批入站已经回应，不表示回应中承诺的工作已完成。`send_message.work=continue` 只在进程内为下一轮保留短期行动锚点，不跨重启；`work=goal_progress` 必须绑定当前 active Goal 且其 `currentCommitment` 非空，否则 before-tool hook 以 `work_commitment_required` 拒绝外发。进度消息可以关闭 mailbox 防重，长期行动锚点仍由 Goal revision/continuation 契约跨轮与跨重启保留。
- owner `/compact` 只接受 NapCat 已确认的 friend 私聊，且 peer/sender 都必须等于配置 owner。startup replay 与 live overlap 按 message row 去重；命令文本不进入普通 LLM history，focus 作为有界 trusted metadata 进入 compaction payload。
- owner 和 self Goal 的 `complete` 在状态写入前各执行一次独立、无工具 LLM 验收。judger 只读取当前 canonical projection：优先从当前 goalId 首次出现处截取，marker 已被 compaction 移出时使用完整 projection；transcript 包在 untrusted envelope 中，不能从日志、Goal side table、Memory 或其他可变 side state 重建证据。
- 只有严格解析出的 `{ok:true}` 才允许调用 `GoalStore.complete()`；`ok:false`、provider 或协议失败都不改变 Goal 状态，同一次尝试不自动重试。拒绝或不可用原因只通过正常 `goal` tool result 进入 ledger；judger 不决定 blocker，也不创建第二个 Agent。
- 不实现 pi 风格 session tree。QQ 外发、mailbox cursor、Goal revision 和工具副作用需要一条可审计的线性时间线；分叉历史会让“哪条分支已发送/已处理”失去唯一答案。并行工作只通过有明确类型和边界的 background task 完成，结果回到主 ledger。

## 代码地图

- `src/agent/agent-ledger-repo.ts`：append、CAS compaction、runtime 原子更新和 checkpoint I/O。
- `src/agent/agent-ledger-projection.ts`：canonical 校验与确定性 projection。
- `src/agent/agent-ledger-loader.ts`：checkpoint 分类、rebuild 和安装输入。
- `src/agent/agent-context.ts`：当前内存 projection。
- `src/agent/bot-loop-agent.ts`：Runtime Host、事务边界、trigger 与失败恢复。
- `src/agent/compaction*.ts`：token cut、serialization、hooks、candidate 和 summary 校验。
- `src/agent/working-context.ts`、`src/media/agent-image-ref.ts`：单次请求 projection 与稳定图片引用解析。
- `src/agent/compaction-control.ts`：owner `/compact` 身份、replay gate 和去重。
- `src/ops/agent-ledger-check.ts`：完全只读的 canonical/checkpoint 检查。

## 修改前检查

- 会不会更新或删除已有 ledger entry？
- 会不会在事务提交前改变 `AgentContext`？
- 会不会切开 tool call/result，或从 side state 重建历史？
- checkpoint 删除后能否从 canonical ledger 得到相同 projection？
- 图片或其他可变资源失效后 replay 是否仍确定？
- 对外副作用是否仍只有一条主时间线和明确 target？
- QQ focus 是否只来自受控 runtime state，并和产生它的 tool result 原子提交？
