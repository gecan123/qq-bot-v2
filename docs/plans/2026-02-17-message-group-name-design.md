# Message Group Name Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a nullable `group_name` field to `Message` and persist group name for each saved group message.

**Architecture:** Extend Prisma model and write path. During message handling, prefer group name from the incoming event payload; if absent, call `get_group_info` and use `group_name` as fallback.

**Tech Stack:** TypeScript, Prisma 7, node-napcat-ts

---

### Task 1: Extend data model

**Files:**
- Modify: `prisma/schema.prisma`

1. Add `groupName String? @map("group_name") @db.VarChar(255)` to `Message`.

### Task 2: Extend insert contract

**Files:**
- Modify: `src/database/messages.ts`

1. Add `groupName?: string` to `InsertMessageParams`.
2. Persist `groupName` in Prisma `create` payload.

### Task 3: Resolve and pass group name

**Files:**
- Modify: `src/bot/core.ts`

1. Add helper to extract event-side group name if present.
2. Add fallback helper that calls `napcat.get_group_info({ group_id })`.
3. Pass resolved `groupName` into `insertMessage`.

### Task 4: Regenerate and verify

**Files:**
- Generated: `src/generated/prisma/*`

1. Run `pnpm db:generate`.
2. Run `pnpm build`.
