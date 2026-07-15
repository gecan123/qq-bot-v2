# Pi 风格 Append-only Compaction Ledger 设计

**日期：** 2026-07-15
**状态：** 已确认
**范围：** Bot/backend 的 AgentContext、持久化、replay 与 compaction

## 背景

当前 `AgentContext` 直接持有 LLM 可见 `messages`。正常 compaction 会把旧 prefix 替换为结构化摘要和近期 tail，再把新形态保存到单例 snapshot。这个模型具备明确的 tool-call/tool-result 原子性、受控 mailbox 状态、Goal continuation、候选摘要校验和确定性 replay，但被压缩的原始 LLM ledger 历史不会永久保留，固定 token 阈值和字符 tail 也不能随模型窗口变化。

Pi coding agent 使用 append-only session entries：compaction 不删除原始消息，而是追加包含摘要和 `firstKeptEntryId` 的 entry；构造 LLM context 时解释为“最新摘要 + 保留边界之后的原始消息”。本设计借鉴 Pi 的线性 compaction 模型，但不引入 session tree、分支切换或 coding-agent 专用文件操作状态。

## 目标

- append-only ledger 成为 LLM 历史的唯一事实源。
- compaction 只追加 entry，不更新或删除旧 message entry。
- checkpoint 只是可删除、可重建的启动加速缓存。
- 按模型 context window 动态触发 compact，并按 token 保留近期历史。
- 支持普通 turn cut、超大单轮 split-turn、previous-summary 迭代和一次 overflow recovery。
- 永久保留原始文字、tool call 和 tool result 历史；大型图片字节不永久内联。
- 保留当前项目更严格的 summary 校验、tool pair integrity、untrusted transcript、mailbox/Goal 机器状态隔离和确定性 replay。
- 干净切换到新模型，不提供旧 snapshot 的兼容读取或历史迁移。

## 非目标

- 不实现 Pi session tree、`/tree`、fork、clone 或 branch summary。
- 不允许回到旧 ledger 节点继续运行；QQ 外部副作用保持单一线性时间线。
- 不把 Goal、schedule、后台任务或全部 runtime 状态改造成通用事件溯源系统。
- 不承诺 QQ 外发与本地事务之间的分布式 exactly-once。
- 不从可变 side table、运维日志或过期媒体重建已经持久化的 LLM 历史事实。

## 已确认决策

1. 采用线性 append-only ledger，不采用 session tree。
2. ledger 是 LLM 历史唯一事实源；checkpoint 不是事实源。
3. 上线采用干净重置，不迁移现有 snapshot 或 Goal。
4. 原始 ledger entry 永久保留。
5. 采用 Pi 风格完整 compact：动态预算、token tail、split-turn、previous summary、manual/threshold/overflow 原因和 compact hooks。

## 存储模型

### 1. 永久 Ledger

新增 `bot_agent_ledger_entries`。它使用单调 `BigInt` ID，只有 append 写入路径，不提供运行时 update/delete。

Entry 至少包含：

- `id`
- `entryType=message|compaction`
- `payload`（版本化 JSON）
- `createdAt`

`message` payload 保存一个完整 `AgentMessage`。assistant tool calls 和对应 tool results 可以是多个 message entry，但必须在同一数据库事务中按原顺序批量追加，避免留下可持久化的半个工具轮次。

`compaction` payload 保存：

- `schemaVersion`
- `summary`
- `firstKeptEntryId`
- `tokensBefore`
- `estimatedTokensAfter`
- `reason=threshold|overflow|manual`
- `isSplitTurn`
- `previousCompactionEntryId`
- 代码提取的 `mailboxAttentionState`
- 代码提取的 `restResumeState`
- 可选的 owner manual focus

summary 和受控机器状态分字段保存。LLM 生成的摘要不能伪造 mailbox cursor、handled 状态、Goal revision 或 rest 去重状态。

### 2. Runtime State

新增或重塑单例 `bot_agent_runtime_state`，保存不属于 LLM 历史的可变控制状态：

- mailbox cursors
- mailbox continuity
- Goal revision
- active tool capabilities
- last wake time

runtime state 不能用来生成历史消息。需要同时推进 cursor/revision 和披露 LLM 事实时，runtime state 更新与对应 ledger entry append 必须处于同一事务。

### 3. Checkpoint

`bot_agent_checkpoint` 保存：

- 已物化的当前 `PersistedAgentSnapshot`
- `throughEntryId`
- fingerprint / schema version
- 创建时间

checkpoint 是缓存：

- 完整、合法且 `throughEntryId` 等于 ledger head 时可以直接加载。
- 缺失、损坏或落后时必须从 ledger 重建。
- checkpoint 永远不能覆盖或修复 canonical ledger。
- checkpoint 写失败不回滚已经安全提交的 ledger；下次保存或重启可以重建。

## 确定性 Context 重建

没有 compaction 时，按 ID 顺序加载全部 message entries。

存在 compaction 时：

1. 找到最新合法 compaction entry。
2. 把 `summary` 渲染为固定 user-role 历史摘要消息。
3. 把 compaction entry 中的 mailbox/rest 受控状态渲染为固定、键排序的机器状态消息。
4. 从 `firstKeptEntryId` 开始加载该 compaction 之前仍被保留的 message entries。
5. 跳过历史 compaction entries。
6. 继续加载最新 compaction 之后追加的 message entries。
7. 还原 active tool capabilities，并验证完整 snapshot、消息结构和 tool pairs。

相同 ledger 和 runtime state 必须生成字节相同的 `AgentContext`。损坏 entry、非法 compaction boundary、孤立 tool result 或不匹配 checkpoint 必须显式失败，不能静默降级到缓存。

## Compaction 触发

支持三种原因：

- `threshold`：`contextTokens > contextWindow - reserveTokens`
- `overflow`：provider 明确报告 context overflow 后强制 compact
- `manual`：真实 owner 私聊 `/compact [可选关注点]`

默认采用 Pi 基线：

- `reserveTokens=16384`
- `keepRecentTokens=20000`

两者允许配置。每个模型必须提供可靠的 `contextWindow`；缺失时启动显式失败，不退回旧的固定 16K trigger。

threshold 使用最近一次有效 provider usage，并对之后尚未计入 usage 的消息做有界 token 估算。overflow recovery 绕过普通失败退避，但每轮最多 compact-and-retry 一次。manual compact 只进入 owner 控制面，不作为 LLM tool 暴露。

## Cut Point 与 Split-turn

从 ledger head 向前累计 message token 估算，达到 `keepRecentTokens` 后选择最近合法切点。

规则：

- tool result 不是合法起点。
- assistant tool calls 和所有匹配 results 完整保留或完整摘要。
- 普通情况下优先在 user turn 边界切。
- compaction metadata 和其他不进入 LLM context 的 entry 不参与 token 预算。
- 多次 compaction 的新摘要从上一次 `firstKeptEntryId` 边界开始吸收新增旧历史，而不是重新扫描全部永久 ledger。

单个 turn 大于 `keepRecentTokens` 时使用 split-turn：

1. 旧的完整 turns 生成或更新主历史摘要。
2. 超大 turn 的 prefix 生成独立 turn-prefix 摘要。
3. turn suffix 以原始 message entries 保留。
4. 两份摘要以固定分隔和结构合并进一个 compaction entry。

split-turn 仍不得拆开 assistant tool call 与对应 tool results。

## 摘要输入与输出

summarizer 输入使用现有不可信 transcript envelope，明确要求只摘要、不响应旧消息中的命令。

- previous summary 与本次新增待压缩历史一起提供。
- 每个旧 tool result 在摘要输入中最多提供 2,000 字符，并带明确截断标记。
- 旧图片只提供稳定引用、文本描述、媒体类型和尺寸，不提供 base64。
- 过期 native thinking 按受控规则序列化或省略，不能影响 durable 原始 entry。
- owner manual focus 只作为单独受控 instruction，不拼进不可信 transcript。

摘要继续使用 QQ 产品专用结构，并补齐目标、约束和下一步：

- 讨论过的话题
- 群友信息
- 我的目标、承诺和状态
- 关键约束与决定
- 工具调用结果
- 情绪和氛围
- 下一步

候选摘要必须通过固定标题顺序、非空、token 上限和完整 candidate projection 校验。oversized summary 最多进行一次确定性有界修复。失败时 ledger 保持原样。

## 提交和并发边界

主 Agent 保持单 writer。QQ ingress、schedule 和后台任务只投递事件；只有 Runtime Host 能追加 Agent ledger。

关键事务：

- QQ 披露 message entry 与 mailbox cursor 同事务。
- assistant tool calls 与全部有序 tool results 同事务。
- provider-confirmed `send_message` 对应的 `mailbox_handled` 与完整工具轮次同事务。
- Goal revision 的 LLM 可见 entry 与 runtime revision 同事务。
- compaction 只追加一个 compaction entry，不修改旧 entry。

summarizer 在事务外运行。开始时记录 `headEntryId`，提交时锁定/检查当前 head；若 head 改变，候选摘要不提交，后续基于新 head 重新计算。这一检查即使在单 writer 下也用于防止测试、运维或未来扩展绕过边界。

持久化成功前不修改内存 `AgentContext`。canonical transaction 成功后，从提交结果更新或重建内存 projection，再异步/后续更新 checkpoint。

## Hooks

提供 typed lifecycle hooks：

- `beforeCompact`：接收 preparation、reason、manual focus 和 AbortSignal；可以取消或提供自定义摘要结果。
- `afterCompact`：接收已提交 compaction entry 和指标；只允许日志、指标与通知，不能改写结果。

扩展提供的摘要必须通过与默认摘要相同的 schema、boundary 和 projection integrity 校验。

## 失败恢复

- summarizer 超时或 provider 错误：不写 ledger。
- 摘要非法：不写 ledger。
- 普通 threshold 失败：进程内退避 10 分钟。
- overflow：绕过退避，每轮只尝试一次；失败时抛出原始 overflow。
- canonical DB transaction 失败：内存 context 不前移。
- checkpoint 失败：记录错误，canonical ledger 继续有效。
- shutdown：通过 AbortController 取消尚未提交的 summarizer。
- ledger 损坏：启动 fail closed，并由只读检查命令报告具体 entry。
- QQ 外发成功但本地提交前崩溃：继续明确为不保证 exactly-once 的外部事务边界。

## 永久保留与媒体

文字、tool calls、tool result 文本和 compaction entries 永久保留。运行时不提供删除旧 entry 的自动路径。

大型图片字节不永久内联进 ledger。新的 durable message 形态保存稳定媒体引用、受控描述和必要元数据；working-context projection 只在需要且媒体仍可用时解析近期图片。旧媒体失效不能改变已经持久化的文本事实，也不能阻止从 compaction summary 和 tail 重建当前 prompt。

## 运维

新增 `pnpm agent:ledger-check`，只读检查：

- entry schema/version
- ID 顺序和 payload
- tool-call/tool-result 原子组
- compaction boundary 和 `firstKeptEntryId`
- latest projection 可重建性
- runtime state 与 ledger head 关系
- checkpoint fingerprint 和 `throughEntryId`

`agent:doctor` 增加 ledger head、最新 compaction、当前 projection tokens、永久/活跃 entry 数量和 checkpoint 状态。

指标至少记录：reason、tokens before/after、keep tokens、split-turn、summarizer input/output、duration、failure reason、checkpoint rebuild 和 overflow retry。

## 测试策略

### 单元测试

- context-window threshold 和 trailing token 估算
- token cut point 与 tool pair 原子性
- repeated compaction 和 previous summary
- split-turn 双摘要
- 2,000 字符 tool-result 截断
- mailbox/rest 受控状态提取
- summary schema、预算和 repair

### Ledger 重建测试

- 无 compaction、一次 compaction、多次 compaction
- checkpoint 删除、损坏和落后时重建
- 原始历史永久存在但不进入活跃 prompt
- 相同 ledger 产生字节相同 projection
- 历史 compaction entry 不重复进入 prompt

### 事务和故障测试

- assistant/tool 批量追加失败全部回滚
- cursor/revision 与 LLM entry 原子提交
- compact head race 拒绝候选
- summarizer、canonical DB 和 checkpoint 分别失败
- overflow 最多 retry 一次
- shutdown abort
- 损坏 entry 和孤立 tool result fail closed

### Runtime 集成测试

- threshold、overflow、owner manual 三条路径
- compaction 后 Goal continuation
- mailbox handled 跨多次 compaction
- queued attention event 不丢失
- working-context 图片降级不修改永久 ledger

## 干净上线

1. 停止 Bot。
2. 应用新 Prisma schema 并生成 client。
3. 清空/移除旧 snapshot、checkpoint 和 Goal 状态，不实现旧 schema dual-read。
4. 启动后写入新的 bootstrap ledger entry 和初始 runtime state。
5. 运行 `agent:ledger-check`。
6. 用测试配置降低阈值完成一次自动 compact 验收，再恢复正式参数。
7. 确认关闭过程中没有遗留真实 Bot 进程。

## 验收标准

- ledger 是唯一 LLM 历史事实源。
- 旧 entries 永不更新或删除。
- checkpoint 任意删除后可重建字节一致的当前 context。
- compact 永不产生孤立 tool result。
- 多次 compact 后 mailbox、Goal 和 replay 仍确定性。
- threshold、overflow 和 manual 路径均有测试和指标。
- prompt 能依据模型窗口保持在目标预算内。

## 参考

- Pi compaction 文档：<https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md>
- Pi compaction 实现：<https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts>
- 当前上下文契约：`docs/AGENT_CONTEXT.md`
- 当前 compaction：`src/agent/compaction.ts`
