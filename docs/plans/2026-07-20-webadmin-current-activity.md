# WebAdmin 当前活动面设计

## 目标

让只读 WebAdmin 首页直接回答：Agent 为什么醒来、此刻处于哪一阶段、正在执行什么、最近完成了什么，以及下一项可检查结果是什么。

## 事实边界

- `bot_agent_ledger_entries` 继续是唯一持久 LLM history source；当前活动面不能进入 replay 或反向重建 context。
- `bot_agent_goal.current_commitment` 是持久 Goal 当前步骤的权威来源。
- `agent_tool_calls` 是已经完成的工具审计证据，不表示工具仍在执行。
- 进程内 phase、并发工具、等待原因和唤醒原因写入 `logs/agent-activity.json`。它是可丢弃的 best-effort 观察面，不是控制状态或事实账本。
- AdminWeb 只读以上来源，不提供 wake、send、compact 或状态更新接口。

## 数据流

```text
BotLoopAgent / ToolExecutor
  -> AgentActivityReporter
  -> atomic logs/agent-activity.json

PostgreSQL Goal / runtime / completed tool calls ----+
                                                     +-> WebAdmin overview DTO -> Browser
logs/agent-activity.json ----------------------------+
```

## Runtime phase

- `starting`：主循环准备启动。
- `thinking`：主 LLM round 正在决定或生成工具调用。
- `tool`：至少一个普通工具正在执行。
- `resting`：`pause` / `rest` 正在计时，可被注意事件打断。
- `committing`：本轮工具结果正在写入 canonical ledger/runtime。
- `waiting`：等待新消息、定时唤醒、后台结果或退避到期。
- `error`：本轮失败，正在进入有界退避。
- `stopping` / `stopped`：生命周期收尾或已结束。

工具可以并行，因此 surface 保存 `activeTools[]`，而不是单一 `currentTool`。每次更新使用同目录临时文件加 rename，避免 WebAdmin 读到半截 JSON。写入失败只能记录 warning，不得影响 Agent 行为。

## 页面结构

首页第一屏依次展示：

1. 当前状态、阶段持续时间、最近刷新时间。
2. 当前 Goal；没有持久 Goal 时明确显示，而不是从日志猜一个 Goal。
3. 当前步骤：优先 Goal `currentCommitment.action`，否则展示正在执行的工具或当前等待条件。
4. 唤醒原因、当前 QQ focus、下一项预期证据/等待条件。
5. 最近进展：把已完成工具调用翻译成简短动作，默认隐藏 toolCallId、roundIndex、参数 JSON 等技术细节。

`/context` 和 `/timeline` 保留为下钻诊断页，不承担“现在正在干什么”的主要入口。

## 验证

- Reporter 状态转换、并发工具和原子 writer 使用 focused test。
- Overview service 测试 live/missing/stale surface、Goal commitment 和最近进展翻译。
- Overview 组件测试当前状态、步骤、等待条件与技术细节。
- 运行 AdminWeb test、typecheck、build，以及根 `pnpm repo-check`。
