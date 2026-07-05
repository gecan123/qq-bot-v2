# Private Mailbox Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop automatically disclosing private-message bodies and instead emit one bounded mailbox notification per private peer while preserving direct disclosure for group `@bot` messages.

**Architecture:** Generalize `src/agent/mailbox.ts` so a mailbox batch can contain either ordinary group events or private events. The bot loop keeps one direct-vs-mailbox branch; rendering selects group or private metadata and read instructions from the event type. Existing per-source cursors, replay, `inbox source=private`, database schema, and outbound private messaging remain unchanged.

**Tech Stack:** TypeScript ESM, Node.js test runner, Zod, Prisma, pnpm.

---

### Task 1: Generalize mailbox planning and rendering

**Files:**
- Modify: `src/agent/mailbox.test.ts`
- Modify: `src/agent/mailbox.ts`

- [ ] **Step 1: Replace the direct-private assertion with failing private-mailbox tests**

Update the private event helper so tests can create distinct peers and bodies:

```ts
function privateEvent(input: {
  rowId: number
  peerId?: number
  text?: string
  senderNickname?: string
  sentAt?: string
}): Extract<BotEvent, { type: 'napcat_private_message' }> {
  const peerId = input.peerId ?? 9001
  return {
    type: 'napcat_private_message',
    messageRowId: input.rowId,
    peerId,
    messageId: 20_000 + input.rowId,
    senderId: peerId,
    senderNickname: input.senderNickname ?? `peer-${peerId}`,
    mentionedSelf: true,
    sentAt: new Date(input.sentAt ?? `2026-07-03T00:01:${String(input.rowId).padStart(2, '0')}Z`),
    renderedText: input.text ?? 'private secret',
  }
}
```

Replace the first planner test and add notification coverage:

```ts
test('keeps mentioned group messages direct but groups private messages by peer mailbox', () => {
  const mentioned = groupEvent({ rowId: 1, groupId: 111, text: 'direct group', mentionedSelf: true })
  const firstAlice = privateEvent({ rowId: 2, peerId: 9001, text: 'SECRET_ONE' })
  const bob = privateEvent({ rowId: 3, peerId: 9002, text: 'SECRET_BOB' })
  const secondAlice = privateEvent({ rowId: 4, peerId: 9001, text: 'SECRET_TWO' })

  const result = planMailboxDisclosures([mentioned, firstAlice, bob, secondAlice], {})

  assert.deepEqual(result.disclosures, [
    { kind: 'direct', event: mentioned },
    { kind: 'mailbox', mailboxKey: 'qq_private:9001', events: [firstAlice, secondAlice] },
    { kind: 'mailbox', mailboxKey: 'qq_private:9002', events: [bob] },
  ])
  assert.deepEqual(result.cursors, {
    'qq_group:111': 1,
    'qq_private:9001': 4,
    'qq_private:9002': 3,
  })
})

test('renders a bounded private notification without message bodies', () => {
  const events = [
    privateEvent({ rowId: 20, peerId: 9001, text: 'SECRET_ONE', senderNickname: 'Alice' }),
    privateEvent({ rowId: 22, peerId: 9001, text: 'SECRET_TWO', senderNickname: 'Alice' }),
  ]

  const rendered = renderMailboxNotification('qq_private:9001', events)

  assert.match(rendered, /^\[inbox 更新 \| 私聊:Alice\(QQ:9001\) \| mailbox=qq_private:9001\]/)
  assert.match(rendered, /新增 2 条/)
  assert.match(rendered, /rowId 20\.\.22/)
  assert.match(rendered, /inbox action=read source=private peerId=9001 afterRowId=19/)
  assert.doesNotMatch(rendered, /SECRET_/)
})
```

Rename the group notification import in the test to `renderMailboxNotification`, update existing calls, and change expected disclosure kind from `ambient` to `mailbox`.

- [ ] **Step 2: Run the mailbox test and verify RED**

Run:

```bash
node_modules/.bin/tsx --test --import tsx src/agent/mailbox.test.ts
```

Expected: FAIL because private events are still returned as `direct`, the disclosure kind is still `ambient`, and `renderMailboxNotification` is not exported.

- [ ] **Step 3: Generalize the mailbox event and renderer types**

In `src/agent/mailbox.ts`, replace the group-only mailbox type with:

```ts
type MessageEvent = Extract<BotEvent, { type: 'napcat_message' | 'napcat_private_message' }>
type MailboxEvent = MessageEvent

export type MailboxDisclosure =
  | { kind: 'direct'; event: BotEvent }
  | { kind: 'mailbox'; mailboxKey: string; events: MailboxEvent[] }
```

Use `const mailboxEventsByKey = new Map<string, MailboxEvent[]>()`. Classify all private events and only unmentioned group events as mailbox events:

```ts
const shouldUseMailbox = event.type === 'napcat_private_message'
  || (event.type === 'napcat_message' && !event.mentionedSelf)
if (shouldUseMailbox) {
  const existing = mailboxEventsByKey.get(mailboxKey)
  if (existing) {
    existing.push(message)
  } else {
    const batch = [message]
    mailboxEventsByKey.set(mailboxKey, batch)
    disclosures.push({ kind: 'mailbox', mailboxKey, events: batch })
  }
  continue
}
```

Rename the renderer to `renderMailboxNotification` and accept `readonly MailboxEvent[]`. Keep the existing count, row-id, and time calculations, then select metadata by event type:

```ts
const source = first.type === 'napcat_private_message'
  ? {
      label: `私聊:${first.senderNickname}(QQ:${first.peerId})`,
      read: `inbox action=read source=private peerId=${first.peerId} afterRowId=${afterRowId}`,
    }
  : {
      label: `群:${first.groupName && first.groupName.length > 0 ? first.groupName : first.groupId}`,
      read: `inbox action=read source=group groupId=${first.groupId} afterRowId=${afterRowId}`,
    }

return [
  `[inbox 更新 | ${source.label} | mailbox=${mailboxKey}]`,
  `新增 ${events.length} 条; rowId ${first.messageRowId}..${last.messageRowId}; 时间 ${timeRange}; 发送者 ${senderCount} 人.`,
  `正文未自动披露. 需要时调用 ${source.read}.`,
].join(' ')
```

- [ ] **Step 4: Run the mailbox test and verify GREEN**

Run the command from Step 2. Expected: all mailbox tests PASS.

- [ ] **Step 5: Commit the planner change**

```bash
git add src/agent/mailbox.ts src/agent/mailbox.test.ts
git commit -m "feat: 私聊按联系人进入 mailbox"
```

### Task 2: Integrate private mailbox notifications into the bot loop

**Files:**
- Modify: `src/agent/bot-loop-agent.test.ts`
- Modify: `src/agent/integration-multi-source.test.ts`
- Modify: `src/agent/bot-loop-agent.ts`

- [ ] **Step 1: Add a failing bot-loop private disclosure test**

Add a test beside the existing ambient group test that enqueues two messages from one peer and one from another peer. Assert two user messages, no private bodies, and independent cursors:

```ts
test('replaces private bodies with one metadata notification per peer and persists cursors', async () => {
  const ctx = createAgentContext()
  const eventQueue = new InMemoryEventQueue<BotEvent>()
  const enqueuePrivate = (rowId: number, peerId: number, text: string) => {
    eventQueue.enqueue({
      type: 'napcat_private_message',
      messageRowId: rowId,
      peerId,
      messageId: 20_000 + rowId,
      senderId: peerId,
      senderNickname: peerId === 9001 ? 'Alice' : 'Bob',
      mentionedSelf: true,
      sentAt: new Date(`2026-07-03T00:02:${String(rowId).padStart(2, '0')}Z`),
      renderedText: text,
    })
  }
  enqueuePrivate(51, 9001, 'PRIVATE_ONE')
  enqueuePrivate(52, 9002, 'PRIVATE_OTHER')
  enqueuePrivate(53, 9001, 'PRIVATE_TWO')

  const llm = makeMockLlm([{
    content: '',
    toolCalls: [],
    usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
    model: 'mock',
  }])
  const { repo, savedCursors } = makeMockSnapshotRepo()
  const agent = createBotLoopAgent({
    systemPrompt: '',
    context: ctx,
    eventQueue,
    llm,
    tools: makeMockTools(),
    snapshotRepo: repo,
    renderEvent: (event) => event.type === 'napcat_private_message' ? event.renderedText : null,
    eventDebounceMs: 0,
  })

  await agent.runOnceForTest()

  const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
  assert.equal(userMessages.length, 2)
  assert.match(userMessages[0]!.content, /mailbox=qq_private:9001/)
  assert.match(userMessages[1]!.content, /mailbox=qq_private:9002/)
  assert.doesNotMatch(userMessages.map((message) => message.content).join('\n'), /PRIVATE_/)
  assert.deepEqual(savedCursors.at(-1), {
    'qq_private:9001': 53,
    'qq_private:9002': 52,
  })
})
```

The injected `renderEvent` returns each private body, proving the body is withheld by the loop rather than by the renderer.

Update the first multi-source integration test expectations:

```ts
assert.equal(messages.length, 5)
assert.equal(userMessages.length, 3)
assert.match(userMessages[0]!.content, /^\[[\d/: ]+ 群:阳光厨房 .*\[@bot\]\]/)
assert.match(userMessages[1]!.content, /^\[inbox 更新 \| 私聊:Alice\(QQ:10001\) \| mailbox=qq_private:10001\]/)
assert.match(userMessages[2]!.content, /^\[inbox 更新 \| 群:技术群 \| mailbox=qq_group:222\]/)
assert.doesNotMatch(userMessages.map((message) => message.content).join('\n'), /私聊问个事|今天天气好/)
```

- [ ] **Step 2: Run loop and integration tests and verify RED**

Run:

```bash
node_modules/.bin/tsx --test --import tsx src/agent/bot-loop-agent.test.ts src/agent/integration-multi-source.test.ts
```

Expected: FAIL until the bot loop consumes the renamed mailbox disclosure and renderer.

- [ ] **Step 3: Update the bot loop to use the generalized renderer**

In `src/agent/bot-loop-agent.ts`, import `renderMailboxNotification`. Change the branch to:

```ts
if (disclosure.kind === 'mailbox') {
  deps.context.appendUserMessage(
    renderMailboxNotification(disclosure.mailboxKey, disclosure.events),
  )
  disclosed++
  lastWakeAt = new Date()
  continue
}
```

Do not add a private-specific loop branch and do not call `renderEvent` for mailbox events.

- [ ] **Step 4: Run loop and integration tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests PASS.

- [ ] **Step 5: Commit loop integration**

```bash
git add src/agent/bot-loop-agent.ts src/agent/bot-loop-agent.test.ts src/agent/integration-multi-source.test.ts
git commit -m "feat: 私聊正文改为按需披露"
```

### Task 3: Align stable documentation and verify the repository

**Files:**
- Modify: `README.md`
- Modify: `docs/AGENT_CONTEXT.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `prompts/bot-system.md`

- [ ] **Step 1: Update stable documentation**

Replace claims that private messages enter context directly with the new contract:

```md
群内直接呼叫进入上下文；普通群消息和私聊消息按来源形成 mailbox，默认只披露有界通知，正文由 Agent 按需读取。
```

In `docs/AGENT_CONTEXT.md`, state that private messages are grouped by `peerId`, ordinary group messages by `groupId`, and group `@bot` remains direct.

In `prompts/bot-system.md`, extend the inbox-notification example so it explicitly covers both ordinary group messages and per-contact private mailboxes.

- [ ] **Step 2: Run focused tests**

```bash
node_modules/.bin/tsx --test --import tsx \
  src/agent/mailbox.test.ts \
  src/agent/bot-loop-agent.test.ts \
  src/agent/integration-multi-source.test.ts \
  src/agent/replay-missed.test.ts \
  src/agent/tools/inbox.test.ts
```

Expected: all selected tests PASS. Replay and inbox tests confirm existing private per-peer cursors and reads remain intact.

- [ ] **Step 3: Run static and repository checks**

```bash
pnpm typecheck
pnpm repo-check
git diff --check
```

Expected: all commands exit 0. If `pnpm` has a no-TTY store issue, use `/opt/homebrew/bin/pnpm` or the corresponding local binary without changing dependencies.

- [ ] **Step 4: Inspect scoped diff and commit documentation**

```bash
git diff -- README.md docs/AGENT_CONTEXT.md docs/ARCHITECTURE.md prompts/bot-system.md
git add README.md docs/AGENT_CONTEXT.md docs/ARCHITECTURE.md prompts/bot-system.md docs/plans/2026-07-05-private-mailbox-disclosure-implementation.md
git commit -m "docs: 同步私聊 mailbox 契约"
```

Before committing, verify no pre-existing unrelated files are staged.

- [ ] **Step 5: Final worktree audit**

```bash
git status --short --branch
git log --oneline -5
```

Expected: only the user's pre-existing unrelated modifications remain unstaged; the design, implementation, tests, and documentation are committed.
