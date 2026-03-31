# Codex-Agent P0 Architecture Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current @-mention agent toolchain with the P0 atomic-tool architecture (`db_schema`, `db_read`, `web_search`, `final_answer`) and enforce SQL guardrails with stable fallback behavior.

**Architecture:** Keep the existing loop/adapter skeleton, but swap tool layer from business-specific queries to atomic retrieval primitives. Add a DB-read guardrail module for read-only SQL, group scope enforcement, timeout and result truncation. Keep response routing unchanged except raising defaults to `maxSteps=12` and `replyContextMessages=20`.

**Tech Stack:** TypeScript, Node.js, Prisma, pg, zod, node:test, tsx

---

### Task 1: Replace Tool Surface With Atomic Tools

**Files:**
- Modify: `src/agent/tools.ts`
- Test: `src/agent/tools.test.ts`

- [ ] **Step 1: Write failing tests for new tool schemas and removed legacy tools**
- Add tests asserting declarations include `db_schema`, `db_read`, `final_answer` and optional `web_search`.
- Add tests asserting removed legacy schemas (`search_messages`, `get_user_profile`, etc.) are no longer present.

- [ ] **Step 2: Run tests to verify failure**
- Run: `pnpm test src/agent/tools.test.ts`
- Expected: FAIL because existing tool schemas are still legacy.

- [ ] **Step 3: Implement minimal tool declaration migration**
- Rewrite `createAgentTools(groupId)` declarations and executors to:
  - `db_schema`
  - `db_read`
  - `final_answer`
  - conditional `web_search`
- Return structured JSON strings for `db_schema`/`db_read`/`web_search` results.

- [ ] **Step 4: Re-run tests**
- Run: `pnpm test src/agent/tools.test.ts`
- Expected: PASS.

- [ ] **Step 5: Commit**
- `git add src/agent/tools.ts src/agent/tools.test.ts`
- `git commit -m "feat: migrate agent tools to atomic db/web primitives"`

### Task 2: Add Guarded Read-Only SQL Executor

**Files:**
- Create: `src/database/agent-sql.ts`
- Modify: `src/agent/tools.ts`
- Test: `src/database/agent-sql.test.ts`

- [ ] **Step 1: Write failing tests for SQL guardrails**
- Add tests for:
  - allow `SELECT` / `WITH ... SELECT`
  - reject multi-statement SQL
  - reject DDL/DML keywords
  - require `:group_id`
  - require explicit group predicate (`group_id = :group_id` or `<alias>.group_id = :group_id`)
  - named param compilation (`:name` -> `$n`)

- [ ] **Step 2: Run tests to verify failure**
- Run: `pnpm test src/database/agent-sql.test.ts`
- Expected: FAIL (module not implemented yet).

- [ ] **Step 3: Implement minimal guarded SQL module**
- Add:
  - SQL validation helpers
  - named-parameter compiler
  - read-only query execution via `pg` with timeout
  - result row cap + `truncated` flag
- Wire `db_read` executor to this module.

- [ ] **Step 4: Re-run tests**
- Run: `pnpm test src/database/agent-sql.test.ts`
- Expected: PASS.

- [ ] **Step 5: Commit**
- `git add src/database/agent-sql.ts src/database/agent-sql.test.ts src/agent/tools.ts`
- `git commit -m "feat: add guarded read-only sql executor for agent db_read"`

### Task 3: Align Loop/Entry Defaults With P0

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `src/config/agent-profiles.ts`
- Test: `src/agent/loop.test.ts`

- [ ] **Step 1: Write failing tests for defaults**
- Add/adjust tests expecting:
  - loop default `maxSteps=12`
  - profile default `replyContextMessages=20`

- [ ] **Step 2: Run tests to verify failure**
- Run: `pnpm test src/agent/loop.test.ts`
- Expected: FAIL before default updates.

- [ ] **Step 3: Implement minimal default updates**
- Update loop default max steps.
- Update agent profile default context message count.

- [ ] **Step 4: Re-run tests**
- Run: `pnpm test src/agent/loop.test.ts`
- Expected: PASS.

- [ ] **Step 5: Commit**
- `git add src/agent/loop.ts src/config/agent-profiles.ts src/agent/loop.test.ts`
- `git commit -m "feat: set agent loop and context defaults for p0 architecture"`

### Task 4: End-to-End Validation And Regression Check

**Files:**
- Modify (if needed): `src/responder/handlers/at-mention.ts`
- Test: existing impacted tests

- [ ] **Step 1: Run focused suite**
- Run: `pnpm test src/agent/*.test.ts src/database/*.test.ts src/responder/ensure-descriptions.test.ts`
- Expected: PASS.

- [ ] **Step 2: Run type/build gate**
- Run: `pnpm build`
- Expected: PASS.

- [ ] **Step 3: Fix residual regressions minimally**
- Patch only files directly impacted by P0 changes.

- [ ] **Step 4: Re-run verification**
- Run same test/build commands again.
- Expected: PASS.

- [ ] **Step 5: Final commit**
- `git add <only p0-related files>`
- `git commit -m "feat: deliver p0 codex-agent architecture with guarded db tools"`

### Task 5: Update Architecture/Reply Docs For New Tool Surface

**Files:**
- Modify: `docs/reply-logic.md`
- Modify: `docs/agent-loop-design.md`

- [ ] **Step 1: Write doc assertions as failing checks (manual)**
- Identify stale references to legacy tools and old defaults.

- [ ] **Step 2: Update docs minimally**
- Replace tool table and defaults to match P0 implementation.

- [ ] **Step 3: Manual doc sanity pass**
- Ensure docs align with code behavior and naming.

- [ ] **Step 4: Commit**
- `git add docs/reply-logic.md docs/agent-loop-design.md`
- `git commit -m "docs: align agent loop docs with p0 atomic tool architecture"`
