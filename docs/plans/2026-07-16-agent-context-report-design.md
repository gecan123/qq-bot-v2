# Agent Context 占用分析 CLI 设计

**日期：** 2026-07-16
**状态：** 已确认
**范围：** Bot/backend 的只读运维分析、运行时 request surface 快照与终端报告

## 背景

Claude Code 的 `/context` 会展示模型上下文窗口、当前占用、分类估算和剩余空间。这个项目已经拥有构造同类报告所需的大部分事实：append-only LLM ledger、确定性 projection、working-context 图片降级、显式模型窗口、compaction reserve、provider token usage 和稳定顶层工具面。

直接把 `/context` 做成 QQ 普通消息或 LLM tool 会让 mailbox disclosure、工具调用、工具结果和发送结果继续进入 ledger；把它做成 QQ 控制命令又需要新增一条绕过 `qq_conversation -> send_message` 的控制回复路径。第一版因此选择本地 `pnpm agent:context`：它不经过 QQ、BotLoop 或 LLM，不产生新的 context 内容，也不扩大外部副作用边界。

## 目标

- 新增 `pnpm agent:context`，显示当前 Agent context 的占用分析。
- 命令严格只读，不追加 ledger、不刷新 checkpoint、不修改 runtime cursor，也不调用 LLM 或外部服务。
- 以 canonical ledger 和确定性 projection 为消息事实来源。
- 报告当前模型窗口、当前本地估算、最近一次 provider 实际 input/cache usage、compaction 阈值和剩余空间。
- 按本项目真实 request 结构分类，而不是照搬 Claude Code 不适用的分类。
- 默认输出适合终端阅读的文本，同时提供 `--json` 作为稳定机器接口。
- 数据缺失、运行时 surface 过期或估算来源不同必须显式披露，不能伪装成精确值。

## 非目标

- 第一版不新增 QQ `/context` 控制命令。
- 不新增常驻或 deferred LLM tool。
- 不调用 provider count-tokens API，也不引入 tokenizer 依赖。
- 不把运维日志、surface 快照或 token usage 变成 replay、memory 或 compaction 的事实来源。
- 不修改 compaction 算法、触发条件或 provider request wire format。
- 不生成图片、TUI 交互界面或 Web dashboard。

## 已确认决策

1. 第一入口是本地 `pnpm agent:context`，不是 QQ 命令。
2. CLI 对 LLM context 零污染，并保持数据库和 runtime 严格只读。
3. 默认输出 Claude Code 风格的终端概览；`--json` 暴露同一份结构化报告。
4. 分类 token 使用现有 UTF-8/local-structure 估算口径；provider 只提供总量实测，不能宣称分类值精确。
5. 当前 request surface 的静态部分由 bot 启动时写入一个只含统计元数据的运维快照，CLI 不在离线进程中伪造工具依赖或连接 NapCat。

## 数据边界

### 1. Canonical context

CLI 直接只读查询：

- `bot_agent_ledger_entries`
- `bot_agent_runtime_state`
- 最近一条 `operation=agent.chat` 的 `agent_token_usage`

它复用 `projectAgentLedger` 重建当前 `PersistedAgentSnapshot`。不能通过 `AgentLedgerLoader.load()` 读取，因为 loader 允许 best-effort 刷新 checkpoint；运维命令必须使用与 `agent:ledger-check` 相同的 raw read-only source 边界。

`bot_agent_checkpoint` 不是分析输入。删除 checkpoint 后，报告的 context 分类和估算必须保持一致。

### 2. Working projection

CLI 对 canonical messages 调用现有 `buildWorkingContextProjection`。最近图片引用只通过数据库读取解析；缺失图片使用与生产请求相同的 unavailable marker，旧图片使用相同 omitted marker。这个过程不得 upsert Media 或修改 ledger。

报告同时显示：

- canonical message 数
- working message 数
- hydrated / omitted / unavailable image 数

### 3. Request surface 快照

system prompt 和顶层 tool declarations 在 runtime 装配完成后才能准确确定。离线 CLI 不应为了重建它们而创建 NapCat、sender、scheduler、MCP 或其他真实依赖。

bot 启动时在 `createAgentRuntime()` 完成后，原子覆盖 `logs/context-surface.json`。它是可丢弃的运维 side-data，只保存统计元数据，不保存完整 prompt、schema、密钥或动态消息正文：

- schema version
- generatedAt、pid
- provider、model、contextWindowTokens
- system identity / bot prompt 的 UTF-8 bytes 与 estimated tokens
- 每个当前顶层 tool declaration 的 name、bytes 与 estimated tokens
- tools 合计
- surface fingerprint

Claude 路径的固定 billing identity 和 provider wrapper 计入 system identity；OpenAI 路径计入 developer-message wrapper。active deferred capability 不改变下一轮顶层 tools，因此不要求在每次 capability 切换时重写 surface。

CLI 读取 `.bot.pid` 并以无副作用的进程存在性检查标记 surface 为 `live` 或 `last_startup`。surface 缺失或 schema 不支持时，CLI 仍可报告 ledger/messages，但 system/tools 标为 unavailable，退出码保持成功；canonical ledger 损坏或读取失败才返回非零。

surface 快照不能用于启动恢复、prompt 重建或 compaction。它只回答“最近一次装配的运行时静态 request surface 有多大”。

### 4. Provider usage

最近一次持久化的 `agent.chat` usage 作为独立参考显示：

- timestamp
- model
- inputTokens
- cachedTokens
- outputTokens

它不一定对应当前 ledger head，因此不用于覆盖当前估算，也不按比例伪造分类精确值。报告必须把两者分别命名为 `estimatedCurrentInputTokens` 和 `latestProviderUsage`。

## 分类模型

第一版输出以下互斥顶层分类：

1. `systemIdentity`：provider 固定 identity/wrapper。
2. `botSystemPrompt`：当前 bot system prompt。
3. `visibleTools`：本轮真正发送的顶层 tool declarations。
4. `userAndRuntimeMessages`：user-role 的 mailbox、Goal、compaction summary 和其他受控 runtime disclosure。
5. `assistantToolCalls`：assistant tool call 名称、参数和 envelope。
6. `assistantThinking`：当前 provider 会 replay 的 native thinking blocks。
7. `toolResultsText`：tool result 的文本和结构化非图片内容。
8. `workingImages`：working projection 中实际 hydrated 的 base64 图片输入。
9. `assistantText`：历史中存在的普通 assistant text；当前主 BotLoop 通常为零，但 projection 类型允许存在。

tool result 通过 `toolCallId` 映射回 assistant call，并额外给出按工具名排序的 top contributors。Memory、Notebook、Skills、MCP 只有在对应 tool result 真正进入 messages 时才占用这里的 token；它们不被伪装成常驻分类。active capabilities 和 QQ focus 是 runtime control state，除非实际渲染进 request，否则报告为控制元数据而不计 token。

所有本地分类沿用 `compaction-token-estimator` 的保守思路：按 provider-facing JSON/文本的 UTF-8 bytes、固定 envelope 和结构化 envelope 估算。报告包含 `estimateMethod`，并保证：

- 分类值非负且为安全整数。
- `estimatedCurrentInputTokens` 等于所有可用分类之和。
- percentage 以估算总量为分母。
- unavailable 分类不默认为零；JSON 中显式给出 availability/warnings。

## 窗口与 compaction 指标

模型和 context window 来自 surface 快照；缺失时使用当前显式配置，并增加 warning。绝不根据模型名称猜窗口。

报告计算：

- `contextWindowTokens`
- `estimatedCurrentInputTokens`
- `freeTokens = max(0, window - estimate)`
- `usagePercent`
- `reserveTokens`
- `compactionTriggerTokens = window - reserveTokens`
- `tokensUntilCompaction = max(0, trigger - estimate)`
- `overCompactionTrigger`
- `keepRecentTokens`

这些是诊断值，不触发 compaction，也不修改失败退避。

## CLI 输出

默认 `pnpm agent:context` 输出紧凑终端报告：

```text
Context Usage
Model: claude-opus-4-7 · window 1.0m
Estimated current: 293.4k (29.3%) · free 706.6k
Latest provider input: 291.8k · cached 286.1k

System identity       1.2k   0.1%
Bot system prompt    10.3k   1.0%
Visible tools        18.1k   1.8%
User/runtime         31.4k   3.1%
Assistant calls      22.7k   2.3%
Tool results        207.9k  20.8%
Working images        1.8k   0.2%
Free space          706.6k  70.7%

Compaction trigger: 983.6k · headroom 690.2k
Estimate: local_structure/utf8_bytes
Surface: live
```

渲染层可以使用 Unicode bar，但不能依赖 ANSI 颜色表达语义；重定向到文件时仍可读。数值统一使用确定性 compact formatting。

`pnpm agent:context -- --json` 输出版本化 JSON，不混入日志或说明文字。JSON 是测试和未来 QQ/control adapter 的复用边界，但第一版不实现 adapter。

## 失败与降级

- canonical DB 连接或 integrity 失败：stderr 给出稳定 code，退出码 1，不输出伪报告。
- runtime singleton 缺失：视为 canonical failure。
- surface 缺失/过期：messages 继续分析，system/tools 显式 unavailable，并在 warnings 中说明。
- 最新 provider usage 缺失：字段为 null，不影响当前估算。
- Media 缺失或损坏：沿用 working projection unavailable marker并计数，不让报告失败。
- 输出写入 stdout 失败：沿用普通 CLI 错误语义，不修改任何状态。

## 安全与 replay

- CLI 只允许数据库 read 和受控日志/surface read。
- 不调用 `appendMessages`、`updateRuntime`、`saveCheckpoint` 或任何 tool executor。
- 不启动 NapCat、browser、MCP、scheduler、maintenance reviewer 或真实 bot 进程。
- surface 与 usage 是运维证据，不能反向进入 `AgentContext`、system prompt、memory 或 replay。
- 报告不得打印完整 system prompt、tool schema、message 正文、QQ ID、tool args、图片 base64 或 secret；只输出聚合数、工具名和稳定元数据。

## 代码组织

预计新增：

- `src/ops/agent-context-report.ts`：纯分类、估算、窗口指标和版本化 report。
- `src/ops/agent-context-surface.ts`：静态 runtime surface 统计、schema、原子写入和读取。
- `src/ops/agent-context-report.test.ts`
- `src/ops/agent-context-surface.test.ts`
- `scripts/agent-context.ts`：参数解析、raw read-only Prisma source、working projection 和渲染。

预计修改：

- `src/index.ts`：runtime 装配后写入可丢弃 surface 统计。
- `package.json`：新增 `agent:context`。
- `docs/OPERATIONS.md`：记录用法、估算语义和只读边界。
- 必要时从 provider request builder 导出只负责统计的纯 helper；不得改变现有 request bytes。

不修改 Prisma schema，不新增环境变量。

## 测试策略

### 纯分析测试

- 顶层分类互斥且求和等于总估算。
- assistant tool calls 与多个有序 tool results 正确映射。
- native thinking、assistant text、结构化 tool content 和图片分别归类。
- unknown toolCallId 进入稳定 unknown bucket 并产生 warning，不丢 token。
- free space、compaction headroom、百分比和 0-window 防御正确。

### Surface 测试

- provider-specific identity/system/tool declaration 统计稳定。
- snapshot 不包含完整 prompt、schema、args、base64 或常见 secret 字段。
- 原子覆盖、schema validation、live/last-startup/stale 分类正确。
- surface 缺失和版本不支持时可降级。

### CLI 测试

- 默认文本包含模型、估算、provider usage、分类和 compaction headroom。
- `--json` 只输出合法版本化 JSON。
- canonical read failure 返回退出码 1。
- surface 或 provider usage 缺失仍返回明确的部分报告。
- mock Prisma source 只暴露查询方法，防止测试意外依赖写接口。

### 回归验证

- focused tests 覆盖新的 ops 模块和 script parser。
- `pnpm typecheck`
- `pnpm repo-check`
- 复用 request builder 的测试证明 feature 前后 provider request bytes 不变。

## 后续扩展门

只有本地 CLI 使用稳定后，才考虑：

- owner-only QQ `/context` 控制命令；必须另行设计不进入 mailbox/ledger 的 command receipt 和控制回复审计。
- 历史趋势或按 compaction epoch 对比。
- provider count-tokens API；必须证明本地估算误差影响决策，且保留无网络降级。

这些都不属于第一版。
