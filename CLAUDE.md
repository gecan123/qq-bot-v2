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

**Prompts:** All static prompt text lives in `prompts/` (not in source code). Key files: `default-persona.md`, `reply-instruction.md`, `describe-image.md`, `transcribe-audio.md`, `memory-system.md`, `memory-group-summary.md`, `memory-user-profile.md`. Loaded via `loadPrompt()` at first use and cached. Agent persona baseline is loaded from `default-persona.md` by `src/config/agent-profiles.ts`, and can still be overridden per group.

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
LLM_PROVIDER=openai
OPENAI_BASE_URL=http://127.0.0.1:8317/v1
OPENAI_API_KEY=sk-local
OPENAI_MODEL=gpt-5.1
```

每个场景可单独覆盖 provider 和 model（详见 `.env.example`）：

| 场景环境变量前缀 | 对应方法 | 用途 |
|---|---|---|
| `LLM_DESCRIBE_IMAGE_*` | `describeImage` | 图片/表情包描述 |
| `LLM_GENERATE_GROUP_MEMORY_SUMMARY_*` | `generateGroupMemorySummary` | 群记忆摘要 |
| `LLM_GENERATE_USER_MEMORY_PROFILE_*` | `generateUserMemoryProfile` | 用户画像 |
| `LLM_TRANSCRIBE_AUDIO_*` | `transcribeAudio` | 音频转写 |

## Agent Loop

Multi-turn agent reasoning for @-mention replies. Triggered based on `AgentMode` in agent profiles.

- `src/agent/types.ts` — `AgentLlmAdapter` interface, `ToolCall`, `ToolResult`, `AgentMessage`, `TurnResult`, `LoopResult` types
- `src/agent/heuristic.ts` — `shouldUseAgent(text)` regex heuristic for deciding when to use agent mode
- `src/agent/tools.ts` — `createAgentTools(groupId)` factory returning read-only tools with zod validation: `db_schema`, `db_read`, structured `final_answer`, and optionally `web_search` (requires `TAVILY_API_KEY`)
- `src/agent/openai-agent-adapter.ts` — `OpenAIAgentAdapter` implementing `AgentLlmAdapter` via OpenAI function calling; `createOpenAIAgentAdapter()` factory using `LLM_AGENT_*` env vars (falls back to `OPENAI_*`)
- `src/agent/loop.ts` — `runAgentLoop()` with maxSteps=4, maxTimeMs=30s, final/fallback/aborted states
- `src/config/agent-profiles.ts` — `AgentProfile` supports `personaFile` (path to `.md`) or inline `persona` string; default persona baseline comes from `prompts/default-persona.md`, and `getAgentProfile()` merges default → config.default → group and resolves persona

**At-mention routing:** `src/responder/handlers/at-mention.ts` always routes to the async agent reply pipeline. There is no single-turn reply fallback.

**Message schema:** `prisma/schema.prisma` added `searchText String @default("")` to Message model for agent search tool. Backfill with `scripts/backfill-search-text.ts`.

**Agent env vars:**
- `LLM_AGENT_BASE_URL` — OpenAI-compatible base URL for agent (falls back to `OPENAI_BASE_URL`)
- `LLM_AGENT_API_KEY` — API key for agent (falls back to `OPENAI_API_KEY`)
- `LLM_AGENT_MODEL` — model for agent (falls back to `OPENAI_MODEL`)
- `TAVILY_API_KEY` — (optional) Tavily web search API key; enables `web_search` tool in agent loop when set
