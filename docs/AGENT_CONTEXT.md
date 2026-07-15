# 永续 Agent Context

项目产品契约是稳定、可 replay、可审计并能长期增长的 LLM 历史。Prompt cache 稳定性是一等产品能力。

## 事实模型

- Postgres `bot_agent_ledger_entries` 是唯一持久 LLM history source。普通事实写成 `message` entry；压缩写成 `compaction` entry。运行时没有更新或删除旧 entry 的接口。
- `AgentContext` 是当前 canonical ledger 的内存 projection，不是另一份事实源。`messages` / `media` 是 QQ 入站事实账本，只用于 missed replay、搜索、审计和按需读取，不能重建 prompt transcript。
- `bot_agent_runtime_state` 只保存 mailbox cursors、continuity、Goal revision、active tool capabilities、QQ 当前会话 focus、last wake 和 ledger head。它不保存 LLM history；focus 只能由 `qq_conversation open/close` 改变，不能从消息、memory、日志或其他 side state 推断。
- `bot_agent_checkpoint` 是可丢弃的 projection cache。启动始终先验证 canonical ledger；checkpoint 只有 schema、head、fingerprint 和 projection 都匹配时才命中。missing、stale、corrupt 都从 canonical ledger 重建，checkpoint 写失败不影响已提交历史。
- `bot_agent_goal`、workspace Markdown、调度文件和 `logs/*` 都是 side state，永远不能作为 transcript replay 来源。

## Append 与原子性

- 新的 LLM 可见事实只能通过 Runtime Host 的受控 append 或 compaction projection 进入。
- assistant tool call 和对应 tool result 是不可拆的原子组。结果按 assistant 中的 tool-call 顺序持久化；并行完成时序不进入 ledger。
- `ToolExecutionResult.content` 是唯一持久化工具结果。`outcome` 和 `effects` 只服务当前轮控制流；只有 Runtime Host 验证后的稳定 marker（例如 `mailbox_handled`）可以另外 append。
- 可见消息与 mailbox cursor、continuity、Goal revision、capability 或 QQ focus 变化必须在同一事务提交。持久化成功前不得推进内存 projection；提交失败时 runtime-local focus 必须回滚到 canonical projection。
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
- 被压缩的完整 prefix（除受控机器 marker）都进入 summarizer；不能按比例静默丢弃头部。summary 必须通过固定 heading、token 上限和完整 candidate projection 校验。
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

- bot 在所有允许来源间共享一个串行 `AgentContext`。QQ 消息先写 `messages` / `media`，再以不含正文的 mailbox notification append；正文由 `inbox` 有界读取。
- 新 mailbox 不会自动切换当前会话。发送前必须通过 `qq_conversation open` 显式选择允许的群或好友；`send_message` 只读取当前 focus，focus 变化和对应可见 tool result 同事务进入 runtime state。
- provider-confirmed `send_message` 仍与本地数据库不存在分布式事务。只有同 target 有 pending disclosure 时才 append `mailbox_handled`；这防止重复回应，但不承诺 QQ 外发 exactly-once。
- owner `/compact` 只接受 NapCat 已确认的 friend 私聊，且 peer/sender 都必须等于配置 owner。startup replay 与 live overlap 按 message row 去重；命令文本不进入普通 LLM history，focus 作为有界 trusted metadata 进入 compaction payload。
- 不实现 pi 风格 session tree。QQ 外发、mailbox cursor、Goal revision 和工具副作用需要一条可审计的线性时间线；分叉历史会让“哪条分支已发送/已处理”失去唯一答案。并行研究继续通过 bounded background task/delegate 完成，结果回到主 ledger。

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
