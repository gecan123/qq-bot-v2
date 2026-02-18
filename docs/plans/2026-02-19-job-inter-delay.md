# Job Inter-Delay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a configurable pause between consecutive queue jobs to prevent LLM rate-limiting on restart.

**Architecture:** `createMemoryQueue` accepts an `interJobDelayMs` parameter (default `0` for backward compat). After each job completes, `schedule(interJobDelayMs)` replaces `schedule(0)`. The config module reads `JOB_INTER_DELAY_MS` and passes it when constructing the queue.

**Tech Stack:** Node.js `node:test`, existing `createMemoryQueue` in `src/queue/memory-queue.ts`

---

### Task 1: Add config var

**Files:**
- Modify: `src/config/index.ts`
- Modify: `.env.example`

**Step 1: Add to config object**

In `src/config/index.ts`, add after `memoryJobSkipThreshold`:

```ts
jobInterDelayMs: Number(process.env.JOB_INTER_DELAY_MS ?? '200'),
```

**Step 2: Add to `.env.example`**

Append:
```
JOB_INTER_DELAY_MS=200
```

**Step 3: Commit**

```bash
git add src/config/index.ts .env.example
git commit -m "feat: add JOB_INTER_DELAY_MS config var"
```

---

### Task 2: Update createMemoryQueue to accept and apply the delay

**Files:**
- Modify: `src/queue/memory-queue.ts`
- Test: `src/queue/memory-queue.test.ts` (new)

**Step 1: Write the failing test**

Create `src/queue/memory-queue.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createMemoryQueue } from './memory-queue.js'

describe('createMemoryQueue', () => {
  test('processes jobs in order with interJobDelayMs=0', async () => {
    const queue = createMemoryQueue(0)
    const results: number[] = []

    queue.register('test-job', async (job) => {
      results.push((job.data as { n: number }).n)
    })

    queue.start()
    queue.enqueue('test-job', { n: 1 })
    queue.enqueue('test-job', { n: 2 })
    queue.enqueue('test-job', { n: 3 })

    await new Promise((resolve) => setTimeout(resolve, 200))
    queue.stop()

    assert.deepEqual(results, [1, 2, 3])
  })

  test('defaults to 0 delay when no argument provided', () => {
    // Just verify it constructs without error
    const queue = createMemoryQueue()
    queue.start()
    queue.stop()
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
cd /Users/cange/WebstormProjects/qq-bot-v2 && pnpm test src/queue/memory-queue.test.ts
```

Expected: FAIL — `createMemoryQueue` does not accept arguments yet.

**Step 3: Update createMemoryQueue signature**

In `src/queue/memory-queue.ts`, change the function signature from:

```ts
export function createMemoryQueue(): JobQueue {
```

to:

```ts
export function createMemoryQueue(interJobDelayMs = 0): JobQueue {
```

**Step 4: Apply the delay after each job**

In the same file, find the final `schedule(0)` call at the bottom of the `tick()` function (after the `try/catch/finally` block):

```ts
    schedule(0)
  }
```

Change it to:

```ts
    schedule(interJobDelayMs)
  }
```

**Important:** Only change the `schedule(0)` that comes *after* the `try/catch/finally` block. Do NOT change the `schedule(POLL_INTERVAL_MS)` inside the "no job" early return, or the `schedule(0)` inside the "no handler" branch.

**Step 5: Run tests**

```bash
cd /Users/cange/WebstormProjects/qq-bot-v2 && pnpm test src/queue/memory-queue.test.ts
```

Expected: PASS

**Step 6: Commit**

```bash
git add src/queue/memory-queue.ts src/queue/memory-queue.test.ts
git commit -m "feat: add interJobDelayMs parameter to createMemoryQueue"
```

---

### Task 3: Pass config value when constructing the queue

**Files:**
- Modify: `src/queue/index.ts`

**Step 1: Import config and pass delay**

Current content of `src/queue/index.ts`:

```ts
import { handleGenerateDescription } from '../jobs/generate-description.js'
import type { GenerateDescriptionData } from '../jobs/generate-description.js'
import { createMemoryQueue } from './memory-queue.js'

export const jobQueue = createMemoryQueue()
```

Replace with:

```ts
import { handleGenerateDescription } from '../jobs/generate-description.js'
import type { GenerateDescriptionData } from '../jobs/generate-description.js'
import { createMemoryQueue } from './memory-queue.js'
import { config } from '../config/index.js'

export const jobQueue = createMemoryQueue(config.jobInterDelayMs)
```

**Step 2: Verify TypeScript compiles**

```bash
cd /Users/cange/WebstormProjects/qq-bot-v2 && pnpm build
```

Expected: No errors.

**Step 3: Commit**

```bash
git add src/queue/index.ts
git commit -m "feat: pass jobInterDelayMs to queue on startup"
```

---

### Verification

Run all tests to confirm nothing is broken:

```bash
cd /Users/cange/WebstormProjects/qq-bot-v2 && pnpm test
```

Expected: All tests pass.

To manually verify the delay is working, temporarily set `JOB_INTER_DELAY_MS=2000` in `.env` and restart the bot. After reconnect, watch the logs — `generate-description` jobs should appear with ~2 second gaps between them.
