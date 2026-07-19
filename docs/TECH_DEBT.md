# 技术债

这里记录能提升后续 agent 可靠性的清理项。优先做小而可机械验证的清理 PR，不要做宽泛重写。

## 当前条目

- 为 docs links 和 prompt entry points 增加更多 `repo-check` 规则；Memory 架构的事实来源、ledger/checkpoint 和不可信数据边界已有基础检查。
- 扩展 `agent:doctor`，增加可选的 database、NapCat、LLM provider 和 prompt-rendering probes。
- 扩展 `agent:metrics`，增加趋势窗口和 cache-hit 回归阈值。
- 扩展 replay-focused checks，在 `agent:ledger-check` 基础上增加更多真实 ledger chain 采样和趋势告警。
- 为 `agent_tool_calls`、`agent_token_usage` 和 NDJSON 日志定义统一 retention/归档策略；当前启动清理只覆盖 7 天前的 messages/media。
- 收紧入站媒体去重：当前命中相同 `dataHash` 时会把 canonical `Media.data` 复制进新 placeholder，并保留一份重复 blob。后续应改为规范化引用模型或安全合并行，同时保持 message media handle 稳定。
- 当前 Memory、Notebook、Life Journal 和 Agenda writer 只有单进程按资源键协调；如果未来允许多个 bot writer 进程共享 workspace，需要增加跨进程互斥或改成单 writer service。
- `agent:reset-memory` 实际会同时删除 ledger、checkpoint/runtime、Goal、memory、Notebook 和 Life 状态；虽然 CLI 入口仍有确认门，仍应改成更准确的 state reset 名称，或拆出可显式选择的 scopes。
- Life Journal usage 已进入统一观测日志，但 BotLoop 的进程内每日自主预算目前只累计主 Agent round token；是否纳入 compaction/review 需要统一预算接口后再决定。
- 长期状态当前坚持 Markdown 扫描和确定性 lexical scoring。先积累规模、延迟、召回质量证据；只有出现可复现瓶颈时才评估可从 Markdown 重建的 SQLite FTS/BM25 或 embedding 派生索引。
- 保持 README 和 `docs/` 与当前 single-context runtime 对齐，并逐步把关键契约转成 `repo-check` 规则。

## 清理规则

当 agent 因为上下文缺失、过期或难以验证而卡住时，把这次失败转化成以下之一：

- 一个 repository check；
- 一个 focused test；
- 一段短文档更新；
- 一个更安全的 tool interface。
