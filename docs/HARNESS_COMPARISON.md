# Claude Code Harness 对照表

本表按 `/Users/zzz/WebstormProjects/learn-claude-code` 新版 `s01-s20` 章节对照当前 `qq-bot-v2` Agent harness。状态用于路线图判断，不代表必须逐项照搬。

| 章节 | qq-bot-v2 状态 | 评价 |
|---|---:|---|
| s01 Agent Loop | 已满足 | 标准 LLM -> tool -> result -> loop，额外有事件队列、append-only ledger projection 和显式 `rest`；普通动作完成后立即继续下一轮。 |
| s02 Tool Use | 已满足核心 | 工具集中注册，执行层有 schema 校验、错误隔离、结构化恢复提示和 tool-call 审计；同轮连续的显式只读调用可以并行，结果仍按原 tool-call 顺序 append，未知工具和副作用调用保持 exclusive barrier。 |
| s03 Permission | 已满足核心，面向自主执行 | 不设置通用人工审批层；`workspace_bash` allowlist、repo 只读、blocked paths、timeout/output cap、`send_message` target/ambient 边界，以及各写工具的 revision/path/schema 限制直接约束执行范围。 |
| s04 Hooks | 部分满足，方向正确 | 已有 executor 级 `beforeTool` / `afterTool` hook，以及 compaction 的 `beforeCompact` / `afterCompact`；还没有 `UserPromptSubmit`、`Stop` 或统一的全生命周期 registry。 |
| s05 TodoWrite | 有意不实现 | 当前连续执行状态由主循环和 tool result 直接承接，跨重启工作只使用 Goal；删除独立 Todo 避免第三套计划状态。 |
| s06 Subagent | 有意不提供通用能力 | 通用 clean-context subagent 已移除，避免维护第二套多轮 LLM 控制流；`trading_agent` 继续作为边界明确的专用金融研究 worker，主前台仍只有一个通用 LLM loop。 |
| s07 Skill Loading | 已满足核心 | 主 Agent 有有界的 `skill list/load`；skill 内容由开发者直接维护在 `docs/agent-skills/`，不提供运行时编辑器。仍没有多 skill root 或自动相关选择。 |
| s08 Context Compact | 已满足核心 | 有 token threshold/overflow 触发的摘要 compaction、完整 prefix summarization、safe cut、CAS append-only boundary 和 `beforeCompact` / `afterCompact` hooks，避免切开 tool call/result；完整 transcript 保留在 permanent ledger，LLM 请求另有 working-context 投影，旧图片只在视图中降级。聊天控制面不再提供 `/compact`。 |
| s09 Memory | 已满足核心 | 主 Agent 的 `memory` 只暴露 `remember/recall/correct`；recall 做有界相关召回并返回 opaque ref，文件、revision、生命周期和整理都留在模块内部。Notebook 只保存跨天主题过程，当前承诺由 Goal 表示。 |
| s10 System Prompt | 部分满足，适合本项目 | prompt 分 section 组装，但启动后冻结；这不完全等同教程的运行时动态拼接，但更利于当前 prompt cache 稳定性。 |
| s11 Error Recovery | 核心已满足 | 有工具错误隔离、provider-neutral stop reason、transport/429/5xx/529/SSE overload 有界退避、`retry-after`、prompt-too-long 强制 compaction、`max_tokens` 预算升级与有界 continuation、显式同 provider fallback、round backoff、replay barrier 和幂等 shutdown。仍可补 OpenAI 错误的更细分类与恢复指标汇总。 |
| s12 Task System | 部分满足 | 单一持久 Goal 支持 `origin=owner|self`、状态流转、revision、token/time/round 使用量、完成证据、独立无工具完成验收和三轮 blocker 门槛，并能跨 replay/compaction/restart 续跑；Agent 可自主建/弃 self Goal，owner Goal 可抢占。仍没有多任务图、依赖、认领或 blockedBy DAG。 |
| s13 Background Tasks | 已满足核心 | 图片生成、交易研究等异步任务会注册 task，完成后进 event queue，并用 `background_task get` 取有界结果；registry 已原子持久化、终态幂等，重启时不可恢复闭包明确标成 `interrupted`。共享执行 scheduler 仍是进程内 lane；实验阶段不建设通用 `jobKind + payload` 自动恢复层，接受在途任务因重启中断并按需重新发起。 |
| s14 Cron Scheduler | 已满足所需子集 | `schedule create/list/get_occurrence/cancel` 只支持 30 秒至 3 天内的一次性 `at` / `afterSeconds`。独立 store 可跨重启恢复 timer，到期只产生一次稳定 `scheduled_wake` 注意事件；周期调度、命令执行和 run history 留给 operator。 |
| s15 Agent Teams | 未满足 | 没有持久 teammate、inbox、多个 LLM loop。 |
| s16 Team Protocols | 未满足 | 没有多 Agent request/response FSM、plan approval 或 teammate shutdown handshake；当前是本机多进程 platform 加单一 Agent Core，进程拆分不等于多 Agent 协议。 |
| s17 Autonomous Agents | 产品目标上已较强满足 | 主 Agent 在发送或完成其他动作后持续寻找下一件事；只有显式 `rest` 才主动暂停且可被注意事件打断，不设置普通 idle backoff、每日 token 预算或跨日限流。active Goal 会在每轮和 compaction 后重注入为默认主线，Schedule 负责未来时点重新评估。 |
| s18 Worktree Isolation | 未满足 | 当前 bot 不自主改仓库源码；若以后允许 Luna 自主改代码，需要补。 |
| s19 MCP Plugin | 有意不提供 | 当前没有真实 MCP 连接需求，已删除未启用的 MCP manager、tool、配置和 SDK 依赖；有明确 server 与使用场景后再按实际契约接入。 |
| s20 Comprehensive | 单 Agent 产品骨架成熟 | 已有单循环 + 永续 context/replay + working projection + mailbox + 单一持久 Goal + deferred typed tools + 工具内权限边界 + recovery + compaction + durable typed background task/schedule + explainable memory + hooks + skill + 安全并行 + 自主循环。 |

## 本轮路线图落地状态

1. LLM 恢复状态机：完成。覆盖 transient retry、`retry-after`、context overflow 强制 compact、`max_tokens` 预算升级/有界 continuation、同 provider fallback，并保证截断 tool call 不执行。
2. 分层上下文：完成第一阶段。durable ledger 不变，working projection 只降级较旧图片字节并输出 hygiene 指标。
3. 持久后台任务与调度：完成所需子集。后台状态原子持久化；不可恢复任务重启后明确 `interrupted`；独立 schedule 支持一次性 `at|afterSeconds`、3 天窗口和重启恢复。
4. 记忆召回与整理：主 Agent 收敛为 `remember/recall/correct`；entry 级 lexical recall 可解释且带 provenance/revision，维护整理在内部 lane 完成。
5. 工具内执行边界：当前采用 target、revision、路径、schema、allowlist、timeout 和副作用审计直接约束工具，不设置通用 owner approval。
6. 安全并行：完成核心。只并行连续的显式只读调用，副作用和未知调用构成 barrier，tool result 仍按原 assistant call 顺序进入 ledger。
7. MCP：当前无真实连接需求，已删除整套未启用能力，避免为假设扩展维护额外接口。
8. 单一持久 Goal：完成核心。owner 私聊控制、Agent 自建/放弃 self Goal、owner 抢占、Postgres 状态、snapshot revision、跨重启/compaction continuation、宽松保险丝、预算核算、完成证据、单次无工具 LLM 验收和三轮 blocker 门槛均已接入；只有验收 `{ok:true}` 才完成，主前台仍严格串行。

## 后续优先级

1. P2 根据真实召回失败样本评估 embedding/rerank；lexical provenance 继续保留为可解释基线。
2. P2 根据 token/latency 指标再决定 text/tool-result micro-compact 和 recovery 指标面板，不凭感觉提前删上下文。
3. 通用 durable job 恢复层不列入当前路线图；只有重启丢失昂贵长任务形成可测量痛点，或外部服务原生提供可恢复 task/session ID 时再重新评估。
4. s12 的多任务图/依赖、s15/s16 多 Agent team/protocol、s18 worktree isolation 只在 Luna 真正需要长期协作或自主改代码时引入；不把单一 Goal 扩成第二主循环。
