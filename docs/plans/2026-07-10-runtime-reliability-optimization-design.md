# Runtime 可靠性优化设计

## 目标

在不改变 single-context、mailbox 渐进披露和稳定 tool surface 的前提下，修复当前运行时在 compaction、启动恢复、退出一致性、辅助 LLM 成本和测试隔离方面的缺口。

本轮优先保证正确性和可验证性。媒体物理存储模型需要 schema 迁移，独立放到后续阶段，避免和运行时一致性改动混在同一个变更中。

## 方案选择

考虑过三种方式：

1. 小补丁：只删除 compaction 的固定丢弃和补几个等待。改动最小，但全局 config、辅助 LLM 计量和退出一致性仍会继续制造隐患。
2. 一次性重写 runtime host、媒体模型和配置系统。目标模型最干净，但修改面过大，不适合直接在主干一次完成。
3. 分阶段、正确性优先：先收紧 ledger/recovery/lifecycle，再统一 usage 和测试边界，最后单独处理媒体 schema。

采用第三种方案。

## 设计

### 1. Compaction 保真和持久化

- 所有被移出 ledger prefix 的消息都必须进入 summarizer 输入或已有摘要，不能按固定比例静默丢弃。
- 保留当前 safe-cut 规则，继续保证 assistant tool call 与对应 tool result 不被切开。
- compaction 和 compaction 后的 sticker pool 注入完成后，Runtime Host 立即保存 snapshot，避免依赖下一轮保存。
- summarizer 失败仍保留现有应急摘要语义，但必须显式记录降级。

### 2. 启动恢复 barrier

- `registerNapcatHandlers` 继续在 connect 前完成。
- 首次 lifecycle connect 触发的群历史 backfill 必须暴露一个可等待的 barrier。
- backfill 完成后再执行数据库 replay；实时事件仍可在 connect 后进入统一 dedup queue。
- 后续重连的 backfill 不阻塞主 Agent，也不能重复创建首次启动 barrier。
- backfill 自身仍只负责持久化，由随后 replay 统一决定哪些消息需要披露。

### 3. Graceful shutdown

- composition root 保存 runtime、主循环 Promise 和 ingress lifecycle handle。
- 收到 SIGINT/SIGTERM 后只执行一次 shutdown：停止接收或断开 NapCat、请求 BotLoop 停止、等待当前 round 结束、停止 job queue、保存最终 snapshot，再断开 Prisma。
- shutdown 应设置最大等待时间；超时记录错误并退出，避免永久挂死。
- 不承诺外部副作用的严格 exactly-once，但缩小 send 成功后 snapshot 未保存的窗口。

### 4. 辅助 LLM 路径和预算

- Life Journal review 不再无限期阻塞主循环：提供明确 timeout，并允许在失败或超时时跳过。
- 在进入 review 前做节流判断；处于节流窗口且没有必须更新 agenda 的信号时不调用 LLM。
- token usage operation 扩展到 Life Journal，并让主 Agent、compaction、Life Journal 共用同一日预算计量入口。
- 保持 Life Journal 输出不进入 `AgentContext` 的契约。

第一阶段不引入持久任务队列；辅助 review 仍由 Runtime Host 管理，但必须有界、可观测、可跳过。

### 5. 配置和测试隔离

- 保留纯函数 `parseConfig`，逐步减少业务模块直接读取全局 `config`。
- 测试命令提供固定、无真实凭据的测试环境，不依赖开发者本地 `.env` 或真实群号。
- replay 接收显式 monitored group IDs，而不是在函数内部读取全局 config。
- `SELF_NUMBER` 和 QQ ID 列表启动期校验为正的 safe integer。

### 6. Deferred tool trace

- 一个 LLM `invoke` call 只产生一个准确的最终结果事件，或产生具有明确 parent/child 关系的两条事件。
- 本轮选择单一最终事件：内部工具名作为真实 `toolName`，保留原始 `toolCallId`；inactive/unknown/参数错误也必须记录为失败。
- hooks 仍针对真实内部工具执行。

### 7. 后续媒体存储阶段

- 将二进制 blob 与消息媒体引用拆分：blob 以 `dataHash` 唯一，引用行保存消息侧元数据和 canonical blob 关系。
- 不在本轮运行时一致性提交中修改 Prisma schema。

## 错误处理

- 启动 barrier 的单群 backfill 失败记录 source 级错误，但其余来源继续；整体 barrier 完成后 replay 仍运行。
- snapshot 校验失败不得静默从空启动。启动应输出明确 fatal 诊断，避免遗漏消息和旧 ledger。
- shutdown 中每个阶段 best-effort 执行，聚合错误，并保证 Prisma disconnect 最后发生。
- auxiliary LLM 超时只影响 Life Journal，不影响 AgentContext 和主循环。

## 测试策略

- Compaction：证明 summarizer 收到完整待压缩 prefix；证明 compaction 后立即保存。
- Startup：模拟 backfill 晚于 connect，证明 replay 一定在 barrier 之后查询；模拟实时事件与 replay 重叠，继续验证 rowId dedup。
- Shutdown：证明重复信号只执行一次，BotLoop 停止和最终保存发生在 Prisma disconnect 前。
- Usage：证明 Life Journal token 被记录并计入预算；节流窗口不触发 LLM。
- Config：裸 `pnpm test` 在没有 `.env` 时可运行；replay fixture 不依赖真实群号。
- Trace：invoke 成功、inactive、unknown 各只产生一条符合最终结果的 trace。

验证顺序为 focused test、`pnpm typecheck`、`pnpm repo-check`、完整 `pnpm test`。

## 文档同步

- `README.md` / `docs/ARCHITECTURE.md`：更新启动 barrier、辅助 LLM 和 shutdown 流程。
- `docs/AGENT_CONTEXT.md`：增加 compaction 全量纳入摘要和立即持久化约束。
- `docs/OPERATIONS.md`：增加测试环境、retention、graceful shutdown 和 usage coverage。
- `docs/TOOLS.md`：更新 Life Journal 和 deferred trace 语义。
- `.env.example`：修正 groups YAML fallback，补 event debounce 和 token log 配置。
- `docs/HARNESS_COMPARISON.md` / `docs/TECH_DEBT.md`：清理过期状态并登记媒体存储后续阶段。
- `repo-check`：检查文档引用文件存在、关键 env 示例和 prompt/template 入口。
