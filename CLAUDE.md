# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- `src/database/messages.ts` — `insertMessage()` upserts parsed messages
- `src/types/message-segments.ts` — `ParsedSegment` union type definitions
- `src/config/index.ts` — env validation (fails fast on missing vars)

**Database:** Prisma 7 with PG driver adapter. Client is generated to `src/generated/prisma/` (not `node_modules`). Single `Message` model with BigInt IDs. After schema changes, run `pnpm db:generate`.

**Logging:** pino with pino-pretty. Import `log` from `src/logger.ts`.
