# Unified QQ Mailbox and Send Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route every QQ message through priority-aware mailbox disclosure and replace send dry-run behavior with one authorized, explicit send contract.

**Architecture:** Keep `messages` as the inbound fact ledger and make `mailbox.ts` the sole disclosure path for QQ events. Introduce a centralized outbound target policy backed by monitored-group configuration and NapCat friend-list membership, then send all text/image payloads through shared segment construction and structured receipts.

**Tech Stack:** TypeScript, ESM, Zod, node:test, Prisma, node-napcat-ts

---

### Task 1: Route all QQ events through priority-aware mailbox notifications

**Files:**
- Modify: `src/agent/mailbox.test.ts`
- Modify: `src/agent/bot-loop-agent.test.ts`
- Modify: `src/agent/mailbox.ts`
- Modify: `prompts/bot-system.md`
- Modify: `docs/AGENT_CONTEXT.md`
- Modify: `docs/ARCHITECTURE.md`

**Steps:**

1. Change mailbox tests to require mentioned group messages, ambient group messages, and private messages all to produce mailbox disclosures.
2. Add failing assertions for `priority=high` on private/mentioned batches and `priority=normal` on ambient-only group batches.
3. Run `pnpm test -- src/agent/mailbox.test.ts src/agent/bot-loop-agent.test.ts` and confirm the current direct group behavior fails.
4. Remove the QQ direct-disclosure branch, calculate aggregate priority per mailbox batch, and render it in stable notification text.
5. Update prompt and architecture/context docs to describe the unified mailbox contract.
6. Re-run the focused tests and confirm they pass.

### Task 2: Add a centralized outbound target policy

**Files:**
- Create: `src/agent/send-target-policy.ts`
- Create: `src/agent/send-target-policy.test.ts`
- Modify: `src/index.ts`
- Modify: `src/agent/tools/index.ts`

**Steps:**

1. Write tests for monitored group reply authorization, ambient intersection authorization, current-friend private authorization, cache refresh on a miss, and fail-closed friend lookup.
2. Run `pnpm test -- src/agent/send-target-policy.test.ts` and confirm the module/API is missing.
3. Implement a policy with injected friend-list loading, a short cache, and one forced refresh before rejecting an unknown private target.
4. Wire the policy from the connected NapCat instance into the tool manifest.
5. Re-run the focused test and confirm it passes.

### Task 3: Replace dry-run with strict send validation and receipts

**Files:**
- Modify: `src/agent/tools/send-message.test.ts`
- Modify: `src/agent/tools/send-message.ts`
- Modify: `src/messaging/message-sender.ts`
- Modify: `src/messaging/napcat-sender.ts`
- Modify: `src/agent/tools/index.ts`

**Steps:**

1. Change tests to require explicit mode, exact ambient/reply parameter combinations, rejected unauthorized targets, and `sent|rejected|failed` receipts.
2. Add assertions that rejected sends never call the sender and that no simulated success remains.
3. Run `pnpm test -- src/agent/tools/send-message.test.ts` and confirm failures reflect the old schema/dry-run behavior.
4. Implement strict discriminated schemas, authorize before media resolution, and return structured receipts.
5. Route text and image payloads through shared segment construction and a single sender method.
6. Normalize group/private delivery logs around target, mode, status, and attempts.
7. Re-run focused send, sender, and segment tests.

### Task 4: Make BotLoop wait only after confirmed delivery

**Files:**
- Modify: `src/agent/bot-loop-agent.test.ts`
- Modify: `src/agent/bot-loop-agent.ts`

**Steps:**

1. Add failing tests showing `rejected` and `failed` receipts continue the loop while `sent` waits.
2. Run the focused BotLoop test and confirm the old `ok=true` parser is insufficient for the new receipt.
3. Replace the generic success parser with a strict `status === 'sent'` receipt check.
4. Re-run the focused test.

### Task 5: Synchronize documentation and verify

**Files:**
- Modify: `docs/TOOLS.md`
- Modify: `.env.example` if ambient comments mention dry-run
- Modify: other directly affected tests/docs found by `rg "dry-run|mentionedSelf|直接进入|group ambient"`.

**Steps:**

1. Remove dry-run documentation and document explicit rejection and friend authorization.
2. Run the complete focused test set for mailbox, replay, send policy, send tool, BotLoop, sender, and prompt/repo checks.
3. Run `pnpm typecheck`.
4. Run `pnpm repo-check`.
5. Review `git diff --check`, `git status --short`, and the final scoped diff before committing.
