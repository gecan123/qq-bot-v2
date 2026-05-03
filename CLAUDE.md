# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Commit Messages

Commit message format: `<type>: <中文描述>`

The description (after the colon) must be written in Chinese. The `type` prefix stays in English (feat, fix, refactor, docs, test, chore, perf, ci).

## Project Overview

qq-bot-v2 是一个**单上下文 + 主动 + 被动**的 QQ Agent。它接 NapCat 听一组 QQ 群 + 一组私聊, 把消息存进 Postgres, 跑一个 Kagami-style 的 BotLoopAgent: LLM 通过 wait 工具决定何时休息, 通过 `send_message` 工具 (target 必填: 群 / 私聊) 决定何时 / 在哪说话。整个 bot 持有**单一**永续 AgentContext (一个 messages 数组), 多源事件全部 funnel 进来, 没有 per-scene / per-source 区分。

MVP-2 阶段服务 N 个白名单群 (`BOT_TARGET_GROUP_IDS`) + N 个白名单私聊 (`BOT_TARGET_PRIVATE_USER_IDS`)。同一意识跨源贯通 (在群 A 学到的可以在群 B / 私聊里用), 但发声 target 显式 + 工具层白名单校验, 防止串台。

参考: `docs/single-context-mvp.zh-CN.md` 和 `~/.gstack/projects/gecan123-qq-bot-v2/zzz-single-context-mvp-design-20260504-010859.md`。

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

1. **Owned `BotAgentContext` is the source of truth.** `src/agent/agent-context.ts` defines `AgentContext`,持有唯一一份 `AgentMessage[]`. The LLM only ever sees `getSnapshot().messages`. Persistence layer is `bot_agent_snapshot.context_snapshot` (single row, `id=1`) via `src/agent/snapshot-repo.ts`. Persisted form == runtime form. Don't reintroduce "context as a render product assembled from N tables." If a new feature wants to influence what the LLM sees, it must do so by appending into AgentContext, not by re-rendering.

2. **`messages` table is for inbound facts, not the LLM ledger.** `messages` 是群 + 私聊的入站事实账本 (用于 `db_read` 工具 / 媒体描述目标 / 引用消息查询 / 启动重放). 它**不**双写进 AgentContext, AgentContext 也**不**每轮从它重建. 入库一次性写入, 媒体描述就绪后通过 `src/media/ensure-message-ready.ts` 把 `resolved_text` **一次冻结** (once-frozen); 后续如果 `description_raw` 更新也**不**重写 `resolved_text`. Schema invariant: `sceneKind='qq_group'` → `groupId` 非空 + `sceneExternalId=''`; `sceneKind='qq_private'` → `groupId=null` + `sceneExternalId=String(peerId)` (代码层 assert 在 `insertMessage`).

3. **Bot 通过 `send_message` 工具说话, 不通过 assistant content。** `src/agent/tools/send-message.ts` 是真正的发消息路径, target 必填 (`{type:'group',groupId}` 或 `{type:'private',userId}`)。assistant message 的 content 是模型的内部"思考", 用于让它跨轮 chain-of-thought, 但不会发出去。tool 调用成功才有真发送; 失败的 send 不影响 context (tool 自己返回 `{ok:false}`), 保证「history 里出现的发言一定真发出去过」这条不变量。target 不在 `BOT_TARGET_GROUP_IDS` / `BOT_TARGET_PRIVATE_USER_IDS` 白名单内 → tool 返回 `{ok:false}`, 不真发, 不抛 (隔离靠机制不靠 LLM 自律)。

4. **Compaction 是唯一允许重写前缀的路径。** `src/agent/compaction.ts` 的 `maybeCompactConversation` 是唯一调用 `replaceMessages` 的地方。trigger 是 token 估算 > `COMPACTION_TRIGGER_TOKENS` env (默认 16k, MVP-2 多源场景上调), `keepRatio` = 0.1。cut 边界不能切开 `assistant.toolCalls` 与对应 `tool` result (锚 toolCallId 检测)。`previousSummary` 作为合并输入, 不简单 append。空摘要不写回。post-round compaction 用 try/catch 包, 失败不影响已 sent 的消息。

5. **Deterministic replay。** Given the same inputs, `getSnapshot().messages` must be byte-identical across runs. This is the mathematical precondition for prompt-cache hits, not a stylistic preference. Designs that make equivalent reruns produce different prefixes are treated as regressions. **多源 caveat**: system prompt 启动时根据元数据 (群名 / 私聊昵称) 一次拼装, 跨重启如果元数据变了, 整段 prompt cache 失效是设计预期, 不是 bug。historical messages 数组里 `renderedText` 永远不变 (per-event 一次冻结)。

**Implications for plans / refactors:**

- 新事件源 (forum / RSS / 系统通知) 必须明确说明: 它怎么渲染成一条 `user`-role AgentMessage, 然后通过 `enqueueMessageEvent` (`src/agent/dedup-enqueue.ts`) 入队 → BotLoopAgent drainEvents → `appendUserMessage` 进 AgentContext。**不**改写已有 messages, **不**插入到 prefix 中段。新源也要决定它在 `render-event.ts` 里的 source label 形态 (现有: `[群:名 | 昵称(QQ)] text` / `[私聊 | 昵称(QQ)] text`)。
- 跨源知识流 (LLM 在群 A 听到, 想在群 B / 私聊用) 在 single-context 模型下天然拥有, 不需要额外 inner_journal / RAG 桥。MVP-2 已经多群 + 私聊, 这个能力是在用的; 扩到 forum / 新闻时同样适用。
- 跨源**发声隔离**靠 `send_message` tool 的 target + 白名单校验, 不靠 LLM 自律。任何新源出现 → 必须把"发到这个源"加入 tool 的 target 联合类型 + 白名单 env 加新字段。
- system prompt 在启动后**不变** (`src/agent/bot-system-prompt.ts` 启动时根据 `resolveTargetMetadataMaps` 拉到的群名 / 昵称一次拼装). 修改 system prompt 内容 = 整段 cache 失效, 这是有意为之, 提醒只能集中改。
- 工具描述同上, 集中改, 不小步频改。
- 大块原始数据 (web 抓页 / 长文件) 走子 TaskAgent 模式 (现 MVP 暂未实现), **只回摘要给主 context**, 不要让原始 token 进 messages 数组。
- Late-binding 信息 (媒体描述在消息已入库后才返回) 走 `resolved_text` 一次冻结。如果某条消息的描述在它进入 BotEvent 之前还没好, `ensureMessageReadyForAgent` 会等待最多 `REPLY_MEDIA_TIMEOUT_MS`, 然后用当前最佳值冻结, 后续不再变。
- **replay × live 重叠去重**: D2 reordering 把 `napcat.connect()` 排在 `resolveTargetMetadataMaps` 之前, 中间窗口 live 入站消息可能被 replay-missed 再扫一次。`createDedupEnqueue` 按 `messageRowId` (Message PK, 跨 scene 全局唯一) 去重, replay 和 live 共享同一份 set, 同条消息只进队一次。

## Commands

```bash
pnpm dev              # tsx watch (hot reload)
pnpm build            # rm -rf dist && tsc
pnpm start            # node dist/index.js
pnpm db:generate      # prisma generate (after schema changes)
pnpm db:migrate       # prisma migrate dev
pnpm db:push          # prisma db push (no migration files)
pnpm test             # tsx --test src/**/*.test.ts
```

## Required Environment Variables

See `.env.example`. All required at startup:
- `DATABASE_URL` — PostgreSQL connection string
- `NAPCAT_WS_URL` — NapCat WebSocket endpoint
- `NAPCAT_ACCESS_TOKEN` — NapCat auth token
- `BOT_TARGET_GROUP_IDS` — 群白名单 (逗号分隔, 例: `111,222`)
- `BOT_TARGET_PRIVATE_USER_IDS` — 私聊白名单 (逗号分隔, 空表示不开私聊)
  注意: `BOT_TARGET_GROUP_IDS` 和 `BOT_TARGET_PRIVATE_USER_IDS` 不能同时为空
- `SELF_NUMBER` — bot 自身 QQ 号 (过滤自身消息)

可选:
- `TAVILY_API_KEY` — Tavily web search, 设置则 web_search 工具自动注册
- `COMPACTION_TRIGGER_TOKENS` — compaction 触发阈值 (默认 16000, 多源场景默认值)
- `LLM_PROVIDER_*_URL` / `_API_KEY` — provider 注册表, 默认 provider 由 `LLM_DEFAULT_PROVIDER` 选
- `LLM_SCENARIO_*` — 媒体描述各场景的 provider/model 覆盖

## Architecture

**ESM-only** (`"type": "module"` in package.json). All local imports use `.js` extensions.

**启动流程** (`src/index.ts`):

1. 连 Prisma → 注册媒体 RoutingProvider → jobQueue 启动
2. `createLlmClient()` 给 BotLoopAgent 用 (默认 provider/model, 与媒体路由独立)
3. `BotSnapshotRepo.load()` 从 `bot_agent_snapshot` 单行表恢复 AgentContext
4. `eventQueue` + `createDedupEnqueue(eventQueue)` (按 `messageRowId` 去重的统一入队 hook)
5. `registerNapcatHandlers({ onMessageReady })` 注册 NapCat 事件 handler (sync, no I/O)
6. `connectNapcat()` 真打开 WebSocket (D2: 必须在 resolveTargetMetadataMaps 之前)
7. `resolveTargetMetadataMaps()` 一次性拉群名 / 私聊昵称 (Promise.allSettled, 每调用 3s 超时)
8. `replayMissedMessages(lastWakeAt)` 多源回放, 与 live 共享同一去重 set
9. `buildBotTools()` 装配 wait / send_message / db_schema / db_read / web_search; `buildBotSystemPrompt({groupIds, privateUserIds, metadata})` 拼 prompt
10. `createBotLoopAgent({...})` + `agent.start()` — 进入 while 循环

**主循环** (`src/agent/bot-loop-agent.ts`):

```
while (!stopRequested) {
  drainEvents()          // BotEvent → context.appendUserMessage(renderedText)
  if (context 是空) await waitForEvent(); continue
  runRound()             // LLM call + execute tool calls
  persistSnapshot()      // 写 bot_agent_snapshot
  maybeCompact()         // token 阈值触发
  if (queue 空) await waitForEvent()  // 守 LLM 不空跑
}
```

**关键模块**:
- `src/bot/napcat.ts` — NCWebsocket client
- `src/bot/core.ts` — `registerNapcatHandlers` (sync .on 注册) + `connectNapcat`; 多源 `processMessage(scope: GroupScope | PrivateScope)` 走相同 ingest 路径; 持久化 + 媒体就绪 + onMessageReady
- `src/bot/message-parser.ts` — NapCat segments → `ParsedSegment` 联合类型
- `src/database/messages.ts` — `insertMessage()` upsert + invariant assert (qq_group / qq_private 必填字段) + `freezeResolvedTextIfUnset` 一次冻结
- `src/database/agent-sql.ts` — agent `db_read` 的安全只读 SQL 校验 + 执行 (多源, 不再强制 :group_id)
- `src/media/media-cache.ts` — `persistMediaReferences(scope: group|private)` 把媒体下载 + Media 表入库
- `src/media/ensure-message-ready.ts` — 等媒体描述 + 渲染 + 冻结 resolved_text
- `src/media/message-resolver.ts` — `resolveMessage` 把 segments 跑到带 mediaDescription 的形态
- `src/agent/agent-context.ts` — single-bot AgentContext (red line 1)
- `src/agent/event-queue.ts` — `InMemoryEventQueue<BotEvent>`
- `src/agent/event.ts` — `BotEvent = napcat_message | napcat_private_message | wake`
- `src/agent/dedup-enqueue.ts` — `createDedupEnqueue` 按 messageRowId 去重 (red line 5 + replay×live 重叠保护)
- `src/agent/render-event.ts` — 纯函数 `BotEvent → string`, 多源标签 + 群名缺失裸 ID fallback (red line 5)
- `src/agent/resolve-target-meta.ts` — 启动时一次性拉群名 / 私聊昵称 (Promise.allSettled, 3s/调用, 失败裸 ID)
- `src/agent/llm-client.ts` — `AgentMessage <-> OpenAI ChatCompletion` 翻译
- `src/agent/bot-system-prompt.ts` — 启动时一次拼装 (使用 metadata maps, red line 5)
- `src/agent/snapshot-repo.ts` — `bot_agent_snapshot` 单行持久化
- `src/agent/compaction.ts` — `maybeCompactConversation` (red line 4 唯一前缀写口)
- `src/agent/bot-loop-agent.ts` — 主循环
- `src/agent/replay-missed.ts` — 启动时多源回放关机期间漏掉的消息 (与 live 共享 dedup hook)
- `src/agent/tool.ts` — Tool / ToolExecutor 接口
- `src/agent/tools/*` — wait / send_message / db_schema / db_read / web_search
- `src/messaging/message-sender.ts` + `napcat-sender.ts` — 底层 NapCat 发送 + 重试 (含群 + 私聊 reply)
- `src/llm/*` — 媒体描述用的 provider routing (与 agent LLM 独立)

**Database** (Prisma 7, PG driver adapter): 3 个 model — `Message` / `Media` / `BotAgentSnapshot`. `Message.groupId` 改 nullable 以容纳私聊 (private 用 `sceneExternalId=peerId`). 永续上下文唯一持久化点就是 `bot_agent_snapshot` 单行表 (`id=1`)。`llm_traces` 表 MVP-2 移除 (零应用消费者)。

**Logging**: pino + pino-pretty。`createLogger(scope)` from `src/logger.ts`。

## LLM 配置

双 provider routing,但 agent 自身的 LLM 调用走 default provider/model,媒体描述按场景路由。

```
LLM_DEFAULT_PROVIDER=claude
LLM_DEFAULT_MODEL=gpt-5.1

LLM_PROVIDER_CLAUDE_URL=http://127.0.0.1:8317/v1
LLM_PROVIDER_CLAUDE_API_KEY=sk-local
LLM_PROVIDER_OPENAI_URL=http://127.0.0.1:8317/v1
LLM_PROVIDER_OPENAI_API_KEY=sk-local
```

每个媒体场景可覆盖:

| 前缀 | 用途 |
|---|---|
| `LLM_SCENARIO_DESCRIBE_IMAGE_*` | 图片/表情包描述 |
| `LLM_SCENARIO_DESCRIBE_VIDEO_*` | 视频描述 |
| `LLM_SCENARIO_DESCRIBE_PDF_*` | PDF 描述 |
| `LLM_SCENARIO_TRANSCRIBE_AUDIO_*` | 音频转写 |

详见 `.env.example`。

## Agent 行为

bot 通过工具自主决定:
- `wait`: 没事可做时调用, 阻塞到下个 BotEvent
- `send_message`: 真发到群 / 私聊。target 必填, 工具层白名单校验, 越界返回 `{ok:false}`
  - target = `{type:'group', groupId, mentionUserId?}` 发群里
  - target = `{type:'private', userId}` 发私聊
  - replyToMessageId 可选, 引用某条已存在消息
- `db_schema` / `db_read`: 查历史聊天 (任一源) / 媒体描述。多源后系统**不再**自动注入 `:group_id`, LLM 想限定单源时显式传 (`params: {group_id: ...}` 或 `peer_id`)。跨源 SELECT (无 ID 过滤) 是合法的。
- `web_search`: 仅在 `TAVILY_API_KEY` 配置时注册

system prompt (`src/agent/bot-system-prompt.ts`) 明示 LLM:
- 主动发也走工具, assistant content 只是内心想法
- 优先 wait, 质量比频率重要
- 群消息以 `[群:名字 | 昵称(QQ:id) [@bot]] text` (群名缺失时退化为 `[群:id | 昵称(QQ:id)] text`) 进 history
- 私聊以 `[私聊 | 昵称(QQ:id)] text` 进 history (默认就是对 bot 说话, 无 [@bot] tag, 但允许 wait)
- 跨源知识共享 OK (同一意识), 跨源 cue 人不行 (target 显式)

## Prompts

所有静态 prompt 文本在 `prompts/`。当前用到:
- `prompts/characters/default.md` — bot 人设基座 (`bot-system-prompt.ts` 通过 `loadPrompt` 加载)

旧的 reply-instruction / proactive-judge / 媒体描述 prompts 保留在 `prompts/` 目录,但当前 single-context MVP 不再使用 (媒体描述还在用图/视频/PDF/音频几个)。

## Skill routing

<!-- 以下 skill 均为 GStack 提供的专用技能,需安装 GStack 后方可使用 -->

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
