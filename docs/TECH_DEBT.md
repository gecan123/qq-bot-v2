# 技术债

这里记录能提升后续 agent 可靠性的清理项。优先做小而可机械验证的清理，不做宽泛重写。代码、schema、测试和实际日志仍是最终事实来源。

## 当前架构基线

当前是一个 Agent Core 加数个窄职责本机 sidecar，主前台仍只有一个串行 `BotLoopAgent`：

```text
QQ / 飞书入站
  -> QQ Gateway / Feishu Gateway
  -> messages / media 事实账本
  -> Agent Core database mailbox watcher
  -> EventQueue 与 mailbox 元数据通知
  -> append-only bot_agent_ledger_entries
  -> AgentContext canonical projection
  -> working-context projection
  -> LLM ReAct
  -> tools / effects
  -> ledger 与 runtime state 原子提交
```

QQ Gateway、Feishu Gateway 和 Media Worker 通过 PostgreSQL 事实边界或薄 HTTP 与 Agent Core 协作；不使用通用 broker。短期 ScheduleRuntime、occurrence 与 pending delivery 都由 Agent Core 进程内持有，Agent Core 和 Media Worker 直接调用配置的 LLM provider。只有 Agent Core 可以拥有 `AgentContext`、推进 runtime singleton 和写 canonical ledger。PostgreSQL 保存入站事实、append-only LLM ledger、runtime singleton、Goal 和观测数据；Memory、Notebook、Life Journal、Agenda、schedule 与 background task 元数据主要保存在 workspace Markdown/JSON。WebAdmin 的观察 feature 保持只读，固定 operations feature 是唯一受控写入口。

现有设计的可靠性基础包括：append-only canonical history、确定性 replay、compaction CAS、tool call/result 原子组、显式跨平台 conversation focus、集中 tool policy、渐进式披露、有界 scheduler，以及 WebAdmin 的只读观察边界和固定 operations 写入边界。下面条目是在这些契约之上的具体缺口。

## P0：已确认正确性缺陷

当前没有已知未修复的 P0 正确性缺陷。2026-08-23 已统一 canonical/legacy QQ 与飞书 mailbox key 解析，并为 inbox cursor、compaction projection、effect interpretation 增加统一契约测试。

## 2026-08-23 已完成的可靠性与结构收敛

- 普通 ledger append 已增加 expected-head CAS；日常提交使用 `LedgerCommitCoordinator` 增量安装已验证 projection，不再每次全量 replay。启动、compaction 后刷新、`agent:ledger-check` 与 WebAdmin 手动 Deep Integrity 仍保留完整 chain 校验。
- Agent Core 启动持有专用 PostgreSQL session advisory lock；`.bot.pid` 只保留诊断意义。
- QQ/飞书入站事实写入与撤回使用有界 transient retry 和小抖动；最终失败进入结构化 NDJSON，Health 展示最近 24 小时计数。Mailbox watcher 保持不自动跳过 poison row，并暴露阻塞 row、连续失败和错误分类。
- 独立 Media Worker 复用有界 scheduler，Browser 与全部本机服务 URL 共用 loopback origin parser。
- WebAdmin Metrics 默认读取 NDJSON 并明确 source/coverage/truncated；会话页覆盖 QQ 与飞书；Health 常规刷新只做 quick metadata check，完整 replay 由 operator 手动触发。
- `BotLoopAgent` 已把 persistence、compaction 与循环决策分别下沉到 `LedgerCommitCoordinator`、`CompactionCoordinator` 与纯 `LoopPolicy`；Memory、Notebook、Life Journal 共享薄的 Markdown revision/CAS/atomic-write 基础设施。

## P1：可靠性与规模风险

### 已偿还：Canonical commit 热路径随永久 ledger 线性增长

- 状态：已完成。普通 commit 不再调用 canonical loader；commit、ledger load、projection/fingerprint 与 checkpoint refresh 分别记录耗时。
- `pnpm bench:ledger-commit` 固定覆盖 1 万/10 万 permanent entry 的合法 compacted ledger；增量路径实际调用 `LedgerCommitCoordinator`，包含 `AgentContext` 克隆、active projection 校验与 runtime state 安装，避免用数组切片冒充 commit 成本。
- 完整校验仍是明确的低频/启动路径；checkpoint 是可丢弃 cache，不会掩盖 canonical 损坏。

### 已偿还：Agent Core 数据库级 fencing

- 状态：已完成。`src/database/agent-core-lock.ts` 使用专用连接持有 session advisory lock，shutdown 明确释放；普通 append、runtime update 与 compaction 全部校验 expected head。

## P2：可维护性与可观测性

### 多进程交付仍是单机轻量契约

- QQ Gateway、Feishu Gateway 和 Agent Core 当前都按单实例运行；database mailbox watcher 只使用进程内 high-water cursor，没有 consumer lease。
- Agent Core 内的 ScheduleRuntime 使用本机持久 delivery store 恢复未确认 wake，并以 canonical ledger 落账作为完成确认；它仍是单机单实例契约，不支持多主或跨机器共享状态。
- Media Worker 的游标轮转会越过冷却中的旧行，停机也会有界等待在途描述；但它没有数据库 claim/lease，当前只能运行一个实例。Agent Core 与 Media Worker 直连 provider，不提供独立 wire proxy 的统一请求字节日志。
- 这些是当前明确限制。只有日志或故障复现证明需要时，才分别增加 claim/lease、streaming 或跨主机交付；不要先引入 Redis、Kafka、通用 outbox/broker 或集群选主。

### TODO：飞书重启窗口尚未补拉

- Feishu Gateway 当前只消费官方 WebSocket ready 之后的新事件；没有历史导入，也没有按时间窗或游标补拉停机期间消息。
- 这是为保持第一版简单而接受的明确缺口。只有真实漏消息证据出现后，再设计有界 restart backfill 与幂等对账；不要顺带引入独立 egress、通用 outbox、复杂重试或平台降级状态机。

### 飞书编辑事件需要实机契约验证

- 当前 Gateway 把 `im.message.receive_v1` 中 `update_time > create_time` 的 payload 追加为 `edit` 事实；当前 Node SDK 事件类型只有消息接收和撤回，没有单独的消息编辑事件声明。
- 因此代码已能处理收到的编辑态 payload，但尚未用真实飞书连接证明“用户在首次入库后编辑消息”会再次触发接收事件。切换时应把它列入 smoke test；若平台不重投，再基于实际 OpenAPI 能力增加有界查询，不先建设轮询平台或历史同步系统。

### Goal 总成本与非 Agent LLM 路径尚未统一

- `LlmClient` 路径已经统一记录 callId、actor/operation/taskId/goalId、provider/model、成功/失败/取消、耗时、stop reason、token/cache 和不含正文的四段结构 evidence；主 Agent、compaction、Memory maintenance、Goal completion judge、startup probe、`fetch_url` 摘要与长期状态翻译均已接入。
- Life Journal 和媒体描述等 `src/llm/openai-adapter.ts` 路径仍主要使用 AsyncLocal usage 聚合，没有进入同一逐调用 trace；不同稳定 prompt family 的 cache key 分离也没有形成统一契约。
- Goal token budget 当前只覆盖主 Agent round 的未缓存 input + output；包括完成验收在内的辅助 LLM 调用不进入完整任务成本。
- 目标：决定是否让非 `LlmClient` 路径复用同一安全 trace，再建立稳定 prompt-family 分离，并明确 Goal budget 是“主循环预算”还是“目标总成本预算”。

### BotLoopAgent 职责过密

- persistence、compaction 与循环决策已经提取为三个深模块；主循环仍是唯一 orchestration，没有引入第二套 runtime。
- 剩余 mailbox/Goal/recovery 只有在继续出现可独立测试的稳定边界时再提取，不按行数机械拆分。

### 数据库 singleton 约束主要依赖应用代码

- 已通过 `20260823010000_enforce_agent_singletons` 为 runtime/checkpoint 增加数据库 CHECK；应用层校验继续保留为错误诊断。

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

1. 根据个人使用周期调整 `BOT_INBOUND_RETENTION_DAYS`；当前契约明确 provenance 只在该窗口内保证原文可回查。
2. 观察 Feishu 重启窗口、编辑事件和 Markdown lexical recall 的真实证据，再决定是否补平台 backfill 或派生检索索引。
3. 不为个人实验项目预建 HA、broker、跨主机恢复或多 Agent；只有可测量痛点出现时再扩展。

## 持续维护

- README、`docs/`、prompt entry points 和 single-context runtime 必须保持一致。
- 当 agent 因上下文缺失、过期或难以验证而卡住时，把失败转化为 repository check、focused test、短文档更新或更安全的 tool interface。
