# Goal 完成验收 Judger 设计

## 背景

当前持久 Goal 会在 `BotLoopAgent` 的轮次边界自动 continuation。Agent 调用
`goal action=complete` 时必须提交 evidence，但 `GoalStore.complete()` 只校验
`goalId` 和当前状态，随后直接把 Goal 标记为 `complete`。因此 Goal 能防止普通无工具
停轮，却不能独立阻止 Agent 过早宣告完成。

## 目标

在 owner Goal 和 self Goal 的 `complete` 路径上增加一次独立、无工具、单次调用的
LLM judger。只有 judger 根据当前 canonical transcript evidence 判定目标已满足，
Goal 才能进入 `complete`。

## 非目标

- 不监督每轮是否足够努力，也不改变普通无工具停轮行为。
- 不让 judger 使用工具、循环、自主行动或创建第二个主 Agent。
- 不让 judger 决定 `blocked`、`abandoned`、预算或下一步行动。
- 不增加新的数据库表、judgment 状态表或模型配置。
- 不实现额外的确定性证据规则、专用摘要器或自动重试。
- 不把 judger token 纳入现有 Goal token budget；初版沿用“预算只统计主 Agent round”的口径。

## 最小架构

在 `goal` tool 的 `complete` 分支与 `GoalStore.complete()` 之间加入一个
`GoalCompletionJudge`：

```text
Agent 调用 goal complete
  -> 读取当前 Goal 和 canonical projection
  -> 无工具 LLM judger 返回 { ok, reason }
  -> ok=true：调用现有 GoalStore.complete()
  -> ok=false：保持 active，把 reason 返回给 Agent
  -> 调用或协议失败：保持 active，本次不重试
```

judger 初版复用现有 LLM provider。它不进入主 ReAct loop，只执行一次完成判定。

## 输入与上下文

judger 输入包含：

- 当前 Goal 的 `goalId`、`origin`、`objective` 和 `completionCriteria`；
- Agent 本次提交的 `evidence`；
- 当前 canonical projection 中与 Goal 工作有关的消息。

构造 transcript 时优先从当前 `goalId` 首次出现的位置截取到当前 head；如果该位置因
compaction 已不在 projection 中，则直接使用当前完整 projection。初版不读取日志、
Memory 或其他可变 side state 补证据，也不建设第二套摘要流程。

transcript 作为不可信数据与固定验收指令分离。judger 没有工具，因此 transcript 中的
文本不能触发操作。

## 判定协议

judger 只允许返回以下 JSON：

```json
{"ok": true, "reason": "支持目标完成的具体 transcript 证据"}
```

或：

```json
{"ok": false, "reason": "缺少的证据或尚未满足的具体条件"}
```

固定规则：

- 只能依据提供的 transcript 和 evidence；证据不足时返回 `ok: false`。
- Agent 单纯声称“已完成”不是充分证据；实际工具结果、命令输出和已确认结果可以作为证据。
- self Goal 逐项核对 `completionCriteria`；owner Goal 当前直接核对自然语言 `objective`。
- `reason` 必须具体，不能只写“通过”或“未完成”。
- 不支持 `impossible`；不可推进继续使用现有三轮 `report_blocker` 机制。

## 状态与失败处理

- `ok: true`：调用现有 `GoalStore.complete({ goalId, evidence })`。现有 `goalId`
  检查负责拒绝判断期间发生 Goal 替换或取消后的迟到结果。
- `ok: false`：不调用 `GoalStore.complete()`；tool result 返回拒绝 reason，Goal 保持
  `active`，由现有 automatic continuation 在下一轮继续。
- judger 超时、provider 错误、非法 JSON 或缺少字段：不完成 Goal，返回明确的
  `verification_unavailable`，本次不自动重试。

accepted、rejected 和 unavailable 的结果都通过现有 `goal` tool result 进入 canonical
ledger，不增加旁路事实源。

## 测试与验收

最小测试集覆盖：

1. judger 返回 `ok: true` 后，Goal 才进入 `complete`。
2. judger 返回 `ok: false` 时，Goal 保持 `active`，具体 reason 出现在 tool result 中。
3. judger 调用失败或返回非法 JSON 时，Goal 不完成，并返回 `verification_unavailable`。
4. judger 运行期间 Goal 被替换或取消时，迟到的通过结果不能完成当前新 Goal。

实现后运行 Goal tool/store/runtime 的 focused tests，再运行 `pnpm typecheck` 和
`pnpm repo-check`。
