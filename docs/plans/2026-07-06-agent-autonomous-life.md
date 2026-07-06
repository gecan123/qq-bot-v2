# Agent Autonomous Life Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the agent continue self-directed work after sending, schedule its own wake-up through `pause`, and remain bounded by round and daily token safeguards.

**Architecture:** Keep self-wake timing inside the existing blocking `pause/rest` tool so no mutable scheduler state enters replay. Remove send-success waiting from BotLoop, return the agent's next intention after rest, and add injectable runtime-only guards for runaway consecutive rounds and daily autonomous token usage.

**Tech Stack:** TypeScript ESM, Zod, node:test, existing EventQueue and BotLoopAgent

---

### Task 1: Make pause carry a self-chosen next intention

**Files:**
- Modify: `src/agent/tools/pause.test.ts`
- Modify: `src/agent/tools/rest.test.ts`
- Modify: `src/agent/tools/pause.ts`
- Modify: `src/agent/tools/rest.ts`
- Modify: `src/agent/tool-schema.test.ts`

**Steps:**

1. Write failing tests requiring `intention`, a 300-second default, a 30-second minimum, a 21,600-second maximum, and an elapsed result that includes the intention.
2. Run pause/rest/tool-schema tests and confirm the old schema/result fails.
3. Replace `reason` with bounded `intention`, update duration limits, and include the intention in elapsed/interrupted tool results.
4. Re-run focused tests and confirm they pass.

### Task 2: Continue after successful sends

**Files:**
- Modify: `src/agent/bot-loop-agent.test.ts`
- Modify: `src/agent/bot-loop-agent.ts`

**Steps:**

1. Replace the old “sent waits for an external event” test with a failing test proving `send_message status=sent` immediately reaches a following `pause` call.
2. Run the focused BotLoop test and confirm the old wait branch prevents the second round.
3. Remove `shouldWaitForExternalEvent` and the send-result parser; only an empty/no-context step waits for external input.
4. Re-run the focused BotLoop test.

### Task 3: Add consecutive-round cooldown

**Files:**
- Modify: `src/agent/bot-loop-agent.test.ts`
- Modify: `src/agent/bot-loop-agent.ts`

**Steps:**

1. Add failing tests with injected `maxConsecutiveRounds`, fake cooldown timer, and an attention event.
2. Prove the loop cools down after the configured number of rounds, resets after a `pause` call, and lets attention events interrupt cooldown.
3. Implement runtime-only consecutive-round tracking and `waitForAttentionOrTimeout` without appending synthetic context messages.
4. Re-run focused tests.

### Task 4: Add daily autonomous token budget

**Files:**
- Modify: `src/agent/bot-loop-agent.test.ts`
- Modify: `src/agent/bot-loop-agent.ts`

**Steps:**

1. Add failing tests with an injected day key, next-day delay and tiny budget.
2. Prove budget exhaustion blocks rounds with no newly disclosed event, resets on a new day, and still allows a newly disclosed external event to run.
3. Count non-null input/output tokens after each round in runtime-only state and wait until the next day when an autonomous round would exceed the budget.
4. Re-run focused tests.

### Task 5: Teach the autonomous-life contract

**Files:**
- Modify: `prompts/bot-system.md`
- Modify: `src/agent/bot-system-prompt.test.ts`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/TOOLS.md`
- Modify: `docs/OPERATIONS.md`

**Steps:**

1. Add failing prompt assertions for tick-as-debug-only, group-chat-not-total-life, self-chosen next action, and no runtime-mechanism narration.
2. Update prompt and docs with the new loop and pause contract.
3. Re-run prompt and repo checks.

### Task 6: Verify

1. Run focused pause, rest, BotLoop, prompt and schema tests.
2. Run `./node_modules/.bin/tsc --noEmit`.
3. Run `./node_modules/.bin/tsx scripts/repo-check.ts`.
4. Run `git diff --check` and inspect scoped status.
