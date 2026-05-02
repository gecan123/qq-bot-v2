# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Commit Messages

Commit message format: `<type>: <中文描述>`

The description (after the colon) must be written in Chinese. The `type` prefix stays in English (feat, fix, refactor, docs, test, chore, perf, ci).

## Monorepo Scope Routing
- First classify the task scope before reading files.
- If the task explicitly involves admin WebUI design or implementation, read and modify only `apps/admin-web/**` first.
- If the task is bot/backend related, do not read or modify `apps/admin-web/**`.
- When working inside admin WebUI, follow `apps/admin-web/CLAUDE.md`.

## Project Overview

QQ Bot V2 — a QQ group message storage bot. Connects to NapCat (QQ bridge) via WebSocket, listens for group messages, parses them into structured segments, and persists them to PostgreSQL.

## Experimental Project Policy

This repository is an experimental new-project implementation. Do not optimize plans or implementations around historical data compatibility, migration cost, or preserving old intermediate architecture.

Default stance:
- Everything may be redesigned or replaced when it helps reach the target architecture.
- Destructive refactors are acceptable, including deleting or replacing old runtime, memory, proactive, reply, recovery, and admin surfaces.
- Prefer the clean target model over compatibility bridges, dual-write paths, or long-lived legacy adapters.
- Historical data migration/backfill is not a blocker unless the user explicitly asks for it.
- Do not preserve stale concepts just because they currently work; if a concept conflicts with the target model, treat it as removable.

## Perpetual Context Contract

「Perpetual context」 here means: keep the LLM history prefix bit-stable across calls so the provider's prompt cache hits, and use that low marginal cost to extend conversation lifetime indefinitely. This is the project's central design contract — not a "long context window" optimization. README has a 中文 version of this section under 「核心要义：永续上下文」; this is the engineering-side restatement with file pointers.

**Why it matters.** Claude/OpenAI prompt cache hits are prefix-matched. A hit makes cached input tokens near-free and TTFT near-zero; a miss re-bills and re-attends the whole prefix. If any reply path rewrites earlier turns (reordering messages, refreshing a media description, swapping the system prompt), cache hit rate collapses and the bot's economics break. A stable prefix is what makes 24/7 always-on agents financially viable.

**Hard invariants** — treat any violation as a regression unless explicitly justified in the PR description:

1. **Owned AgentContext is the source of truth.** `src/agent/agent-context.ts` defines `AgentContext`, an object that holds a scene's `AgentMessage[]`. The LLM only ever sees `getSnapshot().messages`. Persistence layer is `scene_agent_contexts.snapshot` (`src/agent/scene-agent-context-store.ts`) — persisted form == runtime form. Don't reintroduce "context as a render product assembled from N tables." If a new feature wants to influence what the LLM sees, it must do so by appending into AgentContext, not by re-rendering.

2. **`messages` table is for inbound facts, not the LLM ledger.** `messages` remains the canonical audit log of what users sent (used by `db_read` agent tool, media resolution target, quoted-message lookup, recovery source). It is **not** double-written into AgentContext, and AgentContext is **not** rebuilt from it on every turn. Ingestion is one-way and append-time-frozen via `src/agent/scene-message-ingestor.ts`: when `ingestSceneMessages` appends, it captures the message's `resolvedText` *at that moment*; later upserts of `resolvedText` do not rewrite AgentContext.

3. **Bot replies as `model` role; control tools omitted.** Successful sends append `{role:'model', content: replyText}` via `agentContext.appendAssistantTurn` in `src/runtime/reply-executor.ts`. Failed / dry-run sends do **not** append — history must not contain replies that never went out. Control tools (currently just `final_answer`, see `CONTROL_TOOL_NAMES` in `src/agent/agent-context.ts`) are filtered out of `appendToolCalls` so they never persist as `tool_calls` turns. Normal tool calls (`db_read`, `web_search`, etc.) and their results **do** persist, so the model can see what it queried last turn.

4. **Compaction is the only path that breaks the prefix.** `maybeCompactConversation(context)` in `src/conversation/compaction.ts` is the sole writer that mutates existing messages. It does `replaceMessages([summaryHead, ...keptTail])` in-place on AgentContext: kept tail is byte-identical to its previous form, only the head changes. Trigger is token-based (default 12k token estimate); `keepRatio` defaults to 0.1; cut boundary is extended to never split a `tool_calls` turn from its matching `tool_results` turn. `previousSummary` is a merge input (the system prompt forbids string concatenation). Empty summaries do not write back. Post-send compaction is wrapped in try/catch in `src/runtime/reply-executor.ts` so a compaction failure cannot poison a successful send.

5. **Deterministic replay.** Given the same inputs, `getSnapshot().messages` must be byte-identical across runs. This is the mathematical precondition for prompt-cache hits, not a stylistic preference. `src/agent/context-frame.ts` records `prefixHash` and `tailHash` on every `LlmTrace` so drift is observable in admin-web `/llm-traces`. Designs that make equivalent reruns produce different prefixes are treated as regressions.

**Implications for plans / refactors:**

- New side-effect paths must specify whether they touch the prefix. Anything appending to AgentContext (even just a `user` role facts message) is a prefix touch on the next turn.
- Cache stability is a product feature with directly measurable cost impact — admin-web `/llm-traces` is the canonical observation surface (prefix-hash switch count, `cached_tokens` ratio per scene).
- Late-binding facts (media descriptions arriving after the message was already in history) belong in tail-only fields or behind the `resolvedText` freeze barrier — never injected back into already-committed AgentContext entries.
- Before introducing a new field that influences `getSnapshot().messages`, check whether it is bit-stable across reruns of the same scope. If not, keep it out of AgentContext entirely or gate it behind a frozen / append-only structure.
- Don't add `appendXxx` methods to AgentContext that don't have a clear "what does the LLM see" answer. If a feature needs structured metadata (cursors, indexes), put it in `AgentContextSnapshot` outside the `messages` array (see `lastObservedMessageRowId` for the precedent).

## Commands

```bash
pnpm dev              # Run with tsx watch (hot reload)
pnpm build            # TypeScript compile to dist/
pnpm start            # Run compiled output (node dist/index.js)
pnpm db:generate      # Generate Prisma client (after schema changes)
pnpm db:migrate       # Create and apply migrations
pnpm db:push          # Push schema directly (no migration files)
```

## Required Environment Variables

See `.env.example`. All are required at startup:
- `DATABASE_URL` — PostgreSQL connection string
- `NAPCAT_WS_URL` — NapCat WebSocket endpoint
- `NAPCAT_ACCESS_TOKEN` — NapCat auth token
- `GROUP_IDS` — comma-separated group IDs to monitor
- `SELF_NUMBER` — bot's own QQ number (used to ignore self-messages)

## Architecture

**ESM-only** (`"type": "module"` in package.json). All local imports use `.js` extensions.

**Flow:** `src/index.ts` → connects Prisma → calls `startBot()` → NapCat WebSocket listens for `message.group` events → parses message segments → upserts to PostgreSQL.

Key modules:
- `src/bot/napcat.ts` — NCWebsocket client instance (from `node-napcat-ts`)
- `src/bot/core.ts` — event handlers; filters by group ID and self-number
- `src/bot/message-parser.ts` — converts NapCat message segments into typed `ParsedSegment` discriminated union (text, image, face, at, reply, raw)
- `src/database/client.ts` — Prisma client with `@prisma/adapter-pg` driver adapter
- `src/database/messages.ts` — `insertMessage()` upserts parsed messages; writes `searchText`
- `src/database/search.ts` — `searchMessages()`, `getUserProfile()`, `getGroupSummary()` for agent tool use
- `src/types/message-segments.ts` — `ParsedSegment` union type definitions
- `src/config/index.ts` — env validation (fails fast on missing vars)
- `src/config/prompt-loader.ts` — `loadPrompt(filePath)` reads and caches prompt files from `prompts/`
- `src/utils/segment-text.ts` — `segmentsToPlainText(segments)` helper used across context-builder, format-messages, and insertMessage

**Prompts:** All static prompt text lives in `prompts/` (not in source code). Key files: `characters/default.md`, `reply-instruction.md`, `proactive-judge.md`, `describe-image.md`, `describe-video.md`, `describe-pdf.md`, `transcribe-audio.md`. Loaded via `loadPrompt()` at first use and cached. Agent persona baseline is loaded from `prompts/characters/default.md` by `src/config/agent-profiles.ts`, and can still be overridden via `agent-config.json`.

**Database:** Prisma 7 with PG driver adapter. Client is generated to `src/generated/prisma/` (not `node_modules`). Single `Message` model with BigInt IDs. After schema changes, run `pnpm db:generate`.

**Logging:** pino with pino-pretty. Import `log` from `src/logger.ts`.

**LLM:** 双 provider 架构，支持按场景路由。

- `src/llm/types.ts` — `LlmProvider` 接口（媒体理解 + 记忆生成）
- `src/llm/gemini-adapter.ts` — Gemini provider（OAuth 凭证自动检测）
- `src/llm/openai-adapter.ts` — OpenAI-compatible provider（`openai` SDK，支持自定义 `baseURL`）
- `src/llm/routing-provider.ts` — 路由层，按场景分发到不同 provider / model
- `src/llm/provider.ts` — 全局单例 getter/setter

本地部署了 **CLIProxyAPI**（OpenAI-compatible proxy），运行在 `http://127.0.0.1:8317`，暴露 GPT 系列模型。通过以下环境变量接入：

```
LLM_DEFAULT_PROVIDER=claude
LLM_DEFAULT_MODEL=claude-sonnet-4-6

LLM_PROVIDER_CLAUDE_URL=http://127.0.0.1:8317/v1
LLM_PROVIDER_CLAUDE_API_KEY=sk-local

LLM_PROVIDER_OPENAI_URL=http://127.0.0.1:8317/v1
LLM_PROVIDER_OPENAI_API_KEY=sk-local

LLM_SCENARIO_DESCRIBE_IMAGE_FALLBACK_PROVIDER=openai
LLM_SCENARIO_DESCRIBE_IMAGE_FALLBACK_MODEL=gpt-5.4
```

即使 `claude` 和 `openai` 暂时都指向同一个本地统一网关，也建议保留两个独立 provider key，后续切换真实上游时只需要改对应 provider 的 URL / API_KEY。

每个场景可单独覆盖 provider 和 model（详见 `.env.example`）：

| 场景环境变量前缀 | 对应方法 | 用途 |
|---|---|---|
| `LLM_DESCRIBE_IMAGE_*` | `describeImage` | 图片/表情包描述 |
| `LLM_TRANSCRIBE_AUDIO_*` | `transcribeAudio` | 音频转写 |

## Agent Loop

Multi-turn agent reasoning for @-mention replies. Triggered based on `AgentMode` in agent profiles.

- `src/agent/types.ts` — `AgentLlmAdapter` interface, `ToolCall`, `ToolResult`, `AgentMessage`, `TurnResult`, `LoopResult` types
- `src/agent/heuristic.ts` — `shouldUseAgent(text)` regex heuristic for deciding when to use agent mode
- `src/agent/tools.ts` — `createAgentTools(groupId)` factory returning read-only tools with zod validation: `db_schema`, `db_read`, structured `final_answer`, and optionally `web_search` (requires `TAVILY_API_KEY`)
- `src/agent/openai-agent-adapter.ts` — `OpenAIAgentAdapter` implementing `AgentLlmAdapter` via OpenAI function calling; `createOpenAIAgentAdapter()` factory using `LLM_AGENT_*` env vars (falls back to `OPENAI_*`)
- `src/agent/loop.ts` — `runAgentLoop()` with maxSteps=4, maxTimeMs=30s, final/fallback/aborted states
- `src/config/agent-profiles.ts` — `AgentProfile` supports `personaFile` (path to `.md`) or inline `persona` string; default persona baseline comes from `prompts/characters/default.md`, and `getAgentProfile()` merges default → config.default → group and resolves persona

**At-mention routing:** `src/responder/handlers/at-mention.ts` always routes to the async agent reply pipeline. There is no single-turn reply fallback.

**Message schema:** `prisma/schema.prisma` added `searchText String @default("")` to Message model for agent search tool. Backfill with `scripts/backfill-search-text.ts`.

**Agent env vars:**
- `LLM_AGENT_BASE_URL` — OpenAI-compatible base URL for agent (falls back to `OPENAI_BASE_URL`)
- `LLM_AGENT_API_KEY` — API key for agent (falls back to `OPENAI_API_KEY`)
- `LLM_AGENT_MODEL` — model for agent (falls back to `OPENAI_MODEL`)
- `TAVILY_API_KEY` — (optional) Tavily web search API key; enables `web_search` tool in agent loop when set

## Skill routing

<!-- 以下 skill 均为 GStack 提供的专用技能，需安装 GStack 后方可使用 -->

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
