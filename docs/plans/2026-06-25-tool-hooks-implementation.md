# Tool Hooks Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a minimal hook pipeline to `createToolExecutor` so later permission, background, MCP, and audit behavior can attach to one stable tool boundary.

**Architecture:** Keep `BotLoopAgent` unchanged. Extend `src/agent/tool.ts` with typed `beforeTool` and `afterTool` hooks around validated tool execution. Hook-blocked calls still return a normal `ToolExecutionResult` for the original tool call id and are traced through the existing tool-call log.

**Tech Stack:** TypeScript ESM, Zod, Node test runner, existing `Tool` / `ToolExecutor` / `ToolExecutionResult` interfaces.

---

## Ground Rules

- Do not change `AgentContext`, replay, compaction, or system prompt bytes.
- Do not change registered tool names or tool descriptions in this slice.
- Do not move existing per-tool validation out of tools.
- Keep `BotLoopAgent` behavior unchanged.
- Do not touch existing dirty files unless the implementation genuinely requires them.
- Use focused tests before broader verification.

## Task 1: Add Before Hook Blocking

**Files:**
- Modify: `src/agent/tool.ts`
- Modify: `src/agent/tool.test.ts`

**Step 1: Write failing test**

Add a test to `createToolExecutor`:

```ts
test('beforeTool hook can block execution with a tool result', async () => {
  let executed = false
  const tool: Tool<{ text?: string }> = {
    name: 'echo',
    description: 'echo',
    schema: z.object({ text: z.string().optional() }),
    async execute() {
      executed = true
      return { content: 'executed' }
    },
  }
  const exec = createToolExecutor([tool], {
    hooks: {
      beforeTool: [() => ({ content: JSON.stringify({ ok: false, error: 'blocked' }) })],
    },
  })

  const result = await exec.execute({ id: 'c1', name: 'echo', args: {} }, makeCtx())

  assert.equal(executed, false)
  assert.match(result.content as string, /blocked/)
})
```

**Step 2: Run failing test**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/tool.test.ts
```

Expected: FAIL because `hooks` is not supported.

**Step 3: Add hook types**

In `src/agent/tool.ts`, add:

```ts
export interface ToolHookContext extends ToolContext {
  tool: Tool
  call: AssistantToolCall
}

export type BeforeToolHook = (
  ctx: ToolHookContext,
) => Promise<ToolExecutionResult | void> | ToolExecutionResult | void

export type AfterToolHook = (
  ctx: ToolHookContext & { result: ToolExecutionResult },
) => Promise<void> | void
```

Extend `ToolExecutorOptions`:

```ts
hooks?: {
  beforeTool?: BeforeToolHook[]
  afterTool?: AfterToolHook[]
}
```

**Step 4: Run `beforeTool` after validation**

After schema validation succeeds and before `tool.execute`, call hooks in order:

```ts
for (const hook of options.hooks?.beforeTool ?? []) {
  const blocked = await hook({ ...ctx, tool, call: normalizedCall })
  if (blocked) {
    await traceToolCall(options.trace, normalizedCall, ctx.roundIndex, startedAt, blocked)
    return blocked
  }
}
```

**Step 5: Run focused test**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/tool.test.ts
```

Expected: PASS.

## Task 2: Normalize Args Before Hooks

**Files:**
- Modify: `src/agent/tool.test.ts`

**Step 1: Add regression test**

Add a test proving the hook receives normalized args:

```ts
test('beforeTool hook receives normalized args', async () => {
  let seen: unknown
  const tool: Tool<{ value?: string }> = {
    name: 'optional',
    description: 'optional',
    schema: z.object({ value: z.string().optional() }),
    async execute() {
      return { content: 'ok' }
    },
  }
  const exec = createToolExecutor([tool], {
    hooks: {
      beforeTool: [(ctx) => {
        seen = ctx.call.args
      }],
    },
  })

  await exec.execute({ id: 'c1', name: 'optional', args: { value: null } }, makeCtx())

  assert.deepEqual(seen, {})
})
```

**Step 2: Run test**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/tool.test.ts
```

Expected: PASS if Task 1 placed hooks after normalization.

## Task 3: Hook Error Handling

**Files:**
- Modify: `src/agent/tool.ts`
- Modify: `src/agent/tool.test.ts`

**Step 1: Add failing before hook error test**

Add:

```ts
test('beforeTool hook errors become structured tool errors', async () => {
  const tool: Tool<Record<string, never>> = {
    name: 'echo',
    description: 'echo',
    schema: z.object({}),
    async execute() {
      return { content: 'executed' }
    },
  }
  const exec = createToolExecutor([tool], {
    hooks: {
      beforeTool: [() => {
        throw new Error('policy exploded')
      }],
    },
  })

  const result = await exec.execute({ id: 'c1', name: 'echo', args: {} }, makeCtx())

  assert.match(result.content as string, /Tool hook failed: policy exploded/)
})
```

**Step 2: Implement helper**

Wrap before hooks:

```ts
async function runBeforeToolHooks(...): Promise<ToolExecutionResult | null>
```

If a hook throws, return:

```ts
{ content: JSON.stringify({ error: `Tool hook failed: ${message}` }) }
```

Trace this as a failed call.

**Step 3: Run focused test**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/tool.test.ts
```

Expected: PASS.

## Task 4: Add After Hooks

**Files:**
- Modify: `src/agent/tool.ts`
- Modify: `src/agent/tool.test.ts`

**Step 1: Add after hook order test**

Add:

```ts
test('afterTool hook runs after successful tool execution', async () => {
  const events: string[] = []
  const tool: Tool<Record<string, never>> = {
    name: 'echo',
    description: 'echo',
    schema: z.object({}),
    async execute() {
      events.push('execute')
      return { content: 'ok' }
    },
  }
  const exec = createToolExecutor([tool], {
    hooks: {
      afterTool: [({ result }) => {
        events.push(`after:${result.content}`)
      }],
    },
  })

  await exec.execute({ id: 'c1', name: 'echo', args: {} }, makeCtx())

  assert.deepEqual(events, ['execute', 'after:ok'])
})
```

**Step 2: Add after hook failure test**

Add:

```ts
test('afterTool hook failure preserves original tool result', async () => {
  const tool: Tool<Record<string, never>> = {
    name: 'echo',
    description: 'echo',
    schema: z.object({}),
    async execute() {
      return { content: 'ok' }
    },
  }
  const exec = createToolExecutor([tool], {
    hooks: {
      afterTool: [() => {
        throw new Error('after exploded')
      }],
    },
  })

  const result = await exec.execute({ id: 'c1', name: 'echo', args: {} }, makeCtx())

  assert.equal(result.content, 'ok')
})
```

**Step 3: Implement after hook runner**

After `tool.execute` succeeds, run all `afterTool` hooks. Catch and log failures with module logger:

```ts
log.warn({ err, toolName: call.name, toolCallId: call.id }, 'after_tool_hook_failed')
```

Do not alter the original tool result.

**Step 4: Run focused test**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/tool.test.ts
```

Expected: PASS.

## Task 5: Preserve Existing Trace Semantics

**Files:**
- Modify: `src/agent/tool.test.ts`

**Step 1: Add blocked trace test**

Add a test similar to existing trace tests:

```ts
test('traces hook-blocked calls once with normalized args', async () => {
  const writes: string[] = []
  const tool: Tool<{ value?: string }> = {
    name: 'echo',
    description: 'echo',
    schema: z.object({ value: z.string().optional() }),
    async execute() {
      return { content: 'executed' }
    },
  }
  const exec = createToolExecutor([tool], {
    hooks: {
      beforeTool: [() => ({ content: JSON.stringify({ ok: false, error: 'blocked' }) })],
    },
    trace: {
      now: () => new Date('2026-06-25T00:00:00.000Z'),
      clockMs: (() => {
        const values = [10, 15]
        return () => values.shift() ?? 15
      })(),
      appender: async (_path, line) => {
        writes.push(line)
      },
    },
  })

  await exec.execute({ id: 'c1', name: 'echo', args: { value: null } }, makeCtx())

  assert.equal(writes.length, 1)
  const entry = JSON.parse(writes[0]!)
  assert.equal(entry.ok, false)
  assert.deepEqual(entry.argsSummary, {})
  assert.equal(entry.error, 'blocked')
})
```

**Step 2: Run focused test**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/tool.test.ts
```

Expected: PASS.

## Task 6: Verification

**Files:**
- Review only: `docs/TOOLS.md`
- Review only: `docs/AGENT_CONTEXT.md`

**Step 1: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

**Step 2: Run repo check**

Run:

```bash
pnpm repo-check
```

Expected: PASS, unless pre-existing dirty prompt/docs changes are incomplete. If it fails, inspect whether failures are from this hook work or from unrelated working-tree changes.

**Step 3: Run focused and broad tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/tool.test.ts
pnpm test
```

Expected: PASS.

**Step 4: Commit when the worktree is ready**

Only stage files touched by this plan:

```bash
git add src/agent/tool.ts src/agent/tool.test.ts docs/plans/2026-06-25-tool-hooks-design.md docs/plans/2026-06-25-tool-hooks-implementation.md
git commit -m "refactor: 增加工具调用 hook 管线"
```
