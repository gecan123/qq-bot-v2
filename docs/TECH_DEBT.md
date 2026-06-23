# 技术债

这里记录能提升后续 agent 可靠性的清理项。优先做小而可机械验证的清理 PR，不要做宽泛重写。

## 当前条目

- 为 docs links 和 prompt entry points 增加更多 `repo-check` 规则。
- 扩展 `agent:doctor`，增加可选的 database、NapCat、LLM provider 和 prompt-rendering probes。
- 扩展 `agent:metrics`，增加趋势窗口和 cache-hit 回归阈值。
- 增加 replay-focused checks，从 `bot_agent_snapshot` 采样并验证稳定序列化。
- 保持 README 和 `docs/` 与当前 single-context runtime 对齐。

## 清理规则

当 agent 因为上下文缺失、过期或难以验证而卡住时，把这次失败转化成以下之一：

- 一个 repository check；
- 一个 focused test；
- 一段短文档更新；
- 一个更安全的 tool interface。
