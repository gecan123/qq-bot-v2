# Redis Image Reference Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Store image payloads in Redis and persist only reference IDs in `messages` records.

**Architecture:** Extract image segments, download image bytes from message URL, encode and save payload under `qqbot:image:<referenceId>` in Redis using raw Redis protocol over TCP (no external dependency). Replace image URL in message content with `referenceId` and persist collected IDs in `Message.imageReferenceIds`.

**Tech Stack:** TypeScript, Node.js net/fetch, Prisma 7, PostgreSQL

---

### Task 1: Data model updates

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/database/messages.ts`

1. Add `imageReferenceIds String[] @default([]) @map("image_reference_ids")` to `Message`.
2. Accept `imageReferenceIds` in insert params and persist on create/update.

### Task 2: Redis/config support

**Files:**
- Modify: `.env.example`
- Modify: `src/config/index.ts`
- Create: `src/redis/raw-client.ts`

1. Add `REDIS_URL` config.
2. Add minimal Redis `SET` client via TCP for environments without Redis package.

### Task 3: Image reference pipeline

**Files:**
- Modify: `src/types/message-segments.ts`
- Modify: `src/bot/message-parser.ts`
- Create: `src/media/image-reference.ts`
- Modify: `src/bot/core.ts`

1. Extend image segment fields (`referenceId`, metadata).
2. Persist image bytes+metadata in Redis and return reference IDs.
3. Replace image URL in content with reference IDs before DB insert.

### Task 4: Regenerate and verify

**Files:**
- Generated: `src/generated/prisma/*`

1. Run `pnpm db:generate`.
2. Run `pnpm build`.
