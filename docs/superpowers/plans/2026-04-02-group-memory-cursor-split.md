# Group Memory Cursor Split Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split durable group memory data from rebuildable cursor state and make missing-cursor recovery scan only the most recent 24 hours of messages.

**Architecture:** Keep `group_memory` as the durable summary table and move incremental refresh state into a new `group_memory_cursor` table. Refresh logic reads and writes the cursor table separately, using `messages.id` as the primary scan cursor and a 24-hour time window when no cursor exists.

**Tech Stack:** Prisma, PostgreSQL, TypeScript, node:test, tsx

---

### Task 1: Lock expected cursor semantics with tests

**Files:**
- Modify: `src/memory/message-cursor.test.ts`
- Test: `src/memory/message-cursor.test.ts`

- [ ] **Step 1: Write failing tests**
- [ ] **Step 2: Run `pnpm test src/memory/message-cursor.test.ts` and verify failure**
- [ ] **Step 3: Implement minimal cursor helpers**
- [ ] **Step 4: Re-run `pnpm test src/memory/message-cursor.test.ts` and verify pass**

### Task 2: Split the Prisma models and DB access layer

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_split_group_memory_cursor/migration.sql`
- Modify: `src/database/memory.ts`

- [ ] **Step 1: Update schema to add `group_memory_cursor` and remove cursor columns from `group_memory`**
- [ ] **Step 2: Add migration with backfill SQL**
- [ ] **Step 3: Update database helpers to read/write memory and cursor separately**
- [ ] **Step 4: Run targeted tests or `pnpm build` to catch type breakage**

### Task 3: Move refresh logic onto the new cursor model

**Files:**
- Modify: `src/jobs/refresh-memory.ts`
- Modify: `src/memory/message-cursor.ts`
- Modify: `src/memory/message-cursor.test.ts`

- [ ] **Step 1: Write failing tests for missing-cursor 24-hour fallback semantics**
- [ ] **Step 2: Run the targeted tests and verify failure**
- [ ] **Step 3: Update refresh logic to use `GroupMemoryCursor`**
- [ ] **Step 4: Re-run targeted tests and verify pass**

### Task 4: Verify integration

**Files:**
- Verify only

- [ ] **Step 1: Run `pnpm test src/memory/message-cursor.test.ts`**
- [ ] **Step 2: Run `pnpm build`**
- [ ] **Step 3: Review staged diff and commit only relevant files**
