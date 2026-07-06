# Remove `send_image` Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the agent from calling the nonexistent `send_image` tool while preserving `send_message(imageRef)` as the only QQ image-send path.

**Architecture:** Keep the typed tool surface unchanged. Strengthen the existing `send_message` description and resident system prompt, then add regression assertions covering both guidance layers and the manifest inventory; unknown tools must continue to fail explicitly instead of being aliased.

**Tech Stack:** TypeScript, Node.js test runner, Zod tool schemas, Markdown prompt templates, pnpm.

---

### Task 1: Lock the unified tool surface and tool description

**Files:**
- Modify: `src/agent/tools/send-message.test.ts`
- Modify: `src/agent/tools/merged-tools.test.ts`
- Modify: `src/agent/tools/send-message.ts`

- [ ] **Step 1: Add a failing tool-description regression test**

Add this test inside `describe('send_message tool — schema rejection', ...)`:

```ts
test('description makes send_message the only text and image send tool', () => {
  const { sender } = makeMockSender()
  const tool = createAllowedTool(sender)

  assert.match(tool.description, /文本、图片和图文消息都统一使用 send_message/)
  assert.match(tool.description, /不存在 send_image 工具/)
})
```

- [ ] **Step 2: Add a manifest regression assertion**

In `buildBotToolManifest groups deferred capabilities by intent`, collect every always-on and deferred tool name and assert the clean target surface:

```ts
const allToolNames = [
  ...alwaysOnNames,
  ...manifest.capabilities.flatMap((capability) => capability.tools.map((tool) => tool.name)),
]

assert.ok(allToolNames.includes('send_message'))
assert.equal(allToolNames.includes('send_image'), false)
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
node --import tsx --test src/agent/tools/send-message.test.ts src/agent/tools/merged-tools.test.ts
```

Expected: the new description assertion fails because the current description does not explicitly say that `send_image` does not exist; existing manifest assertions remain green.

- [ ] **Step 4: Add the minimal tool-description guidance**

Add this sentence to the `send_message` description array immediately after the opening sentence:

```ts
'文本、图片和图文消息都统一使用 send_message；不存在 send_image 工具。发送图片时把已有句柄传给 imageRef。',
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
node --import tsx --test src/agent/tools/send-message.test.ts src/agent/tools/merged-tools.test.ts
```

Expected: all tests pass with zero failures.

### Task 2: Lock the resident system-prompt guidance

**Files:**
- Modify: `src/agent/bot-system-prompt.test.ts`
- Modify: `prompts/bot-system.md`

- [ ] **Step 1: Add a failing prompt regression assertion**

In `keeps chat constraints and style details out of the resident system prompt`, add:

```ts
assert.match(prompt, /文本、图片和图文消息都统一使用 send_message；不存在 send_image 工具/)
```

- [ ] **Step 2: Run the focused prompt test and verify RED**

Run:

```bash
node --import tsx --test src/agent/bot-system-prompt.test.ts
```

Expected: the new assertion fails because the resident prompt does not yet contain the unified image-send guidance.

- [ ] **Step 3: Add the minimal resident prompt rule**

In the system section, immediately after `每轮用工具表达动作: 想真实发送只能调用 send_message.`, add:

```md
文本、图片和图文消息都统一使用 send_message；不存在 send_image 工具。发送图片时把已有的 media:... 或 ephemeral:... 句柄传给 imageRef.
```

- [ ] **Step 4: Run the focused prompt test and verify GREEN**

Run:

```bash
node --import tsx --test src/agent/bot-system-prompt.test.ts
```

Expected: all tests pass with zero failures.

### Task 3: Verify repository consistency

**Files:**
- Verify: `docs/superpowers/specs/2026-07-06-remove-send-image-guidance-design.md`
- Verify: all files modified by Tasks 1 and 2

- [ ] **Step 1: Run all focused regression tests together**

Run:

```bash
node --import tsx --test src/agent/tools/send-message.test.ts src/agent/tools/merged-tools.test.ts src/agent/bot-system-prompt.test.ts
```

Expected: zero failed tests.

- [ ] **Step 2: Run repository checks**

Run:

```bash
pnpm repo-check
```

Expected: exit code 0 with no repository contract drift.

- [ ] **Step 3: Run TypeScript validation**

Run:

```bash
pnpm typecheck
```

Expected: exit code 0.

- [ ] **Step 4: Inspect the final diff**

Run:

```bash
git diff --check
git diff -- src/agent/tools/send-message.ts src/agent/tools/send-message.test.ts src/agent/tools/merged-tools.test.ts prompts/bot-system.md src/agent/bot-system-prompt.test.ts docs/superpowers/specs/2026-07-06-remove-send-image-guidance-design.md docs/superpowers/plans/2026-07-06-remove-send-image-guidance.md
```

Expected: no whitespace errors; the diff contains only the approved guidance, regression tests, spec, and plan. Leave changes uncommitted.
