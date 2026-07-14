# Mailbox 已处理标记 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 成功回复 QQ mailbox 后向 durable AgentContext 追加确定性的 handled cursor，避免自主轮次把同一批消息再次当成新请求。

**Architecture:** `send_message` 成功时产生只供 Runtime Host 使用的 `message_sent` effect。Runtime Host 用纯函数扫描 durable ledger 中的 `inbox_update` 与 `mailbox_handled` 事件，找到发送目标仍未关闭的最新 `throughRowId`，追加一个稳定的 `mailbox_handled` user event，并随现有 post-round snapshot 保存。

**Tech Stack:** TypeScript、Node.js test runner、Zod、现有 AgentContext/BotLoop/tool-effect 架构。

---

### Task 1: Durable mailbox handled 状态纯函数

**Files:**
- Create: `src/agent/mailbox-handled.ts`
- Create: `src/agent/mailbox-handled.test.ts`

**Step 1: Write the failing tests**

覆盖以下行为：

```ts
test('finds the latest disclosed cursor that is newer than the handled cursor', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: '{"event":"inbox_update","mailbox":"qq_private:123","throughRowId":10}' },
    { role: 'user', content: '{"event":"mailbox_handled","mailbox":"qq_private:123","throughRowId":8}' },
  ]
  assert.equal(findPendingMailboxThroughRowId(messages, 'qq_private:123'), 10)
})

test('returns null when the latest disclosed range is already handled', () => {
  // inbox_update through 10 followed by mailbox_handled through 10
})

test('ignores malformed JSON and other mailboxes', () => {
  // invalid user content and qq_group:* must not affect qq_private:123
})

test('renders a byte-stable handled event', () => {
  assert.equal(
    renderMailboxHandledEvent('qq_private:123', 10),
    '{"event":"mailbox_handled","mailbox":"qq_private:123","throughRowId":10}',
  )
})
```

**Step 2: Run the tests and verify RED**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/mailbox-handled.test.ts
```

Expected: FAIL because `mailbox-handled.ts` does not exist or its exports are missing.

**Step 3: Implement the minimal pure functions**

Create exports:

```ts
export function findPendingMailboxThroughRowId(
  messages: readonly AgentMessage[],
  mailbox: string,
): number | null

export function renderMailboxHandledEvent(mailbox: string, throughRowId: number): string
```

Scan only `role: 'user'` string content. Parse JSON defensively. Accept only safe positive integer `throughRowId` and exact mailbox matches. Track the maximum disclosed and handled cursors; return the disclosed cursor only when it is greater than handled.

**Step 4: Run the tests and verify GREEN**

Run the Task 1 command again. Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/mailbox-handled.ts src/agent/mailbox-handled.test.ts
git commit -m "fix: 增加邮箱已处理游标解析"
```

### Task 2: 可信的 message_sent effect

**Files:**
- Modify: `src/agent/tool.ts`
- Modify: `src/agent/tools/send-message.ts`
- Modify: `src/agent/tools/send-message.test.ts`
- Modify: `src/agent/effect-interpreter.ts`
- Modify: `src/agent/effect-interpreter.test.ts`

**Step 1: Write failing send_message tests**

在现有 sent/rejected/failed 测试附近断言：

```ts
assert.deepEqual(result.effects, [{
  type: 'message_sent',
  target: { type: 'private', userId: 123 },
}])
```

并断言 rejected/failed result 的 `effects` 为 `undefined`。

**Step 2: Write failing EffectInterpreter tests**

覆盖：

- `toolName='send_message'` 的合法 group/private target 被返回。
- 同一目标多次 effect 去重。
- 其他工具伪造 `message_sent` 被拒绝。

期望 API：

```ts
const result = interpretToolEffects(effects)
assert.deepEqual(result.sentTargets, [
  { type: 'private', userId: 123 },
])
```

**Step 3: Run focused tests and verify RED**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/tools/send-message.test.ts \
  src/agent/effect-interpreter.test.ts
```

Expected: FAIL because the effect type and `sentTargets` do not exist.

**Step 4: Implement the minimal effect flow**

Extend `ToolEffect` with:

```ts
| {
    type: 'message_sent'
    target:
      | { type: 'group'; groupId: number }
      | { type: 'private'; userId: number }
  }
```

In `sendResolved`, add the effect only to the confirmed `status='sent'` return value. Preserve existing receipt content unchanged.

In `interpretToolEffects`, accept this effect only when `item.toolName === 'send_message'`, validate positive safe integer IDs, deduplicate by mailbox key, and return `sentTargets` alongside the existing pause fields.

**Step 5: Run focused tests and verify GREEN**

Run the Task 2 command again. Expected: PASS.

**Step 6: Commit**

```bash
git add src/agent/tool.ts src/agent/tools/send-message.ts \
  src/agent/tools/send-message.test.ts src/agent/effect-interpreter.ts \
  src/agent/effect-interpreter.test.ts
git commit -m "fix: 披露成功发言目标 effect"
```

### Task 3: BotLoop 追加并持久化 handled marker

**Files:**
- Modify: `src/agent/bot-loop-agent.ts`
- Modify: `src/agent/bot-loop-agent.test.ts`

**Step 1: Write the failing regression test**

构造一个 private `inbox_update` 对应的事件。第一轮 mock LLM 调用 `send_message`，mock tool 返回 sent effect；断言 round 结束后 ledger 尾部包含：

```json
{"event":"mailbox_handled","mailbox":"qq_private:9001","throughRowId":88}
```

同时断言最后一次 snapshot 已包含该 marker。

**Step 2: Add edge-case failing tests**

- 先一轮 `inbox` 读取、下一轮才成功发送，仍能从 durable ledger 找到待关闭 cursor。
- failed/rejected send 不追加 marker。
- 发送到另一个 target 不关闭当前 mailbox。
- 同轮向同一 target 多次发送只追加一个 marker。

**Step 3: Run BotLoop tests and verify RED**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/bot-loop-agent.test.ts
```

Expected: FAIL because no handled marker is appended.

**Step 4: Implement minimal BotLoop integration**

After `runRound` returns:

1. Read `sentTargets` from `interpretToolEffects`.
2. Map targets to `qq_group:<groupId>` / `qq_private:<userId>`.
3. For each unique mailbox, call `findPendingMailboxThroughRowId` on the current durable messages.
4. Append `renderMailboxHandledEvent(...)` only when a pending cursor exists.
5. Keep the append before the existing post-round `saveSnapshot()` so tool results and handled marker are saved together.

Do not stop the autonomous loop and do not query `messages` or side state.

**Step 5: Run BotLoop tests and verify GREEN**

Run the Task 3 command again. Expected: PASS.

**Step 6: Commit**

```bash
git add src/agent/bot-loop-agent.ts src/agent/bot-loop-agent.test.ts
git commit -m "fix: 成功回复后关闭已处理邮箱批次"
```

### Task 4: Prompt、契约文档与完整验证

**Files:**
- Modify: `prompts/bot-system.md`
- Modify: `docs/AGENT_CONTEXT.md`
- Modify: `docs/ARCHITECTURE.md`

**Step 1: Update the stable prompt contract**

在消息通知格式附近加入一个稳定示例和语义：

```text
{"event":"mailbox_handled","mailbox":"qq_private:222222","throughRowId":203}
```

说明该 mailbox 到此 rowId 已经成功发言处理，后续自主轮次不得再次把这些行当作新请求；这不禁止基于新动机主动延续话题。

**Step 2: Update architecture and replay documentation**

记录 marker 只能由可信 `send_message` sent effect 触发，进入 AgentContext 并随 snapshot replay，不从 side table 重建。

**Step 3: Run focused and broad verification**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/mailbox-handled.test.ts \
  src/agent/effect-interpreter.test.ts \
  src/agent/tools/send-message.test.ts \
  src/agent/bot-loop-agent.test.ts
pnpm typecheck
pnpm repo-check
```

Expected: all commands exit 0.

**Step 4: Inspect the final diff**

```bash
git diff --check
git status --short
git diff --stat
```

Confirm that `data/agent-workspace/` and the pre-existing untracked architecture plan are untouched.

**Step 5: Commit**

```bash
git add prompts/bot-system.md docs/AGENT_CONTEXT.md docs/ARCHITECTURE.md
git commit -m "docs: 说明邮箱已处理标记契约"
```
