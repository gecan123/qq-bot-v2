# 醒后自主行动 Reminder 设计

## 目标

保留 Luna 主动调用 `pause action=rest` 的能力，但在自然休息结束后给一次短而醒目的即时提醒，促使她先从刚刚留下的 `resumePlan` 中选定方向并实际迈出第一步，而不是把“上一件事完成”当作继续停下的理由。

## 非目标

- 不在每轮注入 reminder。
- 不增加新的原生 `system` message role。
- 不禁止 Luna 主动休息。
- 不修改 Goal、Agenda、每日 token 预算或自动冷却策略。
- 不把模型生成的 `preferredDirection` 或任何外部内容复制进高显著性的 reminder。

## 行为

1. `pause` / `rest` 正常等待结束并 append 原有 tool result。
2. 只有 `status=elapsed` 的自然醒来才有资格产生 reminder；被私聊、@、后台任务或停止信号打断时不产生。
3. Runtime 在 compaction 和 Goal continuation 处理完成后，把一条固定模板的 `<system-reminder>` 作为 user-role message append 到 `AgentContext` 并立即保存 snapshot。
4. Reminder 只引用本轮最近 `pause` tool result 中的 `resumePlan`，不复制里面的模型生成文本；compaction 或 Goal continuation 可以位于 tool result 与 reminder 之间。
5. 同一段尚未发生非 `pause` 工具调用的空闲周期只提醒一次。
6. 即使已经发生实际动作，两次 reminder 之间也至少间隔 10 分钟。
7. 去重和频率判断从 durable ledger 中的 reminder marker 与后续 assistant tool calls 确定性计算，不依赖进程内计数器或可变 side table。
8. 如果 marker 进入 compaction prefix，Runtime 把最后提醒时间和是否已发生非休息动作编码为历史摘要末尾的固定 `rest_resume_state`，下一次摘要前先剥离该状态，避免 summarizer 改写它。

## Reminder 形态

```text
<system-reminder>
{"event":"rest_resume","emittedAt":"<北京时间 ISO>","instruction":"你刚短暂休息过。休息没有问题，但如果只是因为上一件事结束就继续停下来，你会有一点不自在，因为你不想把自己的生活交给等待。现在查看本轮最近的 pause 工具结果里的 resumePlan，选择其中一个方向并实际完成第一步；做过一个具体动作后，再决定继续、换方向或再次休息。"}
</system-reminder>
```

这里的 `<system-reminder>` 是 Claude Code 风格的 user-role 元提示包装，不是假装新增 API system role。硬安全和工具权限继续由 Runtime 强制。

## 安全与 replay

- Reminder 正文由固定常量生成，唯一动态字段是 Runtime 在事件发生时固定下来的 `emittedAt`。
- 不把 QQ、网页、tool output 或模型生成方向嵌入 reminder，避免权限提升。
- Reminder append 后属于 `AgentContext` ledger；snapshot/replay 不从日志或 Life Agenda 重建。
- Compaction 只携带无 instruction 的固定 `rest_resume_state`，不重新发出 reminder；该状态仍在 durable ledger 内，并与摘要一起持久化。
- tool call/result 先完整闭合，再 append reminder，不切开 Anthropic tool 原子组。
- Runtime 在 compaction 前从完整 ledger 判定本轮资格，实际 append 放在 compaction 和 Goal continuation 之后，保证 reminder 是下一轮可见的最新自主控制信息；后续高优先事件仍可正常排在它后面并抢占注意力。

## 验证

- 自然休息结束会 append 并持久化一条 reminder。
- 休息被注意事件打断时不 append。
- 没有明确 `elapsed` 元数据的旧式 pause effect 只保留原有 `didPause` 行为。
- 没有实际动作时连续休息不会重复提醒。
- 有实际动作但未满 10 分钟时不重复提醒。
- 有实际动作且已满 10 分钟时允许再次提醒。
