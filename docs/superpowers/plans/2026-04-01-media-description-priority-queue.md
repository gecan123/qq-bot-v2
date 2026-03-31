# Media Description Priority Queue Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify foreground and backfill media description requests behind one queue while allowing foreground requests to preempt background backlog.

**Architecture:** Extend the in-memory job queue with priority-aware scheduling and an awaitable enqueue path. Keep `generateDescriptionForMedia()` as the worker entrypoint, enqueue backfill jobs as low priority, and let `ensureDescriptions()` wait on high-priority queue jobs instead of calling the LLM path directly.

**Tech Stack:** TypeScript, Node.js, existing in-memory queue, node:test, tsx

---

### Task 1: Queue capabilities

**Files:**
- Modify: `src/queue/types.ts`
- Modify: `src/queue/memory-queue.ts`
- Test: `src/queue/memory-queue.test.ts`

- [ ] Add failing tests for priority ordering and awaitable jobs.
- [ ] Run queue tests to verify they fail for the missing queue features.
- [ ] Implement minimal queue support for `priority` and `enqueueAndWait`.
- [ ] Re-run queue tests to verify they pass.

### Task 2: Route foreground and background jobs

**Files:**
- Modify: `src/media/media-cache.ts`
- Modify: `src/responder/ensure-descriptions.ts`
- Test: `src/responder/ensure-descriptions.test.ts`

- [ ] Add a failing test showing foreground description requests use the shared queue path.
- [ ] Run the ensure-descriptions test to verify it fails.
- [ ] Update backfill enqueue to low priority and foreground waiting to high-priority `enqueueAndWait`.
- [ ] Re-run the ensure-descriptions test to verify it passes.

### Task 3: Verify integration

**Files:**
- Test: `src/queue/memory-queue.test.ts`
- Test: `src/responder/ensure-descriptions.test.ts`

- [ ] Run targeted tests for queue and ensure-descriptions together.
- [ ] Run `pnpm build`.
