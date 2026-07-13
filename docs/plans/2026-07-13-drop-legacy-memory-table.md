# Drop Legacy Memory Table Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion while executing this plan.

**Goal:** Remove the unused PostgreSQL `memory_entries` table and every live-code dependency on its Prisma model.

**Architecture:** Markdown files under `data/agent-workspace/memory/` remain the sole long-term memory store. A forward Prisma migration drops the legacy table; reset-memory only clears active snapshot/goal rows and managed workspace directories.

**Tech Stack:** TypeScript, Node test runner, Prisma, PostgreSQL, pnpm.

---

### Task 1: Update the reset-memory contract

**Files:**
- Modify: `src/ops/reset-agent-memory.test.ts`
- Modify: `src/ops/reset-agent-memory.ts`

1. Remove the `memoryEntry` test dependency and `deletedLegacyMemoryRows` expectations.
2. Run `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/reset-agent-memory.test.ts`; expect a type/runtime failure against the old implementation.
3. Remove `memoryEntry` and `deletedLegacyMemoryRows` from the implementation.
4. Re-run the focused test; expect PASS.

### Task 2: Drop the Prisma model and database table

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260713030000_drop_legacy_memory_entries/migration.sql`

1. Remove the legacy `MemoryEntry` model from the schema.
2. Add `DROP TABLE IF EXISTS "memory_entries";` as a forward migration.
3. Run `pnpm db:generate` and confirm generated Prisma types no longer expose `MemoryEntry`/`memoryEntry`.

### Task 3: Verify the cleanup

1. Run `rg -n "deletedLegacyMemoryRows|memoryEntry|model MemoryEntry|@@map\\(\"memory_entries\"\\)" src scripts prisma/schema.prisma src/generated/prisma` and confirm no live references.
2. Run `pnpm test`.
3. Run `pnpm typecheck`.
4. Run `pnpm repo-check`.
5. Inspect `git diff --check` and the final diff.
