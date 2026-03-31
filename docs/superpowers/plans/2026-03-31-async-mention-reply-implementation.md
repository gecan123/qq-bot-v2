# Async Mention Reply Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `@bot` 回复从主消息处理链路中剥离出来，改为“消息入库后实时创建任务，由群级调度器异步聚合并回复”。

**Architecture:** 保留现有 `NapCat -> parse -> media -> DB` 主链路不变，在其后增加独立的会话任务系统。第一版使用内存队列与群级 mailbox，实现跨群并发、群内串行、30 秒聚合窗口，并通过独立 `MessageSender` 抽象发送正式回复。

**Tech Stack:** TypeScript, Node.js, `tsx --test`, NapCat WebSocket, Prisma/PostgreSQL, in-memory queue

---

## File Structure

### New files

- `src/conversation/types.ts`
  定义 mention 事件、群级会话、worker 输入输出、调度状态。
- `src/conversation/dispatcher.ts`
  将 `@bot` 消息转换为 mention 事件并送入队列。
- `src/conversation/group-mailbox.ts`
  管理单群 30 秒聚合窗口、当前运行状态和待处理会话。
- `src/conversation/scheduler.ts`
  实现跨群调度、群内串行、窗口封口与 worker 触发。
- `src/conversation/worker.ts`
  读取一轮会话、构造上下文、调用回复生成器、交给 `MessageSender` 发出。
- `src/queue/conversation-queue.ts`
  定义 conversation queue 抽象接口。
- `src/queue/conversation-memory-queue.ts`
  基于内存的 conversation queue 实现。
- `src/messaging/message-sender.ts`
  对 reply / send 的发送抽象。
- `src/messaging/segment-builder.ts`
  将内部回复内容转换为 NapCat segments。
- `src/responder/reply-generator.ts`
  从现有 `at-mention` handler 中抽出“单轮回复 / agent 回复”的纯生成逻辑。
- `src/conversation/group-mailbox.test.ts`
  群级聚合窗口、群内串行相关测试。
- `src/queue/conversation-memory-queue.test.ts`
  队列 enqueue / start / stop / delivery 行为测试。
- `src/messaging/segment-builder.test.ts`
  reply + at + text 组装测试。
- `src/conversation/worker.test.ts`
  worker 调用上下文构建、回复生成、发送器的测试。

### Modified files

- `src/index.ts`
  启动 / 停止 conversation scheduler。
- `src/bot/core.ts`
  消息入库后检测 `@bot` 并交给 dispatcher；不再直接走 `@回复` 正式回复路径。
- `src/responder/handlers/at-mention.ts`
  改为轻量桥接或直接退役；不再负责直接回复。
- `src/responder/pipeline.ts`
  如果 `at-mention` handler 退役，需要调整 handler 注册顺序或移除。
- `src/responder/reply-executor.ts`
  作为 `MessageSender` 的底层发送实现来源，必要时保留兼容包装。

### Existing files to read during implementation

- `src/bot/core.ts`
- `src/responder/context-builder.ts`
- `src/responder/ensure-descriptions.ts`
- `src/agent/loop.ts`
- `src/agent/openai-agent-adapter.ts`
- `src/config/agent-profiles.ts`
- `src/queue/memory-queue.ts`
- `src/types/message-segments.ts`

## Task 1: Define Conversation Domain and Queue Contract

**Files:**
- Create: `src/conversation/types.ts`
- Create: `src/queue/conversation-queue.ts`
- Test: `src/conversation/group-mailbox.test.ts`
- Test: `src/queue/conversation-memory-queue.test.ts`

- [ ] **Step 1: Write failing tests for mention event grouping expectations**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createGroupMailbox } from './group-mailbox.js'

test('same group mentions within 30s belong to one open window', () => {
  const mailbox = createGroupMailbox({ groupId: 123, mergeWindowMs: 30_000 })
  mailbox.addMention({ groupId: 123, messageId: 1, senderId: 10, createdAt: 0 })
  mailbox.addMention({ groupId: 123, messageId: 2, senderId: 11, createdAt: 20_000 })

  const snapshot = mailbox.snapshot()
  assert.equal(snapshot.pendingEvents.length, 2)
  assert.equal(snapshot.windowOpen, true)
})
```

- [ ] **Step 2: Write failing tests for queue abstraction**

```ts
test('conversation queue delivers mention events to scheduler callback', async () => {
  const delivered: number[] = []
  const queue = createConversationMemoryQueue({
    onMention: async (event) => delivered.push(event.messageId),
  })

  queue.start()
  queue.enqueueMention({ groupId: 1, messageId: 42, senderId: 9, createdAt: Date.now() })

  await waitFor(() => delivered.length === 1)
  assert.deepEqual(delivered, [42])
})
```

- [ ] **Step 3: Implement `src/conversation/types.ts`**

```ts
export interface MentionEvent {
  groupId: number
  messageId: number
  senderId: number
  createdAt: number
}

export interface GroupConversationBatch {
  groupId: number
  events: MentionEvent[]
  openedAt: number
  closedAt: number
}
```

- [ ] **Step 4: Implement queue contract in `src/queue/conversation-queue.ts`**

```ts
export interface ConversationQueue {
  enqueueMention(event: MentionEvent): void
  start(): void
  stop(): void
}
```

- [ ] **Step 5: Run focused tests**

Run: `pnpm test -- src/queue/conversation-memory-queue.test.ts src/conversation/group-mailbox.test.ts`  
Expected: tests fail first, then pass after minimal types and interfaces land.

- [ ] **Step 6: Commit**

```bash
git add src/conversation/types.ts src/queue/conversation-queue.ts src/conversation/group-mailbox.test.ts src/queue/conversation-memory-queue.test.ts
git commit -m "feat: 定义异步会话任务领域模型"
```

## Task 2: Implement Group Mailbox and Scheduler

**Files:**
- Create: `src/conversation/group-mailbox.ts`
- Create: `src/conversation/scheduler.ts`
- Create: `src/queue/conversation-memory-queue.ts`
- Test: `src/conversation/group-mailbox.test.ts`
- Test: `src/queue/conversation-memory-queue.test.ts`

- [ ] **Step 1: Add failing tests for group-level serialization**

```ts
test('same group never runs two workers concurrently', async () => {
  const runs: string[] = []
  const scheduler = createConversationScheduler({
    mergeWindowMs: 30_000,
    worker: async (batch) => {
      runs.push(`start:${batch.groupId}`)
      await delay(50)
      runs.push(`end:${batch.groupId}`)
    },
  })

  scheduler.onMention({ groupId: 1, messageId: 1, senderId: 10, createdAt: 0 })
  scheduler.onMention({ groupId: 1, messageId: 2, senderId: 11, createdAt: 31_000 })

  // verify second batch starts only after first ends
})
```

- [ ] **Step 2: Add failing tests for cross-group parallelism**

```ts
test('different groups may run in parallel', async () => {
  // enqueue group 1 and group 2
  // assert worker observed overlap
})
```

- [ ] **Step 3: Implement `createGroupMailbox()`**

Implementation notes:
- Maintain:
  - `pendingEvents`
  - `windowOpenedAt`
  - `timer`
  - `running`
- Behavior:
  - first event opens a 30s window
  - later events within window append
  - when timer fires, mailbox yields a closed batch

- [ ] **Step 4: Implement `createConversationScheduler()`**

Implementation notes:
- Keep `Map<number, GroupMailbox>`
- Each mailbox exposes “batch ready” callback
- Scheduler starts one worker per group max
- Different groups can start immediately
- If a batch finishes and mailbox already has a newly closed batch, schedule next run for same group

- [ ] **Step 5: Implement `createConversationMemoryQueue()`**

Implementation notes:
- Simpler than current generic job queue
- Delivers mention events to `scheduler.onMention()`
- No retries in v1
- `start()` activates delivery; `stop()` drains timers

- [ ] **Step 6: Run scheduler tests**

Run: `pnpm test -- src/conversation/group-mailbox.test.ts src/queue/conversation-memory-queue.test.ts`  
Expected: all mailbox / scheduler / queue tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/conversation/group-mailbox.ts src/conversation/scheduler.ts src/queue/conversation-memory-queue.ts src/conversation/group-mailbox.test.ts src/queue/conversation-memory-queue.test.ts
git commit -m "feat: 实现群级异步会话调度器"
```

## Task 3: Extract Reply Generation from At-Mention Handler

**Files:**
- Create: `src/responder/reply-generator.ts`
- Modify: `src/responder/handlers/at-mention.ts`
- Test: `src/conversation/worker.test.ts`

- [ ] **Step 1: Write failing tests around pure reply generation**

```ts
test('reply generator returns text without sending message directly', async () => {
  const reply = await generateMentionReply({
    groupId: 1,
    messageId: 10,
    senderId: 20,
    segments: [{ type: 'text', content: '@bot hi' }],
  })

  assert.equal(typeof reply, 'string')
})
```

- [ ] **Step 2: Move single-turn and agent generation into `reply-generator.ts`**

Implementation notes:
- Extract current:
  - `singleTurnReply()`
  - `agentReply()`
- New exported function:

```ts
export async function generateMentionReply(input: {
  groupId: number
  messageId: number
  senderId: number
  senderNickname: string
  segments: ParsedSegment[]
}): Promise<string | null>
```

- [ ] **Step 3: Reduce `at-mention.ts` to non-sending logic or deprecate it**

Implementation notes:
- If still kept in pipeline, it should only return `'break'` after dispatcher enqueue
- It must no longer call `sendGroupReply()`

- [ ] **Step 4: Run focused tests**

Run: `pnpm test -- src/conversation/worker.test.ts src/agent/loop.test.ts`  
Expected: reply generation path still works after extraction.

- [ ] **Step 5: Commit**

```bash
git add src/responder/reply-generator.ts src/responder/handlers/at-mention.ts src/conversation/worker.test.ts
git commit -m "refactor: 抽离@回复生成逻辑"
```

## Task 4: Add Message Sender and Segment Builder

**Files:**
- Create: `src/messaging/message-sender.ts`
- Create: `src/messaging/segment-builder.ts`
- Modify: `src/responder/reply-executor.ts`
- Test: `src/messaging/segment-builder.test.ts`

- [ ] **Step 1: Write failing tests for reply segment rendering**

```ts
test('reply builder prepends reply and at segments', () => {
  const segments = buildReplySegments({
    replyToMessageId: 123,
    mentionUserId: 456,
    text: '你好',
  })

  assert.equal(segments[0]?.type, 'reply')
  assert.equal(segments[1]?.type, 'at')
  assert.equal(segments[2]?.type, 'text')
})
```

- [ ] **Step 2: Implement `segment-builder.ts`**

Implementation notes:
- Start with only:
  - plain text
  - reply
  - at
- Do not implement forward/card in v1

- [ ] **Step 3: Implement `message-sender.ts`**

Suggested surface:

```ts
export interface MessageSender {
  replyToMessage(params: {
    groupId: number
    replyToMessageId: number
    mentionUserId?: number
    text: string
  }): Promise<void>
}
```

- [ ] **Step 4: Refactor `reply-executor.ts` to be a thin transport helper**

Implementation notes:
- Preserve retry behavior
- Reuse NapCat send implementation
- Keep message preview logging

- [ ] **Step 5: Run messaging tests**

Run: `pnpm test -- src/messaging/segment-builder.test.ts`  
Expected: segment rendering tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/messaging/message-sender.ts src/messaging/segment-builder.ts src/responder/reply-executor.ts src/messaging/segment-builder.test.ts
git commit -m "feat: 抽象异步回复消息发送层"
```

## Task 5: Implement Conversation Worker

**Files:**
- Create: `src/conversation/worker.ts`
- Test: `src/conversation/worker.test.ts`
- Modify: `src/responder/context-builder.ts` (only if worker needs a narrower reusable API)

- [ ] **Step 1: Write failing tests for worker behavior**

```ts
test('worker generates one reply for a simple single-user batch', async () => {
  const sent: string[] = []
  const worker = createConversationWorker({
    generateReply: async () => '你好',
    sender: { replyToMessage: async ({ text }) => sent.push(text) },
  })

  await worker.run({
    groupId: 1,
    events: [{ groupId: 1, messageId: 10, senderId: 20, createdAt: Date.now() }],
    openedAt: Date.now(),
    closedAt: Date.now(),
  })

  assert.deepEqual(sent, ['你好'])
})
```

- [ ] **Step 2: Add failing tests for split-batch behavior**

```ts
test('worker only handles first two subthreads in one batch and returns leftovers', async () => {
  // 3 senders in one batch -> process first 2, keep 1 leftover for next round
})
```

- [ ] **Step 3: Implement worker orchestration**

Implementation notes:
- Group events by sender first
- Process max two sender threads in one run
- Oldest first
- Generate reply using `reply-generator.ts`
- Use earliest event message id as reply target for that sender thread
- Return leftovers to scheduler if batch exceeds current limits

- [ ] **Step 4: Keep AI out of boundary decisions**

Rules in code, not prompt:
- same sender within same batch => same thread
- different sender => different thread
- max two sender threads per run
- default one message, max two sends

- [ ] **Step 5: Run worker tests**

Run: `pnpm test -- src/conversation/worker.test.ts`  
Expected: worker tests pass for single-thread and split-batch cases.

- [ ] **Step 6: Commit**

```bash
git add src/conversation/worker.ts src/conversation/worker.test.ts
git commit -m "feat: 实现异步会话回复worker"
```

## Task 6: Wire Dispatcher into Bot Ingress

**Files:**
- Create: `src/conversation/dispatcher.ts`
- Modify: `src/bot/core.ts`
- Modify: `src/responder/pipeline.ts`
- Modify: `src/responder/handlers/at-mention.ts`

- [ ] **Step 1: Write failing integration test or targeted unit test for dispatcher**

```ts
test('dispatcher enqueues mention event when message contains @self', async () => {
  // parse message -> persist -> dispatcher called with groupId/messageId/senderId
})
```

- [ ] **Step 2: Implement dispatcher**

Suggested API:

```ts
export function createMentionDispatcher(queue: ConversationQueue) {
  return {
    dispatch(event: MentionEvent) {
      queue.enqueueMention(event)
    },
  }
}
```

- [ ] **Step 3: Modify `src/bot/core.ts`**

Implementation notes:
- Keep parse / media / insert path unchanged
- After message insert, if message mentions `config.selfNumber`, call dispatcher
- Do not directly invoke responder pipeline for `@reply`

- [ ] **Step 4: Simplify responder pipeline usage**

Implementation notes:
- Keep proactive handler path alive if needed
- Remove `at-mention` direct send behavior from runtime path

- [ ] **Step 5: Run focused tests**

Run: `pnpm test -- src/bot/*.test.ts src/conversation/worker.test.ts`  
Expected: message ingress still stores messages; mention dispatch path works.

- [ ] **Step 6: Commit**

```bash
git add src/conversation/dispatcher.ts src/bot/core.ts src/responder/pipeline.ts src/responder/handlers/at-mention.ts
git commit -m "feat: 将@消息接入异步会话任务系统"
```

## Task 7: Start and Stop Scheduler in Application Lifecycle

**Files:**
- Modify: `src/index.ts`
- Modify: `src/queue/index.ts` (if conversation queue is registered here)
- Modify: `src/conversation/scheduler.ts`

- [ ] **Step 1: Write a failing lifecycle test or smoke test checklist**

Manual smoke checklist:
- start app
- send `@bot`
- verify no direct reply in ingress path
- verify conversation queue receives event
- verify worker replies later through sender

- [ ] **Step 2: Wire scheduler startup in `src/index.ts`**

Implementation notes:
- create queue instance
- create scheduler instance
- start both before `startBot()`
- pass dispatcher dependency into bot runtime

- [ ] **Step 3: Wire scheduler shutdown**

Implementation notes:
- stop scheduler in `shutdown()`
- stop queue timers cleanly

- [ ] **Step 4: Run build and tests**

Run: `pnpm build`  
Expected: TypeScript build succeeds

Run: `pnpm test -- src/conversation/*.test.ts src/messaging/*.test.ts src/agent/*.test.ts`  
Expected: all touched unit tests pass

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/queue/index.ts src/conversation/scheduler.ts
git commit -m "feat: 接入异步@回复调度生命周期"
```

## Task 8: Verification and Documentation Update

**Files:**
- Modify: `README.md`
- Modify: `docs/reply-logic.md` (if still authoritative)

- [ ] **Step 1: Update README behavior description**

Add a short section:
- messages are stored first
- `@bot` enters async conversation scheduler
- first version uses in-memory queue
- same-group 30s merge window

- [ ] **Step 2: Add operator caveats**

Document:
- process restart drops pending async reply tasks in v1
- Redis-backed durable queue is planned follow-up

- [ ] **Step 3: Run final verification**

Run: `pnpm build`  
Expected: PASS

Run: `pnpm test`  
Expected: all project tests pass

Manual verification:
- boot bot in dev group
- send single `@bot`
- confirm message lands in DB before reply is sent
- send two `@bot` in same group within 30s
- confirm single group run and grouped behavior
- send `@bot` in two groups
- confirm cross-group parallel handling

- [ ] **Step 4: Commit**

```bash
git add README.md docs/reply-logic.md
git commit -m "docs: 更新异步@回复任务化说明"
```

## Notes for Execution

- Keep existing user changes intact; the repository is already dirty.
- Do not introduce Redis in this plan.
- Do not add ack behavior.
- Do not let AI decide merge boundaries in v1.
- Prefer adding narrow tests per module over a single broad integration test.
- If `src/responder/handlers/at-mention.ts` becomes dead code, either remove it in the same task or leave a thin compatibility wrapper with an explicit comment.

## Suggested First Execution Slice

If executing incrementally, start with:
1. Task 1
2. Task 2
3. Task 4

That yields:
- domain model
- queue abstraction
- scheduler behavior
- sender abstraction

before touching live bot ingress.
