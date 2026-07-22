# Architecture Documentation Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Synchronize the repository architecture overview with the current ReAct execution, background scheduling, event-return, and snapshot persistence boundaries.

**Architecture:** Keep `docs/ARCHITECTURE.md` as the concise runtime overview and make it defer detailed invariants to the existing focused documents. Mirror only the affected high-level wording into `README.md` and the Prisma schema comment; do not change runtime behavior or add new repository checks.

**Tech Stack:** Markdown, Prisma schema comments, pnpm repository checks.

---

### Task 1: Correct the ReAct and background execution overview

**Files:**
- Modify: `docs/ARCHITECTURE.md:15-19`

**Step 1: Update the ReAct description**

State that `react-kernel.ts` sends the deterministic working-context projection, parallelizes only consecutive explicitly read-only tool calls, treats side effects and unknown calls as barriers, and appends results in original tool-call order.

**Step 2: Update the scheduler topology**

List all shared scheduler lanes: `maintenance=1`, `network=3`, `media-description=2`, and `delegate=2`. Explicitly distinguish the separate ingress media-description `jobQueue` and Browser sidecar housekeeping scheduler.

**Step 3: Qualify concurrent result routing**

State that user-visible background tasks and delegates return completion events to the main ledger, while Memory maintenance, Life review, and housekeeping update side-data or logs without entering the ledger.

### Task 2: Correct the snapshot persistence boundary

**Files:**
- Modify: `docs/ARCHITECTURE.md:31-34`
- Modify: `README.md:11-14`
- Modify: `prisma/schema.prisma:57-59`

**Step 1: Separate ledger messages from runtime control state**

Describe `context_snapshot` as the persisted `AgentContext` shape containing LLM-visible `messages` and non-visible `activeToolCapabilities`.

**Step 2: List atomic row metadata**

Include `mailbox_cursors`, `mailbox_continuity`, `goal_revision`, and legacy recovery boundary `last_wake_at` as row-level runtime control state.

**Step 3: Correct the Prisma comment**

Replace the direct-feed claim with wording that LLM requests use a deterministic working-context projection derived from durable `messages`.

### Task 3: Verify the documentation-only change

**Files:**
- Verify: `docs/ARCHITECTURE.md`
- Verify: `README.md`
- Verify: `prisma/schema.prisma`

**Step 1: Inspect the diff**

Run: `git diff --check && git diff -- docs/ARCHITECTURE.md README.md prisma/schema.prisma`

Expected: no whitespace errors; only the approved architecture wording changes.

**Step 2: Run the repository documentation check**

Run: `pnpm repo-check`

Expected: `repo-check passed`.

**Step 3: Commit if requested**

```bash
git add docs/ARCHITECTURE.md README.md prisma/schema.prisma
git commit -m "docs: 同步架构运行边界"
```
