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

1. **Prefix / tail split.** `src/agent/context-frame.ts` carves the request into a stable prefix (system + compacted summary head) and a volatile tail (window + current trigger). `prefixHash` and `tailHash` are recorded on every `LlmTrace` for cache-hit verification. Do not collapse them back into a single hash.

2. **Append-only history.** `messages` is the only inbound user-fact ledger; never introduce a second one. Bot-emitted content enters history as `model` role (not as `[BOT] xxx` text concat) so multi-turn semantics survive compaction. The full conversation ledger reconstructs deterministically from `messages` + sent `action_records` (rendered as `model` role) + `conversation_state` compaction metadata.

3. **Frozen media text.** First-time media resolution writes into `messages.resolvedText`. Compaction reads `resolvedText` if present and only re-resolves if absent (`src/conversation/compaction.ts` `getStableCompactionText`); the freeze prevents a later resolver upgrade from rewriting historical prefixes.

4. **Compaction is a planned prefix-breaking operation.** `maybeCompactConversation()` in `src/conversation/compaction.ts` is the only path that replaces raw history with an LLM summary. The trigger threshold is deliberately high (80 messages, keep last 20) to keep the prefix alive as long as possible. `previousSummary` is a merge input, not an append target — the system prompt forbids string concatenation. Empty / whitespace summaries do not write back. Post-send compaction failures must not poison sent replies; the caller wraps in try/catch (see `src/runtime/passive-mention-processor.ts`).

5. **Deterministic replay.** The history reconstructed for the same scope at any time must be byte-identical given the same inputs. This is the mathematical precondition for cache hits, not a stylistic nicety. Designs that make equivalent reruns produce different prefixes are treated as regressions.

**Implications for plans / refactors:**

- Optimize for deterministic reconstruction, not for backfilling old turns with late-arriving facts.
- Cache stability is a product feature with directly measurable cost impact — the admin-web `/llm-traces` page is the canonical observation surface (prefix-hash switch count, `cached_tokens` ratio per scene).
- New side-effect paths must specify whether they touch the prefix; if yes, justify it.
- Late-binding facts (e.g. media descriptions arriving after the message was already in history) belong in tail-only fields or behind the `resolvedText` freeze barrier — never injected back into prefix turns.
- Before introducing a new field that influences prefix rendering, check whether it is bit-stable across reruns of the same scope. If not, gate it behind a frozen / append-only structure.

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
