# Mailbox Batch Window Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make high-priority mailbox notifications identify the complete row window that must be read, without skipping group messages before a late `@bot` mention.

**Architecture:** Keep mailbox cursor persistence and the `inbox read` query contract unchanged. Render both the exclusive starting cursor (`afterRowId`) and inclusive batch end (`throughRowId`) in each notification, then instruct the agent to paginate high-priority reads until the returned messages cover the batch end.

**Tech Stack:** TypeScript ESM, node:test, existing mailbox renderer and prompt templates

---

### Task 1: Render an explicit mailbox batch window

**Files:**
- Modify: `src/agent/mailbox.test.ts`
- Modify: `src/agent/mailbox.ts`

**Step 1: Write the failing test**

Extend the high-priority group batch test so a normal message at row 13 precedes an `@bot` message at row 14, then assert the notification contains the complete window:

```ts
assert.match(rendered, /afterRowId=12/)
assert.match(rendered, /throughRowId=14/)
```

Also assert the normal and private notification tests expose their respective `throughRowId` values.

**Step 2: Run the test to verify it fails**

Run:

```bash
./node_modules/.bin/tsx --test --import tsx src/agent/mailbox.test.ts
```

Expected: FAIL because notifications do not contain `throughRowId`.

**Step 3: Implement the minimal renderer change**

In `renderMailboxNotification`, retain the existing `afterRowId` based on the first event and add the inclusive batch end to the read instruction:

```ts
const throughRowId = last.messageRowId
```

Render:

```text
需要时调用 inbox ... afterRowId=<start>; 本批读取至 throughRowId=<end>.
```

Do not move `afterRowId` to the first high-priority message. Every row in the batch must remain readable in order.

**Step 4: Run the test to verify it passes**

Run the focused mailbox test and expect all cases to pass.

### Task 2: Require complete reads for high-priority batches

**Files:**
- Modify: `prompts/bot-system.md`
- Modify: `src/agent/bot-system-prompt.test.ts`

**Step 1: Write the failing prompt test**

Add an assertion that the rendered system prompt states that a high-priority mailbox batch must be paginated from `afterRowId` until `throughRowId` is covered, without skipping earlier messages.

**Step 2: Run the test to verify it fails**

Run:

```bash
./node_modules/.bin/tsx --test --import tsx src/agent/bot-system-prompt.test.ts
```

Expected: FAIL because the prompt currently only says to read high-priority notifications first.

**Step 3: Implement the prompt rule**

Add one stable sentence to the message notification section:

```text
读取 priority=high 批次时，从通知给出的 afterRowId 开始；如果结果尚未覆盖 throughRowId，继续用最后一条 rowId 分页，直到覆盖本批末尾，不要跳过前面的群聊。
```

Do not change the `inbox` schema or add a second filtering path.

**Step 4: Run the test to verify it passes**

Run the focused prompt test and expect it to pass.

### Task 3: Verify the scoped change

**Files:**
- No additional files expected.

**Step 1: Run focused tests**

```bash
./node_modules/.bin/tsx --test --import tsx \
  src/agent/mailbox.test.ts \
  src/agent/bot-system-prompt.test.ts \
  src/agent/bot-loop-agent.test.ts
```

Expected: PASS.

**Step 2: Run static checks**

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsx scripts/repo-check.ts
git diff --check
```

Expected: all commands pass.
