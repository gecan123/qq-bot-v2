# Media Description Raw-Only Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `descriptionRaw` the only persisted and resolved media description field, and return structured media descriptions directly on media segments.

**Architecture:** Remove the flattened `Media.description` column and all runtime projections built on top of it. Update generation, resolver, and reanalyze paths to read and write only `descriptionRaw`, and attach a uniform `mediaDescription` object to resolved media segments.

**Tech Stack:** TypeScript, Prisma, PostgreSQL, node:test, tsx

---

### Task 1: Remove flattened description storage

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/*_drop_media_description/migration.sql`
- Test: `pnpm build`

- [ ] Remove `Media.description` from the Prisma schema.
- [ ] Add a migration that drops the `description` column from `media`.
- [ ] Regenerate the Prisma client if required by the schema change.

### Task 2: Switch generation and reanalyze to raw-only state

**Files:**
- Modify: `src/jobs/generate-description.ts`
- Modify: `src/server/media-reanalyze.ts`
- Test: `src/jobs/generate-description.test.ts`

- [ ] Add or update failing tests so generated media writes only `descriptionRaw`.
- [ ] Replace string-based completion checks with `descriptionRaw` checks.
- [ ] Validate provider output as a non-empty object before persisting it.
- [ ] Remove flattened description writes and responses.

### Task 3: Return structured media descriptions from resolver

**Files:**
- Modify: `src/media/message-resolver.ts`
- Modify: `src/types/message-segments.ts`
- Modify: any compile-time caller that depends on resolved `summary` or `description`
- Test: `src/media/message-resolver.test.ts`
- Test: `src/utils/segment-text.test.ts`

- [ ] Update segment types to expose `mediaDescription`.
- [ ] Change resolver queries and completion checks to use `descriptionRaw`.
- [ ] Attach the full structured object to each resolved media segment.
- [ ] Remove old text-field projections and dead code.

### Task 4: Clean up remaining raw-only checks and verify

**Files:**
- Modify: `src/responder/ensure-descriptions.ts`
- Modify: `src/responder/ensure-descriptions.test.ts`
- Modify: any failing callers or fixtures revealed by type errors
- Test: targeted `node:test` suites
- Test: `pnpm build`

- [ ] Update remaining readiness checks to use `descriptionRaw`.
- [ ] Fix fixtures and tests to match the new structured contract.
- [ ] Run targeted tests for generation, resolver, and ensure-descriptions.
- [ ] Run `pnpm build`.
