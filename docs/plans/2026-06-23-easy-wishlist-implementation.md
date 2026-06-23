# Easy Wishlist Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the easiest Luna wishlist items: configurable image quality, batched image generation with up to five input images, journal recall, and sticker pool browsing/search.

**Architecture:** Keep changes at the bot/backend tool layer. Preserve the single persistent `AgentContext`; large or mutable content stays behind tool calls, `OutboundCache`, Prisma rows, and bounded tool results. Extend existing tools instead of adding new user-facing tool names unless a test shows the current shape becomes unmaintainable.

**Tech Stack:** TypeScript ESM, Zod, Prisma client in `src/generated/prisma/`, Node test runner, OpenAI-compatible image API, existing `BackgroundTaskRegistry` and `OutboundCache`.

---

## Ground Rules

- Work on `main` unless the user explicitly asks for a branch.
- Use `.js` extensions for local TypeScript imports.
- Use TDD for behavior changes.
- Do not touch `data/agent-workspace/`.
- Do not change `AgentContext`, replay, compaction, or system prompt bytes unless a task explicitly says so.
- After tool schema changes, run focused tests, `pnpm typecheck`, and `pnpm repo-check`.

## Task 1: Image Generation API Options

**Files:**
- Modify: `src/llm/image-gen.ts`
- Test: create `src/llm/image-gen.test.ts` or extend existing LLM adapter tests only if dependency injection is easier there.

**Step 1: Write failing tests for quality and multi-image edit**

Create tests that mock the OpenAI client boundary or extract request-building helpers from `src/llm/image-gen.ts`.

Required assertions:

- `generateImage("p")` defaults to `quality: "medium"`.
- `generateImage("p", { quality: "high" })` sends `quality: "high"`.
- `editImage("p", [buf1, buf2], { quality: "low" })` sends multiple image files to `images.edit`.

If direct OpenAI mocking is awkward, first extract pure helpers:

```ts
export type ImageQuality = 'low' | 'medium' | 'high'

export function normalizeImageQuality(value?: ImageQuality): ImageQuality {
  return value ?? 'medium'
}
```

**Step 2: Run failing tests**

Run:

```bash
pnpm test src/llm/image-gen.test.ts
```

Expected: tests fail because options and multi-source edit do not exist.

**Step 3: Implement minimal API changes**

Update `src/llm/image-gen.ts`:

- Export `ImageQuality`.
- Add `ImageGenerationOptions`.
- Change `generateImage(prompt, options?)`.
- Change `editImage(prompt, sourceBytes[], options?)`.
- Keep `SIZE = "1024x1024"`.
- Keep default quality `medium`.
- Pass `quality` to generate.
- Pass image file array to edit.

Expected shape:

```ts
export type ImageQuality = 'low' | 'medium' | 'high'

export interface ImageGenerationOptions {
  quality?: ImageQuality
}
```

**Step 4: Run tests**

Run:

```bash
pnpm test src/llm/image-gen.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/llm/image-gen.ts src/llm/image-gen.test.ts
git commit -m "feat: 支持图片生成质量参数"
```

## Task 2: generate_image Tool Schema

**Files:**
- Modify: `src/agent/tools/generate-image.ts`
- Modify: `src/agent/tools/generate-image.test.ts`

**Step 1: Write failing schema and execution tests**

Add tests:

- accepts `quality: "low" | "medium" | "high"`.
- rejects invalid quality.
- accepts `count` from 1 to 4.
- rejects `count: 5`.
- accepts `images` array with up to 5 handles.
- rejects 6 input images.
- when `images` has 2 handles, calls edit with two buffers.

Use existing `OutboundCache` setup in `generate-image.test.ts`.

**Step 2: Run failing tests**

Run:

```bash
pnpm test src/agent/tools/generate-image.test.ts
```

Expected: FAIL because schema and edit path are single-image only.

**Step 3: Implement schema**

Update the args schema:

```ts
quality: z.enum(['low', 'medium', 'high']).default('medium')
count: z.number().int().min(1).max(4).default(1)
images: z.array(imageHandleSchema).max(5).optional()
```

Keep backwards compatibility by accepting the old `image` field during a short internal transition:

- `image?: imageHandleSchema`
- `images?: imageHandleSchema[]`
- normalize to one `sourceImages` array.
- Reject if both `image` and `images` are provided.

**Step 4: Implement source image resolution**

Resolve every input handle with `resolveImageHandle(handle, { acquire: true })`.

Rules:

- If any handle fails, release all previously acquired handles and return `{ ok: false }`.
- Release all acquired handles in `finally` after background work.
- `isEdit = sourceImages.length > 0`.

**Step 5: Run tests**

Run:

```bash
pnpm test src/agent/tools/generate-image.test.ts
```

Expected: PASS for schema and source image resolution tests.

**Step 6: Commit**

```bash
git add src/agent/tools/generate-image.ts src/agent/tools/generate-image.test.ts
git commit -m "feat: 支持多图输入生成图片"
```

## Task 3: Batched Image Outputs

**Files:**
- Modify: `src/agent/tools/generate-image.ts`
- Modify: `src/agent/tools/generate-image.test.ts`
- Modify if needed: `src/agent/tools/get-task-result.ts`

**Step 1: Write failing batch result tests**

Add tests:

- `count: 3` calls generate/edit three times.
- task result contains `images` with three entries.
- every image entry includes `ephemeralRef`, `dataHash`, `byteSize`, `contentType`, and `description`.
- `background_task get` can render at least the first preview image and text metadata for all images.

**Step 2: Run failing tests**

Run:

```bash
pnpm test src/agent/tools/generate-image.test.ts src/agent/tools/merged-tools.test.ts
```

Expected: FAIL because result data only supports one image.

**Step 3: Implement batch work loop**

Inside background work:

- Loop `count` times.
- For each item, call `generate(prompt, { quality })` or `edit(prompt, sourceBytes, { quality })`.
- Store each result in `OutboundCache`.
- Build a result array.
- Add compressed preview for the first result, or a small bounded number if existing `get-task-result` can safely return multiple image blocks.

Task result shape:

```json
{
  "images": [
    {
      "ephemeralRef": "...",
      "dataHash": "...",
      "byteSize": 123,
      "contentType": "image/png",
      "description": "AI generated image 1/3: ..."
    }
  ]
}
```

**Step 4: Adapt background_task result rendering**

If `get-task-result.ts` only understands single-image task data, extend it to:

- preserve existing single-image behavior.
- render `images` array metadata.
- include one preview image block, not all previews, unless tests prove context size remains bounded.

**Step 5: Run tests**

Run:

```bash
pnpm test src/agent/tools/generate-image.test.ts src/agent/tools/merged-tools.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/agent/tools/generate-image.ts src/agent/tools/generate-image.test.ts src/agent/tools/get-task-result.ts src/agent/tools/merged-tools.test.ts
git commit -m "feat: 支持批量生成图片结果"
```

## Task 4: Journal Read/Search Actions

**Files:**
- Modify: `src/agent/tools/write-journal.ts`
- Test: create `src/agent/tools/write-journal.test.ts`

**Step 1: Write failing tests**

Tests:

- old-style `{ kind, content }` still writes for compatibility, or decide to update callers and test new `action="write"` only.
- `{ action: "write", kind: "dream", content: "..." }` writes a row.
- `{ action: "list", kind: "dream", limit: 5 }` returns recent dream entries.
- `{ action: "search", query: "keyword", limit: 5 }` returns matching entries.
- limit max is bounded, suggested max 20.
- output truncates long content.

**Step 2: Run failing tests**

Run:

```bash
pnpm test src/agent/tools/write-journal.test.ts
```

Expected: FAIL because only write exists.

**Step 3: Implement discriminated actions**

Use `z.discriminatedUnion('action', [...])` with:

- `write`
- `list`
- `search`

To avoid breaking existing LLM history/tool usage, preprocess old args:

```ts
const normalized = 'action' in rawArgs ? rawArgs : { action: 'write', ...rawArgs }
```

Bound output:

- content preview <= 200 chars per row.
- list/search limit <= 20.

**Step 4: Run tests**

Run:

```bash
pnpm test src/agent/tools/write-journal.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/tools/write-journal.ts src/agent/tools/write-journal.test.ts
git commit -m "feat: 支持日记回顾和搜索"
```

## Task 5: Sticker Pool List/Search/Random

**Files:**
- Modify: `src/agent/tools/collect-sticker.ts`
- Test: create or extend `src/agent/tools/collect-sticker.test.ts`

**Step 1: Write failing tests**

Tests:

- old collect args still work, or new `{ action: "collect", ... }` works with compatibility normalization.
- `action="list"` returns rows ordered by `useCount desc, createdAt desc`.
- `action="search"` matches name, tags, or description.
- `action="random"` returns bounded candidates and accepts optional tag.
- list/search/random return `mediaRef: "media:<id>"`.
- output limit max is bounded, suggested max 20.

**Step 2: Run failing tests**

Run:

```bash
pnpm test src/agent/tools/collect-sticker.test.ts
```

Expected: FAIL because only collect exists.

**Step 3: Implement action schema**

Use a discriminated union:

- `collect`
- `list`
- `search`
- `random`

Normalize old collect args without `action` to `{ action: "collect", ... }`.

**Step 4: Implement bounded render helper**

Return compact JSON or text with:

- `mediaRef`
- `mediaId`
- `name`
- `tags`
- `description`
- `useCount`

Do not return image bytes.

**Step 5: Run tests**

Run:

```bash
pnpm test src/agent/tools/collect-sticker.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/agent/tools/collect-sticker.ts src/agent/tools/collect-sticker.test.ts
git commit -m "feat: 支持表情包池检索"
```

## Task 6: Docs and Registry Verification

**Files:**
- Modify: `docs/TOOLS.md`
- Review: `src/agent/tools/index.ts`
- Review: `src/agent/bot-system-prompt.ts`

**Step 1: Update docs**

Update `docs/TOOLS.md` to say:

- `generate_image` supports quality, batched output, and up to five input images.
- `write_journal` supports write/list/search.
- `collect_sticker` supports collect/list/search/random.

**Step 2: Check whether system prompt index needs changes**

Open `src/agent/bot-system-prompt.ts`.

If it lists specific tool capabilities, update only the relevant short index entry. Avoid large prompt wording changes.

**Step 3: Run focused tests**

Run:

```bash
pnpm test src/llm/image-gen.test.ts src/agent/tools/generate-image.test.ts src/agent/tools/write-journal.test.ts src/agent/tools/collect-sticker.test.ts src/agent/tools/merged-tools.test.ts
```

Expected: PASS.

**Step 4: Run broad verification**

Run:

```bash
pnpm typecheck
pnpm repo-check
```

Expected: both PASS.

**Step 5: Final commit**

```bash
git add docs/TOOLS.md src/agent/bot-system-prompt.ts
git commit -m "docs: 更新愿望清单工具说明"
```

If `src/agent/bot-system-prompt.ts` did not change, omit it from `git add`.

## Task 7: Manual Smoke Notes

**Files:**
- No required code changes.

**Step 1: Prepare smoke scenarios**

After tests pass, note these manual scenarios for a running bot:

- Generate one low-quality image.
- Generate four medium-quality images.
- Edit one existing image.
- Combine two to five existing images.
- Write a dream, list recent dreams, search for a keyword.
- Search sticker pool and send one returned `media:<id>`.

**Step 2: Do not run live QQ sends unless the user asks**

`send_message` has external side effects. Keep smoke notes as manual unless explicitly authorized.
