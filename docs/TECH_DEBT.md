# 技术债

这里记录能提升后续 agent 可靠性的清理项。优先做小而可机械验证的清理，不做宽泛重写。代码、schema、测试和实际日志仍是最终事实来源。

## 当前架构基线

当前是单 Node.js 进程内的模块化单体，主前台只有一个串行 `BotLoopAgent`：

```text
NapCat 入站
  -> messages / media 事实账本
  -> EventQueue 与 mailbox 元数据通知
  -> append-only bot_agent_ledger_entries
  -> AgentContext canonical projection
  -> working-context projection
  -> LLM ReAct
  -> tools / effects
  -> ledger 与 runtime state 原子提交
```

PostgreSQL 保存入站事实、append-only LLM ledger、runtime singleton、Goal 和观测数据；Memory、Notebook、Life Journal、Agenda、schedule、approval 与 background task 元数据主要保存在 workspace Markdown/JSON。WebAdmin 是独立只读运维面。

现有设计的可靠性基础包括：append-only canonical history、确定性 replay、compaction CAS、tool call/result 原子组、显式 QQ target focus、集中 tool policy、渐进式披露、有界 scheduler，以及只读 admin 边界。下面条目是在这些契约之上的具体缺口。

## P0：已确认正确性缺陷

### Delegate 多轮上下文没有延续

- 证据：`src/agent/tools/delegate.ts` 每轮调用 `runReactRound()` 后丢弃返回的 `messagesToAppend`；`src/agent/react-kernel.ts` 只返回 assistant tool call 与 tool result，不直接修改传入 context。因此第二轮仍只看到原始 task，看不到第一轮工具结果。
- 测试缺口：`src/agent/tools/delegate.test.ts` 只验证第一轮输入；mock 的第二轮不依赖第一轮结果，所以无法捕获该问题。
- 影响：需要“先查资料、再根据结果继续查或汇总”的委派任务可能重复调用、臆测结果或耗尽 `maxRounds`。
- 目标：给 delegate 使用独立的临时 Runtime Host，或按顺序把每轮 `messagesToAppend` 安装进其本地 context；继续保证 tool call/result 原子性，且内部 transcript 不进入主 ledger。增加真正依赖前一轮 tool result 的回归测试。

## P1：可靠性与规模风险

### Canonical commit 热路径随永久 ledger 线性增长

- 证据：`src/agent/bot-loop-agent.ts` 的每次 `commitChanges()` 都调用 `reloadProjectionFromCanonical()`；`src/agent/agent-ledger-repo.ts` 的 `loadCanonicalState()` 全量读取所有 entry；`src/agent/agent-ledger-loader.ts` 随后全量校验、projection、稳定序列化并计算 SHA-256 fingerprint。
- checkpoint 当前不是热路径加速器：loader 在判断 checkpoint 是否命中之前已经完成 canonical 全量读取和校验。
- 影响：单次提交趋近 `O(N)`，长期累计成本趋近 `O(N²)`；compaction 只缩短 LLM active view，不减少 permanent ledger 的读取与 fingerprint 成本。
- 目标：所有 append 使用 expected-head CAS；成功提交后用返回的 appended entries/runtime state 增量安装 projection；checkpoint 写入批处理或节流。启动、显式 doctor 和周期审计仍保留完整 chain 校验。增加 1 万/10 万 entry 的 benchmark 与 commit latency 指标。

### 单实例是假设，但没有数据库级 fencing

- 证据：`src/index.ts` 直接覆盖 `.bot.pid`，没有检查旧进程、租约或互斥；两个进程会各自持有独立 `AgentContext`、NapCat handler 和自主循环。runtime row lock 只能串行化单次数据库事务，不能阻止双 loop。
- `appendCompaction()` 和 `updateRuntime()` 校验 expected head，但普通 `appendMessages()` 没有 expected-head CAS。
- 影响：误启动第二实例时可能交错写 ledger、重复处理事件或重复发送 QQ 消息。
- 目标：启动时获取 PostgreSQL advisory lock，或实现带 fencing token 的租约；普通 append 同样校验 expected head。`.bot.pid` 只保留为诊断信息，不作为唯一互斥机制。

### Memory provenance 与 7 天事实保留策略冲突

- 证据：person/group Memory 写入要求真实 `messages.id` 作为 `sourceMessageIds`，但 `src/database/retention.ts` 固定删除 7 天前的所有 Message 行。
- 影响：长期 Memory 仍保留来源 ID，但过期后无法复核陈述者、场景和证据语义，provenance 退化为悬空引用。
- 目标：明确唯一策略并写入契约：延长/配置 Message retention、保护被长期状态引用的证据行，或在 Memory entry 中保存最小不可变证据快照/hash 并明确 provenance horizon。选择前不要默认宣称长期来源可永久验证。

### 缺少真实 PostgreSQL 并发与迁移验证

- 现有 ledger repository 测试主要使用 fake client，能覆盖事务意图，但不能证明 PostgreSQL 行锁、CAS race 和隔离行为。
- 仓库当前没有 GitHub Actions workflow，也没有从空数据库执行全部 Prisma migrations 的持续验证。
- 影响：单元测试全部通过时，锁竞争、迁移顺序、约束差异和双 writer 行为仍可能只在部署环境暴露。
- 目标：CI 至少运行 root test/typecheck/repo-check、WebAdmin test/typecheck/build、fresh database migration；再增加使用真实 PostgreSQL 的 concurrent writer、compaction head race 和 singleton 初始化集成测试。

### 入站媒体去重仍复制 blob

- 当前命中相同 `dataHash` 时会把 canonical `Media.data` 复制进新 placeholder，并保留重复 blob。
- 目标：改为规范化引用模型或安全合并行，同时保持既有 message media handle 稳定，并为并发命中相同 hash 增加数据库级测试。

## P2：可维护性与可观测性

### Startup replay 去重集合无界增长

- `src/agent/dedup-enqueue.ts` 把所有见过的 Message row ID 永久放入进程内 `Set`。
- 这个集合只用于 startup replay 与 live ingest 的重叠窗口；稳态继续积累没有额外正确性收益。
- 目标：在 replay barrier 完成后清空/关闭去重，或改成有界窗口并记录大小指标。

### Usage 与 prompt cache 归因混杂

- delegate 复用 `runReactRound()`，其 token usage 仍记录成 `operation=agent.chat`；OpenAI 请求也固定使用 `prompt_cache_key=qq-bot-v2-main-agent`，没有区分主 Agent 与 delegate prompt。
- Goal token budget 当前只覆盖主 Agent round 的未缓存 input + output；delegate、compaction、Life review、Memory maintenance 等辅助 LLM 调用不进入完整任务成本。
- 目标：建立统一 usage accounting，至少带 `actor/operation/taskId/goalId`；给不同稳定 prompt family 使用不同 cache key，再明确 Goal budget 是“主循环预算”还是“目标总成本预算”。

### BotLoopAgent 职责过密

- `src/agent/bot-loop-agent.ts` 同时协调 persistence、compaction、mailbox、Goal、autonomy、Life hooks 与 recovery，相关测试也集中在一个大型测试文件。
- 目标：只做边界清晰的提取，例如 pure loop policy 与 ledger commit coordinator；保持单主循环和 canonical ledger 契约，不引入第二套 orchestration 或宽泛重写。

### 数据库 singleton 约束主要依赖应用代码

- runtime/checkpoint 都以 `id=1` 作为 singleton，但 schema 没有像 Goal 一样把该约束表达为数据库 CHECK。
- 目标：在 PostgreSQL migration 中补 singleton CHECK，并用 fresh migration test 验证；应用层校验继续保留为错误诊断。

### Migration 与恢复演练不足

- Prisma migration 历史包含多轮创建/删除链。实验性项目若允许重置历史，可在明确确认后建立新的 baseline；否则不要重写已部署 migration，优先增加空库迁移验证。
- PostgreSQL 与 workspace 文件共同构成可恢复状态，目前缺少整体备份、恢复顺序和一致性验收 runbook。

### 文档语义漂移缺少机械保护

- `docs/HARNESS_COMPARISON.md` 曾把 append-only ledger 写成 snapshot、把 Memory v2 写成 v1，并把已存在的 manual compact、完整 transcript 和 compaction hooks 记为缺口。这类语义漂移不会被普通链接检查发现。
- 本次已同步已知漂移；后续只为稳定且可判定的契约增加 `repo-check`，例如 Memory 版本、manual compact 入口和 hook symbol，避免维护脆弱的全文快照。

## 既有运维与模型语义候选

- 扩展 `agent:doctor` 的可选在线 probes，覆盖 NapCat、LLM provider 和 prompt rendering。database 与 canonical ledger 完整性已经由 `agent:ledger-check` 检查，不重复建设。
- 在现有 `agent:daily-metrics --days` 趋势窗口之上增加 cache-hit 回归阈值。
- 为 replay 完整性增加跨运行趋势和告警。把 entry count、projection tokens、checkpoint 状态和错误类型形成可比较的时间序列；`agent:ledger-check` 已读取完整 canonical chain，不再笼统增加“真实 chain 采样”。
- 主 Agent prompt 允许在没有真实行动方向时无工具结束活动轮，但 OpenAI 固定 `tool_choice=required`，Claude 默认配置也使用强制工具调用的 `any`。切换前需要 provider conformance test 覆盖：有明确行动时可靠调用工具、无行动时自然结束、QQ 外发仍只走 `send_message`。LongCat 在 `auto` 下的工具选择行为没有充分证据前继续保留强制调用。

## 条件性观察项

- Memory、Notebook、Life Journal 和 Agenda writer 当前只有单进程按资源键协调。在单 bot writer 部署下这是明确运行约束；只有未来允许多个 writer 进程共享 workspace 时，才增加跨进程互斥或改成单 writer service。
- 长期状态当前坚持 Markdown 扫描和确定性 lexical scoring。先积累规模、延迟和召回质量证据；只有出现可复现瓶颈时，才评估可从 Markdown 重建的 SQLite FTS/BM25 或 embedding 派生索引。
- s12 多任务图/依赖、s15/s16 多 Agent team/protocol 和 s18 worktree isolation 只有在产品确实需要长期协作或自主改代码时再引入，不把单一 Goal 扩成第二主循环。

## 推荐偿还顺序

1. 修复 delegate 多轮上下文并补回归测试。
2. 增加数据库级单实例 fencing，并让普通 ledger append 使用 expected-head CAS。
3. 把 ledger commit 改为增量 projection，增加规模 benchmark。
4. 清理 startup dedup `Set` 的稳态无界增长。
5. 明确 Memory evidence retention 模型。
6. 建立 CI、fresh migration 和真实 PostgreSQL 并发测试。
7. 再处理媒体 blob 去重、统一 usage accounting、singleton 约束和恢复 runbook。

## 持续维护

- README、`docs/`、prompt entry points 和 single-context runtime 必须保持一致。
- 当 agent 因上下文缺失、过期或难以验证而卡住时，把失败转化为 repository check、focused test、短文档更新或更安全的 tool interface。
