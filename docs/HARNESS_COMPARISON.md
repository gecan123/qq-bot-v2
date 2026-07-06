# Claude Code Harness 对照表

本表按 `/Users/zzz/WebstormProjects/learn-claude-code` 新版 `s01-s20` 章节对照当前 `qq-bot-v2` Agent harness。状态用于路线图判断，不代表必须逐项照搬。

| 章节 | qq-bot-v2 状态 | 评价 |
|---|---:|---|
| s01 Agent Loop | 已满足 | 标准 LLM -> tool -> result -> loop，额外有事件队列、snapshot、send 后等待。 |
| s02 Tool Use | 已满足 | 工具集中注册，执行层有 schema 校验、错误隔离、tool-call 审计。 |
| s03 Permission | 部分满足，做得较好 | 有 `workspace_bash` allowlist、repo 只读、blocked paths、timeout/output cap，`send_message` 有 target/ambient 边界；缺统一 permission result/用户审批管线。 |
| s04 Hooks | 部分满足，方向正确 | 已有 executor 级 `beforeTool` / `afterTool` hook，可阻断、追踪、保留原结果；还没有 `UserPromptSubmit`、`Stop`、compact hooks、全生命周期 registry。 |
| s05 TodoWrite | 部分满足 | 有进程内 `todo` 工具，可 `list/update` 当前多步计划，并约束同一时间最多一个 `in_progress`；还不是持久任务图。 |
| s06 Subagent | 未满足 | 没有一次性干净上下文 subagent；长探索仍进入主 `AgentContext`。 |
| s07 Skill Loading | 部分满足 | 有文件型 `skill list/load`，可按需加载 `docs/agent-skills/` 下的长说明；还没有自动相关选择或外部 skill root。 |
| s08 Context Compact | 已满足核心 | 有 token 触发摘要 compaction、safe cut，避免切开 tool call/result；缺 micro-compact、manual compact、完整 transcript 归档。 |
| s09 Memory | 部分满足 | 有 `memory write/search`、journal、sticker pool；没有自动记忆提取、相关记忆预取、Dream/合并去重。 |
| s10 System Prompt | 部分满足，适合本项目 | prompt 分 section 组装，但启动后冻结；这不完全等同教程的运行时动态拼接，但更利于当前 prompt cache 稳定性。 |
| s11 Error Recovery | 部分满足 | 有工具错误隔离、round 失败 backoff、Claude Code 启动自检；缺 `max_tokens` continuation、429/529 retry/fallback、prompt-too-long reactive compact 状态机。 |
| s12 Task System | 未满足 | 没有持久任务图、依赖、owner、blockedBy、状态流转。 |
| s13 Background Tasks | 部分满足 | 图片生成等异步任务会注册 task，完成后进 event queue，并用 `background_task get` 取结果；registry 是内存态，不跨重启，也不是通用后台执行器。 |
| s14 Cron Scheduler | 部分满足 | `pause` 支持 Agent 自定时休息和自动继续，BotLoop 有冷却/日预算 guard；仍没有 durable schedule/list/cancel 工具。`SIGUSR1` tick 仅用于人工调试。 |
| s15 Agent Teams | 未满足 | 没有持久 teammate、inbox、多个 LLM loop。 |
| s16 Team Protocols | 未满足 | 没有 request/response FSM、plan approval、shutdown handshake。 |
| s17 Autonomous Agents | 部分满足概念，不满足机制 | prompt 和 tick 支持空闲自驱；没有任务板自动认领、idle poll、身份重注入。 |
| s18 Worktree Isolation | 未满足 | 当前 bot 不自主改仓库源码；若以后允许 Luna 自主改代码，需要补。 |
| s19 MCP Plugin | 未满足 | 工具池启动期静态组装；没有 MCP discovery、`mcp__server__tool` 命名空间、动态权限。 |
| s20 Comprehensive | 部分满足 | 已有单循环 + 工具 + 权限边界 + context + compaction + memory/background + tool hooks + todo/skill 的主骨架；缺控制平面：subagent/team、scheduler、MCP、完整 recovery。 |

## 当前优先级

1. 先把 s05/s07 做成小而稳定的 runtime 能力：`todo` 和 `skill`。
2. 后续再考虑 s09 自动记忆、s11 错误恢复、s12 持久任务图。
3. s15-s18 属于编程 agent 并行执行面，只有当 Luna 需要自主改代码或并行处理长任务时再引入。
