# Media Handle Guidance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose stable inbound media handles through `inbox` and make sticker collection guidance match the actual always-on tool surface.

**Architecture:** Project media references directly from the persisted message `content` into a bounded `media` array on each inbox message. Keep frozen message text unchanged for deterministic replay, keep `collect_sticker` always-on, and remove its redundant deferred capability and stale prompt guidance.

**Tech Stack:** TypeScript, Zod, Node test runner, Prisma message records, Markdown prompt templates.

---

### Task 1: Expose structured media handles from inbox

**Files:**
- Modify: `src/agent/tools/inbox.test.ts`
- Modify: `src/agent/tools/inbox.ts`

**Step 1: Write the failing tests**

Add a test whose message content contains image, video, record, and file segments with valid `referenceId` values. Assert that the returned message contains:

```ts
media: [
  { type: 'image', mediaId: 101 },
  { type: 'video', mediaId: 102 },
  { type: 'record', mediaId: 103 },
  { type: 'file', mediaId: 104 },
]
```

Also assert that text/face segments, missing references, zero, negative, decimal, and non-numeric references are ignored, and that a message without valid media returns `media: []`.

**Step 2: Run tests to verify RED**

Run: `pnpm exec tsx --test --import tsx src/agent/tools/inbox.test.ts`

Expected: FAIL because inbox messages do not yet contain `media`.

**Step 3: Implement minimal projection**

Add a local helper in `src/agent/tools/inbox.ts` that inspects array-shaped `content`, accepts only `image|video|record|file` segments, safely converts `referenceId` to a positive integer, and returns `{ type, mediaId }` in segment order. Add the result as `media` on every projected inbox message.

**Step 4: Run tests to verify GREEN**

Run: `pnpm exec tsx --test --import tsx src/agent/tools/inbox.test.ts`

Expected: all inbox tests pass.

### Task 2: Remove the duplicate sticker capability

**Files:**
- Modify: `src/agent/tools/merged-tools.test.ts`
- Modify: `src/agent/tools/index.ts`
- Modify: `docs/TOOLS.md`

**Step 1: Write the failing manifest assertion**

Change the manifest test to assert that `collect_sticker` remains in `alwaysOnTools` and that `media_library` is absent from deferred capabilities.

**Step 2: Run tests to verify RED**

Run: `pnpm exec tsx --test --import tsx src/agent/tools/merged-tools.test.ts`

Expected: FAIL because `media_library` is still registered.

**Step 3: Remove redundant registration and update docs**

Delete the `media_library` capability block from `src/agent/tools/index.ts`. Update `docs/TOOLS.md` so `collect_sticker` is listed once under default capabilities and is no longer described as deferred. Remove nearby duplicated default-capability bullets while preserving current behavior documentation.

**Step 4: Run tests to verify GREEN**

Run: `pnpm exec tsx --test --import tsx src/agent/tools/merged-tools.test.ts`

Expected: merged tool tests pass.

### Task 3: Align the resident prompt with the tool surface

**Files:**
- Modify: `src/agent/bot-system-prompt.test.ts`
- Modify: `prompts/bot-system.md`

**Step 1: Write failing semantic prompt assertions**

Assert that the prompt says `collect_sticker` can be used directly for sticker collection, that `toolbox` guidance applies to image generation/fetch rather than the sticker pool, and that `workspace_bash` and `memory` each appear only once in the progressive-disclosure list.

**Step 2: Run tests to verify RED**

Run: `pnpm exec tsx --test --import tsx src/agent/bot-system-prompt.test.ts`

Expected: FAIL against the current duplicated and conflicting guidance.

**Step 3: Update prompt wording**

Rewrite the `toolbox` bullet to cover browser, finance, external research, image generation, and media fetch only. Add concise direct-use guidance for `collect_sticker`. Merge the duplicate `workspace_bash` and `memory` bullets without changing unrelated persona or runtime rules.

**Step 4: Run tests to verify GREEN**

Run: `pnpm exec tsx --test --import tsx src/agent/bot-system-prompt.test.ts`

Expected: prompt tests pass.

### Task 4: Verify the complete change

**Files:**
- Review: all files changed by Tasks 1-3

**Step 1: Run focused tests together**

Run: `pnpm exec tsx --test --import tsx src/agent/tools/inbox.test.ts src/agent/tools/merged-tools.test.ts src/agent/bot-system-prompt.test.ts`

Expected: all focused tests pass with zero failures.

**Step 2: Run static and repository checks**

Run: `pnpm typecheck && pnpm repo-check`

Expected: both commands exit 0.

**Step 3: Inspect the final diff**

Run: `git diff --check && git diff --stat && git status --short`

Expected: no whitespace errors; only scoped source, test, prompt, documentation, and plan files are changed, while pre-existing unrelated untracked files remain untouched.
