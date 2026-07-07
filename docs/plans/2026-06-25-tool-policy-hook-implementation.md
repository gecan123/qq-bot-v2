# Tool Policy Hook Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a thin internal policy hook that can block explicitly destructive or approval-required tool calls before execution.

**Architecture:** Extend the existing `Tool` interface with optional internal policy metadata. Implement `createToolPolicyHook()` as a `BeforeToolHook` and attach it in `src/index.ts` when constructing `createToolExecutor`. Keep built-in tool behavior unchanged unless a tool explicitly opts into destructive or approval-required metadata.

**Tech Stack:** TypeScript ESM, Zod, Node test runner, existing `Tool`, `BeforeToolHook`, and `createToolExecutor` interfaces.

---

## Ground Rules

- Do not change `AgentContext`, replay, compaction, or system prompt bytes.
- Do not change user-facing tool descriptions in this phase.
- Do not move `send_message`, `workspace_bash`, or `browser` validation logic.
- Do not add an approval UI or owner messaging flow.
- Keep all existing built-in tools allowed by default.
- Use focused tests before broad verification.

## Task 1: Add Tool Policy Metadata Type

**Files:**
- Modify: `src/agent/tool.ts`
- Test: `src/agent/claude-code/request.test.ts`
- Test: `src/agent/openai-agent/llm-client.test.ts`

**Step 1: Write failing schema exposure test for Claude request builder**

In `src/agent/claude-code/request.test.ts`, add or extend a test with a tool containing internal policy metadata:

```ts
const toolWithPolicy: Tool = {
  name: 'internal_policy_demo',
  description: 'demo',
  schema: z.object({}),
  policy: { effect: 'destructive', requiresApproval: true },
  async execute() {
    return { content: 'ok' }
  },
}
```

Assert the serialized Claude tool declaration does not contain `policy`, `effect`, or `requiresApproval`.

**Step 2: Write failing schema exposure test for OpenAI request builder**

In `src/agent/openai-agent/llm-client.test.ts`, add a similar assertion that OpenAI function tool serialization only includes the public tool fields.

**Step 3: Run failing tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/claude-code/request.test.ts src/agent/openai-agent/llm-client.test.ts
```

Expected: FAIL at compile time because `Tool` does not yet allow `policy`.

**Step 4: Add optional policy metadata**

In `src/agent/tool.ts`, extend `Tool`:

```ts
export type ToolPolicyEffect = 'read' | 'write' | 'external' | 'destructive'

export interface ToolPolicy {
  effect?: ToolPolicyEffect
  requiresApproval?: boolean
}

export interface Tool<TArgs = unknown> {
  name: string
  description: string
  schema: ZodTypeAny
  policy?: ToolPolicy
  execute(args: TArgs, ctx: ToolContext): Promise<ToolExecutionResult>
}
```

Do not modify request builders unless tests show they already spread whole tool objects.

**Step 5: Run tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/claude-code/request.test.ts src/agent/openai-agent/llm-client.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/agent/tool.ts src/agent/claude-code/request.test.ts src/agent/openai-agent/llm-client.test.ts
git commit -m "refactor: 增加工具策略元数据"
```

## Task 2: Implement Policy Hook

**Files:**
- Create: `src/agent/tool-policy.ts`
- Create: `src/agent/tool-policy.test.ts`

**Step 1: Write failing tests**

Create tests:

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import { createToolExecutor, type Tool } from './tool.js'
import { createToolPolicyHook } from './tool-policy.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'

function makeCtx() {
  return {
    eventQueue: new InMemoryEventQueue<BotEvent>(),
    roundIndex: 0,
  }
}

function makeTool(policy?: Tool['policy']): Tool<Record<string, never>> {
  return {
    name: 'demo',
    description: 'demo',
    schema: z.object({}),
    ...(policy ? { policy } : {}),
    async execute() {
      return { content: JSON.stringify({ ok: true }) }
    },
  }
}
```

Add cases:

- no policy allows execution.
- `{ effect: 'read' }` allows.
- `{ effect: 'write' }` allows.
- `{ effect: 'external' }` allows.
- `{ effect: 'destructive' }` blocks.
- `{ requiresApproval: true }` blocks.

For blocked cases, assert:

```ts
const parsed = JSON.parse(result.content as string)
assert.equal(parsed.ok, false)
assert.equal(parsed.error, 'Tool call blocked by policy')
assert.equal(parsed.toolName, 'demo')
```

**Step 2: Run failing tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/tool-policy.test.ts
```

Expected: FAIL because `tool-policy.ts` does not exist.

**Step 3: Implement minimal policy hook**

Create `src/agent/tool-policy.ts`:

```ts
import type { BeforeToolHook, ToolExecutionResult, ToolPolicy } from './tool.js'

type BlockReason = 'approval_required' | 'destructive_tool'

export function createToolPolicyHook(): BeforeToolHook {
  return ({ tool }) => {
    const reason = classifyBlocked(tool.policy)
    if (!reason) return
    return blockedToolResult(tool.name, reason)
  }
}

function classifyBlocked(policy: ToolPolicy | undefined): BlockReason | null {
  if (!policy) return null
  if (policy.requiresApproval === true) return 'approval_required'
  if (policy.effect === 'destructive') return 'destructive_tool'
  return null
}

function blockedToolResult(toolName: string, reason: BlockReason): ToolExecutionResult {
  return {
    content: JSON.stringify({
      ok: false,
      error: 'Tool call blocked by policy',
      reason,
      toolName,
    }),
  }
}
```

**Step 4: Run tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/tool-policy.test.ts src/agent/tool.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/tool-policy.ts src/agent/tool-policy.test.ts
git commit -m "refactor: 增加工具策略 hook"
```

## Task 3: Wire Policy Hook Into Runtime

**Files:**
- Modify: `src/index.ts`
- Test: `src/ops/repo-check.test.ts`
- Modify if needed: `src/ops/repo-check.ts`

**Step 1: Add a focused repo-check expectation**

In `src/ops/repo-check.test.ts`, update the “current repository map” fixture or add a focused assertion requiring `src/index.ts` to contain:

```ts
createToolPolicyHook()
```

If `runRepoChecks` does not currently read `src/index.ts`, extend `RepoCheckFiles` and the script wrapper only if this repository check is worth the churn. If that is too broad, skip repo-check changes and rely on focused runtime import tests.

**Step 2: Wire the hook**

In `src/index.ts`:

```ts
import { createToolPolicyHook } from './agent/tool-policy.js'
```

Change executor construction:

```ts
const tools = createToolExecutor(
  buildBotTools({
    sender: messageSender,
    groupAmbientSendIds: config.groupAmbientSendIds,
    taskRegistry,
    groupIds: config.botTargetGroupIds,
    metadata: targetMetadata,
    groupCustomizations,
  }),
  {
    trace: { path: config.toolCallLogPath },
    hooks: {
      beforeTool: [createToolPolicyHook()],
    },
  },
)
```

**Step 3: Run focused tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/tool-policy.test.ts src/agent/tool.test.ts
```

Expected: PASS.

**Step 4: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/index.ts src/ops/repo-check.ts src/ops/repo-check.test.ts
git commit -m "refactor: 接入工具策略 hook"
```

If repo-check files were not changed, stage only `src/index.ts`.

## Task 4: Verify Current Built-In Tools Still Pass

**Files:**
- No code changes expected.

**Step 1: Run focused tool tests**

Run:

```bash
pnpm exec tsx --test --import tsx \
  src/agent/tools/send-message.test.ts \
  src/agent/tools/workspace-bash.test.ts \
  src/agent/tools/browser.test.ts \
  src/agent/tools/merged-tools.test.ts
```

Expected: PASS.

**Step 2: Run broad tests with required test env**

Run:

```bash
DATABASE_URL='postgresql://user:pass@localhost:5432/db' \
NAPCAT_WS_URL='ws://localhost:3001' \
NAPCAT_ACCESS_TOKEN='token' \
BOT_TARGET_GROUP_IDS='123' \
SELF_NUMBER='789' \
LLM_DEFAULT_PROVIDER='claude-code' \
LLM_DEFAULT_MODEL='claude-sonnet-4-6' \
LLM_PROVIDER_CLAUDE_URL='http://127.0.0.1:8317/v1' \
LLM_PROVIDER_CLAUDE_API_KEY='sk-local' \
LLM_PROVIDER_OPENAI_URL='http://127.0.0.1:8317/v1' \
LLM_PROVIDER_OPENAI_API_KEY='sk-local' \
pnpm test
```

Expected: PASS.

**Step 3: Run repo checks**

Run:

```bash
pnpm repo-check
```

Expected: PASS.

**Step 4: Final commit if verification caused docs/check changes**

Only if uncommitted files remain:

```bash
git status --short
git add <changed files from this phase only>
git commit -m "test: 覆盖工具策略 hook"
```

## Handoff Notes

- Bare `pnpm test` fails in environments without the required LLM/config env vars. Use the env-prefixed command above for full verification.
- This phase intentionally leaves existing tools without `policy` metadata. Missing metadata means allowed.
- Do not mark `send_message` as `requiresApproval` in this phase; that would break normal QQ output.
- Do not mark `browser` as destructive in this phase; browser has its own risk classifier.
- Do not mark `workspace_bash` as destructive in this phase; it has its own parser and allowlist.
