# ReAct Kernel Runtime Host Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the generic one-round LLM/tool execution out of `BotLoopAgent` into a small ReAct Kernel while keeping QQ runtime state, snapshot persistence, mailbox disclosure, compaction, and pause scheduling in the Runtime Host.

**Architecture:** Add `src/agent/react-kernel.ts` as the only module responsible for one ReAct round: read `AgentContext`, list tools, call `LlmClient`, append assistant tool calls, execute tools in order, and append only `ToolExecutionResult.content`. Keep `src/agent/bot-loop-agent.ts` as the Runtime Host that decides when to run the kernel and what to do before/after the round.

**Tech Stack:** TypeScript ESM, `node:test`, existing `AgentContext`, existing `LlmClient`, existing `ToolExecutor`, existing token usage logging, existing bot-loop tests.

---

### Task 1: Add Focused ReAct Kernel Tests

**Files:**
- Create: `src/agent/react-kernel.test.ts`
- Read: `src/agent/bot-loop-agent.ts:150-223`
- Read: `src/agent/agent-context.ts:16-29`
- Read: `src/agent/llm-client.ts:28-49`
- Read: `src/agent/tool.ts:18-65`

**Step 1: Write the failing test file**

Create `src/agent/react-kernel.test.ts` with tests for the current `runRound()` behavior. Start with local test helpers:

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentContext } from './agent-context.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { LlmClient, LlmCallInput, LlmCallOutput } from './llm-client.js'
import type { ToolExecutionResult, ToolExecutor } from './tool.js'
import { runReactRound } from './react-kernel.js'

function makeMockLlm(handler: (input: LlmCallInput) => Promise<LlmCallOutput>): LlmClient {
  return { chat: handler }
}

function makeMockTools(input: {
  list?: ToolExecutor['list']
  execute: ToolExecutor['execute']
}): ToolExecutor {
  return {
    list: input.list ?? (() => []),
    execute: input.execute,
  }
}
```

Add this first test:

```ts
test('calls LLM with durable messages and visible tools, then appends assistant tool calls and tool results', async () => {
  const context = createAgentContext()
  context.appendUserMessage('hello')
  const eventQueue = new InMemoryEventQueue<BotEvent>()
  const executed: string[] = []

  const llm = makeMockLlm(async (input) => {
    assert.equal(input.systemPrompt, 'system')
    assert.deepEqual(input.messages, [{ role: 'user', content: 'hello' }])
    assert.deepEqual(input.tools.map((tool) => tool.name), ['lookup'])
    return {
      content: 'plain assistant text must be dropped',
      toolCalls: [{ id: 'call-1', name: 'lookup', args: { q: 'x' } }],
      usage: { inputTokens: 10, cachedTokens: 2, outputTokens: 5 },
      model: 'mock',
    }
  })

  const tools = makeMockTools({
    list: () => [{
      name: 'lookup',
      description: 'lookup',
      schema: { safeParse: () => ({ success: true, data: {} }) } as never,
      execute: async () => ({ content: 'unused' }),
    }],
    execute: async (call, ctx) => {
      executed.push(`${ctx.roundIndex}:${call.name}`)
      return { content: '{"ok":true}' }
    },
  })

  const result = await runReactRound({
    roundIndex: 7,
    systemPrompt: 'system',
    context,
    llm,
    tools,
    toolContext: { eventQueue, roundIndex: 7 },
  })

  assert.deepEqual(executed, ['7:lookup'])
  assert.equal(result.inputTokens, 10)
  assert.equal(result.tokensUsed, 15)
  assert.equal(result.controls.some((control) => control.type === 'pause'), false)
  assert.deepEqual(context.getSnapshot().messages, [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'lookup', args: { q: 'x' } }],
    },
    { role: 'tool', toolCallId: 'call-1', content: '{"ok":true}' },
  ])
})
```

Add two more tests:

- `does not append an assistant turn when the LLM returns no tool calls`
- `returns pause control but only appends tool result content to AgentContext`

The pause test should execute a `pause` call whose result is:

```ts
const pauseResult: ToolExecutionResult = {
  content: '{"ok":true,"action":"rest"}',
  control: { type: 'pause' },
}
```

Assert that the returned controls contain `{ type: 'pause' }`, and that `JSON.stringify(context.getSnapshot().messages)` does not include a serialized `control` field.

**Step 2: Run the focused test and verify failure**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/react-kernel.test.ts
```

Expected: FAIL because `src/agent/react-kernel.ts` does not exist.

**Step 3: Do not implement in this task**

Stop after confirming the failure. This task creates the behavioral specification first.

**Step 4: Commit**

```bash
git add src/agent/react-kernel.test.ts
git commit -m "test: 覆盖 ReAct Kernel 行为"
```

### Task 2: Implement Minimal ReAct Kernel

**Files:**
- Create: `src/agent/react-kernel.ts`
- Modify only if needed: `src/agent/react-kernel.test.ts`

**Step 1: Implement the exported contract**

Create `src/agent/react-kernel.ts`:

```ts
import type { AgentContext } from './agent-context.js'
import type { LlmClient } from './llm-client.js'
import type { ToolControl, ToolContext, ToolExecutor } from './tool.js'
import { recordTokenUsage } from './token-stats.js'
import { createLogger } from '../logger.js'

const log = createLogger('REACT_KERNEL')

export interface ReactRoundInput {
  roundIndex: number
  systemPrompt: string
  context: AgentContext
  llm: LlmClient
  tools: ToolExecutor
  toolContext: ToolContext
}

export interface ReactRoundResult {
  inputTokens: number | null
  tokensUsed: number
  controls: ToolControl[]
}

export async function runReactRound(input: ReactRoundInput): Promise<ReactRoundResult> {
  const snapshot = input.context.getSnapshot()
  const visibleTools = input.tools.list()

  const completion = await input.llm.chat({
    systemPrompt: input.systemPrompt,
    messages: snapshot.messages,
    tools: visibleTools,
  })

  log.info(
    {
      roundIndex: input.roundIndex,
      toolCallCount: completion.toolCalls.length,
      toolNames: completion.toolCalls.map((call) => call.name),
      contentLen: completion.content.length,
      inputTokens: completion.usage.inputTokens,
      cachedTokens: completion.usage.cachedTokens,
      outputTokens: completion.usage.outputTokens,
      model: completion.model,
    },
    'round_llm_done',
  )

  recordTokenUsage({
    operation: 'agent.chat',
    roundIndex: input.roundIndex,
    inputTokens: completion.usage.inputTokens,
    cachedTokens: completion.usage.cachedTokens,
    outputTokens: completion.usage.outputTokens,
    model: completion.model,
  })

  if (completion.content.length > 0) {
    log.warn(
      {
        roundIndex: input.roundIndex,
        contentLen: completion.content.length,
        toolCallCount: completion.toolCalls.length,
      },
      'assistant_text_dropped_from_context',
    )
  }

  if (completion.toolCalls.length > 0) {
    input.context.appendAssistantTurn({
      content: '',
      toolCalls: completion.toolCalls,
    })
  }

  const controls: ToolControl[] = []
  for (const call of completion.toolCalls) {
    const result = await input.tools.execute(call, input.toolContext)
    if (result.control) controls.push(result.control)
    input.context.appendToolResult({ toolCallId: call.id, content: result.content })
  }

  return {
    inputTokens: completion.usage.inputTokens,
    tokensUsed: (completion.usage.inputTokens ?? 0) + (completion.usage.outputTokens ?? 0),
    controls,
  }
}
```

Implementation rules:

- Keep `operation: 'agent.chat'` unchanged.
- Keep log event names `round_llm_done` and `assistant_text_dropped_from_context` unchanged.
- Do not import mailbox, snapshot repo, compaction, life journal, or BotLoop runtime state.
- Do not append `completion.content` to `AgentContext`.
- Do not append `ToolExecutionResult.outcome` or `ToolExecutionResult.control`.

**Step 2: Run the focused test**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/react-kernel.test.ts
```

Expected: PASS.

**Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/agent/react-kernel.ts src/agent/react-kernel.test.ts
git commit -m "refactor: 抽出 ReAct Kernel"
```

### Task 3: Wire BotLoopAgent as Runtime Host

**Files:**
- Modify: `src/agent/bot-loop-agent.ts`
- Test: `src/agent/bot-loop-agent.test.ts`
- Test: `src/agent/integration-multi-source.test.ts`

**Step 1: Replace local `runRound()` internals**

In `src/agent/bot-loop-agent.ts`, import the kernel:

```ts
import { runReactRound } from './react-kernel.js'
```

Remove these now-unused imports from `bot-loop-agent.ts`:

```ts
import type { LlmClient } from './llm-client.js'
import type { ToolExecutor } from './tool.js'
import { recordTokenUsage } from './token-stats.js'
```

Then keep `BotLoopAgentDeps` type imports by re-adding type-only imports if needed:

```ts
import type { LlmClient } from './llm-client.js'
import type { ToolExecutor, ToolControl } from './tool.js'
```

Change local `runRound()` to delegate:

```ts
async function runRound(): Promise<{
  inputTokens: number | null
  tokensUsed: number
  didPause: boolean
}> {
  roundIndex++
  const result = await runReactRound({
    roundIndex,
    systemPrompt: deps.systemPrompt,
    context: deps.context,
    llm: deps.llm,
    tools: deps.tools,
    toolContext: {
      eventQueue: deps.eventQueue,
      roundIndex,
    },
  })

  return {
    inputTokens: result.inputTokens,
    tokensUsed: result.tokensUsed,
    didPause: result.controls.some((control) => control.type === 'pause'),
  }
}
```

If `ToolControl` is unused after this edit, do not import it.

**Step 2: Confirm Host responsibilities stay in BotLoopAgent**

Before moving on, inspect the diff and verify these blocks are still in `src/agent/bot-loop-agent.ts`:

- `drainEvents()`
- pre-round `snapshotRepo.save(...)`
- post-round `snapshotRepo.save(...)`
- `lifeJournal?.recordRound(...)`
- `maybeCompact(...)`
- `runOnce()` autonomy logic
- `waitForExternalEvent()`
- `stop()` wake enqueue

Do not move any of them into `react-kernel.ts`.

**Step 3: Run bot-loop focused tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/bot-loop-agent.test.ts src/agent/integration-multi-source.test.ts
```

Expected: PASS.

**Step 4: Run the new kernel focused test**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/react-kernel.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/bot-loop-agent.ts
git commit -m "refactor: BotLoopAgent 接入 Runtime Host 边界"
```

### Task 4: Update Architecture Documentation

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/AGENT_CONTEXT.md`
- Optional Modify: `docs/TECH_DEBT.md`

**Step 1: Update `docs/ARCHITECTURE.md`**

In the core flow section, replace the single `BotLoopAgent` wording with:

```md
5. `src/agent/bot-loop-agent.ts` 作为 Runtime Host 负责事件披露、mailbox cursor、snapshot 原子保存、life journal hook、compaction 和 pause/autonomy 控制；`src/agent/react-kernel.ts` 只负责一轮通用 ReAct 执行：把 system prompt + messages + visible tools 发给 LLM，append assistant tool calls，顺序执行工具，并只把 `ToolExecutionResult.content` append 为 tool result。
```

In the module map, add:

```md
- `src/agent/react-kernel.ts`：通用一轮 ReAct Kernel，隔离 LLM 调用、tool call 执行和 tool result append。
```

Keep the existing `src/agent/bot-loop-agent.ts` entry, but describe it as Runtime Host.

**Step 2: Update `docs/AGENT_CONTEXT.md`**

In the code map, add:

```md
- `src/agent/react-kernel.ts`：一轮 ReAct transcript append 边界；只允许工具结果的 `content` 进入 `AgentContext`，`outcome` / `control` 返回给 Runtime Host 使用。
```

Do not add model names, changing defaults, or long implementation details.

**Step 3: Check doc diff**

Run:

```bash
git diff -- docs/ARCHITECTURE.md docs/AGENT_CONTEXT.md docs/TECH_DEBT.md
```

Expected: Diff only documents the new Kernel/Host boundary.

**Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md docs/AGENT_CONTEXT.md docs/TECH_DEBT.md
git commit -m "docs: 记录 ReAct Kernel 边界"
```

If `docs/TECH_DEBT.md` is not modified, omit it from `git add`.

### Task 5: Full Verification and Cleanup

**Files:**
- Verify: entire repository

**Step 1: Run all tests**

Run:

```bash
pnpm test
```

Expected: PASS.

**Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

**Step 3: Run repo check**

Run:

```bash
pnpm repo-check
```

Expected: PASS.

**Step 4: Inspect final diff**

Run:

```bash
git diff --stat HEAD~4..HEAD
git diff HEAD~4..HEAD -- src/agent/react-kernel.ts src/agent/bot-loop-agent.ts docs/ARCHITECTURE.md docs/AGENT_CONTEXT.md
```

Expected:

- `react-kernel.ts` contains only generic one-round ReAct behavior.
- `bot-loop-agent.ts` still owns mailbox, snapshot, compaction, life journal, pause scheduling, autonomy, and waiting.
- No schema changes.
- No prompt text changes.
- No tool description changes.
- No generated `data/agent-workspace/` files staged.

**Step 5: Final commit only if needed**

If verification fixes required extra edits:

```bash
git add <changed-files>
git commit -m "fix: 修正 ReAct Kernel 验证问题"
```

If no extra edits were needed, do not create an empty commit.

---

## Non-Goals

- Do not change `AgentContext` schema or snapshot format.
- Do not change LLM provider wire formats.
- Do not move compaction into the Kernel.
- Do not move mailbox disclosure into the Kernel.
- Do not move snapshot persistence into the Kernel.
- Do not change tool registration or tool descriptions.
- Do not introduce a generic framework, package split, monorepo, adapter layer, or plugin system.
- Do not start the real bot, NapCat, browser sidecar, database migration, or long-running processes for this refactor.

## Success Criteria

- `BotLoopAgent` reads as Runtime Host: event intake before the round, persistence/compaction/autonomy after the round.
- `react-kernel.ts` reads as the generic engine for one ReAct round.
- Existing bot-loop behavior is unchanged at the message ledger level.
- Tests explicitly protect that `ToolExecutionResult.content` is the only tool result data appended to `AgentContext`.
- `pnpm test`, `pnpm typecheck`, and `pnpm repo-check` pass.
