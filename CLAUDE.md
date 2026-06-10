# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**This file holds long-term contracts only.** Phase, current default values, file layout, env vars, module map, recent decisions — see `docs/current-state.md`. When implementation details change, update that file, not this one. Keeping CLAUDE.md stable is itself part of the perpetual-context contract: this file is loaded into every session and any churn here invalidates prompt cache for every workflow that reads it.

## Git Commit Messages

Commit message format: `<type>: <中文描述>`

The description (after the colon) must be written in Chinese. The `type` prefix stays in English (feat, fix, refactor, docs, test, chore, perf, ci).

## Project Overview

qq-bot-v2 是一个**单上下文 + 主动 + 被动**的 QQ Agent。接 NapCat 听 QQ 群 + 私聊，把消息存进 Postgres，跑 Kagami-style 的 BotLoopAgent：LLM 通过 `wait` 工具决定何时休息，通过 `send_message` 工具决定何时 / 在哪说话。整个 bot 持有**单一**永续 AgentContext（一个 messages 数组），多源事件全部 funnel 进来，没有 per-scene / per-source 区分。同一意识跨源贯通（在群 A 学到的可以在群 B / 私聊里用），但发声 target 显式 + ingress 层准入过滤，防止串台。

当前阶段、模块清单、env vars、最近取舍见 `docs/current-state.md`。

## Core Design Ideas

The project has two core design ideas: **perpetual context** and **progressive disclosure**.

- Perpetual context defines how history stays stable: the LLM sees one durable, replayable, byte-stable `AgentContext` prefix. Once a turn is appended, late media, tool results, reruns, or side-table changes must not rewrite it; controlled compaction is the normal rewrite path.
- Progressive disclosure defines how knowledge and capability enter context cheaply: the resident system prompt should contain only stable rules, boundaries, indexes, and entry points. Long style guides, group taste, database schema, tool manuals, external pages, workspace files, and other large or mutable content should be fetched through tools or controlled file paths only when needed.
- For new designs, ask both questions up front: will this make an already-appended prefix unstable, and is it putting information into resident context that could instead be disclosed on demand?

## Experimental Project Policy

This repository is an experimental new-project implementation. Do not optimize plans or implementations around historical data compatibility, migration cost, or preserving old intermediate architecture.

Default stance:
- Everything may be redesigned or replaced when it helps reach the target architecture.
- Destructive refactors are acceptable, including deleting or replacing old runtime, memory, proactive, reply, recovery, and admin surfaces.
- Prefer the clean target model over compatibility bridges, dual-write paths, or long-lived legacy adapters.
- Historical data migration/backfill is not a blocker unless the user explicitly asks for it.
- Do not preserve stale concepts just because they currently work; if a concept conflicts with the target model, treat it as removable.

## Perpetual Context Contract

「Perpetual context」 here means: keep the LLM history prefix bit-stable across calls so the provider's prompt cache hits, and use that low marginal cost to extend conversation lifetime indefinitely. This is the project's central design contract — not a "long context window" optimization.

**Why it matters.** Claude / OpenAI prompt cache hits are prefix-matched. A hit makes cached input tokens near-free and TTFT near-zero; a miss re-bills and re-attends the whole prefix. If any path rewrites earlier turns (reordering messages, refreshing a media description, swapping the system prompt), cache hit rate collapses and the bot's economics break. A stable prefix is what makes 24/7 always-on agents financially viable.

**Hard invariants** — treat any violation as a regression unless explicitly justified in the PR description:

1. **`BotAgentContext` is the source of truth.** A single owned `AgentMessage[]` is the only thing the LLM ever sees. Persisted form == runtime form (single-row snapshot table). Don't reintroduce "context as a render product assembled from N tables." If a new feature wants to influence what the LLM sees, it must do so by appending into AgentContext, not by re-rendering.

2. **`messages` table is the inbound fact ledger, not the LLM ledger.** Inbound 消息一次性入库；媒体描述就绪后 `resolved_text` **一次冻结** (once-frozen)，后续 `description_raw` 更新也**不**重写 `resolved_text`。`messages` 表**不**双写进 AgentContext，AgentContext 也**不**每轮从它重建——它服务 `db action=query` 工具、媒体描述目标、引用查询、启动重放，仅此而已。Scene schema invariant：`sceneKind='qq_group'` → `groupId` 非空 + `sceneExternalId=''`；`sceneKind='qq_private'` → `groupId=null` + `sceneExternalId=String(peerId)`（代码层 assert 在 `insertMessage` 兜底）。

3. **Bot speaks through the `send_message` tool, not through assistant content.** `send_message` 是唯一发消息路径，target 必填（`{type:'group',groupId}` 或 `{type:'private',userId}`）。assistant message 的 content 是模型的内部"思考"，用于让它跨轮 chain-of-thought，但**不**会发出去。tool 调用成功才有真发送；失败的 send 不影响 context（tool 自己返回 `{ok:false}`），保证「history 里出现的发言一定真发出去过」这条不变量。当前隔离策略：群白名单只在 ingress 层执行（`BOT_TARGET_GROUP_IDS` 过滤 NapCat `message.group` 事件），工具层**不**做二次白名单校验——能进 AgentContext 的群消息必然来自白名单内的群，所以 LLM 看到 `[群:...]` 标签就一定可以发回去。私聊白名单已删，陌生 DM 由 ingress 层 `sub_type='friend'` 过滤。这样设计是为了避免 LLM 看到工具描述里"会校验"就脑补"我不能发这个群"而停止尝试。

4. **Compaction is the only path allowed to rewrite the prefix.** `maybeCompactConversation` 是唯一调用 `replaceMessages` 的地方。trigger 是 token 估算超 `COMPACTION_TRIGGER_TOKENS` env 阈值，`keepRatio` = 0.1。约束：cut 边界不能切开 `assistant.toolCalls` 与对应 `tool` result（锚 toolCallId 检测）；`previousSummary` 作为合并输入而不是简单 append；空摘要不写回；post-round compaction 用 try/catch 包，失败不影响已 sent 的消息。

5. **Deterministic replay.** Given the same inputs, `getSnapshot().messages` must be byte-identical across runs. This is the mathematical precondition for prompt-cache hits, not a stylistic preference. Designs that make equivalent reruns produce different prefixes are treated as regressions. Caveat: system prompt 启动时根据元数据（群名）一次拼装，跨重启如果元数据变了，整段 prompt cache 失效是设计预期，不是 bug。historical messages 数组里 `renderedText` 永远不变（per-event 一次冻结）。

6. **产图/取图工具压缩 base64 直接进 AgentContext。** 字节进系统的两条路径不变：(a) NapCat 入站 → `media-cache.ts` → `Media` 表；(b) 产字节工具（`generate_image` / `fetch_image`）→ `OutboundCache` 内存。变化：`generate_image` / `fetch_image` 成功时，额外调用 `compressForContext`（768px JPEG ≈ 40-70KB base64）生成压缩图，作为 `ToolResultImageBlock` 与原 JSON text block 一起写入 tool_result content 数组，直接进 AgentContext 持久化。LLM 能看到图。入站 QQ 图片仍然只以文字描述进 context（不变）。压缩图 token ~800-1000 / 张（Anthropic 图像 token 计费），单张 base64 ~40-70KB 入 Postgres snapshot。`compressForContext` 失败时 graceful fallback 到纯文字 result（无图）。OutboundCache 仍用于发送路径（`send_message` 取原图字节）；压缩图是独立拷贝，不影响发送质量。

7. **Universal handle 契约（仅对图工具）**。所有**吃图**工具的 image 输入字段类型为 `z.union([{mediaId: int}, {ephemeralRef: string (64-hex)}])`；所有**吐图**工具的输出形态为 `{ephemeralRef, dataHash, byteSize, contentType, description}`，其中 `description` 字段写法与 inbound `Media.descriptionRaw.description` 同 key 兼容。这条契约让 LLM 自由组合 `fetch_url → edit → send` / `screenshot → edit → send` / `mediaId → edit → edit → send` 任意链路，不需要为每条链路写专用工具或转换层。新加图工具必须遵守。schema 漂移按红线 5 处理（集中改，不小步频改）。非图工具不受此红线约束。

**Implications for plans / refactors:**

- 新事件源（forum / RSS / 系统通知）必须明确：它怎么渲染成一条 `user`-role AgentMessage，然后通过 dedup-enqueue → BotLoopAgent drainEvents → `appendUserMessage` 进 AgentContext。**不**改写已有 messages，**不**插入到 prefix 中段。新源也要决定它在 `render-event.ts` 里的 source label 形态。
- 跨源知识流（LLM 在群 A 听到，想在群 B / 私聊用）在 single-context 模型下天然拥有，不需要额外 inner_journal / RAG 桥。扩到 forum / 新闻时同样适用。
- 跨源**发声隔离**靠 ingress 层过滤（白名单 env、`sub_type='friend'` 等）+ `send_message` tool 的 target 显式必填。工具层不做二次校验。任何新源出现 → 必须把"发到这个源"加入 tool 的 target 联合类型，并在 ingress 层为该源决定准入策略（白名单 env、sub_type 过滤、或其他机制）；工具层不再为新源加 if-allowed 分支。
- system prompt 在启动后**不变**（启动时一次拼装）。修改 system prompt 内容 = 整段 cache 失效，这是有意为之，提醒只能集中改。
- 工具描述同上，集中改，不小步频改。
- 每次修改工具注册后，同步检查并更新对应的 system prompt、tool description、测试、文档和旧导出/旧命名残留；不要让 LLM 看到已废弃的工具名或入口。
- **Establish-time disclosure.** 新能力建立 / 注册时，只向常驻 system prompt 披露稳定边界、索引和入口；长说明、风格正文、群口味、工具手册、可变数据、外部内容，都放到工具、文件工作区或其它按需读取路径里。Bash 可以作为 capability 的统一交互形态，但不是统一权限：对常驻 bot 暴露的 Bash 必须是 allowlist、固定工作区、最小 env、可审计的受控执行器，而不是裸 shell。
- `data/agent-workspace/` 是 agent 自己生产和整理内容的仓库内工作区（journal / dream / scratch / index / draft 等）。该区域不是产品源代码、不是 Prisma 事实账本、也不是 AgentContext replay 的一部分；默认由局部 `.gitignore` 忽略运行时内容，只保留目录契约文件入库，除非人类明确决定把某个生成物提升为项目文档。
- 大块原始数据（web 抓页 / 长文件）走子 TaskAgent 模式（现 MVP 暂未实现），**只回摘要给主 context**，不要让原始 token 进 messages 数组。
- Late-binding 信息（媒体描述在消息已入库后才返回）走 `resolved_text` 一次冻结。如果某条消息的描述在它进入 BotEvent 之前还没好，会等待最多 `REPLY_MEDIA_TIMEOUT_MS`，然后用当前最佳值冻结，后续不再变。
- **Replay × live 重叠去重**：启动期 replay 与 live 入站可能命中同一条消息，统一按 `messageRowId`（Message PK，跨 scene 全局唯一）去重，replay 与 live 共享同一份 set，同条消息只进队一次。
- **idle 引信 + fetch/reddit 工具**：`wait` 工具内嵌 `BOT_IDLE_HINT_MS` Promise.race，长时间无事件时返回一条 `[空闲提示]` tool result + enqueue 一个 `wake` 让 Guard 2 不阻塞。idle 提示**不**写进 `messages` 表（红线 2 不变），仅作为 tool result 进 AgentContext snapshot 一次冻结（红线 5 不变）。`reddit action=list` / `fetch_url` 工具**实现层硬截断**：reddit list ≤10 条且每条 title/summary 字符级 clip；fetch_url 抓取 body ≤256KB → cheerio 抽文 ≤8KB → 默认 LLM 摘要 ≤500 中文字 → 输出 ≤1500 字符 clamp。原始 HTML / 长 RSS feed **绝不**进 messages 数组。fetch tool result 走正常 `appendToolResult` 路径持久化进 snapshot；replay 时是字节快照，**不**重发 HTTP 求新值（红线 5）。NDJSON 旁路日志（`logs/fetch.ndjson`，`BOT_FETCH_LOG_PATH` 覆盖）是运维信息，**不**进 Prisma、**不**进 AgentContext，LLM 看不到也不该看到。

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
