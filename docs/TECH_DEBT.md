# 技术债

这里记录能提升后续 agent 可靠性的清理项。优先做小而可机械验证的清理 PR，不要做宽泛重写。

## 当前条目

- 扩展 `agent:doctor` 的可选在线 probes，覆盖 NapCat、LLM provider 和 prompt rendering。database 与 canonical ledger 完整性已经由现有 `agent:ledger-check` 路径检查，不再重复记为缺口。
- 在现有 `agent:daily-metrics --days` 趋势窗口之上增加 cache-hit 回归阈值。
- 为 replay 完整性增加跨运行趋势和告警。`agent:ledger-check` 已读取并校验完整 canonical chain，不再需要笼统的“增加真实 chain 采样”；缺口是把 entry count、projection tokens、checkpoint 状态和错误类型形成可比较的时间序列。
- 收紧入站媒体去重：当前命中相同 `dataHash` 时会把 canonical `Media.data` 复制进新 placeholder，并保留一份重复 blob。后续应改为规范化引用模型或安全合并行，同时保持 message media handle 稳定。
- 明确 Goal token budget 的成本边界。当前 Goal 只按主 Agent round 的未缓存 input 加 output 记账，compaction、Life review 和 Memory maintenance 由统一观测记录但不计入 Goal；如果 Goal budget 要表达完整任务成本，应先建立统一 usage accounting 接口。
- 主 Agent prompt 允许在没有真实行动方向时无工具结束活动轮，但 OpenAI 路径当前固定 `tool_choice=required`，Claude 默认配置也使用强制工具调用的 `any`。这会让模型在本应安静时倾向调用低价值工具，与“不为证明自主而保持忙碌”的语义存在冲突。现有 provider conformance test 只覆盖请求投影、replay 和错误归一化；切换前还需覆盖有明确行动时可靠调用工具、无行动时自然结束、QQ 外发仍只走 `send_message`。LongCat 当前在 `auto` 下的工具选择仍不稳定，因此确认模型版本行为前继续保留强制调用。

## 条件性观察项

- Memory、Notebook、Life Journal 和 Agenda writer 当前只有单进程按资源键协调。在单 bot writer 部署下这是明确运行约束，不是近期清理项；只有未来允许多个 writer 进程共享 workspace 时，才增加跨进程互斥或改成单 writer service。
- 长期状态当前坚持 Markdown 扫描和确定性 lexical scoring。先积累规模、延迟和召回质量证据；只有出现可复现瓶颈时，才评估可从 Markdown 重建的 SQLite FTS/BM25 或 embedding 派生索引。

## 持续维护

- README、`docs/`、prompt entry points 和当前 single-context runtime 必须保持一致。只在出现具体漂移或事故模式时增加对应 `repo-check`，不要保留无法判定完成的“增加更多检查”条目。

## 清理规则

当 agent 因为上下文缺失、过期或难以验证而卡住时，把这次失败转化成以下之一：

- 一个 repository check；
- 一个 focused test；
- 一段短文档更新；
- 一个更安全的 tool interface。
