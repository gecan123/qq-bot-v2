# Multi-Source Mailbox Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep one global AgentContext while disclosing direct QQ messages immediately, reducing ambient group traffic to bounded mailbox notifications, and allowing bounded on-demand mailbox reads.

**Architecture:** `messages` remains the immutable source of truth. A mailbox checkpoint containing per-source message-row cursors is persisted atomically beside the AgentContext snapshot. The bot loop classifies drained message events into direct disclosures or source-grouped ambient notifications; an `inbox` tool reads exact source history on demand.

**Tech Stack:** TypeScript ESM, Node test runner, Zod, Prisma/PostgreSQL, pnpm.

---

### Task 1: Mailbox disclosure planner

**Files:**
- Create: `src/agent/mailbox.ts`
- Create: `src/agent/mailbox.test.ts`

1. Write failing tests showing private and mentioned group events remain direct, ambient group events are grouped by source, notification text excludes message bodies, and source cursors advance by maximum `messageRowId`.
2. Run `node_modules/.bin/tsx --test --import tsx src/agent/mailbox.test.ts`; expect failure because `mailbox.ts` is absent.
3. Implement stable mailbox keys, event classification, disclosure planning, bounded notification rendering, and cursor advancement.
4. Re-run the focused test; expect all tests to pass.

### Task 2: Bot loop integration and atomic checkpoint API

**Files:**
- Modify: `src/agent/bot-loop-agent.ts`
- Modify: `src/agent/bot-loop-agent.test.ts`
- Modify: `src/agent/integration-multi-source.test.ts`
- Modify: `src/agent/snapshot-repo.ts`
- Modify: `prisma/schema.prisma`

1. Change loop tests first: an unmentioned group body must not enter context, its notification must; private and mentioned messages remain verbatim; snapshot saves include advanced per-source cursors.
2. Run the focused bot-loop and integration tests; expect assertion/type failures against current behavior and repo API.
3. Add `mailbox_cursors` JSON to `BotAgentSnapshot`, extend `BotSnapshotRepo` load/save values, and pass the loaded cursor map into the loop.
4. Replace per-event unconditional append with the disclosure planner and persist context plus cursors in each snapshot save.
5. Re-run focused tests; expect pass.

### Task 3: Cursor-based replay

**Files:**
- Modify: `src/agent/replay-missed.ts`
- Modify: `src/agent/replay-missed.test.ts`
- Modify: `src/index.ts`

1. Add failing tests proving rows at or below each source cursor are skipped independently, rows above are enqueued, and an absent snapshot still skips cold-start history.
2. Run `node_modules/.bin/tsx --test --import tsx src/agent/replay-missed.test.ts`; expect failures because replay only accepts `lastWakeAt`.
3. Implement cursor filtering with legacy `lastWakeAt` fallback for old snapshots and wire loaded cursors through startup.
4. Re-run the replay tests; expect pass.

### Task 4: Bounded inbox tool

**Files:**
- Create: `src/agent/tools/inbox.ts`
- Create: `src/agent/tools/inbox.test.ts`
- Modify: `src/agent/tools/index.ts`
- Modify: `src/agent/tools/merged-tools.test.ts`
- Modify: `prompts/bot-system.md`

1. Add failing tests for explicit group/private reads, group whitelist rejection, ascending row pagination, list output, and output truncation.
2. Run the focused inbox and tool-registry tests; expect failure because the tool is absent.
3. Implement the Zod action union, bounded Prisma reads, stable JSON projection, group allowlist, and registry wiring.
4. Update the stable system-prompt index to explain inbox notifications and the tool entry point.
5. Re-run focused tests; expect pass.

### Task 5: Generated client, documentation, and verification

**Files:**
- Modify generated output: `src/generated/prisma/**`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/AGENT_CONTEXT.md`
- Modify: `docs/TOOLS.md`
- Modify comments that still describe global `lastWakeAt` as the primary replay contract.

1. Run `node_modules/.bin/prisma generate`; expect the client to include `mailboxCursors`.
2. Update architecture and contract documentation with the fact/delivery/context split and direct/ambient policy.
3. Run focused mailbox, bot-loop, replay, inbox, integration, and prompt tests.
4. Run `node_modules/.bin/tsc --noEmit`.
5. Run `node_modules/.bin/tsx scripts/repo-check.ts`.
6. Run `node_modules/.bin/tsx --test --import tsx 'src/**/*.test.ts'`.
7. Inspect `git diff --check` and `git status --short`; preserve unrelated untracked files.
