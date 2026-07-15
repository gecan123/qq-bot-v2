# QQ Conversation Focus Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the always-on explicit-target `send_message` contract with a deferred `qq` capability whose durable current conversation supplies the send target and whose optional `reply_to` selects reply mode.

**Architecture:** Reuse the existing stable `help` / `invoke` shell. Persist a `qqConversationFocus` control field in `AgentContext`, expose a `qq_conversation` subtool to manage it, and move `send_message` into the `qq` capability. Keep the existing sender, authorization, media, music, mute diagnostics, audit, and mailbox-handled paths; only target selection and model-facing arguments change.

**Tech Stack:** TypeScript ESM, Zod 4, Node test runner through `tsx`, Prisma-backed snapshots, existing ReAct/deferred-tool runtime.

---

### Task 1: Persist the current QQ conversation in AgentContext

**Files:**
- Modify: `src/agent/agent-context.types.ts`
- Modify: `src/agent/agent-context.ts`
- Modify: `src/agent/agent-context.test.ts`
- Modify: `src/agent/snapshot-integrity.ts`
- Modify: `src/agent/snapshot-integrity.test.ts`
- Modify: snapshot fixtures found with `rg -n "activeToolCapabilities" src --glob '*.test.ts'`

**Step 1: Write the failing AgentContext tests**

Add tests proving that focus is cloned, exported, restored, cleared, and unaffected by `replaceMessages`:

```ts
ctx.setQqConversationFocus({ type: 'group', groupId: 123 })
assert.deepEqual(ctx.getSnapshot().qqConversationFocus, { type: 'group', groupId: 123 })

const persisted = ctx.exportPersistedSnapshot()
const restored = createAgentContext()
restored.restorePersistedSnapshot(persisted)
assert.deepEqual(restored.getSnapshot().qqConversationFocus, { type: 'group', groupId: 123 })

restored.replaceMessages([{ role: 'user', content: 'summary' }])
assert.deepEqual(restored.getSnapshot().qqConversationFocus, { type: 'group', groupId: 123 })

restored.setQqConversationFocus(null)
assert.equal(restored.getSnapshot().qqConversationFocus, null)
```

Add integrity cases rejecting malformed, non-positive, unsafe, or extra-key focus objects.

**Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/agent-context.test.ts src/agent/snapshot-integrity.test.ts
```

Expected: FAIL because `qqConversationFocus` and `setQqConversationFocus` do not exist.

**Step 3: Implement the snapshot field**

Add the control type and bump the schema version:

```ts
export type QqConversationFocus =
  | { type: 'group'; groupId: number }
  | { type: 'private'; userId: number }
  | null

export interface PersistedAgentSnapshot {
  schemaVersion: number
  messages: AgentMessage[]
  activeToolCapabilities: string[]
  qqConversationFocus: QqConversationFocus
}

export const SNAPSHOT_SCHEMA_VERSION = 4
```

Extend `AgentContext.getSnapshot()`, `exportPersistedSnapshot()`, `restorePersistedSnapshot()`, and `reset()`. Add:

```ts
setQqConversationFocus(focus: QqConversationFocus): void
```

Clone and sanitize focus rather than returning shared object references. Update integrity validation with exact-key positive-safe-integer rules. Update all snapshot literals to include `qqConversationFocus: null`; do not add legacy fallback adapters.

**Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/agent-context.types.ts src/agent/agent-context.ts \
  src/agent/agent-context.test.ts src/agent/snapshot-integrity.ts \
  src/agent/snapshot-integrity.test.ts src
git commit -m "feat: 持久化QQ当前会话"
```

### Task 2: Add the QQ conversation controller tool

**Files:**
- Create: `src/agent/tools/qq-conversation.ts`
- Create: `src/agent/tools/qq-conversation.test.ts`
- Modify: `src/agent/tools/qq-directory.ts` only if a shared exported directory row type removes duplication

**Step 1: Write failing tool tests**

Cover:

- `list` returns monitored joined groups and current friends with stable target objects.
- `current` returns `null` before open.
- `open` accepts a monitored group and a current friend, persists the normalized target, and returns it.
- `open` rejects an unmonitored group or non-friend without changing existing focus.
- `close` clears focus.
- `resolveCurrent()` clears and reports stale private focus after the friend disappears.

Use a small state port instead of importing the full AgentContext:

```ts
export interface QqConversationFocusState {
  get(): QqConversationFocus
  set(focus: QqConversationFocus): void
}
```

**Step 2: Run the new test and verify RED**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/tools/qq-conversation.test.ts
```

Expected: FAIL because the module does not exist.

**Step 3: Implement the controller and tool**

Create a controller with these operations:

```ts
export interface QqConversationController {
  getCurrent(): QqConversationFocus
  resolveCurrent(): Promise<
    | { ok: true; target: Exclude<QqConversationFocus, null> }
    | { ok: false; code: 'CHAT_CONTEXT_UNAVAILABLE' | 'CHAT_CONTEXT_STALE' }
  >
  open(target: Exclude<QqConversationFocus, null>): Promise<OpenResult>
  close(): void
  list(): Promise<ConversationSummary[]>
}
```

The Zod schema is action-driven:

```ts
z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('current') }),
  z.object({
    action: z.literal('open'),
    target: z.union([
      z.object({ type: z.literal('group'), groupId: z.number().int().positive() }),
      z.object({ type: z.literal('private'), userId: z.number().int().positive() }),
    ]),
  }),
  z.object({ action: z.literal('close') }),
])
```

Use injected `groupIds`, `loadGroups`, and `loadFriends`. Never infer a target from message text, memory, or logs.

**Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/tools/qq-conversation.ts src/agent/tools/qq-conversation.test.ts \
  src/agent/tools/qq-directory.ts
git commit -m "feat: 增加QQ会话焦点工具"
```

### Task 3: Refactor send_message to use current conversation and optional reply_to

**Files:**
- Modify: `src/agent/tools/send-message.ts`
- Rewrite affected cases: `src/agent/tools/send-message.test.ts`
- Modify: `src/agent/tool-schema.test.ts`
- Modify: `src/agent/tools/merged-tools.test.ts`

**Step 1: Write failing schema and behavior tests**

Assert the new provider-facing internal schema contains no `target`, `mode`, or `replyToMessageId` and exposes:

```ts
message?: string | null
imageRef?: string | null
music?: MusicShare | null
reply_to?: positive integer
mention_user_id?: positive integer
```

Behavior cases:

- no current conversation returns `CHAT_CONTEXT_UNAVAILABLE` and does not authorize/send;
- stale current conversation returns `CHAT_CONTEXT_STALE`, clears focus, and does not send;
- absent `reply_to` calls policy with `mode: 'ambient'`;
- present `reply_to` calls policy with `mode: 'reply'` and the exact message ID;
- private focus rejects `mention_user_id`;
- group focus maps `mention_user_id` into the existing segment builder;
- text/image/music receipts and `message_sent` effects retain the resolved actual target.

**Step 2: Run focused tests and verify RED**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/tools/send-message.test.ts src/agent/tool-schema.test.ts
```

Expected: FAIL against the old target/mode schema.

**Step 3: Implement the clean contract**

Inject `QqConversationController` into `createSendMessageTool`. Normalize the new arguments into the existing internal send path:

```ts
const resolved = await deps.conversations.resolveCurrent()
if (!resolved.ok) return conversationErrorResult(resolved.code)

const target: SendTarget = resolved.target.type === 'group'
  ? {
      ...resolved.target,
      ...(args.mention_user_id ? { mentionUserId: args.mention_user_id } : {}),
    }
  : resolved.target
const mode: SendMode = args.reply_to == null ? 'ambient' : 'reply'
const text = args.message ? normalizeSendText(args.message) : undefined
```

Preserve `SendTargetPolicy`, `buildOutboundSegments`, image promotion/release, mute inspection, receipts, and effects. Remove the old discriminated-union flattening exposure entirely rather than patching `tool-schema.ts` for this one tool.

**Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/tools/send-message.ts src/agent/tools/send-message.test.ts \
  src/agent/tool-schema.test.ts src/agent/tools/merged-tools.test.ts
git commit -m "refactor: 使用当前QQ会话发送消息"
```

### Task 4: Move QQ sending behind the existing deferred capability

**Files:**
- Modify: `src/agent/tools/index.ts`
- Modify: `src/agent/runtime.ts`
- Modify: `src/agent/runtime.test.ts`
- Modify: `src/agent/tools/merged-tools.test.ts`
- Modify: `src/agent/tool.test.ts`

**Step 1: Write failing manifest/runtime tests**

Assert:

```ts
assert.equal(manifest.alwaysOnTools.some(tool => tool.name === 'send_message'), false)
const qq = manifest.capabilities.find(capability => capability.name === 'qq')
assert.deepEqual(qq?.tools.map(tool => tool.name), ['qq_conversation', 'send_message'])
```

At runtime, activate `qq`, open a conversation through `invoke`, then send through:

```ts
{
  name: 'invoke',
  args: { tool: 'send_message', args: { message: 'hi', reply_to: 5 } },
}
```

Assert that the top-level provider tools remain stable (`help` and `invoke` present, `send_message` absent) and snapshot focus changes through the real runtime wiring.

**Step 2: Run focused tests and verify RED**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/runtime.test.ts src/agent/tools/merged-tools.test.ts src/agent/tool.test.ts
```

Expected: FAIL because `send_message` is still always-on and no `qq` capability exists.

**Step 3: Wire the capability**

Extend `BotToolDeps` with a conversation controller or its construction dependencies. In `createAgentRuntime`, adapt `input.context` to `QqConversationFocusState`, build one shared controller, pass it to the manifest and policy hooks, and add:

```ts
capabilities.push({
  name: 'qq',
  description: 'QQ 会话导航与发送；先打开当前会话，再通过 invoke 发送文本、图片或音乐.',
  tools: [qqConversationTool, sendMessageTool],
})
```

Remove `send_message` from `alwaysOnTools`. Keep `qq_directory` and `inbox` always-on for discovery and mailbox reading.

**Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/tools/index.ts src/agent/runtime.ts src/agent/runtime.test.ts \
  src/agent/tools/merged-tools.test.ts src/agent/tool.test.ts
git commit -m "refactor: 将QQ发送收进invoke能力"
```

### Task 5: Preserve safety hooks, audit identity, and message_sent effects through invoke

**Files:**
- Modify: `src/agent/tool-policy-hooks.ts`
- Modify: `src/agent/tool-policy-hooks.test.ts`
- Modify: `src/agent/react-kernel.ts`
- Modify: `src/agent/react-kernel.test.ts`
- Modify: `src/agent/effect-interpreter.test.ts`
- Modify: `src/agent/tool-concurrency.test.ts` if classification assertions need the new arguments

**Step 1: Write failing regression tests**

Add tests proving that an invoked `send_message`:

- is still classified as the effective `send_message` tool;
- runs AI-tone and ambient duplicate/private cooldown hooks using the controller's current target, `message`, and `reply_to`;
- bypasses ambient cooldown for replies;
- produces a `ReactToolEffect` whose trusted `toolName` is `send_message`, not `invoke`;
- reaches `interpretToolEffects` and yields the actual sent target.

The effect assertion should expose the current bug:

```ts
assert.deepEqual(round.effects, [{
  toolCallId: 'send-1',
  toolName: 'send_message',
  effect: { type: 'message_sent', target: { type: 'private', userId: 123 } },
}])
```

**Step 2: Run focused tests and verify RED**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/tool-policy-hooks.test.ts src/agent/react-kernel.test.ts \
  src/agent/effect-interpreter.test.ts src/agent/tool-concurrency.test.ts
```

Expected: FAIL because effects currently retain `batchCall.name === 'invoke'` and hooks expect old explicit arguments.

**Step 3: Fix effective identity and hook inputs**

In `react-kernel.ts`, use the effective tool name for trusted effects:

```ts
const effectiveToolName = resolveEffectiveToolName(batchCall)
effects.push({
  toolCallId: batchCall.id,
  toolName: effectiveToolName,
  effect,
})
```

Change send-message hook factories to accept a synchronous `getCurrentTarget` callback. Read `message` and derive reply mode from `reply_to`; after successful execution, prefer the provider-confirmed `message_sent` effect target. Do not put focus into global mutable module state.

**Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/tool-policy-hooks.ts src/agent/tool-policy-hooks.test.ts \
  src/agent/react-kernel.ts src/agent/react-kernel.test.ts \
  src/agent/effect-interpreter.test.ts src/agent/tool-concurrency.test.ts
git commit -m "fix: 保留invoke发送的安全与effect语义"
```

### Task 6: Update end-to-end QQ flow, prompts, and architecture docs

**Files:**
- Modify: `src/agent/integration-multi-source.test.ts`
- Modify: `prompts/bot-system.md`
- Modify: `prompts/bot-chat-constraints.md`
- Modify: `src/agent/bot-system-prompt.ts` only if the template view model changes
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/AGENT_CONTEXT.md`
- Modify: `docs/TOOLS.md`
- Modify: any focused tests that pin capability names or prompt invariants

**Step 1: Rewrite the integration test first**

For both group and private flows, make the mocked model/runtime perform:

1. activate `qq`;
2. invoke `qq_conversation open` with the intended mailbox target;
3. invoke `send_message` with `message` and optional `reply_to`;
4. assert the sender receives the opened target and correct reply segment;
5. assert no other mailbox target leaks into the send.

**Step 2: Run the integration test and verify RED**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/integration-multi-source.test.ts
```

Expected: FAIL until the new flow and prompt contract are fully wired.

**Step 3: Update prompts and docs**

Replace explicit-target guidance with:

- read a mailbox with `inbox`;
- activate `qq` if needed;
- open the corresponding conversation once;
- invoke `send_message` with `message`, optional `reply_to`, and optional media/music fields;
- never assume the current conversation matches a newly arrived mailbox—open it before replying across sources;
- `CHAT_CONTEXT_UNAVAILABLE` / `CHAT_CONTEXT_STALE` means reopen the intended conversation.

Document that focus is snapshot control state, not replay input reconstructed from messages. Update tool registration, progressive disclosure, effect trust, and mailbox-handled descriptions.

**Step 4: Run focused tests and repo checks**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/integration-multi-source.test.ts src/agent/runtime.test.ts \
  src/agent/bot-system-prompt.test.ts
pnpm repo-check
```

Expected: all commands exit 0.

**Step 5: Commit**

```bash
git add src/agent/integration-multi-source.test.ts prompts/bot-system.md \
  prompts/bot-chat-constraints.md src/agent/bot-system-prompt.ts \
  docs/ARCHITECTURE.md docs/AGENT_CONTEXT.md docs/TOOLS.md src/agent
git commit -m "docs: 更新QQ当前会话发送契约"
```

### Task 7: Full verification and cleanup

**Files:**
- Modify only files needed to fix failures caused by this change

**Step 1: Inspect scope**

```bash
git status --short
git diff --check HEAD~6..HEAD
git diff --stat HEAD~6..HEAD
```

Confirm unrelated user files, especially `data/agent-workspace/` and pre-existing untracked plans, remain untouched.

**Step 2: Run the complete verification suite**

```bash
pnpm typecheck
pnpm test
pnpm repo-check
```

Expected: all commands exit 0 with zero failing tests.

**Step 3: Verify the actual provider-facing surface**

Add or run a focused assertion that the main Agent top-level tool names contain `help` and `invoke` but not `send_message`, and that `help describe tool=send_message` returns the internal schema with `reply_to: integer` and no target/mode fields.

**Step 4: Review the final diff against the design**

Check every requirement in `docs/plans/2026-07-15-qq-conversation-focus-design.md`. Confirm:

- focus persists and compaction preserves it;
- stale focus fails closed;
- send target comes only from the current QQ conversation;
- provider-confirmed effects still drive mailbox handled;
- old target/mode adapter is absent;
- docs match executable behavior.

**Step 5: Commit any verification-only fixes**

```bash
git add <only files changed by verification fixes>
git commit -m "test: 完善QQ会话发送回归覆盖"
```

Skip this commit if verification required no further changes.
