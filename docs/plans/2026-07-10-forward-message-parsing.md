# NapCat Forward Message Parsing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand inbound NapCat `forward` segments into bounded, recursively parsed message trees that are persisted once and rendered deterministically.

**Architecture:** Keep the existing synchronous segment parser for ordinary messages and add an asynchronous forward-aware entry point with an injected NapCat loader. Normalize each forwarded child through `get_msg`, fall back to the child payload on failure, then reuse the same recursive parser. Extend the existing media and text walkers to traverse the new structured segment.

**Tech Stack:** TypeScript 5.9, ESM, node-napcat-ts 0.4.21, Node.js test runner, pnpm.

---

### Task 1: Define and parse structured forward messages

**Files:**
- Modify: `src/types/message-segments.ts`
- Modify: `src/bot/message-parser.ts`
- Create: `src/bot/message-parser.test.ts`

**Step 1: Write the failing tests**

Add tests that pass a `forward` segment to a forward-aware parser and assert that it:

- calls `get_forward_msg` when no usable embedded messages exist;
- calls `get_msg` for each child `message_id`;
- uses the `get_msg` payload as the normalized child;
- falls back to the child payload when `get_msg` rejects;
- recursively expands nested forwards;
- marks unavailable or truncated results without storing exception text.

**Step 2: Run tests to verify RED**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/bot/message-parser.test.ts`

Expected: FAIL because the forward-aware API and structured segment do not exist.

**Step 3: Implement the minimal parser**

Add `ForwardSegment` and `ForwardMessageItem`. Add an injected loader interface and `parseMessageWithForwards`, with a shared request cache, maximum depth 3, total item budget 50, and 2,000 text characters per child.

**Step 4: Run tests to verify GREEN**

Run the command from Step 2.

Expected: PASS.

### Task 2: Integrate ingress and deterministic rendering

**Files:**
- Modify: `src/bot/core.ts`
- Modify: `src/utils/segment-text.ts`
- Modify: `src/utils/segment-text.test.ts`

**Step 1: Write the failing renderer tests**

Assert stable sender-labelled output, nested output, unavailable markers, and truncation markers for structured forward segments.

**Step 2: Run tests to verify RED**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/utils/segment-text.test.ts`

Expected: FAIL because `forward` is not rendered.

**Step 3: Implement rendering and ingress usage**

Render the forward tree in item order and change ingress to await `parseMessageWithForwards(qqMsg, napcat)`. Keep the existing top-level structured mention check unchanged.

**Step 4: Run focused tests to verify GREEN**

Run both parser and renderer test files.

Expected: PASS.

### Task 3: Traverse nested media

**Files:**
- Modify: `src/media/media-cache.ts`
- Modify: `src/media/media-cache.test.ts`
- Modify: `src/media/message-resolver.ts`
- Modify: `src/media/message-resolver.test.ts`
- Modify: `src/agent/tools/inbox.ts`
- Modify: `src/agent/tools/inbox.test.ts`

**Step 1: Write failing tests**

Assert that nested media receives a reference ID, nested descriptions are resolved, and inbox exposes nested handles in stable order.

**Step 2: Run tests to verify RED**

Run the three affected test files.

Expected: FAIL because current walkers only inspect top-level segments.

**Step 3: Implement recursive walkers**

Recursively transform `ForwardSegment.items[].content`, aggregate reference IDs in traversal order, and preserve every non-media field.

**Step 4: Run tests to verify GREEN**

Run the three affected test files.

Expected: PASS.

### Task 4: Verify the repository

**Files:**
- Review: all modified files

**Step 1: Run focused tests**

Run all parser, renderer, media-cache, resolver, and inbox tests.

Expected: PASS.

**Step 2: Run static verification**

Run: `pnpm typecheck`

Expected: exit 0.

Run: `pnpm repo-check`

Expected: exit 0.

**Step 3: Inspect the diff**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors and only planned files changed.
