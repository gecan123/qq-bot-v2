# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Commit Messages

Commit message format: `<type>: <中文描述>`

The description (after the colon) must be written in Chinese. The `type` prefix stays in English (feat, fix, refactor, docs, test, chore, perf, ci).

## Project Overview

qq-bot-v2 是一个**单上下文 + 主动 + 被动**的 QQ 群 Agent。它接 NapCat 听一个 QQ 群,把消息存进 Postgres,跑一个 Kagami-style 的 BotLoopAgent: LLM 通过 wait 工具决定何时休息,通过 send_group_message 工具决定何时说话。整个 bot 持有**单一**永续 AgentContext (一个 messages 数组),不再有 per-scene 区分。

MVP 阶段只服务 1 个测试群 (`BOT_TARGET_GROUP_ID`),验证 single-context 路线在多源事件下的体感和 cache 经济性。

参考: `docs/single-context-mvp.zh-CN.md`。

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

2. **`messages` table is for inbound facts, not the LLM ledger.** `messages` 仍是入站事实的审计源 (用于 `db_read` 工具 / 媒体描述目标 / 引用消息查询 / 启动重放). 它**不**双写进 AgentContext, AgentContext 也**不**每轮从它重建. 入库一次性写入,媒体描述就绪后通过 `src/media/ensure-message-ready.ts` 把 `resolved_text` **一次冻结** (once-frozen);后续如果 `description_raw` 更新也**不**重写 `resolved_text`。

3. **Bot 通过 `send_group_message` 工具说话,不通过 assistant content。** `src/agent/tools/send-group-message.ts` 是真正的发消息路径。assistant message 的 content 是模型的内部"思考",用于让它跨轮 chain-of-thought,但不会发出去。tool 调用成功才有真发送;失败的 send 不影响 context (tool 自己返回 `{ok:false}`),保证「history 里出现的发言一定真发出去过」这条不变量。

4. **Compaction 是唯一允许重写前缀的路径。** `src/agent/compaction.ts` 的 `maybeCompactConversation` 是唯一调用 `replaceMessages` 的地方。trigger 是 token 估算 > 12k (默认),`keepRatio` = 0.1。cut 边界不能切开 `assistant.toolCalls` 与对应 `tool` result (锚 toolCallId 检测)。`previousSummary` 作为合并输入,不简单 append。空摘要不写回。post-round compaction 用 try/catch 包,失败不影响已 sent 的消息。

5. **Deterministic replay。** Given the same inputs, `getSnapshot().messages` must be byte-identical across runs. This is the mathematical precondition for prompt-cache hits, not a stylistic preference. `llm_traces` 表的 `prefix_hash` / `tail_hash` / `cached_tokens` 用来观测 cache 命中率。Designs that make equivalent reruns produce different prefixes are treated as regressions.

**Implications for plans / refactors:**

- 新事件源 (forum / RSS / 系统通知) 必须明确说明:它怎么渲染成一条 `user`-role AgentMessage,然后 `appendUserMessage` 进 AgentContext。**不**改写已有 messages,**不**插入到 prefix 中段。
- 跨"会话"知识流 (LLM 在群 A 听到, 想在群 B 用) 在 single-context 模型下天然拥有,不需要额外 inner_journal / RAG 桥。MVP 阶段单群,这个能力等到扩多群时再回来重新评估。
- system prompt 在启动后**不变** (`src/agent/bot-system-prompt.ts` 启动时一次拼装). 修改 system prompt = 整段 cache 失效, 这是有意为之, 提醒只能集中改。
- 工具描述同上,集中改,不小步频改。
- 大块原始数据 (web 抓页 / 长文件) 走子 TaskAgent 模式 (现 MVP 暂未实现),**只回摘要给主 context**,不要让原始 token 进 messages 数组。
- Late-binding 信息 (媒体描述在消息已入库后才返回) 走 `resolved_text` 一次冻结。如果某条消息的描述在它进入 BotEvent 之前还没好,`ensureMessageReadyForAgent` 会等待最多 `REPLY_MEDIA_TIMEOUT_MS`,然后用当前最佳值冻结,后续不再变。

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
- `BOT_TARGET_GROUP_ID` — MVP 单群 bot 监听并响应的唯一 QQ 群
- `SELF_NUMBER` — bot 自身 QQ 号 (过滤自身消息)

可选:
- `TAVILY_API_KEY` — Tavily web search,设置则 web_search 工具自动注册
- `LLM_PROVIDER_*_URL` / `_API_KEY` — provider 注册表,默认 provider 由 `LLM_DEFAULT_PROVIDER` 选
- `LLM_SCENARIO_*` — 媒体描述各场景的 provider/model 覆盖

## Architecture

**ESM-only** (`"type": "module"` in package.json). All local imports use `.js` extensions.

**启动流程** (`src/index.ts`):

1. 连 Prisma → 注册媒体 RoutingProvider → jobQueue 启动
2. `createLlmClient()` 给 BotLoopAgent 用 (默认 provider/model,与媒体路由独立)
3. `BotSnapshotRepo.load()` 从 `bot_agent_snapshot` 单行表恢复 AgentContext
4. `replayMissedMessages(lastWakeAt)` 把关机期间漏掉的 target group 消息一次性 enqueue
5. `buildBotTools()` 装配 wait / send_group_message / db_schema / db_read / web_search
6. `createBotLoopAgent({...})` + `startBot({onMessageReady})` 接 NapCat
7. `agent.start()` — 进入 while 循环

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
- `src/bot/core.ts` — NapCat 事件入口,过滤目标群,持久化 + 媒体就绪 + onMessageReady
- `src/bot/message-parser.ts` — NapCat segments → `ParsedSegment` 联合类型
- `src/database/messages.ts` — `insertMessage()` upsert + `freezeResolvedTextIfUnset` 一次冻结
- `src/database/agent-sql.ts` — agent `db_read` 的安全只读 SQL 校验 + 执行
- `src/media/ensure-message-ready.ts` — 等媒体描述 + 渲染 + 冻结 resolved_text
- `src/media/message-resolver.ts` — `resolveMessage` 把 segments 跑到带 mediaDescription 的形态
- `src/agent/agent-context.ts` — single-bot AgentContext (red line 1)
- `src/agent/event-queue.ts` — `InMemoryEventQueue<BotEvent>`
- `src/agent/event.ts` — `BotEvent = napcat_message | wake`
- `src/agent/render-event.ts` — 纯函数 `BotEvent → string` (red line 5)
- `src/agent/llm-client.ts` — `AgentMessage <-> OpenAI ChatCompletion` 翻译
- `src/agent/bot-system-prompt.ts` — 启动时一次拼装 (red line 5)
- `src/agent/snapshot-repo.ts` — `bot_agent_snapshot` 单行持久化
- `src/agent/compaction.ts` — `maybeCompactConversation` (red line 4 唯一前缀写口)
- `src/agent/bot-loop-agent.ts` — 主循环
- `src/agent/replay-missed.ts` — 启动时回放关机期间漏掉的消息
- `src/agent/tool.ts` — Tool / ToolExecutor 接口
- `src/agent/tools/*` — wait / send_group_message / db_schema / db_read / web_search
- `src/messaging/message-sender.ts` + `napcat-sender.ts` — 底层 NapCat 发送 + 重试
- `src/llm/*` — 媒体描述用的 provider routing (与 agent LLM 独立)

**Database** (Prisma 7,PG driver adapter): 4 个 model — `Message` / `Media` / `LlmTrace` / `BotAgentSnapshot`. 永续上下文唯一持久化点就是 `bot_agent_snapshot` 单行表 (`id=1`)。

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
- `wait`: 没事可做时调用,阻塞到下个 BotEvent
- `send_group_message`: 真发到 `BOT_TARGET_GROUP_ID`,可 reply 或 ambient
- `db_schema` / `db_read`: 查历史聊天 / 媒体描述 (只读 SQL,自动注入 `:group_id`)
- `web_search`: 仅在 `TAVILY_API_KEY` 配置时注册

system prompt (`src/agent/bot-system-prompt.ts`) 明示 LLM:
- 主动发也走工具,assistant content 只是内心想法
- 优先 wait,质量比频率重要
- 群消息会以 `[昵称(QQ:id) [@bot]] text` 形式作为 user message 进 history

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
